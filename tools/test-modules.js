#!/usr/bin/env node
'use strict';

/* 模块装配测试
 *
 *   node tools/test-modules.js
 *
 * 双向模式在 2026-10-21 拆成了五个文件，靠 window.ADS.E 上的命名空间互相
 * 依赖：core → panel → route → sync → enhance，后面的在加载时就解构前面的。
 * 这种结构最典型的坏法是「某个文件漏进注入清单」或者「顺序排错」，而它
 * 不报错 —— 只是拿到 undefined，等到用户点「启用双向」才炸。
 *
 * 所以这里把五个文件按真实注入顺序喂进一个最小沙箱，核对：
 *   1. 每一块的命名空间和对外方法都在
 *   2. init() 能把面板接起来（说明 panel 真的被调到了）
 *   3. 重复注入不会重建状态（否则旧定时器停不掉，两路音频同时出声）
 *   4. 顺序错乱时后面的块自己早退，而不是抛异常把整个 content script 带崩
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* 与 bg-auth.js 的 contentScriptFiles() 保持一致 */
const ORDER = [
  'build-info.js',
  'ads-detect.js',
  'ads-enh-core.js',
  'ads-enh-panel.js',
  'ads-enh-route.js',
  'ads-enh-sync.js',
  'ads-enhance.js'
];

const SRC = {};
for (const f of ORDER) SRC[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');

function makeEnv() {
  const calls = [];

  function fakeEl() {
    return {
      style: {},
      paused: true,
      currentTime: 0,
      duration: NaN,
      muted: false,
      playbackRate: 1,
      buffered: { length: 0, start() { return 0; }, end() { return 0; } },
      addEventListener() {},
      removeEventListener() {},
      removeAttribute() {},
      load() {},
      remove() {},
      pause() {},
      play() { return Promise.resolve(); }
    };
  }

  const documentElement = {
    dataset: {},
    appendChild() {},
    removeChild() {}
  };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, atob, isFinite,
    location: { origin: 'https://example.com' },
    chrome: { runtime: { sendMessage: () => Promise.resolve({ ok: true }) } },
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    MediaSource: function MediaSource() {},
    document: {
      documentElement,
      fullscreenElement: null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      createElement: () => fakeEl()
    }
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext('this.window = this;', ctx);
  sandbox.__calls = calls;
  return sandbox;
}

function run(env, files) {
  for (const f of files) {
    try {
      vm.runInContext(SRC[f], env, { filename: f });
    } catch (e) {
      throw new Error(f + ' 执行失败：' + e.message);
    }
  }
}

function fakeUi() {
  const seen = {
    bind: null, route: 0, modeBtn: 0, tip: 0, tag: 0, enhanced: null
  };
  const ui = {
    host: { style: { display: 'none' } },
    bind(handlers) { seen.bind = handlers; },
    showToast() {},
    setRoute() { seen.route++; },
    setRouteMeta() {},
    setTip() { seen.tip++; },
    setModeTag() { seen.tag++; },
    setModeBtn() { seen.modeBtn++; },
    setValue() {},
    getValue() { return 0; },
    setEnhanced(v) { seen.enhanced = v; },
    reveal() {},
    __seen: seen
  };
  return ui;
}

let failures = 0;
function check(name, ok, extra) {
  if (!ok) failures++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok || !extra ? '' : ' → ' + extra));
}

console.log('\n[1] 按注入顺序装配');
const env = makeEnv();
run(env, ORDER);
const ADS = env.ADS;
check('window.ADS 建起来了', !!ADS);
check('detect 就位', !!(ADS && ADS.detect && typeof ADS.detect.pickVideo === 'function'));
check('core 就位', !!(ADS && ADS.E && ADS.E.core));
check('panel 就位', !!(ADS && ADS.E && ADS.E.panel));
check('route 就位', !!(ADS && ADS.E && ADS.E.route));
check('sync 就位', !!(ADS && ADS.E && ADS.E.sync));
check('enh 就位', !!(ADS && ADS.enh));

console.log('\n[2] 对外接口完整性');
const API = ['init', 'isEnhanced', 'isCapturing', 'kind', 'pickVideo',
  'updateModeUI', 'exit', 'onSegChunk', 'setPermGranted', 'setHookInstalled'];
for (const k of API) {
  check('enh.' + k, ADS && typeof ADS.enh[k] === 'function', typeof (ADS && ADS.enh[k]));
}

console.log('\n[3] 跨模块依赖都接上了');
const E = ADS.E;
for (const k of ['pushChunk', 'pump', 'bufferedHas', 'bufferedLead', 'bufferedEnd',
  'alignAudio', 'seekAudioTo', 'trimBuffer', 'currentMs', 'syncDelayToSw',
  'bypassCaptureDelay', 'pickRoute', 'captureEnabled', 'routeId', 'whyNoEnhanced']) {
  check('core.' + k, typeof E.core[k] === 'function', typeof E.core[k]);
}
check('life.fail 已填充', typeof E.life.fail === 'function', typeof E.life.fail);
check('life.ready 已填充', typeof E.life.ready === 'function', typeof E.life.ready);
check('life.exit 已填充', typeof E.life.exit === 'function', typeof E.life.exit);

console.log('\n[4] init() 把面板接起来');
const ui = fakeUi();
ADS.enh.init(ui);
check('ui.bind 收到 mode / stop',
  !!(ui.__seen.bind && typeof ui.__seen.bind.mode === 'function' && typeof ui.__seen.bind.stop === 'function'));
check('updateModeUI 画过按钮', ui.__seen.modeBtn > 0, ui.__seen.modeBtn);
check('tip / 标签都写过', ui.__seen.tip > 0 && ui.__seen.tag > 0);
check('页面无 video 时判为 none', ADS.enh.kind() === 'none', ADS.enh.kind());
check('DOM 上有 adsState', typeof env.document.documentElement.dataset.adsState === 'string');

console.log('\n[5] 重复注入不重建状态');
const S0 = E.S;
run(env, ORDER);
check('S 还是同一个对象', env.ADS.E.S === S0);
check('enh 还是同一个对象', typeof env.ADS.enh.init === 'function');
check('监听器没有被装第二份（inited 仍为 true）', env.ADS.E.S.inited === true);

console.log('\n[6] 依赖缺失时自己早退，不抛异常');
{
  const solo = makeEnv();
  let threw = null;
  try { run(solo, ['ads-enh-route.js', 'ads-enh-sync.js', 'ads-enhance.js']); }
  catch (e) { threw = e.message; }
  check('单独加载后三块不崩', threw === null, threw);
  check('route 没有硬建', !(solo.ADS && solo.ADS.E && solo.ADS.E.route));
  check('enh 没有硬建', !(solo.ADS && solo.ADS.enh));
}

console.log('\n[7] 两条链路的正负分工（延迟回归的守门断言）');
{
  /* 正值 = 声音延后，交给 DelayNode，音频只跟着画面；
     负值 = 声音提前，DelayNode 归零，音频往前挪。
     2026-10-22 之前两边都减 currentMs，正值会去要「更早的数据」，
     缓冲里没有，于是拖任何正值都卡在「等缓冲 · 还差 N 秒」。 */
  const core = env.ADS.E.core;
  const S = env.ADS.E.S;
  S.videoEl = { currentTime: 100 };
  check('负值 -3000 → 音频往前 3 秒（103）', core.wantAt(-3000) === 103, core.wantAt(-3000));
  check('正值 +2000 → 音频贴画面（100）', core.wantAt(2000) === 100, core.wantAt(2000));
  check('零 → 音频贴画面（100）', core.wantAt(0) === 100, core.wantAt(0));
  S.videoEl = null;
  check('没有 video 时返回 0', core.wantAt(-3000) === 0, core.wantAt(-3000));
}

console.log('\n[8] 链路② 主切片目录锁定（广告切片过滤）');
{
  /* 5:00 广告插播时，播放器会去拉另一条路径的 ts
     （实测 /video/adjump/time/1787…ts）。异目录切片绝不能进主 muxer，
     否则之后正片切片解不出音频，一直「音频重新加载中」。 */
  const core = env.ADS.E.core;
  const mainDir = core.segDir('https://cdn.example.com/video/show/abc123/index.m3u8');
  check('正片目录归一', mainDir === 'https://cdn.example.com/video/show/abc123/', mainDir);
  check('正片切片与播放列表同目录',
    core.segDir('https://cdn.example.com/video/show/abc123/0000291.ts') === mainDir);
  check('广告切片在另一个目录',
    core.segDir('https://cdn.example.com/video/adjump/time/17873200017900000000.ts') !== mainDir);
  check('带 query 的切片不影响目录',
    core.segDir('https://cdn.example.com/video/show/abc123/0000291.ts?token=x') === mainDir);
  check('坏地址返回空串，不抛异常', core.segDir('') === '');
}

console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exit(failures === 0 ? 0 : 1);
