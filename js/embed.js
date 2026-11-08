// Image-first embeds, run on the page that embeds the network. The copied embed code is only a box
// that shows an image of the network, linked to the viewer, and loads this script from the app:
//
//   <div data-bn-embed="<viewer URL>" style="…">
//     <a href="<viewer URL>" …><img …></a>
//     <script src="…/js/embed.js" async></script>
//   </div>
//
// Everything else happens here, so a change to this file reaches every embed already published.
// Keep this path, and keep reading that markup. Embed code copied before this file existed has
// an inline script that swaps in the viewer on the same "bn-viewer-ready" message.
(() => {
  // Every embed loads this script, and the first copy to run may start embeds still being parsed.
  for (const box of document.querySelectorAll("[data-bn-embed]")) {
    if (box.querySelector(":scope > iframe")) continue; // started by another copy
    const url = box.dataset.bnEmbed;
    // The viewer loads hidden, behind the image, until it has rendered the network.
    const frame = document.createElement("iframe");
    frame.title = box.querySelector("img")?.alt || "Bayesian network";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position: absolute; inset: 0; width: 100%; height: 100%; border: 0; visibility: hidden;";
    // A sandboxed page without allow-same-origin (a LessWrong widget) passes its sandbox to the
    // frame, whose messages then come from the opaque origin "null".
    const origin = window.origin === "null" ? "null" : new URL(url).origin;
    const ready = (event) => {
      if (event.source !== frame.contentWindow || event.origin !== origin || event.data !== "bn-viewer-ready") return;
      box.querySelector("a").inert = true;
      frame.style.visibility = "visible";
      frame.removeAttribute("aria-hidden");
      frame.removeAttribute("tabindex");
      window.removeEventListener("message", ready);
    };
    window.addEventListener("message", ready);
    frame.src = url;
    box.append(frame);
  }
})();
