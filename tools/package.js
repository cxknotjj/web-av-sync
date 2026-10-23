'use strict';

/* 打两个包：
 *
 *   node tools/package.js
 *
 *   dist/audio-delay-sync-<ver>.zip         完整版，三条链路都在，自用 / GitHub 分发
 *   dist/audio-delay-sync-<ver>-store.zip   上架版，砍掉链路②，不带 debugger 权限
 *
 * 两个包来自同一份源码，差别只有两处，都由这个脚本在打包时生成：
 *   1. build-info.js 里 capture: true → false
 *   2. manifest 去掉 debugger；连同只服务链路② 的 bg-capture.js / mux.min.js
 *      一起不进包（mux.js 的 Apache 许可文件也就没必要放了）
 *
 * 其余代码一个字不动，所以不存在两份分支要同步的问题。
 *
 * zip 用 zlib 手写：不依赖任何 npm 包，Windows 上也能直接跑。
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
  'build-info.js',
  'ads-i18n.js',
  /* 语言包：manifest 的 __MSG__ 和面板文案都从这里取 */
  '_locales/zh_CN/messages.json',
  '_locales/en/messages.json',
  'background.js',
  'bg-capture.js',
  'bg-auth.js',
  'offscreen.html',
  'offscreen.js',
  'ads-template.js',
  'ads-ui.js',
  'ads-detect.js',
  /* 双向模式的五块，注入顺序就是这里的顺序 */
  'ads-enh-core.js',
  'ads-enh-panel.js',
  'ads-enh-route.js',
  'ads-enh-sync.js',
  'ads-enhance.js',
  'content.js',
  'inject-main.js',
  'mux.min.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'LICENSE',
  /* mux.js 是 Apache-2.0，分发时必须随包带上许可全文和版权声明，
     否则上架审核会以「第三方组件许可不清」打回。 */
  'LICENSE-APACHE-2.0.txt',
  'THIRD_PARTY_NOTICES.md'
];

/* 上架版砍掉的四个文件。前两个只服务链路②（debugger 抓 ts 切片），
   后两个是 mux.js 的许可文件 —— mux 都不进包了，许可声明也就无从依附。 */
const STORE_DROP = ['bg-capture.js', 'mux.min.js', 'LICENSE-APACHE-2.0.txt', 'THIRD_PARTY_NOTICES.md'];

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

    /* png 已经是压缩格式，deflate 一遍只会更大；文本（js/json/md）能压 3~4 倍。
       之前一律 store 是错的 —— mux.min.js 115KB 原样进包，白占了一半体积。 */
    const isPng = /\.png$/i.test(item.name);
    const stored = isPng ? data : zlib.deflateRawSync(data, { level: 9 });
    const method = isPng ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // flag: UTF-8 文件名
    local.writeUInt16LE(method, 8);    // 0 = store（png），8 = deflate（文本）
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);      // version made by
    central.writeUInt16LE(20, 6);      // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);      // extra
    central.writeUInt16LE(0, 32);      // comment
    central.writeUInt16LE(0, 34);      // disk
    central.writeUInt16LE(0, 36);      // internal attrs
    central.writeUInt32LE(0, 38);      // external attrs
    central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + stored.length;
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

/* ---------------- 构建变体 ---------------- */

/** 改 build-info.js 里那唯一一行标记。找不到就报错 —— 说明有人改了格式，
 *  这时候静默放过去会打出一个「自称上架版、实际带 debugger」的包。 */
function buildInfoFor(store) {
  const src = fs.readFileSync(path.join(ROOT, 'build-info.js'), 'utf8');
  if (!store) return Buffer.from(src);

  const next = src.replace(
    'globalThis.ADS_BUILD = { capture: true };',
    'globalThis.ADS_BUILD = { capture: false };'
  );
  if (next === src) throw new Error('build-info.js 里没找到构建标记行，无法生成上架版');
  return Buffer.from(next);
}

/** 上架版的清单：删掉 debugger，其余原样 */
function storeManifest(mf) {
  const copy = JSON.parse(JSON.stringify(mf));
  copy.permissions = (copy.permissions || []).filter(p => p !== 'debugger');
  return copy;
}

/* ---------------- 检查 ---------------- */

/* manifest 里的 name / description 现在是 __MSG_xxx__，直接量长度或查违禁词
   都会量到占位符本身。这里按语言包还原成真正的文案再校验 —— 每个语言各来一遍，
   英文简介超长、或者出现别的浏览器名字，都会在这里被挡下。 */
function resolveManifestText(text, locale) {
  const f = path.join(ROOT, '_locales', locale, 'messages.json');
  if (!fs.existsSync(f)) return text;
  let msgs = {};
  try { msgs = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return text; }
  return String(text || '').replace(/__MSG_([A-Za-z0-9_]+)__/g, (all, key) =>
    (msgs[key] && msgs[key].message) || all);
}

function manifestLocales() {
  const dir = path.join(ROOT, '_locales');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory());
}

function assertManifest(mf, entries) {
  const problems = [];

  if (mf.manifest_version !== 3) problems.push('manifest_version 必须是 3');

  const locales = manifestLocales().length ? manifestLocales() : [''];
  for (const loc of locales) {
    const where = loc ? '[' + loc + '] ' : '';
    const name = resolveManifestText(mf.name, loc);
    const desc = resolveManifestText(mf.description, loc);
    if (!name || name.length > 45) {
      problems.push(where + `name 必须存在且不超过 45 字符（当前 ${name.length}）`);
    }
    if (!desc || desc.length > 132) {
      problems.push(where + `description 不超过 132 字符（当前 ${desc.length}）`);
    }
  }
  if (!/^\d+(\.\d+){0,3}$/.test(mf.version || '')) problems.push('version 格式不合法');
  if (mf.update_url) problems.push('update_url 必须删除，Edge 不接受');

  /* Edge / Chrome 都要求：名称和描述里不能出现别的浏览器名字。
     逐个语言查 —— 占位符本身永远不含违禁词，只查原文等于没查。 */
  const banned = /chrome|google chrome|firefox|safari|edge 浏览|chromium/i;
  for (const loc of locales) {
    const where = loc ? '[' + loc + '] ' : '';
    if (banned.test(resolveManifestText(mf.name, loc))) {
      problems.push(where + 'name 里不能出现其他浏览器名称');
    }
    if (banned.test(resolveManifestText(mf.description, loc))) {
      problems.push(where + 'description 里不能出现其他浏览器名称');
    }
  }

  for (const size of [16, 32, 48, 128]) {
    if (!mf.icons || !mf.icons[String(size)]) problems.push(`缺少 ${size}x${size} 图标`);
  }

  /* 商店审核最看重的：权限必须是实际用到的 */
  const used = new Set();
  const src = entries.filter(e => e.name.endsWith('.js'))
    .map(e => e.data.toString('utf8'))
    .join('\n');
  const apiToPerm = {
    'chrome.tabCapture': 'tabCapture',
    'chrome.offscreen': 'offscreen',
    'chrome.scripting': 'scripting',
    'chrome.storage': 'storage',
    /* 原生 HLS 抓切片走调试协议，attach / sendCommand 都是它的调用点 */
    'chrome.debugger': 'debugger',
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

const baseManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const VERSION = baseManifest.version;

const TARGETS = [
  {
    key: 'full',
    label: '完整版 三条链路',
    store: false,
    include: INCLUDE,
    manifest: baseManifest,
    out: `audio-delay-sync-${VERSION}.zip`
  },
  {
    key: 'store',
    label: '上架版 无 debugger',
    store: true,
    include: INCLUDE.filter(f => !STORE_DROP.includes(f)),
    manifest: storeManifest(baseManifest),
    out: `audio-delay-sync-${VERSION}-store.zip`
  }
];

fs.mkdirSync(DIST, { recursive: true });

for (const t of TARGETS) {
  const entries = t.include.map(name => {
    const full = path.join(ROOT, name);
    if (!fs.existsSync(full)) {
      console.error(`[${t.key}] 缺少文件：` + name);
      process.exit(1);
    }
    if (name === 'build-info.js') return { name, data: buildInfoFor(t.store) };
    if (name === 'manifest.json') {
      return { name, data: Buffer.from(JSON.stringify(t.manifest, null, 2) + '\n', 'utf8') };
    }
    return { name, data: fs.readFileSync(full) };
  });

  const problems = assertManifest(t.manifest, entries);
  if (problems.length) {
    console.error(`[${t.key}] 清单检查未通过：`);
    for (const p of problems) console.error('  ✗ ' + p);
    process.exit(1);
  }

  /* 上架版额外两道闸：包里不能残留调试协议调用，也不能把 mux 漏进来 */
  if (t.store) {
    const dirty = entries.filter(e => e.name.endsWith('.js') && e.data.includes('chrome.debugger'));
    if (dirty.length) {
      console.error(`[${t.key}] 上架包里仍有 debugger 调用：` + dirty.map(e => e.name).join(', '));
      process.exit(1);
    }
    if (entries.some(e => e.name === 'mux.min.js')) {
      console.error(`[${t.key}] 上架包里不该有 mux.min.js`);
      process.exit(1);
    }
  }

  const out = path.join(DIST, t.out);
  fs.writeFileSync(out, buildZip(entries));

  /* 同时展开一份目录。加载未打包扩展和 test-env 下的诊断脚本都直接读它，
     以前这里只出 zip，目录是手工留下的旧快照 —— 改了源码、也打了包，
     测试跑的却还是上一版，排查方向整个被带偏。 */
  const outDir = path.join(DIST, path.basename(t.out, '.zip'));
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const e of entries) {
    const full = path.join(outDir, e.name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, e.data);
  }

  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`✓ ${t.label}　${entries.length} 个文件　${kb} KB　${t.manifest.permissions.length} 项权限`);
  console.log('  ' + out);
  console.log('  ' + outDir + path.sep);
}
