'use strict';

/* ================================================================
 * 静态检查：语法 + JSON + 版本一致性 + 注入清单里的文件是否真的存在
 *
 *   node tools/check.js      （npm run check）
 *
 * 不依赖任何第三方包，本地和 CI 跑的是同一套。
 *
 * 为什么要查「注入清单里的文件存在」：
 *   chrome.scripting.registerContentScripts 遇到不存在的文件会整条抛错，
 *   结果是**面板根本不注入**，页面上一点异常都看不到。mux.min.js 从上架版
 *   被裁掉那次就踩过这个坑 —— 上架包里只要清单还写着它，扩展就等于坏了。
 * ================================================================ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;

const ok = (msg) => console.log('  ✓ ' + msg);
const bad = (msg) => { failures++; console.log('  ✗ ' + msg); };

/* ---------------- 1. 语法 ---------------- */

const rootJs = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.js') && f !== 'mux.min.js');   /* 第三方压缩包不查 */
const toolJs = fs.readdirSync(path.join(ROOT, 'tools'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => 'tools/' + f);

/* 用 vm.Script 编译一遍，等价于 node --check，但不启子进程。
   子进程方式在 Windows 上会遇到 EBUSY（同一个 node.exe 正被自己占用），
   而且多起 30 个进程纯属浪费。 */
let syntaxBad = 0;
for (const rel of rootJs.concat(toolJs)) {
  try {
    new vm.Script(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
  } catch (e) {
    syntaxBad++;
    bad('语法错误 ' + rel + '：' + ((e && e.message) || e));
  }
}
if (!syntaxBad) ok((rootJs.length + toolJs.length) + ' 个 JS 文件语法正常');

/* ---------------- 2. JSON 可解析 ---------------- */

const readJson = (rel) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch (e) {
    bad(rel + ' 解析失败：' + ((e && e.message) || e));
    return null;
  }
};

const manifest = readJson('manifest.json');
const pkg = readJson('package.json');
if (manifest && pkg) ok('manifest.json / package.json 可解析');

/* ---------------- 3. 版本一致 ---------------- */

if (manifest && pkg) {
  if (manifest.version === pkg.version) ok('版本号一致：' + manifest.version);
  else bad('版本号不一致：manifest ' + manifest.version + ' ≠ package ' + pkg.version);
}

/* ---------------- 4. 清单里的文件都存在 ---------------- */

/** 递归收集 JSON 里所有像文件名的字符串（.js/.html/.png/.css） */
function collect(quiet) {
  const out = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      if (/\.(js|html|png|css)$/i.test(node) && node.indexOf('://') < 0) out.push(node);
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') Object.keys(node).forEach((k) => walk(node[k]));
  };
  walk(quiet);
  return out;
}

if (manifest) {
  const refs = collect(manifest).filter((f) => f.indexOf('*') < 0);
  const missing = refs.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) missing.forEach((f) => bad('manifest 引用了不存在的文件：' + f));
  else ok('manifest 引用的 ' + refs.length + ' 个文件都在');
}

/* contentScriptFiles() 是注入清单的唯一来源：把它里面写的 .js 逐个对一遍 */
const bgAuth = fs.readFileSync(path.join(ROOT, 'bg-auth.js'), 'utf8');
const fnStart = bgAuth.indexOf('function contentScriptFiles()');
if (fnStart < 0) {
  bad('bg-auth.js 里找不到 contentScriptFiles()');
} else {
  const fnBody = bgAuth.slice(fnStart, bgAuth.indexOf('\n}', fnStart));
  const listed = (fnBody.match(/'([\w.-]+\.js)'/g) || []).map((s) => s.slice(1, -1));
  const absent = listed.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (!listed.length) bad('contentScriptFiles() 里没解析出任何文件');
  else if (absent.length) absent.forEach((f) => bad('注入清单里的文件不存在：' + f));
  else ok('注入清单 ' + listed.length + ' 个文件都在');
}

/* ---------------- 5. 上架版不该带 mux.min.js ---------------- */

const manifestAll = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
if (manifestAll.indexOf('mux.min.js') >= 0) {
  bad('manifest.json 直接引用了 mux.min.js（它只该按需注入）');
}

console.log(failures === 0 ? '\ncheck 通过' : '\ncheck 失败 ' + failures + ' 项');
process.exit(failures === 0 ? 0 : 1);
