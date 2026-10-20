'use strict';

/* 生成扩展图标：深色圆角底 + 两条错开的青色音轨（中间断开，表达"延迟"）
 * 不依赖任何图形库，直接手写 PNG（zlib + CRC32）。
 *
 *   node tools/make-icons.js
 *   → icons/icon16.png  icon32.png  icon48.png  icon128.png
 *
 * 注意：这里必须同时输出 32px，商店清单和 package.js 都要求四档齐全。 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, pixel) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const c = pixel(x, y);
      raw[p++] = c[0]; raw[p++] = c[1]; raw[p++] = c[2]; raw[p++] = c[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 几何辅助 ---------------- */

/* 覆盖率采样：每个像素取 4x4 个子采样，得到 0~1 的软边，
   小尺寸（16px）下圆角和胶囊端头才不会锯齿得看不清 */
const SS = 4;

function roundRectHit(px, py, w, h, r) {
  const cx = px < r ? r : (px > w - r ? w - r : px);
  const cy = py < r ? r : (py > h - r ? h - r : py);
  const dx = px - cx;
  const dy = py - cy;
  return (dx * dx + dy * dy) <= r * r;
}

/* 水平胶囊：两端各一个半圆，中间一个矩形 */
function capsuleHit(px, py, x0, x1, yc, half) {
  if (px < x0 || px > x1) return false;
  const cx = px < x0 + half ? x0 + half : (px > x1 - half ? x1 - half : px);
  const dx = px - cx;
  const dy = py - yc;
  return (dx * dx + dy * dy) <= half * half;
}

/* ---------------- 绘制 ---------------- */

const BG = [14, 18, 24];        // #0e1218
const ACCENT = [34, 211, 238];  // #22d3ee

function makeIcon(size) {
  const radius = size * 0.22;

  /* 上条偏左、下条偏右，中间那截错位就是"被挪走的延迟" */
  const barH = Math.max(2, Math.round(size * 0.16));
  const half = barH / 2;

  const y1 = size * 0.36;
  const y2 = size * 0.64;
  const x1a = size * 0.20, x1b = size * 0.56;
  const x2a = size * 0.44, x2b = size * 0.80;

  /* 中间那道竖切线：让两条胶囊看起来"断"了一下 */
  const gapW = Math.max(1, size * 0.07);
  const gapX = size * 0.50;

  return encodePng(size, size, (x, y) => {
    let bgCov = 0;
    let fgCov = 0;

    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;

        if (!roundRectHit(px, py, size, size, radius)) continue;
        bgCov++;

        if (Math.abs(px - gapX) < gapW / 2) continue;
        if (capsuleHit(px, py, x1a, x1b, y1, half)) fgCov++;
        else if (capsuleHit(px, py, x2a, x2b, y2, half)) fgCov++;
      }
    }

    const total = SS * SS;
    const a = bgCov / total;
    if (a === 0) return [0, 0, 0, 0];

    /* 前景压在背景上，按覆盖率混合，避免边缘发灰 */
    const f = fgCov / total;
    const t = f / a;   // 在已覆盖区域内的前景占比
    const r = Math.round(BG[0] + (ACCENT[0] - BG[0]) * t);
    const g = Math.round(BG[1] + (ACCENT[1] - BG[1]) * t);
    const b = Math.round(BG[2] + (ACCENT[2] - BG[2]) * t);

    return [r, g, b, Math.round(a * 255)];
  });
}

/* ---------------- 输出 ---------------- */

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, makeIcon(size));
  console.log(`icons/icon${size}.png  ${size}x${size}  ${fs.statSync(file).size} bytes`);
}
