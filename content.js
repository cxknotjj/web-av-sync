'use strict';

/* ================================================================
 * 页面内悬浮面板
 *
 * 为什么需要它：popup 一失焦就关，全屏看片时根本打不开。
 * 面板挂在页面里，拖动滑块才能随手可用。
 *
 * 用 Shadow DOM 隔离：页面自己的 CSS 再野也污染不进来。
 * ================================================================ */

(function () {
  /* 重复注入时直接复用，避免叠出好几个面板 */
  if (window.__adsPanel) {
    try { window.__adsPanel.reveal(); } catch (e) {}
    return;
  }

  const HOST_ID = 'audio-delay-sync-panel';
  const MAX_MS = 10000;
  /* 双向模式才有负半轴：tabCapture 拿的是播放输出，没有未来样本 */
  const MIN_ENH_MS = -10000;

  /* ---------------- 错误提示 ----------------
   * 与主面板完全独立：接管失败时主面板会因 getState 返回 inactive 而自我
   * 销毁，提示必须活下来，否则用户点了图标什么都没发生，完全无从排查。
   */

  let toastEl = null;
  let toastTimer = null;

  function hideToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (toastEl) {
      try { toastEl.remove(); } catch (e) {}
      toastEl = null;
    }
  }

  function showToast(text, kind) {
    hideToast();

    /* 上一次注入留下的提示可能还在页面上，先清掉再建 */
    const stale = document.getElementById('audio-delay-sync-toast');
    if (stale) { try { stale.remove(); } catch (e) {} }

    const ok = kind === 'ok';
    const accent = ok ? '#3fb950' : '#f85149';
    const bg = ok ? 'rgba(10, 18, 13, .96)' : 'rgba(20, 14, 14, .96)';
    const edge = ok ? 'rgba(63, 185, 80, .45)' : 'rgba(248, 81, 73, .45)';

    const wrap = document.createElement('div');
    wrap.id = 'audio-delay-sync-toast';
    const sh = wrap.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          top: 20px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        }
        .toast {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          max-width: 460px;
          padding: 11px 12px 11px 14px;
          border-radius: 9px;
          background: ${bg};
          border: 1px solid ${edge};
          box-shadow: 0 8px 28px rgba(0, 0, 0, .45);
          color: #e6edf3;
          font-size: 12.5px;
          line-height: 1.55;
        }
        .bar {
          width: 2px;
          align-self: stretch;
          border-radius: 1px;
          background: ${accent};
          flex: none;
        }
        .txt { flex: 1; user-select: text; }
        .x {
          flex: none;
          width: 18px;
          height: 18px;
          padding: 0;
          border: 0;
          border-radius: 4px;
          background: transparent;
          color: #8b949e;
          font-size: 14px;
          line-height: 1;
          cursor: pointer;
          font-family: inherit;
        }
        .x:hover { background: rgba(255, 255, 255, .1); color: #e6edf3; }
      </style>
      <div class="toast">
        <span class="bar"></span>
        <span class="txt"></span>
        <button class="x" type="button" title="关闭">×</button>
      </div>
    `;

    sh.querySelector('.txt').textContent = text;
    sh.querySelector('.x').addEventListener('click', hideToast);
    document.documentElement.appendChild(wrap);
    toastEl = wrap;

    toastTimer = setTimeout(hideToast, 7000);
  }

  let currentMs = 0;
  let collapsed = false;
  let dragging = false;
  let dragDX = 0;
  let dragDY = 0;

  /* ---------------- 双向模式状态 ----------------
   * chunks 缓存页面自己拉到的音频片段。限制总字节数，避免长片把内存吃满。
   */
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
  const MAX_CHUNK_BYTES = 48 * 1024 * 1024;
  let enhMS = null;
  let enhAudio = null;
  let enhBuf = null;
  let appendQueue = [];
  let syncTimer = null;
  let videoEl = null;

  const host = document.createElement('div');
  host.id = HOST_ID;
  /* 先藏着，等确认真的在接管再显形。
     否则接管失败时面板会闪一下再消失，看着像 bug。 */
  host.style.display = 'none';

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        -webkit-font-smoothing: antialiased;
      }

      .panel {
        width: 268px;
        border-radius: 10px;
        background: rgba(15, 18, 22, .94);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, .09);
        box-shadow: 0 8px 28px rgba(0, 0, 0, .45);
        color: #e6edf3;
        overflow: hidden;
        user-select: none;
      }

      .head {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        cursor: move;
        background: rgba(255, 255, 255, .03);
        border-bottom: 1px solid rgba(255, 255, 255, .06);
      }

      .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #3fb950;
        flex: none;
      }

      .title {
        font-size: 11.5px;
        font-weight: 500;
        letter-spacing: .2px;
        color: #e6edf3;
      }

      .grow { flex: 1; }

      .icon {
        width: 18px;
        height: 18px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: #8b949e;
        cursor: pointer;
        font-size: 13px;
        line-height: 1;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: inherit;
      }

      .icon:hover { background: rgba(255, 255, 255, .08); color: #e6edf3; }

      .body { padding: 10px 12px 11px; }

      .panel.collapsed .body { display: none; }

      .readout {
        display: flex;
        align-items: baseline;
        justify-content: center;
        gap: 3px;
        margin-bottom: 8px;
      }

      .num {
        font: 500 25px/1.1 ui-monospace, "SF Mono", Consolas, monospace;
        font-variant-numeric: tabular-nums;
        letter-spacing: -.5px;
        color: #8b949e;
        transition: color .18s;
      }

      .num.pos { color: #22d3ee; }

      .unit { font-size: 11px; color: #6b7280; }

      input[type="range"] {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 16px;
        background: transparent;
        cursor: pointer;
        display: block;
        margin: 0;
      }

      input[type="range"]::-webkit-slider-runnable-track {
        height: 3px;
        border-radius: 2px;
        /* 两段填充：从 0 点向上界画，negative 时就是中点往左 */
        background: linear-gradient(to right,
          rgba(255,255,255,.12) 0%, rgba(255,255,255,.12) var(--lo, 50%),
          rgba(34,211,238,.85) var(--lo, 50%), rgba(34,211,238,.85) var(--hi, 50%),
          rgba(255,255,255,.12) var(--hi, 50%), rgba(255,255,255,.12) 100%);
      }

      input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 12px;
        height: 12px;
        margin-top: -4.5px;
        border-radius: 50%;
        background: #e6edf3;
        border: 2px solid #22d3ee;
      }

      .steps {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 4px;
        margin: 8px 0 0;
      }

      .steps button {
        padding: 4px 0;
        font-size: 10.5px;
        color: #8b949e;
        background: rgba(255, 255, 255, .05);
        border: 1px solid rgba(255, 255, 255, .07);
        border-radius: 4px;
        cursor: pointer;
        font-family: inherit;
      }

      .steps button:hover { color: #e6edf3; background: rgba(255, 255, 255, .1); }

      .mode {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 7px 0 0;
      }

      .mode-tag {
        padding: 2px 7px;
        border-radius: 4px;
        background: rgba(255, 255, 255, .06);
        color: #8b949e;
        font-size: 10px;
      }

      .mode-tag.enh {
        background: rgba(34, 211, 238, .16);
        color: #22d3ee;
      }

      .mode-btn {
        margin-left: auto;
        padding: 3px 9px;
        font-size: 10px;
        font-family: inherit;
        color: #8b949e;
        background: transparent;
        border: 1px solid rgba(255, 255, 255, .12);
        border-radius: 4px;
        cursor: pointer;
      }

      .mode-btn:hover { color: #e6edf3; border-color: rgba(255, 255, 255, .26); }
      .mode-btn[hidden] { display: none; }

      .meter {
        height: 2px;
        margin-top: 9px;
        border-radius: 1px;
        background: rgba(255, 255, 255, .07);
        overflow: hidden;
      }

      .bar {
        height: 100%;
        width: 0;
        background: #3fb950;
        transition: width .12s linear;
      }

      .foot {
        display: flex;
        align-items: center;
        margin-top: 9px;
        gap: 8px;
      }

      .tip {
        font-size: 10px;
        color: #6b7280;
        flex: 1;
        line-height: 1.4;
      }

      .stop {
        padding: 4px 10px;
        font-size: 10.5px;
        color: #f85149;
        background: transparent;
        border: 1px solid rgba(248, 81, 73, .35);
        border-radius: 4px;
        cursor: pointer;
        font-family: inherit;
        flex: none;
      }

      .stop:hover { background: rgba(248, 81, 73, .1); }
    </style>

    <div class="panel">
      <div class="head">
        <span class="dot"></span>
        <span class="title">音画偏移</span>
        <span class="grow"></span>
        <button class="icon" data-act="collapse" title="收起">−</button>
        <button class="icon" data-act="close" title="停止并关闭">×</button>
      </div>
      <div class="body">
        <div class="readout">
          <span class="num" data-el="num">0.000</span>
          <span class="unit">s</span>
        </div>
        <input type="range" min="-10000" max="10000" step="100" value="0" data-el="slider">
        <div class="steps">
          <button data-step="-1000">−1s</button>
          <button data-step="-100">−100</button>
          <button data-step="0">归零</button>
          <button data-step="100">+100</button>
          <button data-step="1000">+1s</button>
        </div>
        <div class="mode">
          <span class="mode-tag" data-el="modeTag">延迟</span>
          <button class="mode-btn" data-act="mode" data-el="modeBtn" hidden>启用双向</button>
        </div>
        <div class="meter"><div class="bar" data-el="bar"></div></div>
        <div class="foot">
          <span class="tip" data-el="tip">滚轮 / ←→ 微调 100ms</span>
          <button class="stop" data-act="stop">停止</button>
        </div>
      </div>
    </div>
  `;

  const panel = shadow.querySelector('.panel');
  const head = shadow.querySelector('.head');
  const slider = shadow.querySelector('[data-el="slider"]');
  const num = shadow.querySelector('[data-el="num"]');
  const bar = shadow.querySelector('[data-el="bar"]');
  const tip = shadow.querySelector('[data-el="tip"]');
  const modeTag = shadow.querySelector('[data-el="modeTag"]');
  const modeBtn = shadow.querySelector('[data-el="modeBtn"]');

  /* ---------------- 渲染 ---------------- */

  function clampMs(v) {
    const n = Number(v);
    if (!isFinite(n)) return 0;
    /* 只有双向模式才放行负值：tabCapture 没有未来样本，负延迟是假的 */
    const lo = enhanced ? MIN_ENH_MS : 0;
    return Math.min(MAX_MS, Math.max(lo, Math.round(n)));
  }

  function setValue(ms) {
    currentMs = clampMs(ms);
    slider.value = String(currentMs);
    num.textContent = (currentMs / 1000).toFixed(3);
    num.className = 'num' + (currentMs !== 0 ? ' pos' : '');
    /* 滑块物理范围固定 -10000..10000，0 点落在 50% */
    const pct = (currentMs + 10000) / 20000 * 100;
    slider.style.setProperty('--lo', Math.min(pct, 50).toFixed(2) + '%');
    slider.style.setProperty('--hi', Math.max(pct, 50).toFixed(2) + '%');
  }

  function paintMeter(rms) {
    const v = Number(rms) || 0;
    const level = Math.min(1, Math.sqrt(v / 0.2));
    bar.style.width = (level * 100).toFixed(1) + '%';
  }

  /* ---------------- 下发（节流） ---------------- */

  let pendingMs = null;
  let sendTimer = null;

  function queueDelay(ms) {
    /* 双向模式不走 tabCapture，延迟只作用于本地那条 audio 轨，不用通知 SW */
    if (enhanced) return;
    pendingMs = ms;
    if (sendTimer) return;
    sendTimer = setTimeout(flush, 50);
  }

  function flush() {
    sendTimer = null;
    const ms = pendingMs;
    pendingMs = null;
    if (ms == null) return;
    chrome.runtime.sendMessage({ target: 'sw', type: 'setDelay', delayMs: ms })
      .catch(function () {});
  }

  /* ---------------- 交互 ---------------- */

  slider.addEventListener('input', function () {
    setValue(Number(slider.value));
    queueDelay(currentMs);
  });

  shadow.querySelectorAll('[data-step]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const d = Number(btn.getAttribute('data-step')) || 0;
      setValue(d === 0 ? 0 : currentMs + d);
      queueDelay(currentMs);
    });
  });

  shadow.addEventListener('click', function (e) {
    const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
    if (!act) return;

    if (act === 'collapse') {
      collapsed = !collapsed;
      panel.classList.toggle('collapsed', collapsed);
      e.target.textContent = collapsed ? '+' : '−';
      return;
    }
    if (act === 'stop' || act === 'close') {
      if (enhanced) exitEnhanced();
      chrome.runtime.sendMessage({ target: 'sw', type: 'stop' }).catch(function () {});
      destroy();
      return;
    }
    if (act === 'mode') {
      onModeClick();
      return;
    }
  });

  /* ---------------- 键盘 ----------------
   * 只在鼠标悬停于面板时响应：页面播放器自己就拿方向键快进快退，
   * 全局监听会跟它打架，用户按一下两边都动。
   */

  let hovering = false;
  host.addEventListener('pointerenter', function () { hovering = true; });
  host.addEventListener('pointerleave', function () { hovering = false; });

  document.addEventListener('keydown', function (e) {
    if (!hovering) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/i.test(tag)) return;

    const step = e.shiftKey ? 1000 : 100;
    let next = null;

    if (e.key === 'ArrowLeft') next = currentMs - step;
    else if (e.key === 'ArrowRight') next = currentMs + step;
    else if (e.key === 'Home') next = 0;
    else return;

    e.preventDefault();
    e.stopPropagation();
    setValue(next);
    queueDelay(currentMs);
  }, true);

  /* ---------------- 滚轮 ----------------
   * 触控板一次滑动会连发几十个小 delta，必须累积到「一格」再动，
   * 否则数值会乱跳；同时要拦掉默认滚动，不然面板一动页面就跟着跑。
   */
  const WHEEL_NOTCH = 100;
  let wheelAcc = 0;
  let wheelShift = false;
  let wheelTimer = null;

  function flushWheel() {
    wheelTimer = null;
    const notches = Math.trunc(wheelAcc / WHEEL_NOTCH);
    wheelAcc -= notches * WHEEL_NOTCH;
    if (!notches) return;

    /* 向上滚 = 数值变大（声音更晚），和滑块向右拖一致 */
    const step = wheelShift ? 1000 : 100;
    setValue(currentMs - notches * step);
    queueDelay(currentMs);
  }

  host.addEventListener('wheel', function (e) {
    let d = e.deltaY;
    /* deltaMode: 0=像素 1=行 2=页，统一折算成像素 */
    if (e.deltaMode === 1) d *= 16;
    else if (e.deltaMode === 2) d *= 400;
    if (!d) return;

    e.preventDefault();
    e.stopPropagation();

    wheelShift = e.shiftKey;
    wheelAcc += d;
    if (!wheelTimer) wheelTimer = setTimeout(flushWheel, 40);
  }, { passive: false });

  /* 拖动：按住头部移动整个面板 */
  head.addEventListener('pointerdown', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('data-act')) return;
    dragging = true;
    const r = host.getBoundingClientRect();
    dragDX = e.clientX - r.left;
    dragDY = e.clientY - r.top;
    try { head.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });

  head.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    const x = Math.max(0, Math.min(window.innerWidth - host.offsetWidth, e.clientX - dragDX));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragDY));
    host.style.left = x + 'px';
    host.style.top = y + 'px';
    host.style.right = 'auto';
    host.style.bottom = 'auto';
  });

  head.addEventListener('pointerup', function () {
    dragging = false;
  });

  /* ---------------- 全屏跟随 ----------------
   * 全屏时只有 fullscreenElement 子树可见，面板挂在 body 上会消失。
   */
  function syncFullscreen() {
    const fs = document.fullscreenElement;
    const target = (fs && fs.tagName !== 'VIDEO') ? fs : document.documentElement;
    if (host.parentNode !== target) {
      try { target.appendChild(host); } catch (e) {}
    }
  }

  document.addEventListener('fullscreenchange', syncFullscreen, true);

  /* ---------------- 生命周期 ---------------- */

  function destroy() {
    if (enhanced) exitEnhanced();
    document.removeEventListener('fullscreenchange', syncFullscreen, true);
    try { host.remove(); } catch (e) {}
    window.__adsPanel = null;
  }

  const api = {
    reveal: function () {
      host.style.display = '';
      if (collapsed) {
        collapsed = false;
        panel.classList.remove('collapsed');
        shadow.querySelector('[data-act="collapse"]').textContent = '−';
      }
    },
    setDelay: setValue,
    setMeter: paintMeter,
    destroy: destroy,
    toast: showToast,
    updateMode: updateModeUI
  };
  window.__adsPanel = api;

  /* ---------------- 双向模式（复用页面 MSE 音频） ----------------
   *
   * 页面用 MSE 播放时，inject-main.js 会把每个音频片段复制一份丢过来。
   * 这里用一条只有音频的 MediaSource 接住，让浏览器自己解码出声。
   *
   * 关键：这条 audio 有自己的时钟，currentTime 可以设到 video 当前位置之后，
   * 因为 buffer 里存着「已经下载但还没播」的数据。这就是负延迟的来源。
   */

  function pickVideo() {
    let best = null;
    let bestArea = 0;
    document.querySelectorAll('video').forEach(function (v) {
      const area = (v.clientWidth || 0) * (v.clientHeight || 0);
      if (area > bestArea) { bestArea = area; best = v; }
    });
    return best || document.querySelector('video');
  }

  /** 页面的播放方式。双向模式只认 mse，其余都无从复用音频片段。
   *  区分 hls / direct 是为了给准原因 —— 两者都是「用不了」，但为什么用不了不一样。 */
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

  /** 为什么用不了双向模式。按播放方式给具体原因，而不是一律说「不支持」。 */
  function whyNoEnhanced() {
    switch (pageKind()) {
      case 'none':
        return '这个页面没有找到视频元素。';
      case 'unknown':
        return '视频还没开始加载。先点一下播放，播几秒再试。';
      case 'stream':
        return '这个页面播的是实时媒体流（MediaStream），音频不经过 MSE，双向模式用不了。延迟模式仍可用。';
      case 'hls':
        return '视频地址是 .m3u8 直连（原生 HLS），数据在浏览器内部，JS 拿不到。双向模式用不了，延迟模式仍可用。';
      default:
        return '视频是整段文件直连，音频数据不经过 MSE，双向模式用不了。延迟模式仍可用。';
    }
  }

  function pushChunk(buf) {
    if (!(buf instanceof ArrayBuffer) || !buf.byteLength) return;

    chunks.push(buf);
    chunkBytes += buf.byteLength;

    /* 太老的片段自己丢掉：留着也只会让内存一路涨上去 */
    while (chunkBytes > MAX_CHUNK_BYTES && chunks.length > 2) {
      chunkBytes -= chunks.shift().byteLength;
    }

    if (enhanced) appendChunk(buf);
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

    /* 视频暂停时音频也要停，否则声音会跑到画面前面 */
    if (videoEl.paused) {
      if (!enhAudio.paused) enhAudio.pause();
      return;
    }
    if (enhAudio.paused) enhAudio.play().catch(function () {});

    const want = videoEl.currentTime + currentMs / 1000;
    if (!bufferedHas(want)) return;
    if (Math.abs(enhAudio.currentTime - want) > 0.04) {
      try { enhAudio.currentTime = want; } catch (e) {}
    }
  }

  function enterEnhanced() {
    const v = pickVideo();
    if (!v) { showToast('这个页面没有找到视频元素'); return; }

    if (!hookReady) {
      showToast(pageIsMSE()
        ? '还没截到音频轨，先让视频播放几秒再点。'
        : whyNoEnhanced());
      return;
    }

    if (!chunks.length) {
      showToast('音频片段还没攒到，先让视频播放几秒再试。');
      return;
    }

    videoEl = v;
    enhMS = new MediaSource();
    /* 标记一下，inject-main 那边看到就会跳过，避免自己截自己 */
    enhMS.__adsOwn = true;

    enhAudio = document.createElement('audio');
    enhAudio.src = URL.createObjectURL(enhMS);
    enhAudio.style.display = 'none';
    document.documentElement.appendChild(enhAudio);

    let settled = false;

    /* 任何一步没跑通都走这里：把音频元素拆掉，视频从头到尾没被静音过 */
    function rollback(msg) {
      if (settled) return;
      settled = true;
      clearTimeout(guard);

      if (enhAudio) {
        try { enhAudio.pause(); } catch (e) {}
        try { enhAudio.removeAttribute('src'); enhAudio.load(); } catch (e) {}
        try { enhAudio.remove(); } catch (e) {}
      }
      enhAudio = null;
      enhMS = null;
      enhBuf = null;
      appendQueue = [];
      videoEl = null;
      enhanced = false;
      updateModeUI();
      showToast(msg);
    }

    /* 确认音频轨真有数据，才敢动视频的静音开关 */
    function activate() {
      if (settled) return;
      /* 没有真实数据时不要提前落定，留给后面的 canplay 再来一次 */
      if (!enhAudio || !(enhAudio.buffered.length || isFinite(enhAudio.duration))) return;

      settled = true;
      clearTimeout(guard);

      v.muted = true;
      enhanced = true;
      setValue(currentMs);
      updateModeUI();

      if (syncTimer) clearInterval(syncTimer);
      syncTimer = setInterval(syncTick, 250);
      syncTick();
    }

    /* 4 秒还没任何可播数据，说明这条轨是空的（典型：原生 HLS 页面） */
    const guard = setTimeout(function () {
      rollback('没截到可用的音频数据，已放弃双向模式，视频声音保持原样。');
    }, 4000);

    enhAudio.addEventListener('loadedmetadata', activate);
    enhAudio.addEventListener('canplay', activate);

    enhMS.addEventListener('sourceopen', function () {
      try {
        enhBuf = enhMS.addSourceBuffer(audioMime || 'audio/mp4; codecs="mp4a.40.2"');
        enhBuf.addEventListener('updateend', pump);
        for (const c of chunks) appendQueue.push(c);
        pump();
      } catch (e) {
        rollback('音频轨初始化失败：' + ((e && e.message) || e));
      }
    });
  }

  function exitEnhanced() {
    enhanced = false;
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }

    if (enhAudio) {
      try { enhAudio.pause(); } catch (e) {}
      try { enhAudio.removeAttribute('src'); enhAudio.load(); } catch (e) {}
      try { enhAudio.remove(); } catch (e) {}
    }
    enhAudio = null;
    enhMS = null;
    enhBuf = null;
    appendQueue = [];

    if (videoEl) {
      try { videoEl.muted = false; } catch (e) {}
      videoEl = null;
    }

    if (currentMs < 0) setValue(0);
    updateModeUI();
  }

  function updateModeUI() {
    if (!modeTag || !modeBtn) return;
    modeTag.textContent = enhanced ? '双向' : '延迟';
    modeTag.classList.toggle('enh', enhanced);

    if (tip) {
      tip.textContent = enhanced
        ? '负值让声音提前 · 滚轮可调'
        : '只延后声音 · 滚轮可调';
    }

    if (enhanced) {
      modeBtn.hidden = true;
      return;
    }

    modeBtn.hidden = false;

    if (hookReady) {
      modeBtn.textContent = '启用双向';
      modeBtn.title = '复用页面已经下载的音频片段，支持负值（声音提前）';
      return;
    }

    if (!hookInstalled) {
      if (permGranted) {
        modeBtn.textContent = '刷新页面生效';
        modeBtn.title = '这个站点已经授权，但当前页面加载时脚本还没注册上。刷新一次即可';
      } else {
        modeBtn.textContent = '双向需授权';
        modeBtn.title = '需要当前站点的访问权限，点一下会弹出授权框';
      }
      return;
    }

    /* 脚本装上了却没截到音频轨：要么还没开始播，要么根本不是 MSE */
    const kind = pageKind();
    if (kind === 'mse') {
      modeBtn.textContent = '等待音频轨';
      modeBtn.title = '播放器还没往 MSE 里写音频，先让视频播放几秒';
    } else if (kind === 'unknown') {
      modeBtn.textContent = '等待播放';
      modeBtn.title = '视频还没开始加载，先点一下播放';
    } else {
      modeBtn.textContent = '此页不支持双向';
      modeBtn.title = kind === 'hls'
        ? '视频地址是 .m3u8 直连（原生 HLS），数据不经过 JS'
        : '视频是直连的，音频数据不经过 MSE';
    }
  }

  async function onModeClick() {
    if (enhanced) { exitEnhanced(); return; }

    if (hookReady) { enterEnhanced(); return; }

    if (hookInstalled) {
      showToast(pageIsMSE()
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
        if (res && res.ok) {
          showToast('已重新注册，正在刷新页面…', 'ok');
        } else {
          showToast((res && res.error) || '注册失败');
        }
      } catch (e) {
        showToast('注册请求失败：' + ((e && e.message) || e));
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
      if (res && res.ok) {
        showToast('已授权，正在刷新页面…', 'ok');
      } else {
        /* needGesture 时 error 里已经写清下一步该点哪里，直接展示 */
        showToast((res && res.error) || '授权失败');
      }
    } catch (e) {
      showToast('授权请求失败：' + ((e && e.message) || e));
    }
  }

  /* MAIN world 送过来的消息：hook 就绪、音频轨信息、音频片段 */
  window.addEventListener('message', function (e) {
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
  });

  /* ---------------- 消息 ---------------- */

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.target !== 'content') return;

    if (msg.type === 'panel-show') {
      api.reveal();
      setValue(msg.delayMs || 0);
      if (typeof msg.rms === 'number') paintMeter(msg.rms);
      return;
    }

    if (msg.type === 'meter') {
      paintMeter(msg.rms);
      return;
    }

    if (msg.type === 'panel-notice') {
      showToast(msg.text || '', msg.kind);
      return;
    }

    if (msg.type === 'panel-error') {
      showToast(msg.text || '接管失败，原因未知');
      return;
    }

    if (msg.type === 'stopped') {
      destroy();
    }
  });

  syncFullscreen();
  document.documentElement.appendChild(host);

  setValue(0);
  tip.textContent = '只延后声音 · 滚轮可调';
  updateModeUI();

  /* MAIN world 可能已经先跑完了，问一次它当前截到了什么 */
  try { window.postMessage({ __ads: true, type: 'query' }, '*'); } catch (e) {}

  /* 面板有可能比 panel-show 消息更晚就绪，主动拉一次真实状态。
     如果那边其实已经没在接管，就不要再挂个空面板误导人。
     例外：被注册成增强脚本注入时（DOM 上有标记），面板要留着当双向模式的入口。 */
  chrome.runtime.sendMessage({ target: 'sw', type: 'getState' })
    .then(function (st) {
      if (st && st.active) {
        api.reveal();
        setValue(st.delayMs || 0);
        if (typeof st.rms === 'number') paintMeter(st.rms);
        return;
      }
      if (document.documentElement.dataset.adsHooked === '1') {
        hookInstalled = true;
        api.reveal();
        updateModeUI();
        return;
      }
      destroy();
    })
    .catch(function () {});

  /* 这个站点到底授权没有：决定按钮显示「双向需授权」还是「刷新页面生效」 */
  chrome.runtime.sendMessage({ target: 'sw', type: 'checkOrigin', origin: location.origin })
    .then(function (r) {
      permGranted = !!(r && r.granted);
      updateModeUI();
    })
    .catch(function () {});
})();
