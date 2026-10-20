'use strict';

/* 打商店提交包：只放运行时需要的文件，开发脚本和文档不进包。
 *
 *   node tools/package.js
 *   → dist/audio-delay-sync-1.0.0.zip
 *
 * zip 用 zlib 手写：不依赖任何 npm 包，Windows 上也能直接跑。
 * 校验和用 Chrome 的 --pack-extension，它会做完整清单检查。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/* 进包的东西：只有运行时文件。
   LICENSE 也放进去：MIT 要求在分发的副本中保留版权声明，
   商店 zip 就是一份副本。多这一个纯文本文件不影响审核。 */
const INCLUDE = [
  'manifest.json',
  'background.js',
  'offscreen.html',
  'offscreen.js',
  'content.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'LICENSE'
];

/* ---------------- zip ---------------- */

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

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function buildZip(files) {
  const now = new Date();
  const { time, date } = dosTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const item of files) {
    const nameBuf = Buffer.from(item.name.replace(/\\/g, '/'), 'utf8');
    const data = item.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // flag: UTF-8 文件名
    local.writeUInt16LE(0, 8);         // method: store（已经是压缩过的 png，js 也不值得 deflate）
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);      // version made by
    central.writeUInt16LE(20, 6);      // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);      // extra
    central.writeUInt16LE(0, 32);      // comment
    central.writeUInt16LE(0, 34);      // disk
    central.writeUInt16LE(0, 36);      // internal attrs
    central.writeUInt32LE(0, 38);      // external attrs
    central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

/* ---------------- 检查 ---------------- */

function assertManifest(mf) {
  const problems = [];

  if (mf.manifest_version !== 3) problems.push('manifest_version 必须是 3');
  if (!mf.name || mf.name.length > 45) problems.push('name 必须存在且不超过 45 字符');
  if (!mf.description || mf.description.length > 132) {
    problems.push(`description 不超过 132 字符（当前 ${(mf.description || '').length}）`);
  }
  if (!/^\d+(\.\d+){0,3}$/.test(mf.version || '')) problems.push('version 格式不合法');
  if (mf.update_url) problems.push('update_url 必须删除，Edge 不接受');

  /* Edge / Chrome 都要求：名称和描述里不能出现别的浏览器名字 */
  const banned = /chrome|google chrome|firefox|safari|edge 浏览|chromium/i;
  if (banned.test(mf.name || '')) problems.push('name 里不能出现其他浏览器名称');
  if (banned.test(mf.description || '')) problems.push('description 里不能出现其他浏览器名称');

  for (const size of [16, 32, 48, 128]) {
    if (!mf.icons || !mf.icons[String(size)]) problems.push(`缺少 ${size}x${size} 图标`);
  }

  /* 商店审核最看重的：权限必须是实际用到的 */
  const used = new Set();
  const src = INCLUDE.filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n');
  const apiToPerm = {
    'chrome.tabCapture': 'tabCapture',
    'chrome.offscreen': 'offscreen',
    'chrome.scripting': 'scripting',
    'chrome.storage': 'storage',
    /* activeTab 没有对应代码符号。它授予的临时主机权限正是
       getMediaStreamId 在"用户点了图标"那一刻能读到标签页的前提，
       而 getMediaStreamId 本身已经是调用点。 */
    'chrome.tabCapture.getMediaStreamId': 'activeTab'
  };
  for (const api in apiToPerm) {
    const perm = apiToPerm[api];
    /* activeTab 的判定键是更长的 API 名，不能用 has() 去重：
       chrome.tabCapture 会先命中，导致 activeTab 永远算"未使用"。 */
    if (src.includes(api) && (perm === 'activeTab' || !used.has(perm))) used.add(perm);
  }
  for (const p of (mf.permissions || [])) {
    if (!used.has(p)) problems.push(`权限 ${p} 未被任何代码使用，审核会被要求删掉`);
  }
  for (const p of used) {
    if (!(mf.permissions || []).includes(p)) problems.push(`代码用了 ${p} 但 manifest 没声明`);
  }

  if (mf.host_permissions && mf.host_permissions.length) {
    problems.push('存在 host_permissions，审核会重点问用途（当前设计不需要）');
  }

  return problems;
}

/* ---------------- 主流程 ---------------- */

const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const problems = assertManifest(mf);
if (problems.length) {
  console.error('清单检查未通过：');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}

const files = INCLUDE.map(name => {
  const full = path.join(ROOT, name);
  if (!fs.existsSync(full)) {
    console.error('缺少文件：' + name);
    process.exit(1);
  }
  return { name, data: fs.readFileSync(full) };
});

fs.mkdirSync(DIST, { recursive: true });
const out = path.join(DIST, `audio-delay-sync-${mf.version}.zip`);
fs.writeFileSync(out, buildZip(files));

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`✓ 清单检查通过（${mf.permissions.length} 项权限全部有代码依据）`);
console.log(`✓ 打包 ${files.length} 个文件，共 ${kb} KB`);
console.log('  ' + out);
