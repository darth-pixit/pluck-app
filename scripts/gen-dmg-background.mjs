// Generates the macOS DMG installer background (app/src-tauri/macos/dmg-background.png).
//
// The DMG bundles an "Applications" symlink next to Pluks.app so the install is a
// single drag. This background paints a "DRAG PLUKS TO APPLICATIONS" headline and
// an arrow pointing from the app icon (left) to the Applications folder (right) so
// an unaware user knows exactly what to do — no Finder hunting, no double-click.
//
// Pure Node (zlib only) so it runs in CI without extra deps. The image must match
// the DMG window size in points (660x400) because Finder positions the background
// at native size from the top-left, not scaled. Re-run after editing:
//   node scripts/gen-dmg-background.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const W = 660;
const H = 400;

// These MUST mirror bundle.macOS.dmg.{appPosition,applicationFolderPosition} in
// tauri.conf.json — the icon *centers*. We draw the arrow in the gap between them.
const APP_CENTER = { x: 180, y: 170 };
const APPS_CENTER = { x: 480, y: 170 };

// ── tiny 5x7 uppercase bitmap font ──────────────────────────────────────────────
// Only the glyphs used by the headline are defined. Each glyph is 7 rows of 5
// chars; '#' = ink. ASCII preview is printed at the end so the render can be
// eyeballed without opening the PNG.
const FONT = {
  " ": ["     ", "     ", "     ", "     ", "     ", "     ", "     "],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  N: ["#...#", "##..#", "#.#.#", "#.#.#", "#.#.#", "#..##", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
};

const HEADLINE = "DRAG PLUKS TO APPLICATIONS";
const SCALE = 4; // each font pixel -> SCALE x SCALE block

// ── canvas ───────────────────────────────────────────────────────────────────
// RGB, row-major. Soft warm off-white so the dark Finder icon labels stay legible.
const BG = [0xfb, 0xfa, 0xf8];
const INK = [0x33, 0x33, 0x38]; // near-black headline
const ACCENT = [0xf0, 0x8a, 0x3c]; // brand orange arrow

const px = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) {
  px[i * 3] = BG[0];
  px[i * 3 + 1] = BG[1];
  px[i * 3 + 2] = BG[2];
}

function setPx(x, y, [r, g, b]) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
}

function fillRect(x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(x, y, color);
}

// ── headline ───────────────────────────────────────────────────────────────────
const charW = 5 * SCALE;
const gap = 1 * SCALE;
const textW = HEADLINE.length * charW + (HEADLINE.length - 1) * gap;
let tx = Math.round((W - textW) / 2);
const ty = 44;
for (const ch of HEADLINE) {
  const glyph = FONT[ch];
  if (!glyph) throw new Error(`Missing glyph for '${ch}' — add it to FONT`);
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (glyph[row][col] === "#") fillRect(tx + col * SCALE, ty + row * SCALE, SCALE, SCALE, INK);
    }
  }
  tx += charW + gap;
}

// ── arrow (app -> Applications), drawn in the gap between the two icons ──────────
// Icons render ~128px wide centered on APP_CENTER / APPS_CENTER, so keep clear of
// x = center +/- 70. Arrow sits on the icon vertical center.
const ay = APP_CENTER.y;
const shaftX0 = APP_CENTER.x + 78;
const shaftX1 = APPS_CENTER.x - 92; // leave room for the head
const shaftH = 10;
fillRect(shaftX0, ay - shaftH / 2, shaftX1 - shaftX0, shaftH, ACCENT);
// triangular head
const headLen = 26;
const headHalf = 22;
for (let dx = 0; dx < headLen; dx++) {
  const half = Math.round(headHalf * (1 - dx / headLen));
  for (let dy = -half; dy <= half; dy++) setPx(shaftX1 + dx, ay + dy, ACCENT);
}

// ── PNG encode (color type 2, 8-bit RGB) ────────────────────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: truecolor RGB
// 10..12 left zero: compression, filter, interlace

// filtered scanlines: one 0x00 filter byte per row
const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  const dst = y * (1 + W * 3);
  raw[dst] = 0;
  px.copy(raw, dst + 1, y * W * 3, (y + 1) * W * 3);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "src-tauri", "macos", "dmg-background.png");
writeFileSync(out, png);

// ASCII preview of the headline so the glyphs can be sanity-checked from CI logs.
const preview = [];
for (let row = 0; row < 7; row++) {
  let line = "";
  for (const ch of HEADLINE) line += FONT[ch][row].replace(/#/g, "█").replace(/ /g, " ") + " ";
  preview.push(line);
}
console.log(preview.join("\n"));
console.log(`\nWrote ${out} (${W}x${H}, ${png.length} bytes)`);
