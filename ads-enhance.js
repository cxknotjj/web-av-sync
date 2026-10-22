'use strict';

/* ================================================================
 * 双向模式入口：生命周期、模式切换、对外接口
 *
 * 本文件最后加载，负责把前面几块串起来：
 *   enhReady / enhFail / exitEnhanced   一次接管的落定与收场
 *   onModeClick                         「启用双向」按钮
 *   onPageMessage                       MAIN world 截到音频轨时的通知
 *   window.ADS.enh                      对外接口，content.js 只认这个
 *
 * 拆分的边界就在这里：别的模块只做一件事，而「资源什么时候建、什么时候拆」
 * 全部由这一层决定。
 * ================================================================ */

(function () {
  window.ADS = window.ADS || {};
  const E = window.ADS.E;

  /* 前面几块必须都就位，缺一个就别硬跑 —— 半套模块只会让状态更难查 */
  if (!E || !E.core || !E.panel || !E.route || !E.sync) return;

  /* 重复注入时整份早退：S 里还留着正在跑的定时器和在用的 <audio>，
     重建一份只会得到两套互不相识的状态。 */
  if (window.ADS.enh) return;

  const S = E.S;
  const { pickVideo, pageKind } = window.ADS.detect;
  const {
    pushChunk, syncDelayToSw, currentMs, syncCapturePipe, resetCapturePipe,
    pageIsMSE, whyNoEnhanced
  } = E.core;
  const { updateModeUI } = E.panel;
  const { syncTick, onVideoSeek } = E.sync;
  const { enterEnhanced } = E.route;

  function enhFail(msg, then) {
    if (S.enhGuard) { clearTimeout(S.enhGuard); S.enhGuard = null; }

    /* 抓切片这一路失败时也要把调试会话拆掉。漏了这一步的话浏览器顶部
       那条「正在调试」会一直挂着，下次 attach 还会撞上
       "Another debugger is already attached" —— 之后只能刷新页面。 */
    if (S.enhMode === 'capture') {
      try {
        chrome.runtime.sendMessage({ target: 'sw', type: 'captureStop' }).catch(function () {});
      } catch (e) {}
    }

    if (S.enhAudio) {
      try { S.enhAudio.pause(); } catch (e) {}
      try { S.enhAudio.removeAttribute('src'); S.enhAudio.load(); } catch (e) {}
      try { S.enhAudio.remove(); } catch (e) {}
    }
    S.enhAudio = null;
    S.enhMS = null;
    S.enhBuf = null;
    S.appendQueue = [];
    S.capInitDone = false;
    S.capBytes = 0;
    S.seekAt = 0;
    S.trimBusy = false;
    /* 链路② 的三个状态也要归位：audioSilent 不清，下次进双向会被当成
       「正在静音」而跳过第一拍的出声；muxer 留着的话，新一路流的 PTS
       接着旧状态走，第一批切片就会转错。 */
    S.audioSilent = false;
    S.capSeekBytes = 0;
    S.muxer = null;
    S.enhMode = '';
    S.enhanced = false;

    if (S.videoEl) {
      if (S.guardMute) {
        try { S.videoEl.removeEventListener('volumechange', S.guardMute, true); } catch (e) {}
        S.guardMute = null;
      }
      if (S.seekHandler) {
        try { S.videoEl.removeEventListener('seeking', S.seekHandler, true); } catch (e) {}
        S.seekHandler = null;
      }
      try { S.videoEl.muted = false; } catch (e) {}
      /* 等缓冲时被拆掉（用户点了停止、或者链路降级），画面还停在暂停上，
         必须放开 —— 不然后台一拆，用户的视频就永远停住了 */
      if (S.stalledByUs) {
        S.stalledByUs = false;
        S.stallSince = 0;
        /* 这里别碰 enhAudio：上面已经把它置 null 销毁了（老代码在这里
           写 enhAudio.playbackRate = 1，永远只抛一个被吞掉的 TypeError）。 */
        try {
          const p = S.videoEl.play();
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      }
      S.videoEl = null;
    }

    if (S.syncTimer) { clearInterval(S.syncTimer); S.syncTimer = null; }
    if (S.ui) S.ui.setEnhanced(false);

    updateModeUI();
    if (msg && S.ui) S.ui.showToast(msg);
    resetCapturePipe();
    syncDelayToSw(true);
    if (typeof then === 'function') then();
  }

  function enhReady() {
    if (!S.videoEl || !S.enhAudio || S.enhanced) return;
    if (S.enhGuard) { clearTimeout(S.enhGuard); S.enhGuard = null; }

    /* 有些播放器会自己把静音改回去 —— 那样扩展和页面同时出声（双声）。
       接管期间守住 muted。守卫在我们自己的赋值触发的 volumechange 里
       只做 no-op（muted 已是 true），不会形成循环。
       注意：退出时必须先摘监听再把 muted 设回 false，顺序反了会被守卫按回去。 */
    S.guardMute = function () {
      try { if (S.videoEl && !S.videoEl.muted) S.videoEl.muted = true; } catch (e) {}
    };
    try { S.videoEl.addEventListener('volumechange', S.guardMute, true); } catch (e) {}

    try { S.videoEl.muted = true; } catch (e) {}
    S.enhanced = true;

    /* 拖进度条要在第一时间纠正音频位置、丢掉旧位置的队列。
       等 250ms 一拍的 tick 去发现，中间那几拍已经声画不同步了。 */
    S.seekHandler = onVideoSeek;
    try { S.videoEl.addEventListener('seeking', S.seekHandler, true); } catch (e) {}

    /* 两条链路按符号分工：负值把 DelayNode 归零、提前量交给 <audio>；
       正值反过来，由 DelayNode 承担延后，<audio> 贴着画面走。
       不分符号一律归零的话，拖任何正值都会卡在「等缓冲」。 */
    resetCapturePipe();
    syncCapturePipe(currentMs());

    if (S.ui) {
      S.ui.setEnhanced(true);
      S.ui.setValue(currentMs());
    }
    updateModeUI();

    if (S.syncTimer) clearInterval(S.syncTimer);
    S.syncTimer = setInterval(syncTick, 250);
    syncTick();
  }

  function exitEnhanced() {
    if (S.enhGuard) { clearTimeout(S.enhGuard); S.enhGuard = null; }

    /* 调试通道用完立刻拆掉，黄条不该留在页面上 */
    if (S.enhMode === 'capture') {
      chrome.runtime.sendMessage({ target: 'sw', type: 'captureStop' }).catch(function () {});
    }

    S.enhMode = '';
    S.routeWhy = '';

    if (S.enhAudio) {
      try { S.enhAudio.pause(); } catch (e) {}
      try { S.enhAudio.removeAttribute('src'); S.enhAudio.load(); } catch (e) {}
      try { S.enhAudio.remove(); } catch (e) {}
    }
    S.enhAudio = null;
    S.enhMS = null;
    S.enhBuf = null;
    S.appendQueue = [];
    S.capInitDone = false;
    S.capBytes = 0;
    S.seekAt = 0;
    S.trimBusy = false;
    /* 链路② 的三个状态也要归位：audioSilent 不清，下次进双向会被当成
       「正在静音」而跳过第一拍的出声；muxer 留着的话，新一路流的 PTS
       接着旧状态走，第一批切片就会转错。 */
    S.audioSilent = false;
    S.capSeekBytes = 0;
    S.muxer = null;

    if (S.syncTimer) { clearInterval(S.syncTimer); S.syncTimer = null; }

    if (S.videoEl) {
      if (S.guardMute) {
        try { S.videoEl.removeEventListener('volumechange', S.guardMute, true); } catch (e) {}
        S.guardMute = null;
      }
      if (S.seekHandler) {
        try { S.videoEl.removeEventListener('seeking', S.seekHandler, true); } catch (e) {}
        S.seekHandler = null;
      }
      try { S.videoEl.muted = false; } catch (e) {}
      /* 等缓冲时被拆掉（用户点了停止、或者链路降级），画面还停在暂停上，
         必须放开 —— 不然后台一拆，用户的视频就永远停住了 */
      if (S.stalledByUs) {
        S.stalledByUs = false;
        S.stallSince = 0;
        /* 这里别碰 enhAudio：上面已经把它置 null 销毁了（老代码在这里
           写 enhAudio.playbackRate = 1，永远只抛一个被吞掉的 TypeError）。 */
        try {
          const p = S.videoEl.play();
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      }
      S.videoEl = null;
    }

    S.enhanced = false;
    if (S.ui) {
      /* setEnhanced(false) 会把负值钳回 0（minMs 归零），钳完要同步给
         tabCapture 那条链路，否则面板写着 0.000、听起来还是旧延迟 */
      S.ui.setEnhanced(false);
    }
    updateModeUI();
    resetCapturePipe();
    syncDelayToSw(true);
  }

  async function onModeClick() {
    if (S.enhanced) { exitEnhanced(); return; }
    if (S.hookReady) { enterEnhanced(); return; }

    /* 直连媒体：不用截获、不用授权，直接拉一路 */
    const k = pageKind();
    if (k === 'hls' || k === 'direct') { enterEnhanced(); return; }

    if (!S.ui) return;

    /* DASH 清单：别走到下面的授权流程 —— 授权 + 刷新之后再点还是不支持 */
    if (k === 'dash') {
      S.ui.showToast('DASH（.mpd）暂不支持双向模式，延迟模式仍然可用。');
      return;
    }

    if (S.hookInstalled) {
      S.ui.showToast(pageIsMSE()
        ? '还没截到音频轨，先让视频播放几秒再点。'
        : whyNoEnhanced());
      return;
    }

    /* 已经授权过，只是当前页面没赶上注册：走只注册通道，不要再要一次权限。
       permissions.request 即使权限已存在也要求手势，没必要为它多绕一圈。 */
    if (S.permGranted) {
      try {
        const res = await chrome.runtime.sendMessage({
          target: 'sw',
          type: 'registerOnly',
          origin: location.origin
        });
        S.ui.showToast((res && res.ok) ? '已重新注册，正在刷新页面…' : ((res && res.error) || '注册失败'),
          (res && res.ok) ? 'ok' : undefined);
      } catch (e) {
        S.ui.showToast('注册请求失败：' + ((e && e.message) || e));
      }
      return;
    }

    /* 还没 hook：先问 background 要站点权限，授权后刷新页面才生效 */
    try {
      const res = await chrome.runtime.sendMessage({
        target: 'sw',
        type: 'requestEnhance',
        origin: location.origin
      });
      if (res && res.ok) S.ui.showToast('已授权，正在刷新页面…', 'ok');
      else S.ui.showToast((res && res.error) || '授权失败');
    } catch (e) {
      S.ui.showToast('授权请求失败：' + ((e && e.message) || e));
    }
  }

  function onPageMessage(e) {
    const m = e.data;
    if (!m || m.__ads !== true) return;

    if (m.type === 'ready') {
      S.hookInstalled = true;
      updateModeUI();
      return;
    }
    if (m.type === 'track') {
      if (m.mime) S.audioMime = m.mime;
      S.hookInstalled = true;
      S.hookReady = true;
      updateModeUI();
      return;
    }
    if (m.type === 'state') {
      S.hookInstalled = true;
      if (m.mime) { S.audioMime = m.mime; S.hookReady = true; }
      updateModeUI();
      return;
    }
    if (m.type === 'chunk') {
      pushChunk(m.data);
    }
  }

  /* ---------------- 对外接口 ---------------- */

  window.ADS.enh = {
    init: function (uiRef) {
      S.ui = uiRef;

      /* 这个模块只在页面里跑一份（上面有 window.ADS.enh 的守卫），但 content.js
         会在「停止 → 再接管」时被重新注入并再调一次 init。监听器只能加一次，
         否则每片音频、每条状态消息都会被处理两遍 —— 表现为片段重复 append。 */
      if (!S.inited) {
        S.inited = true;
        window.addEventListener('message', onPageMessage);
      }

      S.ui.bind({
        mode: onModeClick,
        stop: function () {
          if (S.enhanced) exitEnhanced();
          chrome.runtime.sendMessage({ target: 'sw', type: 'stop' }).catch(function () {});
        }
      });

      updateModeUI();

      /* MAIN world 可能已经先跑完了，问一次它当前截到了什么 */
      try { window.postMessage({ __ads: true, type: 'query' }, '*'); } catch (e) {}
    },

    isEnhanced: function () { return S.enhanced; },
    /* 「这条链路是抓切片，且还没放弃」—— 全屏后要重连调试会话，只看 enhanced 不够：
       连接中（enhMode=capture 但音频还没到手）时掉线同样要接回来 */
    isCapturing: function () { return S.enhMode === 'capture'; },
    kind: pageKind,
    pickVideo: pickVideo,
    updateModeUI: updateModeUI,
    exit: exitEnhanced,
    onSegChunk: E.route.onSegChunk,

    setPermGranted: function (v) { S.permGranted = !!v; updateModeUI(); },
    setHookInstalled: function (v) { S.hookInstalled = !!v; updateModeUI(); }
  };

  /* 填满 core 里那个空壳：route 和 sync 通过 L.fail / L.ready / L.exit
     调到这里，绕开「入口最后加载」的循环依赖。 */
  E.life.fail = enhFail;
  E.life.ready = enhReady;
  E.life.exit = exitEnhanced;
})();
