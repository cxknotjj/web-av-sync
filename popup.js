'use strict';

/* ================================================================
 * popup：只做三件事 —— 拿用户手势、发起接管、调节延迟
 *
 * 注意 getMediaStreamId 必须在用户手势的上下文里调用，所以它在
 * 这里执行，而不是在 service worker 里（跨进程传消息容易丢手势）。
 * ================================================================ */

const MAX_MS = 10000;
const MIN_MS = 0;

const el = {
  dot: document.getElementById('dot'),
  tag: document.getElementById('tag'),
  num: document.getElementById('num'),
  hint: document.getElementById('hint'),
  slider: document.getElementById('slider'),
  main: document.getElementById('main'),
  bar: document.getElementById('bar'),
  msg: document.getElementById('msg'),
  readout: document.querySelector('.readout')
};

let currentMs = 0;
let active = false;
let busy = false;

/* popup 一打开就把 tabId 取好：点击时若中间夹着 await，
   用户手势可能已经被消耗，getMediaStreamId 会失败。 */
let cachedTabId = null;
chrome.tabs.query({ active: true, currentWindow: true })
  .then(function (tabs) {
    if (tabs && tabs[0] && typeof tabs[0].id === 'number') cachedTabId = tabs[0].id;
  })
  .catch(function () {});

/* ---------------- 渲染 ---------------- */

function clampMs(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.min(MAX_MS, Math.max(MIN_MS, Math.round(n)));
}

function setValue(ms) {
  currentMs = clampMs(ms);
  el.slider.value = String(currentMs);
  el.num.textContent = (currentMs / 1000).toFixed(3);
  el.num.className = 'num' + (currentMs > 0 ? ' pos' : '');
  el.slider.style.setProperty('--fill', (currentMs / MAX_MS * 100).toFixed(1) + '%');
}

function paintMeter(rms) {
  const v = Number(rms) || 0;
  /* 平方根缩放：人耳对响度接近对数，线性会让小音量完全看不见 */
  const level = Math.min(1, Math.sqrt(v / 0.2));
  el.bar.style.width = (level * 100).toFixed(1) + '%';
  el.bar.style.background = level > 0.02 ? 'var(--ok)' : 'var(--faint)';
}

function showMsg(text, kind) {
  el.msg.textContent = text || '';
  el.msg.className = 'msg' + (kind ? ' ' + kind : '');
}

function renderIdle() {
  active = false;
  el.main.textContent = '接管当前标签页';
  el.main.classList.remove('stop');
  el.tag.textContent = '未接管';
  el.dot.className = 'dot';
  el.hint.textContent = '声音比画面晚多少，就往右拖';
  paintMeter(0);
}

function renderActive(ms) {
  active = true;
  setValue(ms);
  el.main.textContent = '停止接管';
  el.main.classList.add('stop');
  el.tag.textContent = '已接管';
  el.dot.className = 'dot on';
  el.hint.textContent = '拖动滑块实时生效，页面播放器不受影响';
}

function setBusy(on) {
  busy = !!on;
  el.main.disabled = busy;
  el.slider.disabled = busy;
  document.querySelectorAll('[data-step]').forEach(function (b) { b.disabled = busy; });
}

/* ---------------- 延迟下发（节流） ---------------- */

let pendingMs = null;
let sendTimer = null;

function queueDelay(ms) {
  pendingMs = ms;
  if (sendTimer) return;
  sendTimer = setTimeout(flushDelay, 50);
}

async function flushDelay() {
  sendTimer = null;
  const ms = pendingMs;
  pendingMs = null;
  if (ms == null || !active) return;
  try {
    const res = await chrome.runtime.sendMessage({ target: 'sw', type: 'setDelay', delayMs: ms });
    if (res && res.ok === false) {
      showMsg(res.error || '调节没有生效', 'bad');
    }
  } catch (e) {
    /* 接管可能已被页面关闭或浏览器回收，下一次 getState 会纠正 */
  }
}

/* ---------------- 接管 / 停止 ---------------- */

async function doStart() {
  if (busy) return;
  if (cachedTabId == null) {
    showMsg('找不到当前标签页。关掉面板重新打开一次。', 'bad');
    return;
  }

  setBusy(true);
  showMsg('正在接管…');

  try {
    /* 必须在手势上下文里：所以这里不加任何多余的 await */
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: cachedTabId });

    const res = await chrome.runtime.sendMessage({
      target: 'sw',
      type: 'start',
      tabId: cachedTabId,
      streamId: streamId,
      delayMs: currentMs
    });

    if (!res || !res.ok) throw new Error((res && res.error) || '启动失败');

    renderActive(typeof res.delayMs === 'number' ? res.delayMs : currentMs);
    showMsg('已接管。这个标签页的原声已交给扩展输出，页面播放器不受影响。', 'ok');
  } catch (e) {
    showMsg(mapError(e), 'bad');
    renderIdle();
  } finally {
    setBusy(false);
  }
}

async function doStop() {
  if (busy) return;
  setBusy(true);
  showMsg('正在停止…');
  try {
    await chrome.runtime.sendMessage({ target: 'sw', type: 'stop' });
    renderIdle();
    showMsg('已停止，声音回到页面本身。', '');
  } catch (e) {
    showMsg('停止时出错：' + (e && e.message ? e.message : e), 'bad');
  } finally {
    setBusy(false);
  }
}

function mapError(e) {
  const text = String((e && e.message) || e || '未知错误');
  if (/Permission|not allowed|activeTab|gesture/i.test(text)) {
    return '浏览器没给这个标签页的捕获授权。请关掉面板，重新点一次工具栏图标。';
  }
  if (/not permitted|cannot be captured/i.test(text)) {
    return '这个页面不允许捕获（浏览器内部页、扩展商店等）。换一个普通网页再试。';
  }
  return text;
}

/* ---------------- 事件 ---------------- */

el.slider.addEventListener('input', function () {
  setValue(Number(el.slider.value));
  if (active) queueDelay(currentMs);
});

document.querySelectorAll('[data-step]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const delta = Number(btn.getAttribute('data-step')) || 0;
    setValue(currentMs + delta);
    if (active) queueDelay(currentMs);
  });
});

if (el.readout) {
  el.readout.title = '点击归零';
  el.readout.style.cursor = 'pointer';
  el.readout.addEventListener('click', function () {
    setValue(0);
    if (active) queueDelay(0);
  });
}

el.main.addEventListener('click', function () {
  if (active) doStop();
  else doStart();
});

/* 键盘微调 */
document.addEventListener('keydown', function (e) {
  if (busy) return;
  const step = e.shiftKey ? 1000 : 100;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    setValue(currentMs - step);
    if (active) queueDelay(currentMs);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    setValue(currentMs + step);
    if (active) queueDelay(currentMs);
  } else if (e.key === 'Home') {
    e.preventDefault();
    setValue(0);
    if (active) queueDelay(0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (active) doStop(); else doStart();
  }
});

/* ---------------- 状态同步 ---------------- */

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.target !== 'ui') return;

  if (msg.type === 'meter') {
    paintMeter(msg.rms);
    if (msg.ctxState && msg.ctxState !== 'running' && msg.ctxState !== 'none') {
      showMsg('音频上下文处于 ' + msg.ctxState + '，声音可能中断。点一下页面后再试。', 'bad');
    }
    return;
  }

  if (msg.type === 'stopped') {
    renderIdle();
  }
});

(async function init() {
  setValue(0);
  renderIdle();
  try {
    const st = await chrome.runtime.sendMessage({ target: 'sw', type: 'getState' });
    if (st && st.active) {
      renderActive(st.delayMs || 0);
      paintMeter(st.rms || 0);
      if (st.ctxState && st.ctxState !== 'running') {
        showMsg('音频上下文处于 ' + st.ctxState + '，可能需要点一下页面才能出声。', 'bad');
      }
    }
  } catch (e) {
    /* SW 还没醒或没有 offscreen，保持未接管状态 */
  }
})();
