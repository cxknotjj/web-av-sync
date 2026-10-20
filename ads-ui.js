'use strict';

/* ================================================================
 * 页面内悬浮面板：DOM、样式、交互
 *
 * 这一层只管「看得见、点得动」：数值显示、滑块、滚轮、键盘、拖动、
 * 全屏跟随、提示条。至于双向模式能不能开、开了走哪条链路，
 * 全部交给 ADS.enh —— 这里只负责把它的结论画出来。
 *
 * 对外接口挂在 window.ADS.ui。
 * ================================================================ */

(function () {
  const HOST_ID = 'audio-delay-sync-panel';
  const MAX_MS = 10000;
  const MIN_ENH_MS = -10000;   /* 只有双向模式才放行负半轴 */

  if (window.ADS && window.ADS.ui) {
    try { window.ADS.ui.reveal(); } catch (e) {}
    return;
  }

  window.ADS = window.ADS || {};

  const S = window.ADS_STYLE;

  /* ---------------- 提示条 ----------------
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

    const wrap = document.createElement('div');
    wrap.id = 'audio-delay-sync-toast';
    const sh = wrap.attachShadow({ mode: 'open' });
    sh.innerHTML = S.toast(kind === 'ok');

    sh.querySelector('.txt').textContent = text;
    sh.querySelector('.x').addEventListener('click', hideToast);
    document.documentElement.appendChild(wrap);
    toastEl = wrap;

    toastTimer = setTimeout(hideToast, 7000);
  }

  /* ---------------- 面板骨架 ---------------- */

  const host = document.createElement('div');
  host.id = HOST_ID;
  /* 先藏着，等确认真的在接管再显形。
     否则接管失败时面板会闪一下再消失，看着像 bug。 */
  host.style.display = 'none';

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = S.panel;

  const panel = shadow.querySelector('.panel');
  const head = shadow.querySelector('.head');
  const slider = shadow.querySelector('[data-el="slider"]');
  const num = shadow.querySelector('[data-el="num"]');
  const bar = shadow.querySelector('[data-el="bar"]');
  const tip = shadow.querySelector('[data-el="tip"]');
  const modeTag = shadow.querySelector('[data-el="modeTag"]');
  const modeBtn = shadow.querySelector('[data-el="modeBtn"]');

  /* ---------------- 状态 ---------------- */

  let currentMs = 0;
  let minMs = 0;               /* 双向模式时放开到 -10000 */
  let enhanced = false;        /* enhance 层同步过来的副本，只用于取值钳制 */
  let collapsed = false;
  let dragging = false;
  let dragDX = 0;
  let dragDY = 0;

  /* 外部挂进来的回调，避免这一层反过来依赖 enhance */
  let onDelay = null;
  let onStop = null;
  let onMode = null;

  function clampMs(v) {
    const n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.min(MAX_MS, Math.max(minMs, Math.round(n)));
  }

  /* ---------------- 渲染 ---------------- */

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

  /** 让 enhance 层把「当前算什么模式」画到牌子上 */
  function setModeTag(text, isEnh) {
    modeTag.textContent = text;
    modeTag.classList.toggle('enh', !!isEnh);
  }

  function setModeBtn(text, title, hidden) {
    modeBtn.textContent = text || '';
    modeBtn.title = title || '';
    modeBtn.hidden = !!hidden;
  }

  function setTip(text) {
    tip.textContent = text || '';
  }

  /* ---------------- 下发（节流） ---------------- */

  let pendingMs = null;
  let sendTimer = null;

  function queueDelay(ms) {
    /* 双向模式不走 tabCapture，延迟只作用于本地那条 audio 轨，不用通知 SW */
    if (enhanced) return;
    if (typeof onDelay === 'function') { onDelay(ms); return; }
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
      if (typeof onStop === 'function') onStop();
      else chrome.runtime.sendMessage({ target: 'sw', type: 'stop' }).catch(function () {});
      destroy();
      return;
    }
    if (act === 'mode') {
      if (typeof onMode === 'function') onMode();
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

  head.addEventListener('pointerup', function () { dragging = false; });

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

  function reveal() {
    host.style.display = '';
    if (collapsed) {
      collapsed = false;
      panel.classList.remove('collapsed');
      shadow.querySelector('[data-act="collapse"]').textContent = '−';
    }
  }

  function hide() {
    host.style.display = 'none';
  }

  function destroy() {
    document.removeEventListener('fullscreenchange', syncFullscreen, true);
    try { host.remove(); } catch (e) {}
    if (window.ADS) window.ADS.ui = null;
    window.__adsPanel = null;
  }

  window.ADS.ui = {
    host: host,
    shadow: shadow,

    reveal: reveal,
    hide: hide,
    destroy: destroy,

    setValue: setValue,
    getValue: function () { return currentMs; },
    paintMeter: paintMeter,
    showToast: showToast,

    setModeTag: setModeTag,
    setModeBtn: setModeBtn,
    setTip: setTip,

    /** 双向模式：放开负半轴，并告诉这一层「延迟不用再发给 SW」 */
    setEnhanced: function (on) {
      enhanced = !!on;
      minMs = on ? MIN_ENH_MS : 0;
      if (currentMs < minMs) setValue(minMs);
    },

    bind: function (handlers) {
      if (!handlers) return;
      if (handlers.delay) onDelay = handlers.delay;
      if (handlers.stop) onStop = handlers.stop;
      if (handlers.mode) onMode = handlers.mode;
    }
  };

  /* 老代码里通过 window.__adsPanel 拿到面板，保留这个别名 */
  window.__adsPanel = window.ADS.ui;

  syncFullscreen();
  document.documentElement.appendChild(host);
  setValue(0);
})();
