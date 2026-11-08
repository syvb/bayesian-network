#!/usr/bin/env bash
# Regenerates og-image.png, the 1200x630 social preview: the first demo with drooping and soil feels
# wet observed, fitted to the canvas and cropped to the canvas (which includes the evidence bar).
# Needs agent-browser, ImageMagick (magick) and zopflipng. Usage: tools/og-image.sh
set -euo pipefail
cd "$(dirname "$0")/.."
port=23599
python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1 &
server=$!
tmp=$(mktemp -d)
trap 'kill $server; agent-browser --session og-image close >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
sleep 1

B="agent-browser --session og-image"
$B open "http://127.0.0.1:$port/" >/dev/null
# 920px tall makes the canvas 1100x577 CSS px, the 1200:630 shape, so Fit frames it as cropped.
$B set viewport 1500 920 2 >/dev/null
$B eval '(() => {
  localStorage.clear();
  const net = BNDemos[0].build(), id = (n) => net.nodes.find((x) => x.name === n).id;
  localStorage.setItem("bn-editor-network", JSON.stringify(net));
  localStorage.setItem("bn-editor-evidence", JSON.stringify([[id("drooping"), "yes"], [id("soil feels wet"), "yes"]]));
  location.reload();
  return 1;
})()' >/dev/null
sleep 2
# Keep the toolbar on one row and outside the canvas crop, without changing the app.
$B eval 'document.querySelector(".toolbar .hint").style.display = "none"' >/dev/null
$B click "#canvas" >/dev/null
$B press f >/dev/null
sleep 0.6
$B mouse move 5 5 >/dev/null
sleep 0.3
$B screenshot "$tmp/full.png" >/dev/null
# The canvas is x 0-1100, y 43-620 in CSS px, at 2x in the screenshot.
magick "$tmp/full.png" -crop 2200x1154+0+86 +repage -resize '1200x630!' -strip og-image.png
zopflipng -y -m --lossy_transparent og-image.png og-image.png >/dev/null
echo "wrote og-image.png ($(stat -c %s og-image.png) bytes)"
