#!/usr/bin/env bash
# Generates PNG icons from SVG using rsvg-convert or sips (macOS built-in)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SVG="$SCRIPT_DIR/icons/icon.svg"
DEST="$SCRIPT_DIR/icons"

for SIZE in 16 32 48 128; do
  OUT="$DEST/icon${SIZE}.png"
  if command -v rsvg-convert &>/dev/null; then
    rsvg-convert -w $SIZE -h $SIZE "$SVG" -o "$OUT"
  elif command -v sips &>/dev/null; then
    # sips can't handle SVG → use a temp PNG from Python
    python3 - "$SVG" "$OUT" "$SIZE" <<'PY'
import sys, subprocess
svg, out, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
# Use cairosvg if available, else just copy a placeholder
try:
    import cairosvg
    cairosvg.svg2png(url=svg, write_to=out, output_width=size, output_height=size)
except ImportError:
    # Last resort: use ImageMagick convert
    subprocess.run(["convert", "-background", "none", "-resize", f"{size}x{size}", svg, out], check=True)
PY
  else
    echo "No SVG renderer found. Install librsvg (brew install librsvg) or ImageMagick."
    exit 1
  fi
  echo "Generated $OUT"
done
