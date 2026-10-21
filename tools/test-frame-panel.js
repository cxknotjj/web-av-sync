#!/usr/bin/env node
/**
 * 面板归属测试：同一个页面里有 iframe 时，只允许一个面板出现。
 *
 * 背景：content script 注入到所有框架，接管时后台是整标签页广播 panel-show。
 * 之前每个 frame 都无条件 reveal，跨域 iframe 影视站就会出现两个面板——
 * 播放器那个（有 video，功能完整）和父框架那个（没 video，只会说「此页不支持双向」）。
 *
 * 这里直接把 content.js 跑起来，用假的 window / document / chrome 喂消息，
 * 断言四种框架场景下面板该不该出现。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个 frame 环境跑 content.js，返回可操作的句柄 */
function makeFrame(opts) {
  const o = opts || {};
  const state = {
    visible: false,
    revealed: 0,
    hidden: 0,
    video: !!o.hasVideo,
    messages: [],
    onRuntimeMsg: null,
    domHandlers: {}
  };

  const win = {
    ADS: null,
    __adsWired: false,
    addEventListener: function (type, fn) {
      (state.domHandlers[type] = state.domHandlers[type] || []).push(fn);
    }
  };
  /* 顶层：window.top === window；子框架：指向另一个对象 */
  win.top = o.isTop === false ? { fake: 'parent' } : win;
  win.parent = o.isTop === false ? { postMessage: function (m) { state.messages.push(m); } } : win;

  const documentElement = { dataset: {} };
  const document = {
    documentElement: documentElement,
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {}
  };

  const ui = {
    reveal: function () { state.visible = true; state.revealed++; },
    hide: function () { state.visible = false; state.hidden++; },
    destroy: function () { state.visible = false; },
    setValue: function () {},
    paintMeter: function () {},
    showToast: function () {},
    host: { style: { display: 'none' } }
  };

  const enh = {
    init: function () {},
    pickVideo: function () { return state.video ? { fake: 'video' } : null; },
    isEnhanced: function () { return false; },
    exit: function () {},
    setHookInstalled: function () { state.hookInstalled = true; },
    setPermGranted: function () {},
    onSegChunk: function () {}
  };

  win.ADS = { ui: ui, enh: enh };

  const chrome = {
    runtime: {
      onMessage: { addListener: function (fn) { state.onRuntimeMsg = fn; } },
      sendMessage: function () { return Promise.resolve({ active: false, granted: false }); }
    }
  };

  const ctx = vm.createContext({
    window: win,
    document: document,
    chrome: chrome,
    location: { origin: 'https://example.com' },
    setInterval: setInterval,
    setTimeout: setTimeout,
    clearInterval: clearInterval,
    clearTimeout: clearTimeout,
    Promise: Promise,
    JSON: JSON,
    console: console
  });
  vm.runInContext(SRC, ctx);

  return {
    state: state,
    /** 后台广播 panel-show */
    showPanel: function () { if (state.onRuntimeMsg) state.onRuntimeMsg({ target: 'content', type: 'panel-show', delayMs: 0 }); },
    /** 模拟子框架喊「我这层有 video」 */
    childAnnounce: function () {
      const d = { __ads: true, type: '__adsFrameVideo' };
      (state.domHandlers.message || []).forEach(function (fn) { fn({ data: d }); });
    },
    /** 视频晚到 */
    addVideo: function () { state.video = true; },
    dataset: documentElement.dataset
  };
}

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + ' → ' + JSON.stringify(actual) +
    (ok ? '' : '（期望 ' + JSON.stringify(expected) + '）'));
}

(async () => {
  console.log('\n[1] 顶层有 video：直接出面板');
  {
    const f = makeFrame({ hasVideo: true, isTop: true });
    await sleep(100);
    f.showPanel();
    await sleep(50);
    check('立刻 reveal，不等兜底', f.state.revealed, 1);
  }

  console.log('\n[2] 子框架有 video：出面板，并向父框架报到');
  {
    const f = makeFrame({ hasVideo: true, isTop: false });
    await sleep(700);           /* 等 announce 定时器跑一轮 */
    f.showPanel();
    await sleep(50);
    check('reveal', f.state.revealed, 1);
    check('发了家长视频信号', f.state.messages.some((m) => m.type === '__adsFrameVideo'), true);
  }

  console.log('\n[3] 子框架没有 video：永不出面板');
  {
    const f = makeFrame({ hasVideo: false, isTop: false });
    f.showPanel();
    await sleep(1400);          /* 超过顶层兜底时长也不该出 */
    check('revealed 仍为 0', f.state.revealed, 0);
    check('没有向父框架发信号', f.state.messages.length, 0);
  }

  console.log('\n[4] 顶层没有 video、子框架先报到了：顶层不出面板');
  {
    const f = makeFrame({ hasVideo: false, isTop: true });
    f.childAnnounce();
    f.showPanel();
    await sleep(1400);
    check('revealed 仍为 0', f.state.revealed, 0);
    check('dataset.adsChildVideo', f.dataset.adsChildVideo, '1');
  }

  console.log('\n[5] 顶层没有 video、也没有子框架报到：1.2 秒后兜底出面版');
  {
    const f = makeFrame({ hasVideo: false, isTop: true });
    f.showPanel();
    await sleep(400);
    check('先不急着画', f.state.revealed, 0);
    await sleep(1000);
    check('兜底 reveal', f.state.revealed, 1);
  }

  console.log('\n[6] 兜底面板画出来之后才收到子框架信号：立刻收掉');
  {
    const f = makeFrame({ hasVideo: false, isTop: true });
    f.showPanel();
    await sleep(1350);
    check('兜底已显示', f.state.visible, true);
    f.childAnnounce();
    await sleep(50);
    check('被收掉', f.state.visible, false);
    check('hide 调用次数', f.state.hidden, 1);
  }

  console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
  process.exit(failures === 0 ? 0 : 1);
})();
