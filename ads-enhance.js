'use strict';

/* ================================================================
 * 双向模式：让声音比画面早
 *
 * 三条链路，按代价从低到高排，能省则省：
 *   ① mse     页面自己用 MSE（hls.js / shaka），直接复用它的 appendBuffer 片段
 *   ② capture 原生 HLS，切片不经过 JS，靠调试协议把字节取回来，再用 mux.js 转 fMP4
 *   ③ src     直连媒体，同一条流再拉一路，浏览器自己解码（多一倍流量）
 *
 * 三条链路只是「音频从哪来」不同，同步循环 syncTick 完全共用。
 *
 * 对外接口挂在 window.ADS.enh。
 * ================================================================ */

(function () {
  window.ADS = window.ADS || {};
  if (window.ADS.enh) return;

  const MAX_CHUNK_BYTES = 48 * 1024 * 1024;

  /* 三条链路的展示元数据。面板上那一行「走哪一路」全靠这张表：
     id 是编号，meta 是代价，hint 是悬停解释。
     想加链路就在这儿加一条，判断逻辑在 pickRoute()。 */
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

  /* ---------------- 状态 ---------------- */

  let ui = null;
  let inited = false;         /* window 消息监听器只装一次，见 init() */

  let enhanced = false;
  /* hookInstalled：MAIN world 的脚本装上了
     hookReady：真的截到了 audio 轨（收到 track 消息）。
     两者必须分开 —— 原生 HLS 页面 hook 装得上，但永远截不到东西。 */
  let hookInstalled = false;
  let hookReady = false;
  /* 站点是否已授权。和「脚本有没有注入」是两件事：
     授权了但页面在注册完成前就加载，脚本仍然进不来。 */
  let permGranted = false;

  let audioMime = '';
  const chunks = [];
  let chunkBytes = 0;

  let enhMS = null;
  let enhAudio = null;
  let enhBuf = null;
  let appendQueue = [];
  let syncTimer = null;
  let videoEl = null;

  /* 当前走的哪条链路，决定退出时要做哪些清理 */
  let enhMode = '';
  /* 为什么落到这条链路。用户看到 ③ 却不知道为什么没用更省的那条时，
     这个字符串就是答案，会拼进指示条的悬停提示。 */
  let routeWhy = '';
  let enhGuard = null;        /* 试运行超时计时器，非 null 表示还在「未落定」阶段 */
  let capInitDone = false;    /* 调试通道下，init segment 只需 append 一次 */
  let capBytes = 0;           /* 已经解出多少音频字节，用来判断「真有数据了」 */
  let guardMute = null;       /* 接管期间守住「原视频静音」的监听器 */

  /* 等缓冲：要提前的量超过已下载的量时，音频会 underflow（画面在走、没声音）。
     这时由我们主动按住视频，等音频追上来再放开。stalledByUs 必须记住
     「这次暂停是自己按的」，否则下一拍会被当成用户暂停，永远放不开。 */
  let stalledByUs = false;
  let stallSince = 0;
  let stallTail = 0;          /* 进等待时的缓冲末尾，用来判断「还在不在下载」 */
  let stallTailAt = 0;        /* 缓冲最后一次增长的时刻 */
  let stallLead = -999;       /* 进等待时「目标位置离可播数据还差多少」 */
  let lastStallToast = 0;     /* 上次「等缓冲」toast 的时间，做冷却用 */

  /* 用户拖进度条。视频的 currentTime 会瞬间跳到新位置，而我们这条音频还停在
     旧位置、MSE 里还攒着旧位置的片段、appendQueue 里还排着旧位置的队列。
     不在这里一次性纠正的话会有两个后果：
       1. 画面在新位置走，声音还在旧位置 —— 完全对不上；
       2. 队列里的旧片段继续灌进 MSE，把用户刚跳过的整段都缓冲下来。
     seekAt 记下时刻，用来把「seek 之前发出的切片请求」挡在门外 ——
     那些字节属于已经跳过的那一段。 */
  let seekAt = 0;
  let seekHandler = null;
  let trimBusy = false;
  const KEEP_BEHIND = 3;      /* 播放位置之前留几秒缓冲（够回退一点就行） */
  /* 已经因为等不到而自动降档几次。降过一次还不够的，第二次直接归零 ——
     否则会「降一点、再卡四秒、再降一点」，比一直卡着还难受。 */
  let stallGiveUps = 0;
  const WAIT_GAP = 0.4;       /* 目标位置落后缓冲区末尾超过这么多才值得暂停 */
  const RESUME_LEAD = 1.5;    /* 缓冲领先目标位置这么多才放开 —— 要比 WAIT_GAP 大得多，
                                 否则一放开走两步又得按住，声音就是一顿一顿的 */
  const DRIFT_SEEK = 0.35;    /* 音频位置偏差超过这个才 seek，小偏差用倍速慢慢追 */
  const WAIT_STUCK_MS = 4000; /* 缓冲连续这么久一点没长 = 真下不来了，别等了 */
  const WAIT_MAX_MS = 15000;  /* 总等待上限。目标位置迟迟没有数据时，等 15 秒
                                 还没到就认了 —— 再久用户只会觉得播放器坏了 */

  /* ---------------- 页面探测 ----------------
   * pickVideo / pageKind 拆到了 ads-detect.js（纯函数，全屏感知 + mpd 识别），
   * 这里只接引用；对外仍然从 window.ADS.enh.pickVideo 暴露给 content.js 用。 */
  const pickVideo = window.ADS.detect.pickVideo;
  const pageKind = window.ADS.detect.pageKind;

  function pageIsMSE() {
    return pageKind() === 'mse';
  }

  /** 这次会走哪条链路。面板预告和真正分派共用这一份判断，
   *  否则两边各写一套，早晚会说「预告走 ①」然后实际跑 ③。 */
  /* ---------------- 构建能力 ------------- */

  /** 这个包里有没有链路②。上架版没有 debugger 权限，也就没有这条链路：
   *  tools/package.js 只改 build-info.js 里的一行，其余代码原样保留。
   *  读不到标记时按完整版处理 —— 开发时直接 load-unpacked 也能用 ②。 */
  function captureEnabled() {
    const b = globalThis.ADS_BUILD;
    return !(b && b.capture === false);
  }

  /* 面板上的编号按「这个包里实际存在的链路」连续编号。
     上架版没有 ②，否则用户会看到 ① 和 ③ 中间空一个，以为少了东西。 */
  const ROUTE_ORDER = ['mse', 'capture', 'src'];
  const ROUTE_IDS = ['①', '②', '③'];
  function routeId(key) {
    const list = ROUTE_ORDER.filter(function (k) { return k !== 'capture' || captureEnabled(); });
    const i = list.indexOf(key);
    return i < 0 ? '' : ROUTE_IDS[i];
  }

  function pickRoute(kind) {
    if (hookReady && chunks.length) return 'mse';
    if (captureEnabled() && kind === 'hls' && typeof muxjs !== 'undefined') return 'capture';
    /* 只有「浏览器能自己解码的单文件流」才走 ③。<audio> 喂不进 .mpd 清单，
       DASH 页面走 ③ 只会等到 15 秒超时，所以这里明确不给链路。 */
    if (kind === 'hls' || kind === 'direct') return 'src';
    return '';
  }

  /** 为什么用不了双向模式。直连媒体（hls / direct）有独立链路、不走这里，
   *  正常调用只会命中 none / unknown / stream —— 后两个 case 是防御性的。 */
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

  /* ---------------- 片段缓冲 ---------------- */

  function pushChunk(buf) {
    if (!(buf instanceof ArrayBuffer) || !buf.byteLength) return;

    chunks.push(buf);
    chunkBytes += buf.byteLength;

    /* 太老的片段自己丢掉：留着也只会让内存一路涨上去 */
    while (chunkBytes > MAX_CHUNK_BYTES && chunks.length > 2) {
      chunkBytes -= chunks.shift().byteLength;
    }

    if (enhanced && enhMode === 'mse') appendChunk(buf);
  }

  function appendChunk(buf) {
    appendQueue.push(buf);
    pump();
  }

  let appendFails = 0;        /* 连续 append 失败计数 */
  let appendFailToasted = false;  /* 「连续对不上」的提示只弹一次，别刷屏 */

  function pump() {
    if (!enhBuf || enhBuf.updating || !appendQueue.length) return;
    if (enhMS && enhMS.readyState !== 'open') return;
    const next = appendQueue.shift();
    try {
      enhBuf.appendBuffer(next);
      if (appendFails) appendFails = 0;
    } catch (e) {
      /* 片段被拒（时间戳不连续之类）就丢掉，别让队列卡死。
         但不能完全无声无息：连续丢片用户只会觉得「声音缺了一节」，
         得给个说法，也方便从 adsDiag 里看到规律。 */
      appendFails++;
      try {
        document.documentElement.dataset.adsDiag =
          ((document.documentElement.dataset.adsDiag || '') +
            '|append-fail:' + String((e && e.name) || e).slice(0, 24)).slice(-300);
      } catch (e2) {}
      if (appendFails >= 5 && !appendFailToasted && ui) {
        appendFailToasted = true;
        ui.showToast('音频片段连续对不上（页面音轨有空洞），声音可能偶尔缺一截');
      }
      setTimeout(pump, 0);
    }
  }

  /** 目标时间点是否落在已缓冲范围里，不在就别 seek，否则会卡住等数据 */
  function bufferedHas(t) {
    if (!enhAudio) return false;
    const b = enhAudio.buffered;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) + 0.05 && t <= b.end(i) - 0.15) return true;
    }
    return false;
  }

  /** 目标位置相对已缓冲数据的余量。
   *  正数 = 后面还有这么多秒可以播；负数 = 还差这么多秒才够播到那儿。
   *  用它区分「只差一丁点，等下一拍就行」和「差得远，必须按住画面」。
   *  缓冲区为空时返回 -999，等于「一秒都没有」，直接按暂停。
   *
   *  目标落在缓冲范围**之外**时，返回「最近的缓冲边缘有多远」的负数：
   *    · 在末尾之后 → 还没下到那儿（正常前进时拖太远的提前量）
   *    · 在开头之前 → 用户把进度条拖回去了，缓冲里没有更早的数据
   *  两种都返回可测量的数字，而不是一律 -999：只有这样，等缓冲期间
   *  「数字在变大」才能证明还在下载，「一动不动」才等于真卡住。 */
  function bufferedLead(t) {
    if (!enhAudio) return -999;
    const b = enhAudio.buffered;
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

  /** 音频位置对齐。
   *  小偏差（40ms ~ 350ms）用 playbackRate 慢慢追：每秒最多偏差的 1/4，上限 ±4%。
   *  绝不频繁 seek —— seek 会打断解码输出，250ms 一拍 tick 下来就是「一顿一顿」。
   *  以前这里 |偏差|>40ms 就 seek，正是声音断断续续的元凶。
   *  ±4% 的变速对音高的影响听不出来；偏差 0.2 秒时约 5 秒平滑追完。 */
  function alignAudio(want) {
    const drift = enhAudio.currentTime - want;
    const abs = Math.abs(drift);

    if (abs > DRIFT_SEEK) {
      try { enhAudio.playbackRate = 1; } catch (e) {}
      seekAudioTo(want);
      return;
    }

    if (abs < 0.04) {
      if (enhAudio.playbackRate !== 1) {
        try { enhAudio.playbackRate = 1; } catch (e) {}
      }
      return;
    }

    const rate = 1 - drift / 4;
    if (Math.abs(enhAudio.playbackRate - rate) > 0.005) {
      try { enhAudio.playbackRate = rate; } catch (e) {}
    }
  }

  /** 缓冲末尾的绝对时间（秒）。没有缓冲就是 0。 */
  function bufferedEnd() {
    if (!enhAudio) return 0;
    const b = enhAudio.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  }

  /* ---------------- 拖动进度条 ---------------- */

  /** MSE 的 duration 只跟着已 append 的数据长，而且 **seek 会被 duration 钳住**：
   *  缓冲只到 20 秒时把 currentTime 设成 40，浏览器会直接把它改成 20 ——
   *  音频于是永远停在旧位置，画面已经在新位置了。这就是「拖完进度条之后
   *  声音对不上」最直接的那个原因。
   *  解决：目标位置超出 duration 时先把它抬上去，再 seek。 */
  function ensureSeekRange(want) {
    if (!enhMS || enhMS.readyState !== 'open') return;
    let cur;
    try { cur = enhMS.duration; } catch (e) { return; }
    if (!isFinite(cur)) return;          /* NaN / Infinity 都不用管 */
    if (want + 5 <= cur) return;         /* 本来就在范围里 */
    try {
      enhMS.duration = Math.max(want + 60, cur + 1);
    } catch (e) {}
  }

  /** 统一从这里 seek 音频。
   *
   *  判断「能不能 seek」必须看 buffered，不能看 seekable —— 实测缓冲只有
   *  10.36~15.56 时 seekable 会报 0~15.56，中间那一段其实是空的。seek 进
   *  空洞不会报错，而是**永久停在 seeking 上**：之后所有校正都被
   *  `if (!enhAudio.seeking)` 挡住，音频从此不动，画面照走。
   *  宁可这次不 seek，等数据 append 进来下一拍再纠正。 */
  function seekAudioTo(t) {
    if (!enhAudio) return;
    ensureSeekRange(t);
    if (!bufferedHas(t)) return;
    try { enhAudio.currentTime = t; } catch (e) {}
  }

  /** 用户把画面拖到新位置时，音频必须立刻跟过去。
   *  只靠 250ms 一拍的 syncTick 跟的话，中间那几拍画面在走、声音还是旧的，
   *  听感就是「拖完之后声音对不上」。更糟的是旧位置的片段还在队列里，
   *  会继续被 append 进 MSE，把用户刚跳过的那一整段都缓冲下来。 */
  function onVideoSeek() {
    if (!enhanced || !videoEl || !enhAudio) return;
    seekAt = Date.now();

    /* 旧位置的待 append 片段全丢 —— 它们属于用户已经跳过的那一段。
       不清的话 pump 会一片一片塞进去，正是「强制缓存跳过内容」的来源。 */
    appendQueue.length = 0;

    const want = videoEl.currentTime - currentMs() / 1000;
    try { enhAudio.playbackRate = 1; } catch (e) {}
    /* 位置先摆到正确的地方。没缓冲到时 seekAudioTo 会跳过 —— 硬 seek 要么
       被钳回缓冲末尾，要么卡在 seekable 与 buffered 之间的空洞里、从此不再
       接受校正。数据 append 进来后下一拍会自动纠正。 */
    seekAudioTo(want);

    /* 等待基准整体换成新位置：stallSince / stallTail 还是旧位置的，
       继续用会把「刚跳过来的等待」算成「已经等了很久」，几秒后误降档。 */
    if (stalledByUs) {
      stallSince = Date.now();
      stallTail = bufferedEnd();
      stallTailAt = stallSince;
      stallLead = bufferedLead(want);
      stallGiveUps = 0;
    }

    trimBuffer();
    publishState();
  }

  /** 删掉播放位置之前、已经不可能再播到的 MSE 缓冲。
   *  MSE 不回收自己：append 进去的数据一直占着，除非显式 remove。
   *  每拖一次进度条就留下一段永远不播的区间，一部电影下来能攒下整条音轨。 */
  function trimBuffer() {
    if (!enhBuf || !enhMS || enhMS.readyState !== 'open') return;
    if (enhBuf.updating || trimBusy) return;
    if (!enhAudio) return;

    let b;
    try { b = enhAudio.buffered; } catch (e) { return; }
    if (!b.length) return;

    const keepFrom = enhAudio.currentTime - KEEP_BEHIND;
    const firstStart = b.start(0);
    /* 少于 1 秒不值得动一次：remove 会打断 append 的节奏 */
    if (keepFrom - firstStart < 1) return;

    try {
      trimBusy = true;
      enhBuf.remove(firstStart, keepFrom);
    } catch (e) {
      trimBusy = false;
    }
  }

  /** 按住画面等缓冲 */
  function stallNow() {
    if (!stalledByUs) {
      stalledByUs = true;
      stallSince = Date.now();
      stallTail = bufferedEnd();
      stallTailAt = stallSince;
      stallLead = bufferedLead(videoEl.currentTime - currentMs() / 1000);
      /* 全屏时面板多半被收起，画面突然停住得有句话解释，不然像卡死了。
         一次等待只弹一条，且 20 秒冷却 —— 网络差导致连环等待时不刷屏。 */
      if (ui && Date.now() - lastStallToast > 20000) {
        lastStallToast = Date.now();
        ui.showToast('缓冲跟不上提前量，画面暂停等待下载…');
      }
      publishState();
    }
    try { enhAudio.playbackRate = 1; } catch (e) {}
    try { if (!videoEl.paused) videoEl.pause(); } catch (e) {}
    try { if (!enhAudio.paused) enhAudio.pause(); } catch (e) {}
    paintRouteMeta();
  }

  /** 缓冲够了，放开画面 */
  function resumeNow() {
    stalledByUs = false;
    stallSince = 0;
    publishState();
    let p = null;
    try { p = videoEl.play(); } catch (e) {}
    if (p && p.catch) {
      p.catch(function () {
        /* 浏览器拒绝恢复播放（极罕见）。停在这儿等于把用户的视频卡死，
           不如直接退回页面原声 —— 至少画面能继续走。 */
        if (ui) ui.showToast('视频没能自动恢复播放，已退出双向模式');
        exitEnhanced();
      });
    }
    if (enhAudio.paused) {
      const q = enhAudio.play();
      if (q && q.catch) q.catch(function () {});
    }
    paintRouteMeta();
  }

  /** 等不到了：把提前量降到缓冲撑得住的位置，就地恢复。
   *  不能只是「放开画面」—— 那样下一拍又会被按住，变成十几秒卡一下的循环，
   *  比一直卡着更难用。降到能做的值，用户立刻有声有画，面板上数字同步变小。 */
  function giveUpWait() {
    /* 第一次还给缓冲留 1.2 秒余量 —— 恢复播放的瞬间 currentTime 就在走，
       留太少等于刚放开就又得按住。降过一次还撑不住的，直接归零。 */
    const budget = stallGiveUps > 0
      ? 0
      : Math.max(0, bufferedEnd() - videoEl.currentTime - 1.2);
    const target = Math.max(-budget * 1000, currentMs());
    stallGiveUps++;

    /* 已经没什么可降的了：音频在这一段就是没下载下来（往回拖得太远、
       或者站点把流切走了）。再放开画面只会「停一会儿、动半秒」地循环，
       不如老实退回原声 —— 至少画面和声音都是用户熟悉的那一份。 */
    /* 降完提前量，目标位置仍然落在缓冲之外 —— 说明这段音频根本没下载下来
       （用户跳得太远，或者站点把流切走了）。这时候放开画面就是「画面在走、
       声音没有」，而且下一拍还会再 stall，变成规律的卡顿循环。
       老实退回页面原声，至少声画是配套的。 */
    const afterGiveUp = bufferedLead(videoEl.currentTime - target / 1000);
    if (target === currentMs() || afterGiveUp < -WAIT_GAP) {
      enhFail('这个位置的音频还没下载到，已退出双向模式，声音回到页面原声。');
      return;
    }

    stalledByUs = false;
    stallSince = 0;

    if (ui) ui.setValue(target);
    try {
      chrome.runtime.sendMessage({ target: 'sw', type: 'setDelay', delayMs: target })
        .catch(function () {});
    } catch (e) {}

    if (ui) {
      ui.showToast(target === 0
        ? '缓冲一直没跟上，提前量已归零，只保留延迟。'
        : '缓冲跟不上，提前量已自动降到 ' + Math.abs(target / 1000).toFixed(1) + ' 秒。');
    }

    alignAudio(videoEl.currentTime - currentMs() / 1000);
    publishState();
    let p = null;
    try { p = videoEl.play(); } catch (e) {}
    if (p && p.catch) p.catch(function () {});
    if (enhAudio.paused) {
      const q = enhAudio.play();
      if (q && q.catch) q.catch(function () {});
    }
    paintRouteMeta();
  }

  function syncTick() {
    if (!enhanced || !videoEl || !enhAudio) return;
    pump();
    /* 回收播放位置之前的缓冲：MSE 不会自己释放，不删就一路攒着 */
    trimBuffer();
    /* 顺手把「还能提前多少」刷到面板上 */
    paintRouteMeta();

    /* ---------------- 正在等缓冲 ----------------
     * 这一段必须放在「videoEl.paused 就停音频」前面：等缓冲时视频正是被我们自己
     * 按住的，走下面那条分支只会一直 return，再也没人把它放开。 */
    if (stalledByUs) {
      const need = videoEl.currentTime - currentMs() / 1000;
      const lead = bufferedLead(need);
      /* 缓冲已经到顶（后面不会再有数据）：剩下这点余量就是全部本钱，
         不能因为差零点几秒达不到 RESUME_LEAD 就一直按着 —— 那会一路等到
         「卡死」超时，然后把提前量清掉甚至直接退出双向。
         判据是末尾连续 2 秒没长，正常下载中不会触发。 */
      const tailStuck = Date.now() - stallTailAt > 2000;
      if (lead >= RESUME_LEAD || (lead > WAIT_GAP && tailStuck)) {
        alignAudio(need);
        resumeNow();
        return;
      }

      /* 等待期间必须一直按着画面。stallNow 只在第一次调用时 pause，
         而用户拖完进度条后很多播放器会自己接着播 —— 视频在走、音频还停在
         旧位置，正是「拖完之后声音对不上」的样子。 */
      try { if (!videoEl.paused) videoEl.pause(); } catch (e) {}
      try { if (!enhAudio.paused) enhAudio.pause(); } catch (e) {}
      /* 顺带把音频摆到目标位置等着。数据还没到的话 seekable 里没有这一段，
         seekAudioTo 会跳过（硬 seek 只会被钳回一个错的位置），
         等切片 append 进来后由 alignAudio 纠正。 */
      if (Math.abs(enhAudio.currentTime - need) > 1) {
        seekAudioTo(need);
      }

      /* 「还在下载」有两种长相：缓冲末尾在往前长（正常前进），或者目标位置
         离可播数据越来越近（用户把进度条拖回去，要从更早的地方重新下）。
         任一个在动就继续等。以前只看末尾 —— 往回拖时末尾是旧位置的高水位，
         永远不长，4 秒就误判成「下不来了」把提前量清掉。 */
      const tail = bufferedEnd();
      if (lead > stallLead + 0.05) {
        stallLead = lead;
        stallTailAt = Date.now();
      } else if (tail > stallTail + 0.05) {
        stallTail = tail;
        stallTailAt = Date.now();
      }
      const stuck = Date.now() - stallTailAt > WAIT_STUCK_MS;
      const tooLong = Date.now() - stallSince > WAIT_MAX_MS;
      /* 目标位置整个落在缓冲之外 = 在等「新位置」的切片。这种情况降提前量
         一点用都没有（降了也播不到那儿），只会把画面放开、声音留在原地。
         所以宁可多等一会儿，面板上「还差 N 秒」在动，用户看得见。
         例外：末尾连续 6 秒没长 —— 那是真的到片尾/断流了，再等也没有，
         交给 giveUpWait 去降档（它还会再确认一次降完有没有数据）。 */
      const noDataAtTarget = lead < -WAIT_GAP;
      const atStreamEnd = Date.now() - stallTailAt > WAIT_STUCK_MS * 1.5;
      if (tooLong || (stuck && (!noDataAtTarget || atStreamEnd))) { giveUpWait(); return; }

      paintRouteMeta();
      return;
    }

    /* 视频暂停时音频也要停，否则声音会跑到画面前面 */
    if (videoEl.paused) {
      if (!enhAudio.paused) enhAudio.pause();
      return;
    }
    if (enhAudio.paused) enhAudio.play().catch(function () {});

    /* currentMs 的语义是「音频延迟量」：正值 = 声音比画面晚，负值 = 提前。
       所以 audio 要播的位置是 video.currentTime - currentMs/1000：
       currentMs=-3000 → audio 跑到画面前面 3 秒的内容 → 观众提前 3 秒听到。 */
    const want = videoEl.currentTime - currentMs() / 1000;
    if (bufferedHas(want)) { alignAudio(want); return; }

    /* 目标位置还没缓冲到。差得多 = 下载跟不上设定的提前量。这时如果放任画面
       继续走，音频就会 underflow：画面正常、声音没了，而且越走越远，再也追不上。
       所以先按住画面，等缓冲追上来。 */
    if (bufferedLead(want) < -WAIT_GAP) { stallNow(); return; }

    /* 只差一丁点（网络抖一下）：原地等下一拍，别 seek，也别停画面 */
    if (Math.abs(enhAudio.currentTime - want) > 2.5) {
      seekAudioTo(want);
    }
  }

  function currentMs() {
    return ui ? ui.getValue() : 0;
  }

  /** 把面板上的数值同步给 tabCapture 那条链路。
   *  双向期间 queueDelay 是直接 return 的（数值只作用于本地音轨），
   *  所以 offscreen 里的 delayNode 还停在进入双向之前的值。退出时面板可能
   *  被钳制过（负值归零），不同步的话听起来仍是一个旧延迟。
   *  transient：只改这一次的 delayNode，不覆盖用户记住的延迟值。 */
  function syncDelayToSw(transient) {
    try {
      chrome.runtime.sendMessage({
        target: 'sw',
        type: 'setDelay',
        delayMs: currentMs(),
        transient: !!transient
      }).catch(function () {});
    } catch (e) {}
  }

  /** 双向模式期间，tabCapture 那条链路只当「送到扬声器的管子」用。
   *  它抓的是整个标签页的混音 —— 包括我们刚放进来、已经按面板值排好时间的
   *  那条 <audio>。所以 delayNode 必须归零，否则面板写 1.5 秒、耳朵听到 3 秒。
   *  退出时 syncDelayToSw() 会把面板值还原回去。 */
  function bypassCaptureDelay() {
    try {
      chrome.runtime.sendMessage({
        target: 'sw', type: 'setDelay', delayMs: 0, transient: true
      }).catch(function () {});
    } catch (e) {}
  }

  /* ---------------- 收尾 / 落定 ---------------- */

  /** 收尾：拆掉音频元素，视频恢复原声。msg 为空则不打扰用户。 */
  function enhFail(msg, then) {
    if (enhGuard) { clearTimeout(enhGuard); enhGuard = null; }

    /* 抓切片这一路失败时也要把调试会话拆掉。漏了这一步的话浏览器顶部
       那条「正在调试」会一直挂着，下次 attach 还会撞上
       "Another debugger is already attached" —— 之后只能刷新页面。 */
    if (enhMode === 'capture') {
      try {
        chrome.runtime.sendMessage({ target: 'sw', type: 'captureStop' }).catch(function () {});
      } catch (e) {}
    }

    if (enhAudio) {
      try { enhAudio.pause(); } catch (e) {}
      try { enhAudio.removeAttribute('src'); enhAudio.load(); } catch (e) {}
      try { enhAudio.remove(); } catch (e) {}
    }
    enhAudio = null;
    enhMS = null;
    enhBuf = null;
    appendQueue = [];
    capInitDone = false;
    capBytes = 0;
    seekAt = 0;
    trimBusy = false;
    enhMode = '';
    enhanced = false;

    if (videoEl) {
      if (guardMute) {
        try { videoEl.removeEventListener('volumechange', guardMute, true); } catch (e) {}
        guardMute = null;
      }
      if (seekHandler) {
        try { videoEl.removeEventListener('seeking', seekHandler, true); } catch (e) {}
        seekHandler = null;
      }
      try { videoEl.muted = false; } catch (e) {}
      /* 等缓冲时被拆掉（用户点了停止、或者链路降级），画面还停在暂停上，
         必须放开 —— 不然后台一拆，用户的视频就永远停住了 */
      if (stalledByUs) {
        stalledByUs = false;
        stallSince = 0;
        /* 这里别碰 enhAudio：上面已经把它置 null 销毁了（老代码在这里
           写 enhAudio.playbackRate = 1，永远只抛一个被吞掉的 TypeError）。 */
        try {
          const p = videoEl.play();
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      }
      videoEl = null;
    }

    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    if (ui) ui.setEnhanced(false);

    updateModeUI();
    if (msg && ui) ui.showToast(msg);
    syncDelayToSw(true);
    if (typeof then === 'function') then();
  }

  /** 落定：确认音频真的解出了数据，才敢把视频静音 */
  function enhReady() {
    if (!videoEl || !enhAudio || enhanced) return;
    if (enhGuard) { clearTimeout(enhGuard); enhGuard = null; }

    /* 有些播放器会自己把静音改回去 —— 那样扩展和页面同时出声（双声）。
       接管期间守住 muted。守卫在我们自己的赋值触发的 volumechange 里
       只做 no-op（muted 已是 true），不会形成循环。
       注意：退出时必须先摘监听再把 muted 设回 false，顺序反了会被守卫按回去。 */
    guardMute = function () {
      try { if (videoEl && !videoEl.muted) videoEl.muted = true; } catch (e) {}
    };
    try { videoEl.addEventListener('volumechange', guardMute, true); } catch (e) {}

    try { videoEl.muted = true; } catch (e) {}
    enhanced = true;

    /* 拖进度条要在第一时间纠正音频位置、丢掉旧位置的队列。
       等 250ms 一拍的 tick 去发现，中间那几拍已经声画不同步了。 */
    seekHandler = onVideoSeek;
    try { videoEl.addEventListener('seeking', seekHandler, true); } catch (e) {}

    /* 管子清零：这条链路的 delayNode 不能和本地音轨的偏移叠加 */
    bypassCaptureDelay();

    if (ui) {
      ui.setEnhanced(true);
      ui.setValue(currentMs());
    }
    updateModeUI();

    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(syncTick, 250);
    syncTick();
  }

  /* ---------------- 链路 ① 复用页面 MSE 片段 ---------------- */

  function startMseReuse(v) {
    enhMode = 'mse';
    videoEl = v;
    paintRoute();

    enhAudio = document.createElement('audio');
    enhAudio.style.display = 'none';
    document.documentElement.appendChild(enhAudio);

    enhMS = new MediaSource();
    /* 标记一下，inject-main 那边看到就会跳过，避免自己截自己 */
    enhMS.__adsOwn = true;
    enhAudio.src = URL.createObjectURL(enhMS);

    enhGuard = setTimeout(function () {
      enhFail('没截到可用的音频数据，已放弃双向模式，视频声音保持原样。');
    }, 4000);

    /* 两个事件都等：loadedmetadata 可能先到但 buffer 还空着，
       canplay 才是「真的能出声」，所以只在有数据时才落定。 */
    const tryReady = function () {
      if (!enhGuard) return;
      if (enhAudio.buffered.length || isFinite(enhAudio.duration)) enhReady();
    };
    enhAudio.addEventListener('loadedmetadata', tryReady);
    enhAudio.addEventListener('canplay', tryReady);

    enhMS.addEventListener('sourceopen', function () {
      try {
        enhBuf = enhMS.addSourceBuffer(audioMime || 'audio/mp4; codecs="mp4a.40.2"');
        enhBuf.addEventListener('updateend', function () { trimBusy = false; pump(); });
        for (const c of chunks) appendQueue.push(c);
        pump();
      } catch (e) {
        enhFail('音频轨初始化失败：' + ((e && e.message) || e));
      }
    });
  }

  /* ---------------- 链路 ② 调试协议抓 ts 切片 ---------------- */

  function startNativeCapture(v) {
    enhMode = 'capture';
    videoEl = v;
    capInitDone = false;
    capBytes = 0;
    paintRoute();

    let fellBack = false;
    const fallback = function () {
      if (fellBack) return;
      fellBack = true;
      const keep = videoEl;
      /* 降级要留痕：不弹一次提示的话，用户只会看到流量翻倍却不知道为什么 */
      routeWhy = '抓切片失败（调试器被占用，或页面上没有新的切片请求），已自动降级';
      enhFail(null, function () { if (keep) startViaSrc(keep); });
      if (ui) ui.showToast('没抓到切片，已改为重新拉一路（约多一倍流量）');
    };

    enhAudio = document.createElement('audio');
    enhAudio.style.display = 'none';
    document.documentElement.appendChild(enhAudio);

    enhMS = new MediaSource();
    enhAudio.src = URL.createObjectURL(enhMS);

    /* 12 秒还抓不到就退到「再拉一路」。中间过程对用户不可见。
       captureStop 由 fallback → enhFail 统一发，这里不要重复发。 */
    enhGuard = setTimeout(fallback, 12000);

    enhMS.addEventListener('sourceopen', function () {
      try {
        enhBuf = enhMS.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
        enhBuf.addEventListener('updateend', function () { trimBusy = false; pump(); });
      } catch (e) {
        fallback();
      }
    });

    chrome.runtime.sendMessage({ target: 'sw', type: 'captureStart' })
      .then(function (r) { if (!r || !r.ok) fallback(); })
      .catch(function () { fallback(); });
  }

  /* Transmuxer 单例：构造一次要初始化整条 demux 管线，直播场景每 2~5 秒一片，
     每片 new 一个是纯浪费。mux.js 的实例设计上就支持 push/flush 循环使用。
     事件只绑一次，输出写进 muxOut；一旦 push/flush 抛错就整个重建 ——
     内部状态可能已经被半片数据污染，续用会错乱。 */
  let muxer = null;
  let muxOut = null;

  function getMuxer() {
    if (muxer) return muxer;
    try {
      muxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true, remux: false });
      muxer.on('data', function (seg) {
        if (!muxOut || seg.type !== 'audio') return;
        if (!capInitDone && seg.initSegment && seg.initSegment.byteLength) muxOut.init = seg.initSegment;
        if (seg.data && seg.data.byteLength) muxOut.data = seg.data;
      });
    } catch (e) {
      muxer = null;
    }
    return muxer;
  }

  /** 调试通道送来一片 ts：demux 出音频轨，灌进 MSE */
  function onSegChunk(msg) {
    if (enhMode !== 'capture' || !enhBuf) return;

    /* seek 之前发出的切片请求：那些字节属于用户已经跳过的那一段，
       再 append 进来只会白占 MSE 缓冲（「强制缓存跳过内容」的另一半来源）。
       30ms 容差留给同一毫秒的边界。 */
    if (seekAt && msg.at && msg.at < seekAt - 30) return;

    let buf = null;
    try {
      if (msg.b64) {
        const bin = atob(msg.b64);
        buf = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
      }
    } catch (e) { return; }
    if (!buf || !buf.length) return;

    /* remux:false 才会把音轨单独吐出来。默认的 combined 段里含 avc1，
       audio/mp4 的 SourceBuffer 会直接拒收。 */
    const t = getMuxer();
    if (!t) return;
    muxOut = { init: null, data: null };
    try {
      t.push(buf);
      t.flush();
    } catch (e) {
      muxer = null;      /* 状态可能被半片数据污染，重建 */
      muxOut = null;
      return;
    }
    const init = muxOut && muxOut.init;
    const data = muxOut && muxOut.data;
    muxOut = null;

    /* init segment 只 append 第一次：同一路流的编码参数不会变，
       重复 append 会让 SourceBuffer 报错。 */
    if (init) { appendQueue.push(init); capInitDone = true; }
    if (data) { appendQueue.push(data); capBytes += data.byteLength; }
    pump();

    if (!enhanced && data) {
      setTimeout(function () {
        if (!enhanced && enhAudio && enhAudio.buffered.length) enhReady();
      }, 300);
    }
  }

  /* ---------------- 链路 ③ 直连再拉一路 ---------------- */

  function startViaSrc(v) {
    enhMode = 'src';
    videoEl = v;
    capBytes = 0;
    paintRoute();

    enhAudio = document.createElement('audio');
    enhAudio.style.display = 'none';
    document.documentElement.appendChild(enhAudio);
    enhAudio.src = v.currentSrc || v.src;

    /* 放宽到 15 秒：CDN 对第二路请求偶尔会长时间不吐数据（实测过），
       10 秒会误判失败。 */
    enhGuard = setTimeout(function () {
      enhFail('音频流加载超时，已放弃双向模式，视频声音保持原样。');
    }, 15000);

    const tryReady = function () {
      if (!enhGuard) return;
      if (enhAudio.buffered.length || isFinite(enhAudio.duration)) enhReady();
    };
    enhAudio.addEventListener('loadedmetadata', tryReady);
    enhAudio.addEventListener('canplay', tryReady);
  }

  /* ---------------- 分派 ---------------- */

  function enterEnhanced() {
    const v = pickVideo();
    if (!v) {
      if (ui) ui.showToast('这个页面没有找到视频元素');
      return;
    }

    /* 每次重新进双向都给缓冲一次机会：也许这回站点的下载跟得上了 */
    stallGiveUps = 0;

    const kind = pageKind();
    const route = pickRoute(kind);
    routeWhy = '';   /* 每轮重新判断，别把上一轮的降级原因带过来 */

    /* ① 页面自己在用 MSE（hls.js / shaka），切片已经躺在 appendBuffer 里了 */
    if (route === 'mse') { startMseReuse(v); return; }

    /* ② 原生 HLS：没有 appendBuffer 可钩，只能走调试协议 */
    if (route === 'capture') { startNativeCapture(v); return; }

    /* ③ 直连媒体：自己再拉一路 */
    if (route === 'src') {
      /* 记下为什么没走更省的链路 —— 这两种情况代价差一倍，用户有权知道 */
      routeWhy = kind === 'direct'
        ? '页面是直连媒体（.mp4 / 非 m3u8），没有切片可抓，只能重新拉一路'
        : '有 m3u8 但取不到切片数据';
      startViaSrc(v);
      return;
    }

    if (ui) {
      ui.showToast(hookReady
        ? '音频片段还没攒到，先让视频播放几秒再试。'
        : (pageIsMSE() ? '还没截到音频轨，先让视频播放几秒再点。' : whyNoEnhanced()));
    }
  }

  function exitEnhanced() {
    if (enhGuard) { clearTimeout(enhGuard); enhGuard = null; }

    /* 调试通道用完立刻拆掉，黄条不该留在页面上 */
    if (enhMode === 'capture') {
      chrome.runtime.sendMessage({ target: 'sw', type: 'captureStop' }).catch(function () {});
    }

    enhMode = '';
    routeWhy = '';

    if (enhAudio) {
      try { enhAudio.pause(); } catch (e) {}
      try { enhAudio.removeAttribute('src'); enhAudio.load(); } catch (e) {}
      try { enhAudio.remove(); } catch (e) {}
    }
    enhAudio = null;
    enhMS = null;
    enhBuf = null;
    appendQueue = [];
    capInitDone = false;
    capBytes = 0;
    seekAt = 0;
    trimBusy = false;

    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }

    if (videoEl) {
      if (guardMute) {
        try { videoEl.removeEventListener('volumechange', guardMute, true); } catch (e) {}
        guardMute = null;
      }
      if (seekHandler) {
        try { videoEl.removeEventListener('seeking', seekHandler, true); } catch (e) {}
        seekHandler = null;
      }
      try { videoEl.muted = false; } catch (e) {}
      /* 等缓冲时被拆掉（用户点了停止、或者链路降级），画面还停在暂停上，
         必须放开 —— 不然后台一拆，用户的视频就永远停住了 */
      if (stalledByUs) {
        stalledByUs = false;
        stallSince = 0;
        /* 这里别碰 enhAudio：上面已经把它置 null 销毁了（老代码在这里
           写 enhAudio.playbackRate = 1，永远只抛一个被吞掉的 TypeError）。 */
        try {
          const p = videoEl.play();
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      }
      videoEl = null;
    }

    enhanced = false;
    if (ui) {
      /* setEnhanced(false) 会把负值钳回 0（minMs 归零），钳完要同步给
         tabCapture 那条链路，否则面板写着 0.000、听起来还是旧延迟 */
      ui.setEnhanced(false);
    }
    updateModeUI();
    syncDelayToSw(true);
  }

  /* ---------------- 模式文案 ---------------- */

  /** 链路指示条。虚线 = 还没跑起来（预告或正在连），实线 = 已经在出声 */
  function paintRoute() {
    if (!ui) return;

    /* enhMode 一旦有值就说明这条链路已经选定，哪怕还没落定也要按它显示。
       此时不能再走 pickRoute() 预告，否则 ② 降级到 ③ 的过程中，
       面板会一直挂着「将用 ②」，跟实际跑的对不上。 */
    const r = ROUTES[enhMode] || ROUTES[pickRoute(pageKind())];
    if (!r) { ui.setRoute(null); return; }

    ui.setRoute({
      id: routeId(enhMode || pickRoute(pageKind())),
      /* 「将用」是给还没点的用户看的，分清预告和生效 */
      name: enhMode ? r.name : '将用 ' + r.name,
      /* 链路选定了但还没出声（在等数据、等降级），别让用户以为已经生效 */
      meta: enhMode && !enhanced ? '连接中…' : r.meta,
      hint: (enhMode === 'src' && routeWhy) ? r.hint + ' ｜ 原因：' + routeWhy : r.hint,
      on: enhanced
    });

    if (enhanced) paintRouteMeta();
    /* 链路一选定就发布状态，别等下一次整轮重绘 */
    publishState();
  }

  /** 右侧那截动态数字：音频已经缓冲到画面之后多少秒，也就是最多还能提前多少。
   *  三条链路喂进 MSE 时都保留了原始时间戳，所以可以直接和 video.currentTime 相减。 */
  function paintRouteMeta() {
    if (!ui || !enhAudio || !videoEl) return;
    const r = ROUTES[enhMode];
    if (!r) return;

    const b = enhAudio.buffered;
    const tail = b.length ? b.end(b.length - 1) : 0;

    /* 等缓冲时右侧那截改报「还差多少」——不然用户看到「可提前 0.0s」
       却不知道画面为什么要停在那儿 */
    if (stalledByUs) {
      const lead = bufferedLead(videoEl.currentTime - currentMs() / 1000);
      /* -999 是「一段缓冲都没有」的哨兵值，别拿它算成「还差 999 秒」。
         lead 为正 = 数据其实已经够播到目标位置，只是余量还没到 RESUME_LEAD，
         这时候写「还差 0.0s」会让人以为卡死了。 */
      if (lead <= -900) ui.setRouteMeta('等缓冲 · 下载中…');
      else if (lead > 0) ui.setRouteMeta('等缓冲 · 数据已到，准备恢复');
      else ui.setRouteMeta('等缓冲 · 还差 ' + (-lead).toFixed(1) + 's');
      return;
    }

    const ahead = b.length ? Math.max(0, tail - videoEl.currentTime) : 0;
    ui.setRouteMeta(r.meta + ' · 可提前 ' + ahead.toFixed(1) + 's');
  }

  /** 把内部判断结果写到 DOM 属性上。
   *  内容脚本跑在隔离世界，主世界的 Console 读不到 window.ADS，
   *  所以排查只能靠 DOM 这个公共面。用户按 F12 敲一行就能看到全部状态。 */
  function publishState() {
    try {
      const v = pickVideo();
      document.documentElement.dataset.adsState = JSON.stringify({
        kind: pageKind(),
        capture: captureEnabled(),
        mux: typeof muxjs !== 'undefined',
        hookInstalled: hookInstalled,
        hookReady: hookReady,
        chunks: chunks.length,
        enhanced: enhanced,
        mode: enhMode,
        why: routeWhy,
        videoSrc: v ? String(v.currentSrc || v.src || '').slice(0, 80) : null,
        videoPaused: v ? v.paused : null,
        /* 停在暂停上是不是扩展自己按的（为了等缓冲），别和用户暂停混了 */
        delayMs: currentMs(),
        stalled: stalledByUs,
        bufferedLead: enhAudio ? +bufferedLead(v ? v.currentTime - currentMs() / 1000 : 0).toFixed(2) : null
      });
    } catch (e) {}
  }

  function paintModeUI() {
    if (!ui) return;

    ui.setTip(enhanced ? '负值让声音提前 · 滚轮可调' : '只延后声音 · 滚轮可调');
    ui.setModeTag(enhanced ? '双向' : '延迟', enhanced);
    paintRoute();
    publishState();

    if (enhanced) {
      ui.setModeBtn('', '', true);
      return;
    }

    if (hookReady) {
      ui.setModeBtn('启用双向', '复用页面已经下载的音频片段，支持负值（声音提前）', false);
      return;
    }

    const kind = pageKind();

    if (kind === 'hls') {
      ui.setModeBtn('启用双向', (captureEnabled() && typeof muxjs !== 'undefined')
        ? '原生 HLS：先用调试协议取回播放器已下载的切片，不额外耗流量（浏览器顶部会提示正在调试）；取不到时自动改为重新拉一路'
        : '原生 HLS：用同一条流再播一遍（浏览器直接解码），支持负值（声音提前）。会多用一倍流量', false);
      return;
    }

    if (kind === 'direct') {
      ui.setModeBtn('启用双向', '用同一条流的音频再播一遍（浏览器直接解码），支持负值（声音提前）。会多用一倍流量', false);
      return;
    }

    /* DASH：<audio> 喂不进 .mpd 清单，点下去只会白等 15 秒再失败，
       所以按钮直接说明不支持，别让用户去授权、去刷新折腾一圈 */
    if (kind === 'dash') {
      ui.setModeBtn('此页不支持双向', 'DASH（.mpd）清单由页面自己的播放器解码，音频片段没有可复用的通道。延迟模式仍可用', false);
      return;
    }

    if (!hookInstalled) {
      ui.setModeBtn(
        permGranted ? '刷新页面生效' : '双向需授权',
        permGranted
          ? '这个站点已经授权，但当前页面加载时脚本还没注册上。刷新一次即可'
          : '需要当前站点的访问权限，点一下会弹出授权框',
        false
      );
      return;
    }

    /* 脚本装上了却没截到音频轨：要么还没开始播，要么根本不是 MSE */
    if (kind === 'mse') {
      ui.setModeBtn('等待音频轨', '播放器还没往 MSE 里写音频，先让视频播放几秒', false);
    } else if (kind === 'unknown') {
      ui.setModeBtn('等待播放', '视频还没开始加载，先点一下播放', false);
    } else {
      ui.setModeBtn('此页不支持双向', kind === 'hls'
        ? '视频地址是 .m3u8 直连（原生 HLS），数据不经过 JS'
        : '视频是直连的，音频数据不经过 MSE', false);
    }
  }

  let modeTimer = null;

  function startModeWatch() {
    if (modeTimer) return;
    modeTimer = setInterval(function () {
      /* 有 video 了才显形：跨域 iframe 场景下，父框架会一直等不到 video，
         面板就保持隐藏；真正有播放器的那个 frame 会在这里显形。 */
      if (ui && ui.host.style.display === 'none' && pickVideo()) ui.reveal();

      /* 先重绘再判断要不要停：地址刚出现的那一次，正是需要刷新文案的时候 */
      paintModeUI();
      const k = pageKind();
      if (!hookInstalled || hookReady || enhanced || (k !== 'unknown' && k !== 'none')) stopModeWatch();
    }, 400);
  }

  function stopModeWatch() {
    if (modeTimer) { clearInterval(modeTimer); modeTimer = null; }
  }

  function updateModeUI() {
    paintModeUI();

    /* 视频地址从「空」变成 blob:/m3u8 只发生一次，但没有任何事件能可靠捕获
       （播放器可能在任意时刻给 video 赋 src，SPA 还可能稍后才插入 video）。
       unknown / none 都算「还没有定论」，需要轮询；其余状态一次就能判死。 */
    const k = pageKind();
    if (hookInstalled && !hookReady && !enhanced && (k === 'unknown' || k === 'none')) startModeWatch();
    else stopModeWatch();
  }

  /* ---------------- 点「启用双向」 ---------------- */

  async function onModeClick() {
    if (enhanced) { exitEnhanced(); return; }
    if (hookReady) { enterEnhanced(); return; }

    /* 直连媒体：不用截获、不用授权，直接拉一路 */
    const k = pageKind();
    if (k === 'hls' || k === 'direct') { enterEnhanced(); return; }

    if (!ui) return;

    /* DASH 清单：别走到下面的授权流程 —— 授权 + 刷新之后再点还是不支持 */
    if (k === 'dash') {
      ui.showToast('DASH（.mpd）暂不支持双向模式，延迟模式仍然可用。');
      return;
    }

    if (hookInstalled) {
      ui.showToast(pageIsMSE()
        ? '还没截到音频轨，先让视频播放几秒再点。'
        : whyNoEnhanced());
      return;
    }

    /* 已经授权过，只是当前页面没赶上注册：走只注册通道，不要再要一次权限。
       permissions.request 即使权限已存在也要求手势，没必要为它多绕一圈。 */
    if (permGranted) {
      try {
        const res = await chrome.runtime.sendMessage({
          target: 'sw',
          type: 'registerOnly',
          origin: location.origin
        });
        ui.showToast((res && res.ok) ? '已重新注册，正在刷新页面…' : ((res && res.error) || '注册失败'),
          (res && res.ok) ? 'ok' : undefined);
      } catch (e) {
        ui.showToast('注册请求失败：' + ((e && e.message) || e));
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
      if (res && res.ok) ui.showToast('已授权，正在刷新页面…', 'ok');
      else ui.showToast((res && res.error) || '授权失败');
    } catch (e) {
      ui.showToast('授权请求失败：' + ((e && e.message) || e));
    }
  }

  /* ---------------- MAIN world 送来的消息 ---------------- */

  function onPageMessage(e) {
    const m = e.data;
    if (!m || m.__ads !== true) return;

    if (m.type === 'ready') {
      hookInstalled = true;
      updateModeUI();
      return;
    }
    if (m.type === 'track') {
      if (m.mime) audioMime = m.mime;
      hookInstalled = true;
      hookReady = true;
      updateModeUI();
      return;
    }
    if (m.type === 'state') {
      hookInstalled = true;
      if (m.mime) { audioMime = m.mime; hookReady = true; }
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
      ui = uiRef;

      /* 这个文件只在页面里跑一份（上面有 ADS.enh 的守卫），但 content.js
         会在「停止 → 再接管」时被重新注入并再调一次 init。监听器只能加一次，
         否则每片音频、每条状态消息都会被处理两遍 —— 表现为片段重复 append。 */
      if (!inited) {
        inited = true;
        window.addEventListener('message', onPageMessage);
      }

      ui.bind({
        mode: onModeClick,
        stop: function () {
          if (enhanced) exitEnhanced();
          chrome.runtime.sendMessage({ target: 'sw', type: 'stop' }).catch(function () {});
        }
      });

      updateModeUI();

      /* MAIN world 可能已经先跑完了，问一次它当前截到了什么 */
      try { window.postMessage({ __ads: true, type: 'query' }, '*'); } catch (e) {}
    },

    isEnhanced: function () { return enhanced; },
    /* 「这条链路是抓切片，且还没放弃」—— 全屏后要重连调试会话，只看 enhanced 不够：
       连接中（enhMode=capture 但音频还没到手）时掉线同样要接回来 */
    isCapturing: function () { return enhMode === 'capture'; },
    kind: pageKind,
    pickVideo: pickVideo,
    updateModeUI: updateModeUI,
    exit: exitEnhanced,
    onSegChunk: onSegChunk,

    setPermGranted: function (v) { permGranted = !!v; updateModeUI(); },
    setHookInstalled: function (v) { hookInstalled = !!v; updateModeUI(); }
  };
})();
