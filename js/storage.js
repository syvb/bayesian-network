(function () {
  "use strict";

  // A network, its evidence and menu metadata commit together. In particular, a Web Lock
  // followed by a fresh transaction sees the previous owner's completed transaction;
  // localStorage's per-window cache does not provide that handover guarantee.
  globalThis.BNStorage = {
    open() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open("bn-editor", 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("networks", { keyPath: "id" });
          request.result.createObjectStore("meta");
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => db.close();
          function run(stores, mode, action) {
            return new Promise((done, fail) => {
              const tx = db.transaction(stores, mode);
              let result;
              tx.oncomplete = () => done(result?.result);
              tx.onabort = () => fail(tx.error || new Error("Storage transaction aborted"));
              try { result = action(tx); }
              catch (error) { tx.abort(); fail(error); }
            });
          }
          resolve({
            get: id => run("networks", "readonly", tx => tx.objectStore("networks").get(id)),
            list: () => run("networks", "readonly", tx => tx.objectStore("networks").getAll()),
            put: record => run("networks", "readwrite", tx => tx.objectStore("networks").put(record)),
            remove: id => run("networks", "readwrite", tx => tx.objectStore("networks").delete(id)),
            isMigrated: () => run("meta", "readonly", tx => tx.objectStore("meta").get("localStorage-migrated")),
            // Import once, atomically. Keeping the old keys as a backup must not resurrect
            // networks deleted after migration, including when the last network is deleted.
            migrate: records => run(["networks", "meta"], "readwrite", tx => {
              const meta = tx.objectStore("meta"), migrated = meta.get("localStorage-migrated");
              migrated.onsuccess = () => {
                if (migrated.result) return;
                for (const record of records) tx.objectStore("networks").put(record);
                meta.put(true, "localStorage-migrated");
              };
            }),
          });
        };
      });
    },
  };
})();
