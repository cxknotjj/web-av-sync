'use strict';

/* ================================================================
 * 双向模式的底座：共享状态、常量、缓冲工具、链路选择
 *
 * 拆分前这些全在一个 1200 行的闭包里，状态靠闭包变量共享。拆成多文件后
 * 闭包没了，于是收进一个显式的 S 对象 —— 每个模块拿到的都是同一个引用，
 * 读写的是同一份，和原来的闭包变量等价。
 *
 *   S            运行时状态，字段名与拆分前一一对应
 *   C            调参常量
 *   E.core.xxx   缓冲几何、音频对齐、片段队列、链路选择，全是纯函数
 *
 * 这一层不依赖任何其他模块，route / sync / panel 都可以放心依赖它。
 * ================================================================ */

(function () {
  window.ADS = window.ADS || {};
  const E = window.ADS.E = window.ADS.E || {};

  /* 重复注入（停止后再点图标）会把这些文件再跑一遍。以前整个大 IIFE 顶部
     一个守卫就够了，拆开之后每份都得自己挡：重建 S 会丢掉正在跑的
     syncTimer 引用，旧定时器停不掉、新定时器又起一个，表现是两路音频同时出声。 */
  if (E.core) return;

  const { pageKind } = window.ADS.detect;

  /* 三条链路的展示元数据。面板上那一行「走哪一路」全靠这张表：
     meta 是代价，hint 是悬停解释。想加链路就在这儿加一条，
     判断逻辑在 pickRoute()。 */
  const ROUTES = {
    mse: {
      id: '①',
      name: '复用页面切片',
      meta: '零流量',
      hint: '播放器用 MSE 播放，音频片段已经在 appendBuffer 里被截下来了，直接复用，不额外下载'
    },
    capture: {
      id: '②',
      name: '抓取已下载切片',
      meta: '零流量',
      hint: '原生 HLS：靠调试协议取回播放器已经下过的 ts 切片，不额外下载。' +
        '代价是浏览器顶部会显示「正在调试此浏览器」，且用户自己开着 DevTools 时会失败'
    },
    src: {
      id: '③',
      name: '重新拉一路',
      meta: '约双倍流量',
      hint: '同一条流再解码一遍只取声音。不需要授权、不需要刷新，但下载量大约翻倍'
    }
  };

  const ROUTE_ORDER = ['mse', 'capture', 'src'];
  const ROUTE_IDS = ['①', '②', '③'];

  /* ---------------- 状态 ---------------- */

  const S = E.S = {
    ui: null,                 /* 面板句柄，init() 时由 content.js 注入 */
    inited: false,            /* window 消息监听器只装一次，见 init() */

    enhanced: false,
    /* hookInstalled：MAIN world 的脚本装上了
       hookReady：真的截到了 audio 轨（收到 track 消息）。
       两者必须分开 —— 原生 HLS 页面 hook 装得上，但永远截不到东西。 */
    hookInstalled: false,
    hookReady: false,
    /* 站点是否已授权。和「脚本有没有注入」是两件事：
       授权了但页面在注册完成前就加载，脚本仍然进不来。 */
    permGranted: false,

    audioMime: '',
    chunks: [],
    chunkBytes: 0,

    enhMS: null,
    enhAudio: null,
    enhBuf: null,
    appendQueue: [],
    syncTimer: null,
    videoEl: null,

    /* 当前走的哪条链路，决定退出时要做哪些清理 */
    enhMode: '',
    /* 为什么落到这条链路。用户看到 ③ 却不知道为什么没用更省的那条时，
       这个字符串就是答案，会拼进指示条的悬停提示。 */
    routeWhy: '',
    enhGuard: null,           /* 试运行超时计时器，非 null 表示还在「未落定」阶段 */
    capInitDone: false,       /* 调试通道下，init segment 只需 append 一次 */
    capBytes: 0,              /* 已经解出多少音频字节，用来判断「真有数据了」 */
    guardMute: null,          /* 接管期间守住「原视频静音」的监听器 */

    /* 等缓冲：要提前的量超过已下载的量时，音频会 underflow（画面在走、没声音）。
       这时由我们主动按住视频，等音频追上来再放开。stalledByUs 必须记住
       「这次暂停是自己按的」，否则下一拍会被当成用户暂停，永远放不开。 */
    stalledByUs: false,
    stallSince: 0,
    stallTail: 0,             /* 进等待时的缓冲末尾，用来判断「还在不在下载」 */
    stallTailAt: 0,           /* 缓冲最后一次增长的时刻 */
    stallLead: -999,          /* 进等待时「目标位置离可播数据还差多少」 */
    lastStallToast: 0,        /* 上次「等缓冲」toast 的时间，做冷却用 */

    /* 用户拖进度条。视频的 currentTime 会瞬间跳到新位置，而我们这条音频还停在
       旧位置、MSE 里还攒着旧位置的片段、appendQueue 里还排着旧位置的队列。
       不在这里一次性纠正的话会有两个后果：
         1. 画面在新位置走，声音还在旧位置 —— 完全对不上；
         2. 队列里的旧片段继续灌进 MSE，把用户刚跳过的整段都缓冲下来。
       seekAt 记下时刻，用来把「seek 之前发出的切片请求」挡在门外 ——
       那些字节属于已经跳过的那一段。 */
    seekAt: 0,
    seekHandler: null,
    trimBusy: false,
    /* 已经因为等不到而自动降档几次。降过一次还不够的，第二次直接归零 ——
       否则会「降一点、再卡四秒、再降一点」，比一直卡着还难受。 */
    stallGiveUps: 0,

    appendFails: 0,           /* 连续 append 失败计数 */
    appendFailToasted: false, /* 「连续对不上」的提示只弹一次，别刷屏 */

    muxer: null,              /* Transmuxer 单例，见 ads-enh-route.js */
    muxOut: null,             /* 本次 push/flush 的输出，事件回调往里写 */

    /* 上一次写给 DelayNode 的延迟值，null = 本轮还没分配过。
       见 syncCapturePipe()：负值归零、正值由 DelayNode 承担，靠它避免
       每拍重复发消息。 */
    pipeMs: null,

    modeTimer: null           /* 地址从空变成有，需要轮询一段时间 */
  };

  /* ---------------- 常量 ---------------- */

  const C = E.C = {
    MAX_CHUNK_BYTES: 48 * 1024 * 1024,

    KEEP_BEHIND: 3,           /* 播放位置之前留几秒缓冲（够回退一点就行） */
    WAIT_GAP: 0.4,            /* 目标位置落后缓冲区末尾超过这么多才值得暂停 */
    RESUME_LEAD: 1.5,         /* 缓冲领先目标位置这么多才放开 —— 要比 WAIT_GAP 大得多，
                                 否则一放开走两步又得按住，声音就是一顿一顿的 */
    DRIFT_SEEK: 0.35,         /* 音频位置偏差超过这个才 seek，小偏差用倍速慢慢追 */
    WAIT_STUCK_MS: 4000,      /* 缓冲连续这么久一点没长 = 真下不来了，别等了 */
    WAIT_MAX_MS: 15000        /* 总等待上限。目标位置迟迟没有数据时，等 15 秒
                                 还没到就认了 —— 再久用户只会觉得播放器坏了 */
  };

  function pageIsMSE() {
    return pageKind() === 'mse';
  }

  function captureEnabled() {
    const b = globalThis.ADS_BUILD;
    return !(b && b.capture === false);
  }

  function routeId(key) {
    const list = ROUTE_ORDER.filter(function (k) { return k !== 'capture' || captureEnabled(); });
    const i = list.indexOf(key);
    return i < 0 ? '' : ROUTE_IDS[i];
  }

  function pickRoute(kind) {
    if (S.hookReady && S.chunks.length) return 'mse';
    if (captureEnabled() && kind === 'hls' && typeof muxjs !== 'undefined') return 'capture';
    /* 只有「浏览器能自己解码的单文件流」才走 ③。<audio> 喂不进 .mpd 清单，
       DASH 页面走 ③ 只会等到 15 秒超时，所以这里明确不给链路。 */
    if (kind === 'hls' || kind === 'direct') return 'src';
    return '';
  }

  function whyNoEnhanced() {
    switch (pageKind()) {
      case 'none':
        return '这个页面没有找到视频元素。';
      case 'unknown':
        return '视频还没开始加载。先点一下播放，播几秒再试。';
      case 'stream':
        return '这个页面播的是实时媒体流（MediaStream），音频不经过 MSE，双向模式用不了。延迟模式仍可用。';
      case 'dash':
        return '这个页面是 DASH（.mpd）清单，音频片段没有可复用的通道，双向模式用不了。延迟模式仍可用。';
      default:
        return '双向模式没有覆盖这种播放方式。请刷新页面重试，若仍复现请反馈。';
    }
  }

  function pushChunk(buf) {
    if (!(buf instanceof ArrayBuffer) || !buf.byteLength) return;

    S.chunks.push(buf);
    S.chunkBytes += buf.byteLength;

    /* 太老的片段自己丢掉：留着也只会让内存一路涨上去 */
    while (S.chunkBytes > C.MAX_CHUNK_BYTES && S.chunks.length > 2) {
      S.chunkBytes -= S.chunks.shift().byteLength;
    }

    if (S.enhanced && S.enhMode === 'mse') appendChunk(buf);
  }

  function appendChunk(buf) {
    S.appendQueue.push(buf);
    pump();
  }

  function pump() {
    if (!S.enhBuf || S.enhBuf.updating || !S.appendQueue.length) return;
    if (S.enhMS && S.enhMS.readyState !== 'open') return;
    const next = S.appendQueue.shift();
    try {
      S.enhBuf.appendBuffer(next);
      if (S.appendFails) S.appendFails = 0;
    } catch (e) {
      /* 片段被拒（时间戳不连续之类）就丢掉，别让队列卡死。
         但不能完全无声无息：连续丢片用户只会觉得「声音缺了一节」，
         得给个说法，也方便从 adsDiag 里看到规律。 */
      S.appendFails++;
      try {
        document.documentElement.dataset.adsDiag =
          ((document.documentElement.dataset.adsDiag || '') +
            '|append-fail:' + String((e && e.name) || e).slice(0, 24)).slice(-300);
      } catch (e2) {}
      if (S.appendFails >= 5 && !S.appendFailToasted && S.ui) {
        S.appendFailToasted = true;
        S.ui.showToast('音频片段连续对不上（页面音轨有空洞），声音可能偶尔缺一截');
      }
      setTimeout(pump, 0);
    }
  }

  function bufferedHas(t) {
    if (!S.enhAudio) return false;
    const b = S.enhAudio.buffered;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) + 0.05 && t <= b.end(i) - 0.15) return true;
    }
    return false;
  }

  function bufferedLead(t) {
    if (!S.enhAudio) return -999;
    const b = S.enhAudio.buffered;
    if (!b.length) return -999;

    let nearest = -1;
    for (let i = 0; i < b.length; i++) {
      const s = b.start(i);
      const e = b.end(i);
      if (t >= s && t <= e) return e - t;
      const d = t < s ? s - t : t - e;
      if (nearest < 0 || d < nearest) nearest = d;
    }
    return -nearest;
  }

  function bufferedEnd() {
    if (!S.enhAudio) return 0;
    const b = S.enhAudio.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  }

  function alignAudio(want) {
    const drift = S.enhAudio.currentTime - want;
    const abs = Math.abs(drift);

    if (abs > C.DRIFT_SEEK) {
      try { S.enhAudio.playbackRate = 1; } catch (e) {}
      seekAudioTo(want);
      return;
    }

    if (abs < 0.04) {
      if (S.enhAudio.playbackRate !== 1) {
        try { S.enhAudio.playbackRate = 1; } catch (e) {}
      }
      return;
    }

    const rate = 1 - drift / 4;
    if (Math.abs(S.enhAudio.playbackRate - rate) > 0.005) {
      try { S.enhAudio.playbackRate = rate; } catch (e) {}
    }
  }

  function ensureSeekRange(want) {
    if (!S.enhMS || S.enhMS.readyState !== 'open') return;
    let cur;
    try { cur = S.enhMS.duration; } catch (e) { return; }
    if (!isFinite(cur)) return;          /* NaN / Infinity 都不用管 */
    if (want + 5 <= cur) return;         /* 本来就在范围里 */
    try {
      S.enhMS.duration = Math.max(want + 60, cur + 1);
    } catch (e) {}
  }

  function seekAudioTo(t) {
    if (!S.enhAudio) return;
    ensureSeekRange(t);
    if (!bufferedHas(t)) return;
    try { S.enhAudio.currentTime = t; } catch (e) {}
  }

  function trimBuffer() {
    if (!S.enhBuf || !S.enhMS || S.enhMS.readyState !== 'open') return;
    if (S.enhBuf.updating || S.trimBusy) return;
    if (!S.enhAudio) return;

    let b;
    try { b = S.enhAudio.buffered; } catch (e) { return; }
    if (!b.length) return;

    const keepFrom = S.enhAudio.currentTime - C.KEEP_BEHIND;
    const firstStart = b.start(0);
    /* 少于 1 秒不值得动一次：remove 会打断 append 的节奏 */
    if (keepFrom - firstStart < 1) return;

    try {
      S.trimBusy = true;
      S.enhBuf.remove(firstStart, keepFrom);
    } catch (e) {
      S.trimBusy = false;
    }
  }

  function currentMs() {
    return S.ui ? S.ui.getValue() : 0;
  }

  /* ---------------- 两条链路怎么分工 ----------------
   *
   * 双向模式有两条能产生延迟的路径，用哪条取决于符号：
   *
   *   负值（声音提前）—— 只能靠 <audio> 的播放位置往前挪。此时 DelayNode
   *     必须归零：它只会把已经提前的音频再拖回去，两边正好抵消。
   *
   *   正值（声音延后）—— DelayNode 本身就是最省的做法：零缓冲消耗、
   *     不用提前下载，改一次 delayTime 立刻生效。这时候 <audio> 只要
   *     贴着画面走（want 不减 currentMs）。
   *
   * 早先这里不分符号，进双向一律把 DelayNode 归零，而 want 又照旧减
   * currentMs/1000 —— 结果是拖任何正值都去要「更早的数据」，缓冲区里
   * 根本没有，面板一路挂着「等缓冲 · 还差 N 秒」，听感上就是延迟失效。
   */

  /** <audio> 该播到哪一秒。只有负值才往前挪，正值交给 DelayNode。 */
  function wantAt(ms) {
    if (!S.videoEl) return 0;
    return S.videoEl.currentTime - Math.min(0, ms) / 1000;
  }

  function wantTime() {
    return wantAt(currentMs());
  }

  /** 把「这次该谁干活」落到 DelayNode 上。返回值 = 这次是否真的改了分配。
   *  syncTick 每 250ms 调一次，所以两个分支都要能重复调用而无副作用：
   *  负值只在第一次归零，正值只在数值真的变了（>20ms）才发消息。 */
  function syncCapturePipe(ms) {
    const prev = S.pipeMs;

    if (ms < 0) {
      if (prev !== null && prev < 0) return false;   /* 已经归零过，别反复发 */
      S.pipeMs = ms;
      bypassCaptureDelay();
      return true;
    }

    if (prev !== null && prev >= 0 && Math.abs(prev - ms) < 20) return false;
    S.pipeMs = ms;
    syncDelayToSw(true, ms);
    return true;
  }

  /** 退出双向时把分配记录清掉，下次进入重新算一遍 */
  function resetCapturePipe() {
    S.pipeMs = null;
  }

  function syncDelayToSw(transient, ms) {
    try {
      chrome.runtime.sendMessage({
        target: 'sw',
        type: 'setDelay',
        delayMs: ms == null ? currentMs() : ms,
        transient: !!transient
      }).catch(function () {});
    } catch (e) {}
  }

  function bypassCaptureDelay() {
    try {
      chrome.runtime.sendMessage({
        target: 'sw', type: 'setDelay', delayMs: 0, transient: true
      }).catch(function () {});
    } catch (e) {}
  }

  /* ---------------- 对外 ----------------
   * 只导出会被别的模块用到的。ensureSeekRange / appendChunk 是内部细节，
   * 留在这一层，外面拿不到反而更安全。 */

  E.core = {
    S: S,
    C: C,
    ROUTES: ROUTES,
    pageIsMSE: pageIsMSE,
    captureEnabled: captureEnabled,
    routeId: routeId,
    pickRoute: pickRoute,
    whyNoEnhanced: whyNoEnhanced,
    pushChunk: pushChunk,
    pump: pump,
    bufferedHas: bufferedHas,
    bufferedLead: bufferedLead,
    bufferedEnd: bufferedEnd,
    alignAudio: alignAudio,
    seekAudioTo: seekAudioTo,
    trimBuffer: trimBuffer,
    currentMs: currentMs,
    wantAt: wantAt,
    wantTime: wantTime,
    syncCapturePipe: syncCapturePipe,
    resetCapturePipe: resetCapturePipe,
    syncDelayToSw: syncDelayToSw,
    bypassCaptureDelay: bypassCaptureDelay
  };

  /* 生命周期（enhFail / enhReady / exit）定义在最后加载的 ads-enhance.js 里。
     这里先摆一个空壳，route / sync 加载时就能拿到同一个引用。 */
  E.life = E.life || {};
})();
