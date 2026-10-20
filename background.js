'use strict';

/* ================================================================
 * 中枢：管理 offscreen 音频文档、页面悬浮面板、状态广播
 *
 * 为什么要 offscreen：MV3 的 service worker 没有 DOM，也不能持有
 * AudioContext。音频必须跑在一个隐藏的扩展页面里。
 * ================================================================ */

const OFFSCREEN_URL = 'offscreen.html';
const CONTENT_SCRIPT = 'content.js';

let creatingOffscreen = null;
let currentTabId = null;

/* 状态必须能从 storage 恢复：SW 随时可能被浏览器回收 */
let stateReady = (async () => {
  try {
    const r = await chrome.storage.session.get('currentTabId');
    if (typeof r.currentTabId === 'number') currentTabId = r.currentTabId;
  } catch (e) { /* session storage 不可用时忽略 */ }
})();

async function setTab(tabId) {
  currentTabId = tabId;
  try {
    if (tabId == null) await chrome.storage.session.remove('currentTabId');
    else await chrome.storage.session.set({ currentTabId: tabId });
  } catch (e) {}
}

/* ---------------- offscreen 生命周期 ---------------- */

async function hasOffscreen() {
  try {
    if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
      return await chrome.offscreen.hasDocument();
    }
  } catch (e) {}
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['AUDIO_PLAYBACK'],
    justification: '在隐藏文档中用 Web Audio 延迟标签页音频，修正音画不同步'
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function closeOffscreen() {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch (e) {}
}

/**
 * 给 offscreen 发消息。
 *
 * createDocument 返回时文档的脚本未必已经注册好监听器，
 * 首次发送容易撞上 "Receiving end does not exist"，所以带重试。
 */
async function toOffscreen(type, payload, retries) {
  const max = retries == null ? 8 : retries;
  let lastErr = null;
  for (let i = 0; i < max; i++) {
    try {
      const res = await chrome.runtime.sendMessage(
        Object.assign({ target: 'offscreen', type: type }, payload || {})
      );
      if (res !== undefined) return res;
    } catch (e) {
      lastErr = e;
    }
    await new Promise(function (r) { setTimeout(r, 80); });
  }
  throw lastErr || new Error('offscreen 无响应');
}

/* ---------------- 业务动作 ---------------- */

async function start(tabId, streamId, delayMs) {
  await stateReady;
  try {
    /* 先把上一轮彻底拆干净，否则会留下一个没人管的 AudioContext。
       没有 offscreen 时不要重试等待 —— 那会白白耗掉半秒。 */
    if (await hasOffscreen()) {
      try { await toOffscreen('audio-stop', null, 2); } catch (e) {}
    }
    await closeOffscreen();

    await setTab(tabId);
    await ensureOffscreen();

    const res = await toOffscreen('audio-start', { streamId: streamId, delayMs: delayMs });
    if (!res || !res.ok) {
      await closeOffscreen();
      await setTab(null);
      return { ok: false, error: (res && res.error) || '音频链路启动失败' };
    }

    /* 注入悬浮面板。失败不影响音频，只是少了个调节入口 */
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: [CONTENT_SCRIPT] });
      await sendToTab(tabId, { type: 'panel-show', delayMs: delayMs, rms: res.rms || 0 });
    } catch (e) {
      /* chrome:// 、扩展商店等页面不允许注入，忽略 */
    }

    return { ok: true, delayMs: res.delayMs, rms: res.rms };
  } catch (e) {
    await closeOffscreen();
    await setTab(null);
    return { ok: false, error: readableError(e) };
  }
}

async function stop() {
  await stateReady;
  const tabId = currentTabId;
  await stopAudio();
  await setTab(null);

  /* 通知所有界面回到未接管状态 */
  chrome.runtime.sendMessage({ target: 'ui', type: 'stopped' }).catch(function () {});
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { target: 'content', type: 'stopped' })
      .catch(function () {});
  }
  return { ok: true };
}

async function stopAudio() {
  try { await toOffscreen('audio-stop'); } catch (e) {}
  await closeOffscreen();
}

async function setDelay(delayMs) {
  await stateReady;
  if (!(await hasOffscreen())) return { ok: false, error: '尚未接管' };
  try {
    return await toOffscreen('audio-setDelay', { delayMs: delayMs });
  } catch (e) {
    return { ok: false, error: readableError(e) };
  }
}

async function getState() {
  await stateReady;
  if (!(await hasOffscreen())) {
    return { active: false, delayMs: 0, rms: 0, ctxState: 'none' };
  }
  try {
    const st = await toOffscreen('audio-state');
    return st || { active: false, delayMs: 0, rms: 0, ctxState: 'none' };
  } catch (e) {
    return { active: false, delayMs: 0, rms: 0, ctxState: 'none' };
  }
}

/* ---------------- 消息路由 ---------------- */

function sendToTab(tabId, msg) {
  if (tabId == null) return Promise.resolve();
  return chrome.tabs.sendMessage(tabId, Object.assign({ target: 'content' }, msg))
    .catch(function () { /* 页面里没有 content script */ });
}

function broadcast(msg) {
  chrome.runtime.sendMessage(Object.assign({ target: 'ui' }, msg)).catch(function () {});
  sendToTab(currentTabId, msg);
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return false;

  /* offscreen 上报的电平，转发给 popup 和页面面板 */
  if (msg.target === 'sw' && msg.type === 'meter') {
    broadcast({ type: 'meter', rms: msg.rms, ctxState: msg.ctxState, delayMs: msg.delayMs });
    return false;
  }

  /* 音轨被浏览器掐断（标签页关了、导航走了、被别的程序抢走） */
  if (msg.target === 'sw' && msg.type === 'stream-ended') {
    stop();
    return false;
  }

  if (msg.target !== 'sw') return false;

  switch (msg.type) {
    case 'start':
      start(msg.tabId, msg.streamId, msg.delayMs).then(sendResponse);
      return true;
    case 'stop':
      stop().then(sendResponse);
      return true;
    case 'setDelay':
      setDelay(msg.delayMs).then(sendResponse);
      return true;
    case 'getState':
      getState().then(sendResponse);
      return true;
    default:
      return false;
  }
});

/* ---------------- 页面生命周期 ---------------- */

chrome.tabs.onRemoved.addListener(function (tabId) {
  if (tabId === currentTabId) {
    stop();
  }
});

chrome.tabs.onUpdated.addListener(function (tabId, info) {
  if (tabId !== currentTabId) return;
  /* 跳转后原面板已随文档销毁，等新页面稳定再把面板挂回去 */
  if (info.status === 'complete') {
    setTimeout(function () {
      if (tabId !== currentTabId) return;
      chrome.scripting.executeScript({ target: { tabId: tabId }, files: [CONTENT_SCRIPT] })
        .then(function () {
          return getState().then(function (st) {
            return sendToTab(tabId, {
              type: 'panel-show',
              delayMs: st.delayMs || 0,
              rms: st.rms || 0
            });
          });
        })
        .catch(function () {});
    }, 500);
  }
});

/* ---------------- 工具 ---------------- */

function readableError(e) {
  const name = (e && e.name) || '';
  const text = String((e && e.message) || e || '未知错误');

  if (name === 'NotAllowedError' || /Permission denied|not allowed/i.test(text)) {
    return '浏览器拒绝了这个标签页的音频捕获。请直接点击工具栏上的扩展图标再试一次。'
      + '（某些界面，例如扩展管理页、新标签页，不允许捕获。）';
  }
  if (name === 'NotFoundError' || /no audio|Requested device not found/i.test(text)) {
    return '这个标签页当前没有可捕获的音频。先让视频开始播放，再点接管。';
  }
  if (name === 'InvalidStateError') {
    return '这个标签页已经被别的程序捕获了，同一时刻只能有一路。';
  }
  return text;
}

/* SW 被唤醒时把状态读进来 */
stateReady.catch(function () {});
