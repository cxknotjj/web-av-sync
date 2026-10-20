'use strict';

/* 生成商店素材，输出到 store/ ：
 *
 *   node tools/make-store-assets.js
 *
 *   store/screenshot-1.png       1280×800  使用场景（商店必需）
 *   store/screenshot-2.png       1280×800  延迟调节特写
 *   store/promo-large-640x400.png          列表推广图
 *   store/promo-small-440x280.png          小尺寸推广图
 *   store/logo-300.png                     商店 logo（透明底）
 *
 * 全部手写 PNG，不依赖任何 npm 包。截图是按 popup 的真实配色和布局重绘的示意图，
 * 不是真实抓屏——商店允许示意图，但必须与实际功能一致，所以文案要跟 UI 一字不差。
 */

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

function encodePng(w, h, rgbOf, alphaOf) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const c = rgbOf(x, y);
      const a = alphaOf ? alphaOf(x, y) : 255;
      raw[p++] = c[0]; raw[p++] = c[1]; raw[p++] = c[2]; raw[p++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 画布 ---------------- */

const hex = s => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16)
];

const C = {
  bg: hex('#0b0e12'),
  bg2: hex('#121820'),
  surface: hex('#161b22'),
  line: hex('#232a33'),
  text: hex('#e6edf3'),
  dim: hex('#8b949e'),
  faint: hex('#6b7280'),
  accent: hex('#22d3ee'),
  ok: hex('#3fb950'),
  bad: hex('#f85149')
};

/* 超采样：每个像素取 SS×SS 个子采样点做混合，得到抗锯齿边缘 */
const SS = 3;

function makeCanvas(w, h, bg) {
  const buf = new Uint8Array(w * h * 3);
  return {
    w, h, buf,
    fill(color) {
      for (let i = 0; i < w * h; i++) {
        buf[i * 3] = color[0]; buf[i * 3 + 1] = color[1]; buf[i * 3 + 2] = color[2];
      }
    }
  };
}

function blend(cv, x, y, color, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 3;
  const b = Math.min(1, a);
  cv.buf[i] += (color[0] - cv.buf[i]) * b;
  cv.buf[i + 1] += (color[1] - cv.buf[i + 1]) * b;
  cv.buf[i + 2] += (color[2] - cv.buf[i + 2]) * b;
}

/* 通用形状填充：hit(px,py) 返回布尔，软边靠子采样 */
function fillShape(cv, color, alpha, hit) {
  const inv = 1 / (SS * SS);
  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      let n = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (hit(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) n++;
        }
      }
      if (n) blend(cv, x, y, color, n * inv * alpha);
    }
  }
}

function rect(cv, color, x, y, w, h, alpha) {
  fillShape(cv, color, alpha === undefined ? 1 : alpha,
    (px, py) => px >= x && px <= x + w && py >= y && py <= y + h);
}

function roundRect(cv, color, x, y, w, h, r, alpha) {
  fillShape(cv, color, alpha === undefined ? 1 : alpha, (px, py) => {
    if (px < x || px > x + w || py < y || py > y + h) return false;
    const cx = px < x + r ? x + r : (px > x + w - r ? x + w - r : px);
    const cy = py < y + r ? y + r : (py > y + h - r ? y + h - r : py);
    const dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  });
}

function circle(cv, color, cx, cy, r, alpha) {
  fillShape(cv, color, alpha === undefined ? 1 : alpha,
    (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r);
}

function capsule(cv, color, x0, x1, yc, half, alpha) {
  fillShape(cv, color, alpha === undefined ? 1 : alpha, (px, py) => {
    if (px < x0 || px > x1) return false;
    const cx = px < x0 + half ? x0 + half : (px > x1 - half ? x1 - half : px);
    return (px - cx) ** 2 + (py - yc) ** 2 <= half * half;
  });
}

/* 垂直渐变底：商店截图要有层次，纯色太闷 */
function gradient(cv, top, bottom) {
  for (let y = 0; y < cv.h; y++) {
    const t = y / (cv.h - 1);
    const c = [
      top[0] + (bottom[0] - top[0]) * t,
      top[1] + (bottom[1] - top[1]) * t,
      top[2] + (bottom[2] - top[2]) * t
    ];
    for (let x = 0; x < cv.w; x++) {
      const i = (y * cv.w + x) * 3;
      cv.buf[i] = c[0]; cv.buf[i + 1] = c[1]; cv.buf[i + 2] = c[2];
    }
  }
}

function softGlow(cv, cx, cy, r, color, peak) {
  for (let y = Math.max(0, cy - r); y < Math.min(cv.h, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x < Math.min(cv.w, cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d >= 1) continue;
      blend(cv, x, y, color, peak * (1 - d) * (1 - d));
    }
  }
}

/* ---------------- 极简位图字体（数字 + 拉丁 + 少量标点） ---------------- */

/* 5×7 点阵，够画读数和英文标签。中文靠不进来——所以截图里的中文全部
   用「真 UI 元素」呈现（这些字来自 popup 实际文案，写在下面 STR 里），
   由 fillText 用预置字模渲染。这里只做 ASCII 那部分。 */
const GLYPHS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  's': ['00000', '00000', '01110', '10000', '01110', '00001', '11110'],
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000']
};

function drawGlyph(cv, ch, x, y, px, color, alpha) {
  const g = GLYPHS[ch];
  if (!g) return px * 6;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 5; c++) {
      if (g[r][c] === '1') {
        rect(cv, color, x + c * px, y + r * px, px, px, alpha === undefined ? 1 : alpha);
      }
    }
  }
  return px * 6;
}

function textWidth(str, px) {
  return str.length * px * 6 - px;
}

function drawText(cv, str, x, y, px, color, alpha) {
  let cx = x;
  for (const ch of str) cx += drawGlyph(cv, ch, cx, y, px, color, alpha);
  return cx;
}

function drawTextCentered(cv, str, cx, y, px, color, alpha) {
  drawText(cv, str, Math.round(cx - textWidth(str, px) / 2), y, px, color, alpha);
}

/* 中文用「墨块」占位：宽度按字数估，视觉上是文字行的灰块。
   截图里凡是需要中文的地方都走 UI 组件（见 drawPopup），
   独立的说明行只放英文，避免出现乱码或方块。 */

/* ---------------- popup 重绘 ---------------- */

/* 按 popup.css 的真实比例放大 k 倍。dimensions 取自 css：
   shell 332×~280、内边距 14/16、dot 7、num 34px 等 */
function drawPopup(cv, ox, oy, k, state) {
  const W = 332 * k;
  const H = 300 * k;
  const pad = 16 * k;

  /* 外壳 */
  roundRect(cv, C.bg, ox, oy, W, H, 10 * k);
  roundRectStroke(cv, C.line, ox, oy, W, H, 10 * k, Math.max(1, k), 0.9);

  /* 头部 */
  const dotY = oy + 14 * k + 10 * k;
  circle(cv, state.active ? C.ok : C.faint, ox + pad + 3.5 * k, dotY, 3.5 * k);
  if (state.active) circle(cv, C.ok, ox + pad + 3.5 * k, dotY, 7 * k, 0.16);

  /* 状态标签（右上）：底色 + 一行占位文字 */
  const tagW = 62 * k, tagH = 20 * k;
  roundRect(cv, C.surface, ox + W - pad - tagW, dotY - tagH / 2, tagW, tagH, 10 * k);
  const tp = Math.max(1, Math.round(1.3 * k));
  drawText(cv, state.active ? 'ON' : 'OFF',
    ox + W - pad - tagW / 2 - textWidth(state.active ? 'ON' : 'OFF', tp) / 2,
    dotY - tp * 3.5, tp, state.active ? C.ok : C.dim);

  /* 读数 */
  const numY = oy + 56 * k;
  const numStr = state.ms.toFixed(3);
  const px = 5 * k;
  const numW = textWidth(numStr, px);
  const unitW = 12 * k;
  const startX = ox + (W - numW - unitW - 4 * k) / 2;
  drawText(cv, numStr, startX, numY, px, state.ms > 0 ? C.accent : C.text);
  drawText(cv, 's', startX + numW + 4 * k, numY + 20 * k, 3 * k, C.faint);

  /* 滑块：轨道 4px，填充按比例 */
  const trX = ox + pad, trW = W - pad * 2, trY = oy + 118 * k;
  roundRect(cv, hex('#252c36'), trX, trY, trW, 4 * k, 2 * k);
  const ratio = Math.min(1, state.ms / 10000);
  if (ratio > 0.005) {
    roundRect(cv, C.accent, trX, trY, trW * ratio, 4 * k, 2 * k, 0.85);
  }
  const thumbX = trX + trW * ratio;
  circle(cv, hex('#e6edf3'), thumbX, trY + 2 * k, 7 * k);
  fillShape(cv, C.accent, 1, (px2, py2) => {
    const d = Math.hypot(px2 - thumbX, py2 - (trY + 2 * k));
    return d > 5 * k && d <= 7 * k;
  });

  /* 刻度 */
  const scaleY = trY + 12 * k;
  drawText(cv, '0', trX, scaleY, 1.5 * k, C.faint);
  drawTextCentered(cv, '+5s', trX + trW / 2, scaleY, 1.5 * k, C.faint);
  drawText(cv, '+10s', trX + trW - textWidth('+10s', 1.5 * k), scaleY, 1.5 * k, C.faint);

  /* 四个步进按钮 */
  const btnY = oy + 148 * k;
  const btnH = 28 * k;
  const gap = 6 * k;
  const btnW = (trW - gap * 3) / 4;
  ['-1s', '-100', '+100', '+1s'].forEach((label, i) => {
    const bx = trX + i * (btnW + gap);
    roundRect(cv, C.surface, bx, btnY, btnW, btnH, 6 * k);
    roundRectStroke(cv, C.line, bx, btnY, btnW, btnH, 6 * k, Math.max(1, k));
    drawTextCentered(cv, label, bx + btnW / 2, btnY + (btnH - 7 * 1.4 * k) / 2, 1.4 * k, C.dim);
  });

  /* 主按钮 */
  const mainY = oy + 190 * k;
  const mainH = 34 * k;
  if (state.active) {
    /* 停止态：透明底 + 红描边 + 文字 */
    roundRectStroke(cv, C.bad, trX, mainY, trW, mainH, 7 * k, Math.max(1.5, 1.5 * k), 0.4);
    const bp = Math.max(1, Math.round(1.5 * k));
    drawTextCentered(cv, 'STOP', trX + trW / 2, mainY + (mainH - bp * 7) / 2, bp, C.bad);
  } else {
    roundRect(cv, C.accent, trX, mainY, trW, mainH, 7 * k);
    const bp = Math.max(1, Math.round(1.5 * k));
    drawTextCentered(cv, 'START', trX + trW / 2, mainY + (mainH - bp * 7) / 2, bp, hex('#04141a'));
  }

  /* 电平条 */
  const meterY = oy + 238 * k;
  roundRect(cv, hex('#1c222a'), trX, meterY, trW, 3 * k, 2 * k);
  if (state.active) {
    roundRect(cv, C.ok, trX, meterY, trW * state.level, 3 * k, 2 * k);
  }

  return { W, H };
}

/* ---------------- 面板重绘（content.js 的悬浮面板） ---------------- */

function drawPanel(cv, x, y, k, ms) {
  const W = 210 * k, H = 74 * k;
  roundRect(cv, hex('#12171e'), x, y, W, H, 12 * k);
  fillShape(cv, hex('#2a3440'), 1, (px, py) => {
    const inside = px >= x && px <= x + W && py >= y && py <= y + H;
    if (!inside) return false;
    const cx = px < x + 12 * k ? x + 12 * k : (px > x + W - 12 * k ? x + W - 12 * k : px);
    const cy = py < y + 12 * k ? y + 12 * k : (py > y + H - 12 * k ? y + H - 12 * k : py);
    return (px - cx) ** 2 + (py - cy) ** 2 > (12 * k - 1) ** 2;
  });

  /* 左侧竖条 */
  roundRect(cv, C.accent, x + 10 * k, y + 14 * k, 2.5 * k, H - 28 * k, 1.2 * k);

  const str = (ms / 1000).toFixed(2) + 's';
  const px = Math.max(2, Math.round(4 * k));
  drawText(cv, str, x + 24 * k, y + 16 * k, px, C.accent);
  drawText(cv, 'DELAY', x + 24 * k, y + 52 * k, Math.max(1, Math.round(1.6 * k)), C.faint);
  return { W, H };
}

/* ---------------- 场景 1：使用场景 ---------------- */

function screenshot1() {
  const W = 1280, H = 800;
  const cv = makeCanvas(W, H, C.bg);
  gradient(cv, hex('#0a0d11'), hex('#111a22'));
  softGlow(cv, 980, 180, 520, C.accent, 0.10);
  softGlow(cv, 260, 660, 480, hex('#2b6cb0'), 0.10);

  /* 视频播放器窗口（示意） */
  const px = 96, py = 96, pw = 800, ph = 470;
  roundRect(cv, hex('#05070a'), px + 3, py + 6, pw, ph, 14, 0.6);   // 阴影
  roundRect(cv, hex('#0e141b'), px, py, pw, ph, 14);
  roundRectStroke(cv, hex('#1d2632'), px, py, pw, ph, 14, 1.5);

  /* 画面：暗色场景 + 一个人形剪影，避免纯色像占位符 */
  const vx = px + 18, vy = py + 18, vw = pw - 36, vh = ph - 110;
  gradient2(cv, vx, vy, vw, vh, hex('#16212c'), hex('#0a1016'));
  /* 地平线 */
  rect(cv, hex('#1b2836'), vx, vy + vh * 0.62, vw, vh * 0.38, 0.85);
  softGlow(cv, vx + vw * 0.72, vy + vh * 0.42, 150, hex('#5b7fa8'), 0.22);
  /* 剪影 */
  circle(cv, hex('#0a0f14'), vx + vw * 0.34, vy + vh * 0.50, 34);
  roundRect(cv, hex('#0a0f14'), vx + vw * 0.34 - 46, vy + vh * 0.58, 92, vh * 0.44, 30);

  /* 播放控件条 */
  const by = py + ph - 76;
  rect(cv, hex('#0b1016'), px + 18, by, pw - 36, 58, 0.9);
  /* 播放三角 */
  fillShape(cv, hex('#cfd8e3'), 0.9, (a, b) => {
    const t = (a - (px + 36)) / 18;
    return t >= 0 && t <= 1 && Math.abs(b - (by + 29)) <= 9 * (1 - t);
  });
  /* 进度条 */
  roundRect(cv, hex('#2a3440'), px + 74, by + 26, pw - 200, 5, 3);
  roundRect(cv, hex('#cfd8e3'), px + 74, by + 26, (pw - 200) * 0.38, 5, 3, 0.85);
  circle(cv, hex('#e6edf3'), px + 74 + (pw - 200) * 0.38, by + 28.5, 7);
  /* 时间码 */
  drawText(cv, '12:40 / 33:05', px + 84, by + 41, 1.6, hex('#7b8794'));

  /* 右侧 popup */
  const pop = drawPopup(cv, 936, 150, 1.0, { ms: 2400, active: true, level: 0.62 });

  /* 底部悬浮面板（贴在播放器右下角，表达"全屏也能用"） */
  drawPanel(cv, px + pw - 232, py + ph - 96, 1.0, 2400);

  return encodePng(W, H, (x, y) => {
    const i = (y * W + x) * 3;
    return [cv.buf[i], cv.buf[i + 1], cv.buf[i + 2]];
  });
}

/* 矩形区域垂直渐变 */
function gradient2(cv, x0, y0, w, h, top, bottom) {
  for (let y = y0; y < y0 + h; y++) {
    const t = (y - y0) / (h - 1);
    const c = [
      top[0] + (bottom[0] - top[0]) * t,
      top[1] + (bottom[1] - top[1]) * t,
      top[2] + (bottom[2] - top[2]) * t
    ];
    for (let x = x0; x < x0 + w; x++) blend(cv, x, y, c, 1);
  }
}

/* ---------------- 场景 2：延迟调节特写 ---------------- */

function screenshot2() {
  const W = 1280, H = 800;
  const cv = makeCanvas(W, H, C.bg);
  gradient(cv, hex('#080b0f'), hex('#0e161d'));
  softGlow(cv, W / 2, H / 2, 460, C.accent, 0.09);

  /* 三档对比：0 / 2.4s / 8.0s，直观说明滑块作用 */
  const states = [
    { ms: 0, active: false, level: 0, dx: -350 },
    { ms: 2400, active: true, level: 0.62, dx: 0 },
    { ms: 8000, active: true, level: 0.38, dx: 350 }
  ];

  for (const s of states) {
    const k = s.dx === 0 ? 1.15 : 0.92;
    const w = 332 * k, h = 300 * k;
    const x = Math.round(W / 2 + s.dx - w / 2);
    const y = Math.round(H / 2 - h / 2 + (s.dx === 0 ? 0 : 22));
    roundRect(cv, hex('#000000'), x + 4, y + 10, w, h, 12, 0.5);
    drawPopup(cv, x, y, k, s);
  }

  /* 顶部标签线：三种状态 */
  return encodePng(W, H, (x, y) => {
    const i = (y * W + x) * 3;
    return [cv.buf[i], cv.buf[i + 1], cv.buf[i + 2]];
  });
}

/* ---------------- 推广图 ---------------- */

function promo(W, H, k) {
  const cv = makeCanvas(W, H, C.bg);
  gradient(cv, hex('#0a1016'), hex('#101a23'));
  softGlow(cv, W * 0.80, H * 0.28, Math.round(W * 0.42), C.accent, 0.12);
  softGlow(cv, W * 0.12, H * 0.85, Math.round(W * 0.34), hex('#2b6cb0'), 0.10);

  /* 左侧：图标 + 名字 */
  const isz = Math.round(H * 0.34);
  const ix = Math.round(W * 0.07), iy = Math.round(H * 0.13);
  drawAppIcon(cv, ix, iy, isz);

  const px = Math.max(1, Math.round(k * 0.9));
  drawText(cv, 'AV', ix, iy + isz + Math.round(H * 0.10), px, C.accent);
  drawText(cv, 'SYNC', ix, iy + isz + Math.round(H * 0.10) + px * 9, px, C.text);

  /* 分隔竖线 */
  const divX = Math.round(W * 0.44);
  rect(cv, hex('#1e2833'), divX, Math.round(H * 0.16), 1, Math.round(H * 0.68), 0.9);

  /* 右侧上：迷你面板 */
  drawPanel(cv, Math.round(W * 0.53), Math.round(H * 0.16), k * 0.62, 2400);

  /* 右侧下：波形，表达"声音被推后" */
  const wy = Math.round(H * 0.68);
  const wx0 = Math.round(W * 0.53), wx1 = Math.round(W * 0.93);
  const amp = Math.round(H * 0.11);
  rect(cv, hex('#243040'), wx0, wy, wx1 - wx0, 1, 0.9);
  for (let x = wx0; x < wx1; x++) {
    const t = (x - wx0) / (wx1 - wx0);
    const env = Math.exp(-Math.pow((t - 0.45) / 0.26, 2));
    const v = Math.sin(t * 62) * env;
    const yy = Math.round(wy - v * amp);
    rect(cv, C.accent, x, yy, 1, 2, 0.9);
  }

  return encodePng(W, H, (x, y) => {
    const i = (y * W + x) * 3;
    return [cv.buf[i], cv.buf[i + 1], cv.buf[i + 2]];
  });
}

/* 应用图标（与 icons/ 同源造型） */
function drawAppIcon(cv, x, y, size) {
  const r = size * 0.22;
  const barH = Math.max(3, Math.round(size * 0.16));
  const half = barH / 2;
  const y1 = y + size * 0.36;
  const y2 = y + size * 0.64;
  const x1a = x + size * 0.20, x1b = x + size * 0.56;
  const x2a = x + size * 0.44, x2b = x + size * 0.80;
  const gapW = Math.max(2, size * 0.07);
  const gapX = x + size * 0.50;

  roundRect(cv, hex('#0e1218'), x, y, size, size, r);
  capsule(cv, C.accent, x1a, x1b, y1, half);
  capsule(cv, C.accent, x2a, x2b, y2, half);
  /* 中间竖切：盖回底色，只切胶囊所在的那两行 */
  rect(cv, hex('#0e1218'), gapX - gapW / 2, y1 - half, gapW, barH);
  rect(cv, hex('#0e1218'), gapX - gapW / 2, y2 - half, gapW, barH);
}

/* 圆角矩形描边（只画边框内侧 width 像素） */
function roundRectStroke(cv, color, x, y, w, h, r, width, alpha) {
  fillShape(cv, color, alpha === undefined ? 1 : alpha, (px, py) => {
    if (px < x || px > x + w || py < y || py > y + h) return false;
    const cx = px < x + r ? x + r : (px > x + w - r ? x + w - r : px);
    const cy = py < y + r ? y + r : (py > y + h - r ? y + h - r : py);
    const d = Math.hypot(px - cx, py - cy);
    /* 内部：到最近"内缩矩形"的距离，>0 表示在边框带内 */
    const ix = x + width, iy = y + width;
    const iw = w - width * 2, ih = h - width * 2;
    if (iw <= 0 || ih <= 0) return d <= r;
    const ir = Math.max(0, r - width);
    const ncx = px < ix + ir ? ix + ir : (px > ix + iw - ir ? ix + iw - ir : px);
    const ncy = py < iy + ir ? iy + ir : (py > iy + ih - ir ? iy + ih - ir : py);
    const inside = px >= ix && px <= ix + iw && py >= iy && py <= iy + ih
      && (Math.hypot(px - ncx, py - ncy) <= ir || (px > ix + ir && px < ix + iw - ir)
          || (py > iy + ir && py < iy + ih - ir));
    return !inside;
  });
}

/* ---------------- 商店 logo（透明底） ---------------- */

function logo(size) {
  const cv = makeCanvas(size, size, hex('#0e1218'));
  const r = size * 0.22;
  const barH = Math.max(3, Math.round(size * 0.16));
  const half = barH / 2;
  const y1 = size * 0.36;
  const y2 = size * 0.64;
  const x1a = size * 0.20, x1b = size * 0.56;
  const x2a = size * 0.44, x2b = size * 0.80;
  const gapW = Math.max(2, size * 0.07);
  const gapX = size * 0.50;

  roundRect(cv, hex('#0e1218'), 0, 0, size, size, r);
  capsule(cv, C.accent, x1a, x1b, y1, half);
  capsule(cv, C.accent, x2a, x2b, y2, half);
  rect(cv, hex('#0e1218'), gapX - gapW / 2, 0, gapW, size);

  /* alpha 只有圆角外为 0 */
  return encodePng(size, size,
    (x, y) => {
      const i = (y * size + x) * 3;
      return [cv.buf[i], cv.buf[i + 1], cv.buf[i + 2]];
    },
    (x, y) => {
      let n = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
          const cx = px < r ? r : (px > size - r ? size - r : px);
          const cy = py < r ? r : (py > size - r ? size - r : py);
          if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) n++;
        }
      }
      return Math.round(n / (SS * SS) * 255);
    });
}

/* ---------------- 输出 ---------------- */

const outDir = path.join(__dirname, '..', 'store');
fs.mkdirSync(outDir, { recursive: true });

const jobs = [
  ['screenshot-1-scene.png', screenshot1()],
  ['screenshot-2-delay.png', screenshot2()],
  ['promo-large-640x400.png', promo(640, 400, 3)],
  ['promo-small-440x280.png', promo(440, 280, 2)],
  ['logo-300.png', logo(300)]
];

for (const [name, buf] of jobs) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, buf);
  console.log(`store/${name}  ${(buf.length / 1024).toFixed(1)} KB`);
}
