// Export the canvas as a standalone SVG or PNG with the network's pyAgrum code embedded, and read
// that code back out of such an image. SVG keeps it in a <metadata> element; PNG in an iTXt chunk.
(function () {
  "use strict";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const KEYWORD = "bn-editor-pyagrum";
  const STYLE_PROPS = [
    "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity", "opacity",
    "font-family", "font-size", "font-weight",
  ];

  // Copies the computed presentation of each live element onto its clone, so the SVG looks the
  // same without the page's stylesheet and CSS variables.
  function inlineStyles(live, clone) {
    const cs = getComputedStyle(live);
    const style = STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";");
    clone.setAttribute("style", style);
    for (let i = 0; i < live.children.length; i++) inlineStyles(live.children[i], clone.children[i]);
  }

  const cdata = (s) => "<![CDATA[" + s.replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";

  // svg: the live canvas <svg>; viewport: its <g> with the drawing (already rendered without
  // selection). Returns {svg: string, width, height}.
  function buildSvg(svg, viewport, { code, caption, background, captionColor }) {
    const pad = 24;
    const box = viewport.getBBox();
    const capH = caption ? 30 : 0;
    const width = Math.ceil(Math.max(box.width, caption ? caption.width : 0) + 2 * pad);
    const height = Math.ceil(box.height + 2 * pad + capH);

    const g = viewport.cloneNode(true);
    inlineStyles(viewport, g);
    g.removeAttribute("id");
    g.setAttribute("transform", `translate(${pad - box.x},${pad + capH - box.y})`);
    g.querySelectorAll(".port, path.hit, title, .ghost, .rubber").forEach((el) => el.remove());
    g.querySelectorAll("[marker-end]").forEach((el) => el.setAttribute("marker-end", "url(#arrow)"));

    const marker = svg.querySelector("#arrow").cloneNode(true);
    inlineStyles(svg.querySelector("#arrow"), marker);

    const font = getComputedStyle(viewport).fontFamily;
    const out = document.createElementNS(SVG_NS, "svg");
    out.setAttribute("xmlns", SVG_NS);
    out.setAttribute("width", width);
    out.setAttribute("height", height);
    out.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const defs = document.createElementNS(SVG_NS, "defs");
    defs.appendChild(marker);
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("width", "100%");
    bg.setAttribute("height", "100%");
    bg.setAttribute("fill", background);
    out.append(defs, bg);
    if (caption) {
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("x", pad);
      t.setAttribute("y", pad + 12);
      t.setAttribute("style", `font-family:${font};font-size:13px;fill:${captionColor}`);
      t.textContent = caption.text;
      out.appendChild(t);
    }
    out.appendChild(g);
    const xml = new XMLSerializer().serializeToString(out)
      .replace(/<defs>/, `<metadata id="${KEYWORD}">${cdata(code)}</metadata><defs>`);
    return { svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + xml, width, height };
  }

  // ---------------------------------------------------------------- PNG

  const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // An uncompressed iTXt chunk: keyword, flags, empty language and translated keyword, UTF-8 text.
  function itxtChunk(keyword, text) {
    const enc = new TextEncoder();
    const data = new Uint8Array([...enc.encode(keyword), 0, 0, 0, 0, 0, ...enc.encode(text)]);
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(enc.encode("iTXt"), 4);
    chunk.set(data, 8);
    view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
    return chunk;
  }

  async function svgToPng({ svg, width, height }, code, scale = 2) {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const png = new Uint8Array(await blob.arrayBuffer());
      // insert the text chunk just before IEND (the last 12 bytes)
      const extra = itxtChunk(KEYWORD, code);
      const out = new Uint8Array(png.length + extra.length);
      out.set(png.subarray(0, png.length - 12), 0);
      out.set(extra, png.length - 12);
      out.set(png.subarray(png.length - 12), png.length - 12 + extra.length);
      return new Blob([out], { type: "image/png" });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function codeFromPng(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dec = new TextDecoder();
    for (let p = 8; p + 12 <= bytes.length;) {
      const len = view.getUint32(p);
      const type = dec.decode(bytes.subarray(p + 4, p + 8));
      const data = bytes.subarray(p + 8, p + 8 + len);
      const kwEnd = data.indexOf(0);
      if ((type === "iTXt" || type === "tEXt") && dec.decode(data.subarray(0, kwEnd)) === KEYWORD) {
        if (type === "tEXt") return new TextDecoder("latin1").decode(data.subarray(kwEnd + 1));
        if (data[kwEnd + 1] !== 0) return null; // compressed iTXt is not written by this editor
        let q = data.indexOf(0, kwEnd + 3); // end of language tag
        q = data.indexOf(0, q + 1); // end of translated keyword
        return dec.decode(data.subarray(q + 1));
      }
      p += 12 + len;
    }
    return null;
  }

  function codeFromSvg(text) {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const meta = doc.getElementById(KEYWORD);
    return meta ? meta.textContent : null;
  }

  // Returns the embedded pyAgrum code, null for an image without it, or undefined for other files.
  async function codeFromFile(file) {
    const name = file.name.toLowerCase();
    if (file.type === "image/png" || name.endsWith(".png")) return codeFromPng(new Uint8Array(await file.arrayBuffer()));
    if (file.type === "image/svg+xml" || name.endsWith(".svg")) return codeFromSvg(await file.text());
    return undefined;
  }

  globalThis.BNImage = { buildSvg, svgToPng, codeFromFile, codeFromPng, codeFromSvg };
})();
