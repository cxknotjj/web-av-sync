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

function makeEnv(opts) {
  opts = opts || {};
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
    setTimeout: opts.setTimeout || setTimeout,
    clearTimeout: opts.clearTimeout || clearTimeout,
    setInterval: opts.setInterval || setInterval,
    clearInterval: opts.clearInterval || clearInterval,
    Date: opts.Date || Date,
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

/* 四个兄弟模块从 E.core 解构出来的全部函数。漏导出一个不会报错，
   直到对应的调用点被触发（2026-10-22 resetVideoClock 漏导出，
   拖进度条时抛 TypeError），所以这里必须逐个核对。 */
console.log('\n[3] 跨模块依赖都接上了');
const E = ADS.E;
for (const k of ['pushChunk', 'pump', 'bufferedHas', 'bufferedLead', 'bufferedEnd',
  'alignAudio', 'seekAudioTo', 'trySetAudioPos', 'trimBuffer', 'currentMs',
  'wantAt', 'wantTime', 'syncCapturePipe', 'forcePipe', 'resetCapturePipe',
  'syncDelayToSw', 'bypassCaptureDelay', 'samplePtsOffset', 'silenceBudget',
  'pickRoute', 'captureEnabled', 'routeId', 'whyNoEnhanced', 'pageIsMSE',
  'segDir', 'resetStream', 'resetTimebase', 'resetSamples', 'resetVideoClock',
  'decideSilence', 'decideAim']) {
  check('core.' + k, typeof E.core[k] === 'function', typeof E.core[k]);
}
/* 其他三块对外暴露的入口也必须都在 —— 漏一个同样是「调用时才炸」 */
for (const k of ['paintRoute', 'paintRouteMeta', 'publishState', 'updateModeUI']) {
  check('panel.' + k, typeof E.panel[k] === 'function', typeof E.panel[k]);
}
for (const k of ['enterEnhanced', 'onSegChunk', 'startViaSrc']) {
  check('route.' + k, typeof E.route[k] === 'function', typeof E.route[k]);
}
for (const k of ['syncTick', 'onVideoSeek']) {
  check('sync.' + k, typeof E.sync[k] === 'function', typeof E.sync[k]);
}
for (const k of ['pickVideo', 'pageKind']) {
  check('detect.' + k, typeof ADS.detect[k] === 'function', typeof ADS.detect[k]);
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

console.log('\n[9] 链路② 流身份 / 广告状态对象');
{
  const cap = env.ADS.E.S.cap;
  cap.reset();
  cap.lock('https://cdn.example.com/video/show/abc/index.m3u8');
  check('lock 记下主目录', cap.dir === 'https://cdn.example.com/video/show/abc/', cap.dir);
  check('正片切片 → main',
    cap.classify('https://cdn.example.com/video/show/abc/0000001.ts') === 'main');
  check('广告切片 → ad',
    cap.classify('https://cdn.example.com/video/adjump/time/1787.ts') === 'ad');
  check('进入广告时段', cap.isAd() === true);
  check('正片回来 → back',
    cap.classify('https://cdn.example.com/video/show/abc/0000002.ts') === 'back');
  check('广告状态结束', cap.isAd() === false);
  check('最后一次广告切片时间不被 back 清掉', cap.lastForeignAt > 0);
  cap.noteAudio();
  check('数据在来 → isFeeding', cap.isFeeding() === true);
  cap.reset();
  check('reset 清空流身份',
    cap.dir === '' && cap.src === '' && !cap.isAd() && !cap.isFeeding()
    && cap.lastForeignAt === 0);
}

console.log('\n[10] 链路② 静音/位置决策（纯函数）');
{
  const core = env.ADS.E.core;
  const ds = core.decideSilence;
  check('广告期间静音再久也不降级',
    ds({ adGrace: true, feeding: false, silentMs: 99999, silentLimit: 8000 }) === 'wait');
  check('数据在来不降档',
    ds({ adGrace: false, feeding: true, silentMs: 99999, silentLimit: 8000 }) === 'wait');
  check('静音 1s → 继续等',
    ds({ silentMs: 1000, silentLimit: 8000 }) === 'wait');
  check('静音 2.5s → 自动降档',
    ds({ silentMs: 2500, silentLimit: 8000 }) === 'downgrade');
  check('静音 9s → 降级链路③',
    ds({ silentMs: 9000, silentLimit: 8000 }) === 'degrade');

  const da = core.decideAim;
  check('位置已对上 → 不动', da({ needSeek: false }) === 'none');
  check('落后且目标太远 → 不硬跳',
    da({ needSeek: true, ahead: true, lead: -10, catchUp: false }) === 'none');
  check('落后且目标在 5s 内 → 跳',
    da({ needSeek: true, ahead: true, lead: -2, catchUp: false }) === 'jump');
  check('广告追赶窗口 → 允许跳',
    da({ needSeek: true, ahead: true, lead: -100, catchUp: true }) === 'jump');
  check('领先且缓冲在目标之前 → 退到缓冲起点',
    da({ needSeek: true, ahead: false, hasBuffered: true, currentLead: -2 }) === 'rewind');
  check('领先但没有缓冲 → 不动',
    da({ needSeek: true, ahead: false, hasBuffered: false, currentLead: -2 }) === 'none');
}

console.log('\n[11] 重置责任划分（广告后重采样窗口）');
{
  const S = env.ADS.E.S;
  const core = env.ADS.E.core;
  S.ptsOffset = 24;
  S.adResampleUntil = Date.now() + 5000;
  core.resetSamples();
  check('resetSamples 只清基线，不动重采样窗口', S.adResampleUntil > 0);
  core.resetTimebase();
  check('resetTimebase 清掉重采样窗口', S.adResampleUntil === 0);
  check('resetTimebase 顺带清掉偏移', S.ptsOffset === 0);
}

console.log('\n[12] 链路① 原始片段缓存（内存回归）');
{
  const S = env.ADS.E.S;
  const core = env.ADS.E.core;
  const AB = (n) => vm.runInContext('new ArrayBuffer(' + n + ')', env);
  const MB = 1024 * 1024;

  /* 双向播放中：片段只进播放队列，不再留第二份副本 */
  S.enhanced = true; S.enhMode = 'mse';
  S.chunks = []; S.chunkBytes = 0; S.appendQueue = [];
  core.pushChunk(AB(1024));
  check('双向中不囤原始副本', S.chunks.length === 0 && S.chunkBytes === 0);
  check('双向中直接进播放队列', S.appendQueue.length === 1);

  /* 未启用：种子缓存有上限，且 init 片不能被淘汰 */
  S.enhanced = false; S.enhMode = '';
  S.chunks = []; S.chunkBytes = 0; S.appendQueue = [];
  core.pushChunk(AB(1234));
  for (let i = 0; i < 10; i++) core.pushChunk(AB(MB));
  check('种子缓存不超过上限',
    S.chunkBytes <= env.ADS.E.C.SEED_CHUNK_BYTES + MB, S.chunkBytes);
  check('第一片 init 不被淘汰', S.chunks[0].byteLength === 1234);
  S.chunks = []; S.chunkBytes = 0; S.appendQueue = [];
}

console.log('\n[13] 注入清单：mux.js 按需加载，content.js 最后');
{
  const src = fs.readFileSync(path.join(ROOT, 'bg-auth.js'), 'utf8');
  const box = {
    console,
    setTimeout, clearTimeout,
    chrome: {
      permissions: { onRemoved: null },
      storage: { session: { get: async () => ({}) }, local: { get: async () => ({}) } },
      scripting: {}, tabs: {}, action: {}
    }
  };
  vm.createContext(box);
  vm.runInContext(src, box, { filename: 'bg-auth.js' });
  const files = box.contentScriptFiles();
  check('build-info.js 排第一', files[0] === 'build-info.js');
  check('content.js 排最后', files[files.length - 1] === 'content.js');
  check('mux.min.js 不预注入（链路② 按需拉）', files.indexOf('mux.min.js') === -1);
  check('双向五块齐全', ['ads-enh-core.js', 'ads-enh-panel.js', 'ads-enh-route.js',
    'ads-enh-sync.js', 'ads-enhance.js'].every(function (f) { return files.indexOf(f) >= 0; }));
}

console.log('\n[14] 退出时恢复接管前的静音状态');
{
  const S = env.ADS.E.S;
  const mkVideo = function (muted) {
    return {
      muted: muted, paused: false, currentTime: 0,
      play: function () { return Promise.resolve(); },
      addEventListener: function () {}, removeEventListener: function () {}
    };
  };

  /* 用户本来就静音：退出后不能突然外放 */
  let v = mkVideo(true);
  S.videoEl = v; S.mutedByUs = true; S.prevMuted = true;
  env.ADS.enh.exit();
  check('接管前静音 → 退出后仍静音', v.muted === true, v.muted);

  /* 接管前有声：退出后恢复有声 */
  v = mkVideo(false);
  S.videoEl = v; S.mutedByUs = true; S.prevMuted = false;
  env.ADS.enh.exit();
  check('接管前有声 → 退出后取消静音', v.muted === false, v.muted);

  /* 还没走到静音那一步就失败：不要碰用户的静音开关 */
  v = mkVideo(true);
  S.videoEl = v; S.mutedByUs = false; S.prevMuted = false;
  env.ADS.enh.exit();
  check('没接管过静音 → 保持用户原状', v.muted === true, v.muted);
}

console.log('\n[15] content.js 重复注入：监听器能被摘干净');
{
  const winAdd = [], winRemove = [], docAdd = [], docRemove = [];
  const sandbox = {
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    location: { origin: 'https://example.com' },
    document: {
      documentElement: { dataset: {} },
      querySelectorAll: () => [],
      addEventListener: (t) => docAdd.push(t),
      removeEventListener: (t) => docRemove.push(t)
    },
    chrome: {
      runtime: {
        onMessage: { addListener: () => {}, removeListener: () => {} },
        sendMessage: () => Promise.resolve({ active: false, granted: false })
      }
    },
    ADS: {
      ui: {
        host: { style: { display: 'none' } },
        setValue() {}, reveal() {}, hide() {}, destroy() {}, showToast() {}
      },
      enh: {
        init() {}, pickVideo: () => null, isEnhanced: () => false, exit() {},
        isCapturing: () => false, setHookInstalled() {}
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.postMessage = () => {};
  sandbox.addEventListener = (t) => winAdd.push(t);
  sandbox.removeEventListener = (t) => winRemove.push(t);

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'), sandbox, { filename: 'content.js' });

  check('window 上装了 message 监听', winAdd.indexOf('message') >= 0, winAdd.join(','));
  check('document 上装了 fullscreenchange 监听', docAdd.indexOf('fullscreenchange') >= 0, docAdd.join(','));

  sandbox.__adsContentTeardown();
  check('detach 摘掉 message', winRemove.indexOf('message') >= 0, winRemove.join(','));
  check('detach 摘掉 fullscreenchange', docRemove.indexOf('fullscreenchange') >= 0, docRemove.join(','));
}

console.log('\n[16] 空框架的轮询会自己停（退避 + 期限）');
{
  const timers = [];
  let now = 0;
  const fakeSetTimeout = function (fn, ms) {
    const id = timers.length + 1;
    timers.push({ fn: fn, at: now + (ms || 0), done: false, cleared: false });
    return id;
  };
  const fakeClearTimeout = function (id) {
    if (timers[id - 1]) timers[id - 1].cleared = true;
  };
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      let due = null;
      for (const t of timers) {
        if (!t.done && !t.cleared && t.at <= target && (!due || t.at < due.at)) due = t;
      }
      if (!due) break;
      now = due.at;
      due.done = true;
      due.fn();
    }
    now = target;
  }
  const FakeDate = function (v) { return v == null ? new Date(now) : new Date(v); };
  FakeDate.now = function () { return now; };

  const env2 = makeEnv({ setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, Date: FakeDate });
  run(env2, ORDER);
  const ui2 = fakeUi();
  env2.ADS.enh.init(ui2);
  env2.ADS.enh.setHookInstalled(true);
  check('没有 video 的框架开始轮询', env2.ADS.E.S.modeTimer !== null);

  advance(35000);
  check('30 秒等不到 video → 自己停', env2.ADS.E.S.modeTimer === null);
  check('退避生效（回调次数远小于 400ms 固定间隔）', timers.length < 30, timers.length);
}

console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exit(failures === 0 ? 0 : 1);
