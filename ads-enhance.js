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
    forcePipe, alignAudio, wantTime, pageIsMSE, whyNoEnhanced, resetStream
  } = E.core;
  const { updateModeUI, publishState } = E.panel;
  const { syncTick, onVideoSeek } = E.sync;
  const { enterEnhanced } = E.route;

  /** 一次接管的统一收场：销毁音频元素、摘监听、复位状态、把延迟还给 DelayNode。
   *
   *  以前 enhFail 和 exitEnhanced 各写一遍，约 60 行几乎逐行相同 —— 而且已经
   *  分叉过：老代码在 enhFail 里对已经置 null 的 enhAudio 写 playbackRate，
   *  每次都抛一个被吞掉的 TypeError。合成一处之后，这种「只改了一份」的
   *  事故不会再发生。
   *
   *  @param {boolean} keepWhy 保留 routeWhy（失败降级要把原因留在面板上），
   *                           正常退出则清空
   */
  function teardown(keepWhy) {
    if (S.enhGuard) { clearTimeout(S.enhGuard); S.enhGuard = null; }

    /* 抓切片这一路失败时也要把调试会话拆掉。漏了这一步的话浏览器顶部
       那条「正在调试」会一直挂着，下次 attach 还会撞上
       "Another debugger is already attached" —— 之后只能刷新页面。 */
    if (S.enhMode === 'capture') {
      try {
        chrome.runtime.sendMessage({ target: 'sw', type: 'captureStop' }).catch(function () {});
      } catch (e) {}
    }

    if (!keepWhy) S.routeWhy = '';

    /* 先停表：清理过程中 syncTick 再跑一拍，会拿到半拆状态 */
    if (S.syncTimer) { clearInterval(S.syncTimer); S.syncTimer = null; }
    /* 顺序有讲究：先与 enhanced / enhMode 脱钩，后面的清理才不会被当成「正在接管」 */
    S.enhMode = '';
    S.enhanced = false;

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
    S.silentSince = 0;
    S.capSeekBytes = 0;
    S.muxer = null;
    S.lastPosJump = 0;
    resetStream();

    if (S.videoEl) {
      if (S.guardMute) {
        try { S.videoEl.removeEventListener('volumechange', S.guardMute, true); } catch (e) {}
        S.guardMute = null;
      }
      if (S.seekHandler) {
        try { S.videoEl.removeEventListener('seeking', S.seekHandler, true); } catch (e) {}
        S.seekHandler = null;
      }
      /* 只恢复「我们改过的那一份」：用户本来静音、或中途自己点了静音，
         退出后不该被突然外放。必须在摘掉守卫之后恢复，顺序反了会被按回去。 */
      if (S.mutedByUs) {
        try { S.videoEl.muted = S.prevMuted; } catch (e) {}
        S.mutedByUs = false;
      }
      /* 等缓冲时被拆掉（用户点了停止、或者链路降级），画面还停在暂停上，
         必须放开 —— 不然后台一拆，用户的视频就永远停住了 */
      if (S.stalledByUs) {
        S.stalledByUs = false;
        S.stallSince = 0;
        /* 这里别碰 enhAudio：上面已经把它置 null 销毁了 */
        try {
          const p = S.videoEl.play();
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      }
      S.videoEl = null;
    }

    if (S.ui) {
      /* setEnhanced(false) 会把负值钳回 0（minMs 归零），钳完要同步给
         tabCapture 那条链路，否则面板写着 0.000、听起来还是旧延迟 */
      S.ui.setEnhanced(false);
    }
    updateModeUI();
    resetCapturePipe();
    syncDelayToSw(true);
  }

  function enhFail(msg, then) {
    /* 失败往往带着降级原因（route.fallback 会先写 routeWhy），别清掉 */
    teardown(true);
    if (msg && S.ui) S.ui.showToast(msg);
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

    /* 记住接管前的静音状态：退出时只恢复这一份。
       不记的话，用户本来就静音、或者中途自己点了静音，退出瞬间会突然外放。 */
    S.prevMuted = !!S.videoEl.muted;
    S.mutedByUs = false;
    try { S.videoEl.muted = true; S.mutedByUs = true; } catch (e) {}
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

  /** 用户主动退出（点「停止」或再点一次按钮）：原因不留，其余与失败同路 */
  function exitEnhanced() {
    teardown(false);
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
        /* 用户动了滑块就立刻分配一次，不等 syncTick 那 250ms 一拍。
           点「归零」时面板已经写成 0.000，而声音要等到下一拍才变 ——
           这一下是听得出来的，尤其是刚从 2 秒拖回来的时候。
           归零走 forcePipe：正常路径有 20ms 阈值挡重复，但只要中途丢过
           一次消息，pipeMs 就和 DelayNode 的真实值对不上了，
           而阈值恰恰会让纠正的那一次也被挡掉。 */
        value: function (ms) {
          if (!S.enhanced) return;
          if (ms === 0) forcePipe(0);
          else syncCapturePipe(ms);
          /* 数值一变，目标位置也跟着变：负值（声音提前）时 want 在视频前面
             |ms| 秒，拖回 0 就得把音频往后退。只把 DelayNode 归零是不够的 ——
             那条 <audio> 还停在提前的位置上，用户听到的就是「点了归零，
             声音还慢一截」。这里立刻对一次，不等下一拍。 */
          if (S.enhAudio) {
            try { alignAudio(wantTime()); } catch (e) {}
          }
          publishState();
        },
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
    /* SW 在调试通道里看到广告切片（异源目录）时通知过来。
       切片本身不会送到页面，但页面需要知道「现在在广告时段」：
       静音豁免、面板提示、恢复提示都靠这个状态。 */
    onCapAd: function () {
      if (S.enhMode !== 'capture') return;
      S.cap.noteForeign();
    },

    setPermGranted: function (v) { S.permGranted = !!v; updateModeUI(); },
    setHookInstalled: function (v) { S.hookInstalled = !!v; updateModeUI(); }
  };

  /* 填满 core 里那个空壳：route 和 sync 通过 L.fail / L.ready / L.exit
     调到这里，绕开「入口最后加载」的循环依赖。 */
  E.life.fail = enhFail;
  E.life.ready = enhReady;
  E.life.exit = exitEnhanced;
})();
