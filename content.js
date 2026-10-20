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

  function showToast(text) {
    hideToast();

    /* 上一次注入留下的提示可能还在页面上，先清掉再建 */
    const stale = document.getElementById('audio-delay-sync-toast');
    if (stale) { try { stale.remove(); } catch (e) {} }

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
          background: rgba(20, 14, 14, .96);
          border: 1px solid rgba(248, 81, 73, .45);
          box-shadow: 0 8px 28px rgba(0, 0, 0, .45);
          color: #e6edf3;
          font-size: 12.5px;
          line-height: 1.55;
        }
        .bar {
          width: 2px;
          align-self: stretch;
          border-radius: 1px;
          background: #f85149;
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
        background: linear-gradient(to right,
          rgba(34,211,238,.85) 0, rgba(34,211,238,.85) var(--fill, 0%),
          rgba(255,255,255,.12) var(--fill, 0%), rgba(255,255,255,.12) 100%);
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
        <input type="range" min="0" max="10000" step="100" value="0" data-el="slider">
        <div class="steps">
          <button data-step="-1000">−1s</button>
          <button data-step="-100">−100</button>
          <button data-step="0">归零</button>
          <button data-step="100">+100</button>
          <button data-step="1000">+1s</button>
        </div>
        <div class="meter"><div class="bar" data-el="bar"></div></div>
        <div class="foot">
          <span class="tip" data-el="tip">悬停面板后 ←→ 微调 100ms</span>
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

  /* ---------------- 渲染 ---------------- */

  function clampMs(v) {
    const n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.min(MAX_MS, Math.max(0, Math.round(n)));
  }

  function setValue(ms) {
    currentMs = clampMs(ms);
    slider.value = String(currentMs);
    num.textContent = (currentMs / 1000).toFixed(3);
    num.className = 'num' + (currentMs > 0 ? ' pos' : '');
    slider.style.setProperty('--fill', (currentMs / MAX_MS * 100).toFixed(1) + '%');
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
      chrome.runtime.sendMessage({ target: 'sw', type: 'stop' }).catch(function () {});
      destroy();
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
    toast: showToast
  };
  window.__adsPanel = api;

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
  tip.textContent = '悬停面板后 ←→ 微调 100ms';

  /* 面板有可能比 panel-show 消息更晚就绪，主动拉一次真实状态。
     如果那边其实已经没在接管，就不要再挂个空面板误导人。 */
  chrome.runtime.sendMessage({ target: 'sw', type: 'getState' })
    .then(function (st) {
      if (st && st.active) {
        api.reveal();
        setValue(st.delayMs || 0);
        if (typeof st.rms === 'number') paintMeter(st.rms);
      } else {
        destroy();
      }
    })
    .catch(function () {});
})();
