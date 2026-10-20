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
  let enhGuard = null;        /* 试运行超时计时器，非 null 表示还在「未落定」阶段 */
  let capInitDone = false;    /* 调试通道下，init segment 只需 append 一次 */
  let capBytes = 0;           /* 已经解出多少音频字节，用来判断「真有数据了」 */

  /* ---------------- 页面探测 ---------------- */
  function pickVideo() {
    let best = null;
    let bestArea = 0;
    document.querySelectorAll('video').forEach(function (v) {
      const area = (v.clientWidth || 0) * (v.clientHeight || 0);
      if (area > bestArea) { bestArea = area; best = v; }
    });
    return best || document.querySelector('video');
  }

  /** 页面的播放方式。区分 hls / direct 是为了给准原因——
   *  两者对双向模式的处理不一样，但为什么不行也不一样。 */
  function pageKind() {
    const v = pickVideo();
    if (!v) return 'none';

    /* 少数播放器把 MediaSource 挂到 srcObject，地址栏里看不到 blob: */
    try {
      if (v.srcObject) {
        if (typeof MediaSource !== 'undefined' && v.srcObject instanceof MediaSource) return 'mse';
        return 'stream';   /* MediaStream：captureStream / WebRTC，同样没有 appendBuffer */
      }
    } catch (e) {}

    const src = String(v.currentSrc || v.src || '');
    /* 还没开始加载时两个字段都是空的，此时既不是 MSE 也不是原生 HLS，不能乱下结论 */
    if (!src) return 'unknown';
    if (src.indexOf('blob:') === 0) return 'mse';
    if (/m3u8/i.test(src)) return 'hls';
    return 'direct';
  }

  function pageIsMSE() {
    return pageKind() === 'mse';
  }

  /** 这次会走哪条链路。面板预告和真正分派共用这一份判断，
   *  否则两边各写一套，早晚会说「预告走 ①」然后实际跑 ③。 */
  function pickRoute(kind) {
    if (hookReady && chunks.length) return 'mse';
    if (kind === 'hls' && typeof muxjs !== 'undefined') return 'capture';
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

  function pump() {
    if (!enhBuf || enhBuf.updating || !appendQueue.length) return;
    if (enhMS && enhMS.readyState !== 'open') return;
    const next = appendQueue.shift();
    try {
      enhBuf.appendBuffer(next);
    } catch (e) {
      /* 片段被拒（时间戳不连续之类）就丢掉，别让队列卡死 */
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

  function syncTick() {
    if (!enhanced || !videoEl || !enhAudio) return;
    pump();
    /* 顺手把「还能提前多少」刷到面板上 */
    paintRouteMeta();

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
    if (bufferedHas(want)) {
      if (Math.abs(enhAudio.currentTime - want) > 0.04) {
        try { enhAudio.currentTime = want; } catch (e) {}
      }
      return;
    }

    /* 目标位置还没缓冲到。离得远就先 seek 过去 —— media element 的 seek
       会自己驱动加载那一段；离得近就原地等缓冲追上，别来回跳。 */
    if (Math.abs(enhAudio.currentTime - want) > 2.5) {
      try { enhAudio.currentTime = want; } catch (e) {}
    }
  }

  function currentMs() {
    return ui ? ui.getValue() : 0;
  }

  /* ---------------- 收尾 / 落定 ---------------- */

  /** 收尾：拆掉音频元素，视频恢复原声。msg 为空则不打扰用户。 */
  function enhFail(msg, then) {
    if (enhGuard) { clearTimeout(enhGuard); enhGuard = null; }

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
    enhMode = '';
    enhanced = false;

    if (videoEl) {
      try { videoEl.muted = false; } catch (e) {}
      videoEl = null;
    }

    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    if (ui) ui.setEnhanced(false);

    updateModeUI();
    if (msg && ui) ui.showToast(msg);
    if (typeof then === 'function') then();
  }

  /** 落定：确认音频真的解出了数据，才敢把视频静音 */
  function enhReady() {
    if (!videoEl || !enhAudio || enhanced) return;
    if (enhGuard) { clearTimeout(enhGuard); enhGuard = null; }

    try { videoEl.muted = true; } catch (e) {}
    enhanced = true;

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
        enhBuf.addEventListener('updateend', pump);
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

    const fallback = function () {
      const keep = videoEl;
      enhFail(null, function () { if (keep) startViaSrc(keep); });
    };

    enhAudio = document.createElement('audio');
    enhAudio.style.display = 'none';
    document.documentElement.appendChild(enhAudio);

    enhMS = new MediaSource();
    enhAudio.src = URL.createObjectURL(enhMS);

    /* 12 秒还抓不到就退到「再拉一路」。中间过程对用户不可见。 */
    enhGuard = setTimeout(function () {
      chrome.runtime.sendMessage({ target: 'sw', type: 'captureStop' }).catch(function () {});
      fallback();
    }, 12000);

    enhMS.addEventListener('sourceopen', function () {
      try {
        enhBuf = enhMS.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
        enhBuf.addEventListener('updateend', pump);
      } catch (e) {
        fallback();
      }
    });

    chrome.runtime.sendMessage({ target: 'sw', type: 'captureStart' })
      .then(function (r) { if (!r || !r.ok) fallback(); })
      .catch(function () { fallback(); });
  }

  /** 调试通道送来一片 ts：demux 出音频轨，灌进 MSE */
  function onSegChunk(msg) {
    if (enhMode !== 'capture' || !enhBuf) return;

    let buf = null;
    try {
      if (msg.b64) {
        const bin = atob(msg.b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        buf = u8;
      }
    } catch (e) { return; }
    if (!buf || !buf.length) return;

    /* remux:false 才会把音轨单独吐出来。默认的 combined 段里含 avc1，
       audio/mp4 的 SourceBuffer 会直接拒收。 */
    let init = null, data = null;
    try {
      const t = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true, remux: false });
      t.on('data', function (seg) {
        if (seg.type !== 'audio') return;
        if (!capInitDone && seg.initSegment && seg.initSegment.byteLength) init = seg.initSegment;
        if (seg.data && seg.data.byteLength) data = seg.data;
      });
      t.push(buf);
      t.flush();
    } catch (e) { return; }

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

    const route = pickRoute(pageKind());

    /* ① 页面自己在用 MSE（hls.js / shaka），切片已经躺在 appendBuffer 里了 */
    if (route === 'mse') { startMseReuse(v); return; }

    /* ② 原生 HLS：没有 appendBuffer 可钩，只能走调试协议 */
    if (route === 'capture') { startNativeCapture(v); return; }

    /* ③ 直连媒体：自己再拉一路 */
    if (route === 'src') { startViaSrc(v); return; }

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

    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }

    if (videoEl) {
      try { videoEl.muted = false; } catch (e) {}
      videoEl = null;
    }

    enhanced = false;
    if (ui) {
      ui.setEnhanced(false);
      if (ui.getValue() < 0) ui.setValue(0);
    }
    updateModeUI();
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
      id: r.id,
      /* 「将用」是给还没点的用户看的，分清预告和生效 */
      name: enhMode ? r.name : '将用 ' + r.name,
      /* 链路选定了但还没出声（在等数据、等降级），别让用户以为已经生效 */
      meta: enhMode && !enhanced ? '连接中…' : r.meta,
      hint: r.hint,
      on: enhanced
    });

    if (enhanced) paintRouteMeta();
  }

  /** 右侧那截动态数字：音频已经缓冲到画面之后多少秒，也就是最多还能提前多少。
   *  三条链路喂进 MSE 时都保留了原始时间戳，所以可以直接和 video.currentTime 相减。 */
  function paintRouteMeta() {
    if (!ui || !enhAudio || !videoEl) return;
    const r = ROUTES[enhMode];
    if (!r) return;

    const b = enhAudio.buffered;
    const ahead = b.length ? Math.max(0, b.end(b.length - 1) - videoEl.currentTime) : 0;
    ui.setRouteMeta(r.meta + ' · 可提前 ' + ahead.toFixed(1) + 's');
  }

  function paintModeUI() {
    if (!ui) return;

    ui.setTip(enhanced ? '负值让声音提前 · 滚轮可调' : '只延后声音 · 滚轮可调');
    ui.setModeTag(enhanced ? '双向' : '延迟', enhanced);
    paintRoute();

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
      ui.setModeBtn('启用双向', (typeof muxjs !== 'undefined')
        ? '原生 HLS：先用调试协议取回播放器已下载的切片，不额外耗流量（浏览器顶部会提示正在调试）；取不到时自动改为重新拉一路'
        : '原生 HLS：用同一条流再播一遍（浏览器直接解码），支持负值（声音提前）。会多用一倍流量', false);
      return;
    }

    if (kind === 'direct') {
      ui.setModeBtn('启用双向', '用同一条流的音频再播一遍（浏览器直接解码），支持负值（声音提前）。会多用一倍流量', false);
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

      window.addEventListener('message', onPageMessage);
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
    kind: pageKind,
    pickVideo: pickVideo,
    updateModeUI: updateModeUI,
    exit: exitEnhanced,
    onSegChunk: onSegChunk,

    setPermGranted: function (v) { permGranted = !!v; updateModeUI(); },
    setHookInstalled: function (v) { hookInstalled = !!v; updateModeUI(); }
  };
})();
