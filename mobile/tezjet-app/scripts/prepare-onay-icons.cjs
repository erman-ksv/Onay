#!/usr/bin/env node
/**
 * Generate real Android launcher art from the committed transparent Onay logo.
 * No screenshots, external APIs, font substitution, image library or lossy
 * source edits. Run automatically by app.config.ts before Expo prebuild.
 *
 * Outputs are deliberately build-generated. Native build QA must inspect APK
 * mipmap resources; Expo config checks alone are not acceptance evidence.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "assets/onay-original-logo.png");
const ICON = path.join(ROOT, "assets/onay-launcher-icon.png");
const FOREGROUND = path.join(ROOT, "assets/onay-adaptive-foreground.png");
const SIZE = 1024;
const MAX_LOGO = 472; // 46% canvas; all artwork inside Android's central safe circle.
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let n = i;
  for (let k = 0; k < 8; k++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1;
  TABLE[i] = n >>> 0;
}
function crc(data) {
  let n = 0xffffffff;
  for (const b of data) n = TABLE[(n ^ b) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(tag, bytes) {
  const name = Buffer.from(tag, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, sum]);
}
function decodePng(input) {
  if (!input.subarray(0, 8).equals(SIGNATURE)) throw Error("Source is not PNG");
  let width = 0, height = 0, color = 0, depth = 0, interlace = 0;
  const idat = [];
  for (let p = 8; p < input.length;) {
    const length = input.readUInt32BE(p);
    const tag = input.toString("ascii", p + 4, p + 8);
    const body = input.subarray(p + 8, p + 8 + length);
    if (tag === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; color = body[9]; interlace = body[12];
    }
    if (tag === "IDAT") idat.push(body);
    p += length + 12;
    if (tag === "IEND") break;
  }
  if (!width || !height || width > 4096 || height > 4096 || depth !== 8 || color !== 6 || interlace !== 0) {
    throw Error("Expected safe non-interlaced RGBA 8-bit source");
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) throw Error("Malformed PNG scanlines");
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const base = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i < 4 ? 0 : out[base + i - 4];
      const up = y === 0 ? 0 : out[base - stride + i];
      const upperLeft = y === 0 || i < 4 ? 0 : out[base - stride + i - 4];
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const a = left + up - upperLeft;
        const da = Math.abs(a - left), db = Math.abs(a - up), dc = Math.abs(a - upperLeft);
        predictor = da <= db && da <= dc ? left : db <= dc ? up : upperLeft;
      } else if (filter !== 0) throw Error("Unsupported PNG row filter");
      out[base + i] = (raw[p++] + predictor) & 255;
    }
  }
  return { width, height, data: out };
}
function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
function bounds(png, threshold = 6) {
  let left = png.width, top = png.height, right = -1, bottom = -1;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    if (png.data[(y * png.width + x) * 4 + 3] < threshold) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) throw Error("Onay logo has no visible pixels");
  return { left, top, width: right + 1 - left, height: bottom + 1 - top };
}
function produceImages(source) {
  const foreground = Buffer.alloc(SIZE * SIZE * 4);
  const icon = Buffer.alloc(SIZE * SIZE * 4, 255); // Truly white full-canvas launcher background.
  const b = bounds(source);
  const scale = MAX_LOGO / Math.max(b.width, b.height);
  const w = Math.max(1, Math.round(b.width * scale));
  const h = Math.max(1, Math.round(b.height * scale));
  const offsetX = Math.floor((SIZE - w) / 2);
  const offsetY = Math.floor((SIZE - h) / 2);

  // Premultiplied-alpha bilinear sampling prevents black halos around edges.
  for (let y = 0; y < h; y++) {
    const sy = b.top + (y + 0.5) / scale - 0.5;
    const y0 = Math.max(b.top, Math.min(b.top + b.height - 1, Math.floor(sy)));
    const y1 = Math.min(b.top + b.height - 1, y0 + 1);
    const wy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < w; x++) {
      const sx = b.left + (x + 0.5) / scale - 0.5;
      const x0 = Math.max(b.left, Math.min(b.left + b.width - 1, Math.floor(sx)));
      const x1 = Math.min(b.left + b.width - 1, x0 + 1);
      const wx = Math.max(0, Math.min(1, sx - x0));
      let a = 0, r = 0, g = 0, bl = 0;
      for (const [yy, xx, weight] of [
        [y0, x0, (1 - wx) * (1 - wy)],
        [y0, x1, wx * (1 - wy)],
        [y1, x0, (1 - wx) * wy],
        [y1, x1, wx * wy],
      ]) {
        const si = (yy * source.width + xx) * 4;
        const coverage = source.data[si + 3] / 255 * weight;
        a += coverage;
        r += source.data[si] * coverage;
        g += source.data[si + 1] * coverage;
        bl += source.data[si + 2] * coverage;
      }
      const i = ((y + offsetY) * SIZE + x + offsetX) * 4;
      const alpha = Math.round(a * 255);
      foreground[i] = a > 0 ? Math.round(r / a) : 0;
      foreground[i + 1] = a > 0 ? Math.round(g / a) : 0;
      foreground[i + 2] = a > 0 ? Math.round(bl / a) : 0;
      foreground[i + 3] = alpha;
      icon[i] = Math.round(a * foreground[i] + 255 * (1 - a));
      icon[i + 1] = Math.round(a * foreground[i + 1] + 255 * (1 - a));
      icon[i + 2] = Math.round(a * foreground[i + 2] + 255 * (1 - a));
      icon[i + 3] = 255;
    }
  }
  // Final anti-aliased visible bounds may differ from the source alpha outline.
  // Recenter the actual visible artwork for equal left/right and top/bottom space.
  const visible = bounds({ width: SIZE, height: SIZE, data: foreground }, 12);
  const shiftX = Math.round(SIZE / 2 - (visible.left + visible.width / 2));
  const shiftY = Math.round(SIZE / 2 - (visible.top + visible.height / 2));
  if (shiftX || shiftY) {
    const shiftedFg = Buffer.alloc(SIZE * SIZE * 4);
    const shiftedIcon = Buffer.alloc(SIZE * SIZE * 4, 255);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const tx = x + shiftX, ty = y + shiftY;
      if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) continue;
      const src = (y * SIZE + x) * 4, dst = (ty * SIZE + tx) * 4;
      foreground.copy(shiftedFg, dst, src, src + 4);
      icon.copy(shiftedIcon, dst, src, src + 4);
    }
    return { icon: encodePng(SIZE, SIZE, shiftedIcon), foreground: encodePng(SIZE, SIZE, shiftedFg) };
  }
  return { icon: encodePng(SIZE, SIZE, icon), foreground: encodePng(SIZE, SIZE, foreground) };
}
function writeIfChanged(filename, content) {
  if (!fs.existsSync(filename) || !fs.readFileSync(filename).equals(content)) fs.writeFileSync(filename, content);
}
function generate() {
  const image = decodePng(fs.readFileSync(SOURCE));
  const files = produceImages(image);
  writeIfChanged(ICON, files.icon);
  writeIfChanged(FOREGROUND, files.foreground);
}
if (require.main === module) generate();
module.exports = { decodePng, encodePng, bounds, produceImages, generate, ICON, FOREGROUND, SOURCE, SIZE, MAX_LOGO };
