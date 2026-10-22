'use strict';

/* ================================================================
 * 内容脚本入口
 *
 * 分工：
 *   ads-template.js  样式与结构模板（纯字符串）
 *   ads-ui.js        面板、提示、交互        → window.ADS.ui
 *   ads-detect.js    挑 video、判断播放方式  → window.ADS.detect
 *   ads-enh-core.js  状态、常量、缓冲工具    ┐
 *   ads-enh-panel.js 面板文案                │ 共用 window.ADS.E
 *   ads-enh-route.js 三条链路的实现          │ 按这个顺序注入，
 *   ads-enh-sync.js  同步循环                │ 后者解构前者
 *   ads-enhance.js   生命周期 + 对外接口     ┘ → window.ADS.enh
 *   本文件           消息路由、初始化、把两者接起来
 * ================================================================ */

(function () {
  const U = window.ADS && window.ADS.ui;
  const E = window.ADS && window.ADS.enh;

  /* 同一个文档可能被注入多次（点图标 → 停止 → 再点图标、出错后重注入）。
     每次注入都是全新的 IIFE，上一份的 runtime.onMessage 监听器不会自己消失，
     于是同一条消息被处理 N 次 —— 抓切片的 seg 会被重复 demux、MSE 片段
     被重复 append，声音就出现重影或整段 append 失败。
     这里先把上一份的监听器和定时器收掉。注意只收监听器：面板和增强实例
     已经由新实例接手，旧实例不能 destroy 它，否则会把新面板一起弄没。 */
  try {
    if (typeof window.__adsContentTeardown === 'function') window.__adsContentTeardown();
  } catch (e) {}

  if (!U || !E) return;

  /* 重复注入（停止后再点图标重新接管）：content.js 每次都是新 IIFE，必须
     完整重跑给当前面板接线 —— 只做早退的话面板会出现但没人绑事件，
     「启用双向」按钮永远藏着。ads-ui / ads-enhance 有各自的守卫，
     重复注入不会换成新实例（所以 E.init 自己也要防重）。
     清理残留面板时**只能删别的实例**：ads-ui 在模块加载时就把新面板挂上了，
     而本文件在它之后执行，按 id 直接删会把刚建好的新面板删掉（reveal 不会
     重新 append，面板从此永远不出现）。 */
  try {
    document.querySelectorAll('#audio-delay-sync-panel').forEach(function (el) {
      if (el !== U.host) el.remove();
    });
  } catch (e) {}

  let detached = false;

  /** 只摘自己挂上去的东西，不动面板和增强实例 */
  function detach() {
    if (detached) return;
    detached = true;
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (e) {}
    if (announceTimer) clearInterval(announceTimer);
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
  }

  window.__adsContentTeardown = detach;

  function teardown() {
    detach();
    try { if (E.isEnhanced()) E.exit(); } catch (e) {}
    try { U.destroy(); } catch (e) {}
  }

  /* ---------------- 面板归属：同一页面只留一个 ---------------- */

  /* 脚本注入到所有框架，每个 frame 各跑一份。接管时后台是整标签页广播
     panel-show 的，如果每份都无条件 reveal，跨域 iframe 影视站就会出现两个面板：
     播放器那个（有 video，功能完整）和父框架那个（没有 video，只会显示
     「此页不支持双向」）。所以得先判断这一层是不是该出面的那一层。 */

  const FRAME_VIDEO = '__adsFrameVideo';

  let childHasVideo = false;   /* 有子框架宣告过「我这层有 video」 */
  let fallbackTimer = null;    /* 顶层兜底显示的延时器 */
  let announced = false;       /* 本层是否已经把「我有 video」报给上层 */

  function hasVideo() {
    try { return !!E.pickVideo(); } catch (e) { return false; }
  }

  function isTop() {
    try { return window.top === window; } catch (e) { return false; }
  }

  /** 本层有 video 就报给父框架，让父框架别抢着画面板。
   *  只在有播放器的那层发，所以「谁会显示面板」和「谁会发信号」是同一批 frame。 */
  function announceVideo() {
    if (announced || isTop() || !hasVideo()) return;
    announced = true;
    try { window.parent.postMessage({ __ads: true, type: FRAME_VIDEO }, '*'); } catch (e) {}
  }

  /* 面板可能在 video 出现之前就被要求显示（播放器还没插入），所以持续观察一段时间 */
  const announceTimer = setInterval(function () {
    announceVideo();
    if (announced) clearInterval(announceTimer);
  }, 600);
  setTimeout(function () { clearInterval(announceTimer); }, 40000);

  window.addEventListener('message', function (ev) {
    const d = ev.data;
    if (!d || d.__ads !== true || d.type !== FRAME_VIDEO) return;

    childHasVideo = true;
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    try { document.documentElement.dataset.adsChildVideo = '1'; } catch (e) {}

    /* 顶层之前没等到信号、已经画了兜底面板：收掉，改由有播放器的那层显示 */
    if (!hasVideo()) { try { U.hide(); } catch (e) {} }

    /* 多层 iframe 时继续往上转发，最顶层也要知道下面有人认领了 */
    try { window.parent.postMessage(d, '*'); } catch (e) {}
  });

  /** 该不该由这一层显示面板。
   *  有 video → 该；没有 video 的子框架 → 不该；顶层 → 等一小会儿，
   *  确认没有子框架认领再兜底（否则父框架会先闪一下再消失）。 */
  function revealPanel() {
    if (hasVideo()) { U.reveal(); return; }
    if (!isTop()) return;
    if (childHasVideo) return;
    if (fallbackTimer) return;

    fallbackTimer = setTimeout(function () {
      fallbackTimer = null;
      if (childHasVideo || hasVideo()) return;
      U.reveal();
    }, 1200);
  }

  /* ---------------- 后台 / MAIN world 的消息 ---------------- */

  function onRuntimeMessage(msg) {
    if (!msg || msg.target !== 'content') return;

    if (msg.type === 'panel-show') {
      revealPanel();
      U.setValue(msg.delayMs || 0);
      if (typeof msg.rms === 'number') U.paintMeter(msg.rms);
      return;
    }

    if (msg.type === 'meter') {
      U.paintMeter(msg.rms);
      return;
    }

    /* 调试通道送来的原生 HLS 切片 */
    if (msg.type === 'seg') {
      E.onSegChunk(msg);
      return;
    }

    /* SW 侧挡掉了一条广告切片：页面这边维持静音豁免和提示 */
    if (msg.type === 'capad') {
      try { E.onCapAd(); } catch (e) {}
      return;
    }

    /* 抓取链路各节点的状态，写到 DOM 上方便排查 */
    if (msg.type === 'capdiag') {
      try {
        const prev = document.documentElement.dataset.adsDiag || '';
        document.documentElement.dataset.adsDiag = (prev + '|' + msg.text).slice(-300);
      } catch (e) {}
      return;
    }

    if (msg.type === 'panel-notice') {
      U.showToast(msg.text || '', msg.kind);
      return;
    }

    if (msg.type === 'panel-error') {
      U.showToast(msg.text || '接管失败，原因未知');
      return;
    }

    if (msg.type === 'stopped') {
      teardown();
    }
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  /* ---------------- 全屏：调试会话会被浏览器掐掉 ----------------
   * 实测（Edge 151）：标签页一进全屏，Chromium 就把扩展挂在它上面的 debugger
   * 会话 detach 了，之后 Network 事件一条都不来 —— 页面该请求的切片照常在请求，
   * 只是扩展看不见。表现就是「本来抓得好好的，一全屏就抓不到了」，十几秒后
   * 兜底降级成再拉一路。
   *
   * 这里只在真的处于抓切片链路时重连，而且进出全屏都做一遍：
   * MSE 里已经缓冲的音频不受影响，重连后新片接上就恢复。 */
  document.addEventListener('fullscreenchange', function () {
    let capturing = false;
    try { capturing = !!E.isCapturing(); } catch (e) {}
    if (!capturing) return;
    try {
      let baseDir = '';
      try { baseDir = window.ADS.E.core.S.cap.dir || ''; } catch (e) {}
      chrome.runtime.sendMessage({ target: 'sw', type: 'captureReattach', baseDir: baseDir })
        .catch(function () {});
    } catch (e) {}
  }, true);

  /* ---------------- 初始化 ---------------- */

  E.init(U);
  U.setValue(0);

  /* 面板有可能比 panel-show 消息更晚就绪，主动拉一次真实状态。
     如果那边其实已经没在接管，就不要再挂个空面板误导人。
     例外：被注册成增强脚本注入时（DOM 上有标记），面板要留着当双向模式的入口。 */
  chrome.runtime.sendMessage({ target: 'sw', type: 'getState' })
    .then(function (st) {
      if (st && st.active) {
        revealPanel();
        U.setValue(st.delayMs || 0);
        if (typeof st.rms === 'number') U.paintMeter(st.rms);
        return;
      }
      if (document.documentElement.dataset.adsHooked === '1') {
        E.setHookInstalled(true);
        /* 脚本现在注入到所有 iframe，同一个页面会有多个 frame 各跑一份。
           只有真的含有 video 的那个 frame 才该出面版——父框架通常只有播放器外壳，
           在那里显示面板会得到一句「此页不支持双向」，纯属误导。
           没 video 就先藏着，交给轮询等它出现。 */
        announceVideo();
        if (hasVideo()) U.reveal();
        return;
      }
      teardown();
    })
    .catch(function () {});

  /* 这个站点到底授权没有：决定按钮显示「双向需授权」还是「刷新页面生效」 */
  chrome.runtime.sendMessage({ target: 'sw', type: 'checkOrigin', origin: location.origin })
    .then(function (r) { E.setPermGranted(!!(r && r.granted)); })
    .catch(function () {});
})();
