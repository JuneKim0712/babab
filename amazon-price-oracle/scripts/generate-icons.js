#!/usr/bin/env node
/**
 * Generates icons/icon16.png, icon48.png and icon128.png with zero dependencies
 * (software rasteriser + zlib). Run: `node scripts/generate-icons.js`
 *
 * Design: flat teal (#007185) rounded tile with a white axes-and-price-line mark.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 48, 128];
const SUPERSAMPLE = 4;
// Chart mark: axes plus a rising price line, matching the widget header icon (18-unit grid).
const STROKES = [
  { w: 1.9, pts: [[2.5, 3], [2.5, 15], [15.5, 15]] },
  { w: 1.9, pts: [[5.5, 11], [8.5, 7.5], [11, 9.5], [15, 4.5]] }
];
const TEAL = [0, 113, 133];
const RADIUS = 0.2;

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function onMark(x, y) {
  const gx = x * 18;
  const gy = y * 18;
  // Inset the glyph so it sits centred with padding inside the tile.
  const ux = (gx - 9) / 0.72 + 9;
  const uy = (gy - 9) / 0.72 + 9;
  for (const { w, pts } of STROKES) {
    for (let i = 0; i < pts.length - 1; i++) {
      if (distToSegment(ux, uy, pts[i], pts[i + 1]) <= w / 2) return true;
    }
  }
  return false;
}

function insideRoundedSquare(x, y, radius) {
  const dx = Math.max(radius - x, 0, x - (1 - radius));
  const dy = Math.max(radius - y, 0, y - (1 - radius));
  return dx * dx + dy * dy <= radius * radius;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          if (!insideRoundedSquare(x, y, RADIUS)) continue;
          a += 1;
          if (onMark(x, y)) {
            r += 255; g += 255; b += 255;
          } else {
            r += TEAL[0];
            g += TEAL[1];
            b += TEAL[2];
          }
        }
      }
      const i = (py * size + px) * 4;
      const n = SUPERSAMPLE * SUPERSAMPLE;
      if (a > 0) {
        pixels[i] = Math.round(r / a);
        pixels[i + 1] = Math.round(g / a);
        pixels[i + 2] = Math.round(b / a);
        pixels[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
