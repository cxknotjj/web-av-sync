'use strict';

/* ================================================================
 * 三条链路：音频到底从哪儿来
 *
 *   ① mse     页面自己用 MSE（hls.js / shaka），直接复用它的 appendBuffer 片段
 *   ② capture 原生 HLS，切片不经过 JS，靠调试协议把字节取回来，再用 mux.js 转 fMP4
 *   ③ src     直连媒体，同一条流再拉一路，浏览器自己解码（多一倍流量）
 *
 * 三条链路只是「音频从哪来」不同，同步循环完全共用（见 ads-enh-sync.js）。
 * 选哪条由 ads-enh-core.js 的 pickRoute() 决定，这里只负责把它跑起来。
 *
 * 依赖：core（状态、队列）、panel（链路指示条）、life（落定 / 收尾）
 * ================================================================ */

(function () {
  window.ADS = window.ADS || {};
  const E = window.ADS.E;

  /* 每个文件都得自己挡重复注入，理由见 ads-enh-core.js 顶部 */
  if (!E || !E.core || E.route) return;

  const S = E.S;
  const C = E.C;
  const { pickVideo, pageKind } = window.ADS.detect;
  const { pump, pickRoute, whyNoEnhanced, pageIsMSE, resetStream, resetSamples,
    wantTime, trySetAudioPos } = E.core;
  const { paintRoute } = E.panel;
  const L = E.life;

  function startMseReuse(v) {
    S.enhMode = 'mse';
    S.videoEl = v;
    paintRoute();

    S.enhAudio = document.createElement('audio');
    S.enhAudio.style.display = 'none';
    document.documentElement.appendChild(S.enhAudio);

    S.enhMS = new MediaSource();
    /* 标记一下，inject-main 那边看到就会跳过，避免自己截自己 */
    S.enhMS.__adsOwn = true;
    S.enhAudio.src = URL.createObjectURL(S.enhMS);

    S.enhGuard = setTimeout(function () {
      L.fail('没截到可用的音频数据，已放弃双向模式，视频声音保持原样。');
    }, 4000);

    /* 两个事件都等：loadedmetadata 可能先到但 buffer 还空着，
       canplay 才是「真的能出声」，所以只在有数据时才落定。 */
    const tryReady = function () {
      if (!S.enhGuard) return;
      if (S.enhAudio.buffered.length || isFinite(S.enhAudio.duration)) L.ready();
    };
    S.enhAudio.addEventListener('loadedmetadata', tryReady);
    S.enhAudio.addEventListener('canplay', tryReady);

    S.enhMS.addEventListener('sourceopen', function () {
      try {
        S.enhBuf = S.enhMS.addSourceBuffer(S.audioMime || 'audio/mp4; codecs="mp4a.40.2"');
        S.enhBuf.addEventListener('updateend', function () { S.trimBusy = false; pump(); });
        for (const c of S.chunks) S.appendQueue.push(c);
        pump();
      } catch (e) {
        L.fail('音频轨初始化失败：' + ((e && e.message) || e));
      }
    });
  }

  function startNativeCapture(v) {
    S.enhMode = 'capture';
    S.videoEl = v;
    S.capInitDone = false;
    S.capBytes = 0;
    /* 链路② 不走「按住画面等缓冲」那套，这三个字段必须归位：
       audioSilent 是这一轮自己的静音标记，capSeekBytes 是跳转后的字节基准，
       seekAt 留着旧值会让 captureTick 一上来就判定「已经等了 15 秒」而误降级。 */
    S.audioSilent = false;
    S.silentSince = 0;
    S.capSeekBytes = 0;
    S.seekAt = 0;
    /* 新一轮接管：时间轴、切片目录、提示状态一起归零 */
    resetStream();
    S.cap.lock(v.currentSrc || v.src);
    paintRoute();

    let fellBack = false;
    const fallback = function () {
      if (fellBack) return;
      fellBack = true;
      const keep = S.videoEl;
      /* 降级要留痕：不弹一次提示的话，用户只会看到流量翻倍却不知道为什么 */
      S.routeWhy = '抓切片失败（调试器被占用，或页面上没有新的切片请求），已自动降级';
      L.fail(null, function () { if (keep) startViaSrc(keep); });
      if (S.ui) S.ui.showToast('没抓到切片，已改为重新拉一路（约多一倍流量）');
    };

    S.enhAudio = document.createElement('audio');
    S.enhAudio.style.display = 'none';
    document.documentElement.appendChild(S.enhAudio);

    S.enhMS = new MediaSource();
    S.enhAudio.src = URL.createObjectURL(S.enhMS);

    /* 12 秒还抓不到就退到「再拉一路」。中间过程对用户不可见。
       captureStop 由 fallback → enhFail 统一发，这里不要重复发。 */
    S.enhGuard = setTimeout(fallback, 12000);

    S.enhMS.addEventListener('sourceopen', function () {
      try {
        S.enhBuf = S.enhMS.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
        S.enhBuf.addEventListener('updateend', function () { S.trimBusy = false; pump(); });
      } catch (e) {
        fallback();
      }
    });

    chrome.runtime.sendMessage({ target: 'sw', type: 'captureStart', baseDir: S.cap.dir })
      .then(function (r) { if (!r || !r.ok) fallback(); })
      .catch(function () { fallback(); });
  }

  function startViaSrc(v) {
    S.enhMode = 'src';
    S.videoEl = v;
    S.capBytes = 0;
    /* ③ 不抓切片，时间轴和提示状态一起重置 */
    resetStream();
    paintRoute();

    S.enhAudio = document.createElement('audio');
    S.enhAudio.style.display = 'none';
    document.documentElement.appendChild(S.enhAudio);
    S.enhAudio.src = v.currentSrc || v.src;

    /* 放宽到 15 秒：CDN 对第二路请求偶尔会长时间不吐数据（实测过），
       10 秒会误判失败。 */
    S.enhGuard = setTimeout(function () {
      L.fail('音频流加载超时，已放弃双向模式，视频声音保持原样。');
    }, 15000);

    const tryReady = function () {
      if (!S.enhGuard) return;
      if (S.enhAudio.buffered.length || isFinite(S.enhAudio.duration)) L.ready();
    };
    S.enhAudio.addEventListener('loadedmetadata', tryReady);
    S.enhAudio.addEventListener('canplay', tryReady);
  }

  /* ---------------- 链路② 的转换层 ----------------
   * Transmuxer 单例：构造一次要初始化整条 demux 管线，直播场景每 2~5 秒一片，
   * 每片 new 一个是纯浪费。mux.js 的实例设计上就支持 push/flush 循环使用。
   * 事件只绑一次，输出写进 S.muxOut；一旦 push/flush 抛错就整个重建 ——
   * 内部状态可能被半片数据污染，续用会错乱。 */

  function getMuxer() {
    if (S.muxer) return S.muxer;
    try {
      S.muxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true, remux: false });
      S.muxer.on('data', function (seg) {
        if (!S.muxOut || seg.type !== 'audio') return;
        if (!S.capInitDone && seg.initSegment && seg.initSegment.byteLength) S.muxOut.init = seg.initSegment;
        if (seg.data && seg.data.byteLength) S.muxOut.data = seg.data;
      });
    } catch (e) {
      S.muxer = null;
    }
    return S.muxer;
  }

  function onSegChunk(msg) {
    if (S.enhMode !== 'capture' || !S.enhBuf) return;

    /* ---- 只认主切片 ----
       广告插播时播放器会改拉一条完全不同的切片路径（实测 5:00 站点拉的是
       /video/adjump/time/178…ts，正片是 /video/<剧集>/<id>/0000…ts）。
       广告切片带着另一条时间轴，喂给同一个 muxer 会把解复用状态带跑：
       之后正片切片再进来也解不出音频，表现就是「过 5:00 一直音频重新加载中」。
       判断和提示都收在 S.cap 里，这里只按返回值分流。 */
    const kind = S.cap.classify(msg.url);
    if (kind === 'ad') return;
    /* 正片切片回来了：广告期间 muxer 没被喂过异源数据，但中间空了一段，
       重建一次最稳；样本基线也重取（偏移值本身保留，正片时间轴没变）。 */
    if (kind === 'back') {
      S.muxer = null;
      /* 广告把页面时间轴整体推后了一个广告时长，旧 PTS 偏移作废。
         接下来等两边缓冲静止，由 samplePtsOffset 重新量一次。
         注意顺序：resetSamples 只清基线，窗口要在它之后立。 */
      resetSamples();
      S.adResampleUntil = Date.now() + C.AD_RESAMPLE_MS;
      /* 广告这段静音不算「等不到数据」，从正片回来的这一拍重新计时 */
      if (S.audioSilent) S.silentSince = Date.now();
      /* 广告期间正片音轨不会下载，回来时通常已经落后画面一大截（实测 15s+）。
         这段落后没有追的必要：音频直接站到画面该播的位置，等切片续上；
         不站过去的话，缓冲只能以略高于 1 倍速往前赶，永远追不回画面。 */
      if (S.enhAudio) {
        const aim = wantTime();
        if (isFinite(aim) && Math.abs(S.enhAudio.currentTime - aim) > 1) {
          /* 允许接下来一段时间内跳到「还没缓冲到」的画面位置（平时不允许） */
          S.cap.catchUpUntil = Date.now() + C.AD_CATCHUP_MS;
          trySetAudioPos(aim);
        }
      }
    }

    /* seek 之前发出的切片请求：那些字节属于用户已经跳过的那一段，
       再 append 进来只会白占 MSE 缓冲（「强制缓存跳过内容」的另一半来源）。
       30ms 容差留给同一毫秒的边界。 */
    if (S.seekAt && msg.at && msg.at < S.seekAt - 30) return;

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
    S.muxOut = { init: null, data: null };
    try {
      t.push(buf);
      t.flush();
    } catch (e) {
      S.muxer = null;      /* 状态可能被半片数据污染，重建 */
      S.muxOut = null;
      return;
    }
    const init = S.muxOut && S.muxOut.init;
    const data = S.muxOut && S.muxOut.data;
    S.muxOut = null;

    /* init segment 只 append 第一次：同一路流的编码参数不会变，
       重复 append 会让 SourceBuffer 报错。 */
    if (init) { S.appendQueue.push(init); S.capInitDone = true; }
    if (data) {
      S.appendQueue.push(data);
      S.capBytes += data.byteLength;
      /* 数据在源源不断地来：静音只可能是位置还没追上缓冲，不能按「抓不到」降级 */
      S.cap.noteAudio();
    }
    pump();

    if (!S.enhanced && data) {
      setTimeout(function () {
        if (!S.enhanced && S.enhAudio && S.enhAudio.buffered.length) L.ready();
      }, 300);
    }
  }

  function enterEnhanced() {
    const v = pickVideo();
    if (!v) {
      if (S.ui) S.ui.showToast('这个页面没有找到视频元素');
      return;
    }

    /* 每次重新进双向都给缓冲一次机会：也许这回站点的下载跟得上了 */
    S.stallGiveUps = 0;

    const kind = pageKind();
    const route = pickRoute(kind);
    S.routeWhy = '';   /* 每轮重新判断，别把上一轮的降级原因带过来 */

    /* ① 页面自己在用 MSE（hls.js / shaka），切片已经躺在 appendBuffer 里了 */
    if (route === 'mse') { startMseReuse(v); return; }

    /* ② 原生 HLS：没有 appendBuffer 可钩，只能走调试协议 */
    if (route === 'capture') { startNativeCapture(v); return; }

    /* ③ 直连媒体：自己再拉一路 */
    if (route === 'src') {
      /* 记下为什么没走更省的链路 —— 这两种情况代价差一倍，用户有权知道 */
      S.routeWhy = kind === 'direct'
        ? '页面是直连媒体（.mp4 / 非 m3u8），没有切片可抓，只能重新拉一路'
        : '有 m3u8 但取不到切片数据';
      startViaSrc(v);
      return;
    }

    if (S.ui) {
      S.ui.showToast(S.hookReady
        ? '音频片段还没攒到，先让视频播放几秒再试。'
        : (pageIsMSE() ? '还没截到音频轨，先让视频播放几秒再点。' : whyNoEnhanced()));
    }
  }

  E.route = {
    enterEnhanced: enterEnhanced,
    onSegChunk: onSegChunk,
    /* 降级入口。sync 那边发现「跳转后一条新切片都抓不到」时要换到这条，
       但 sync 在 route 之后加载、只单向依赖 core，所以从这里露出去。 */
    startViaSrc: startViaSrc
  };
})();
