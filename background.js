'use strict';

/* ================================================================
 * 中枢：管理 offscreen 音频文档、页面悬浮面板、状态广播
 *
 * 为什么要 offscreen：MV3 的 service worker 没有 DOM，也不能持有
 * AudioContext。音频必须跑在一个隐藏的扩展页面里。
 * ================================================================ */

const OFFSCREEN_URL = 'offscreen.html';
const CONTENT_SCRIPT = 'content.js';
const LAST_DELAY_KEY = 'lastDelayMs';

let creatingOffscreen = null;
let currentTabId = null;

/* 状态必须能从 storage 恢复：SW 随时可能被浏览器回收 */
let stateReady = (async () => {
  try {
    const r = await chrome.storage.session.get('currentTabId');
    if (typeof r.currentTabId === 'number') currentTabId = r.currentTabId;
  } catch (e) { /* session storage 不可用时忽略 */ }
})();

/* 延迟值要跨会话记住：没有 popup 之后，接管时直接沿用上次调好的数，
   否则每次都得从 0 重新拖。 */
let lastDelayMs = 0;
let prefReady = (async () => {
  try {
    const r = await chrome.storage.local.get(LAST_DELAY_KEY);
    if (typeof r[LAST_DELAY_KEY] === 'number') lastDelayMs = clampDelay(r[LAST_DELAY_KEY]);
  } catch (e) {}
})();

function clampDelay(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.min(10000, Math.max(0, Math.round(n)));
}

async function saveDelay(ms) {
  lastDelayMs = clampDelay(ms);
  try {
    await chrome.storage.local.set({ [LAST_DELAY_KEY]: lastDelayMs });
  } catch (e) {}
}


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

    /* 注入悬浮面板。失败不影响音频，但现在没有 popup 了，
       面板进不去就等于用户完全没法调延迟，必须让他知道。 */
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: [CONTENT_SCRIPT] });
      await sendToTab(tabId, { type: 'panel-show', delayMs: delayMs, rms: res.rms || 0 });
    } catch (e) {
      /* chrome:// 、扩展商店等页面不允许注入 */
      flashBadge(tabId);
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
    const res = await toOffscreen('audio-setDelay', { delayMs: delayMs });
    if (res && res.ok) saveDelay(res.delayMs != null ? res.delayMs : delayMs);
    return res;
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

/* ---------------- 点图标：接管的唯一入口 ----------------
 *
 * 为什么放在 service worker：content script 里既拿不到 chrome.tabCapture，
 * 点按钮也不算用户手势，授不出 activeTab。而 action.onClicked 是浏览器
 * 亲自派发的用户手势，在这里调 getMediaStreamId 才是合法的。
 */

async function toggle(tab) {
  if (!tab || typeof tab.id !== 'number') return;
  const tabId = tab.id;

  await stateReady;
  await prefReady;

  /* 这次点图标是来完成「双向模式」授权的，不接管 */
  const pending = await peekPendingEnhance();
  if (pending && pending.tabId === tabId) {
    await completeEnhance(tabId, pending.origin);
    return;
  }

  /* 同一个标签页再点一次 = 停止 */
  if (currentTabId === tabId && (await hasOffscreen())) {
    await stop();
    return;
  }

  /* 接管着别的标签页就先拆掉，避免两个 AudioContext 抢同一路输出 */
  if (currentTabId != null && currentTabId !== tabId) {
    await stop();
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    await notifyError(tabId, readableError(e));
    return;
  }

  const res = await start(tabId, streamId, lastDelayMs);
  if (!res.ok) await notifyError(tabId, res.error);
}

/**
 * 出错时把面板注入进去显示原因。
 * 注入可能失败（chrome:// 之类），那就只能靠图标角标兜底。
 */
async function notifyError(tabId, text) {
  let injected = false;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: [CONTENT_SCRIPT] });
    injected = true;
  } catch (e) {}

  if (injected) {
    await sendToTab(tabId, { type: 'panel-error', text: text });
    return;
  }

  flashBadge(tabId);
}

/** 页面上什么都说不了的时候，用角标提示 4 秒 */
async function flashBadge(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#f85149' });
    await chrome.action.setBadgeText({ tabId: tabId, text: '!' });
    setTimeout(function () {
      chrome.action.setBadgeText({ tabId: tabId, text: '' }).catch(function () {});
    }, 4000);
  } catch (e) {}
}

/* ---------------- 增强模式（MSE 双路解码） ----------------
 *
 * 页面自己用 MSE 播放时，音频片段会经过 SourceBuffer.appendBuffer。
 * inject-main.js 在 MAIN world 劫持那个点，把片段复制一份出来，content.js
 * 用另一条只含音频的 MediaSource 接住 —— 于是音频有了**独立时钟**，
 * currentTime 可以设到画面位置之后，这就是「声音提前」。
 *
 * 权限：需要在目标站点上跑 content script，且必须 document_start 注入
 * （否则拿不到 init segment）。用 optional_host_permissions，安装时不申请
 * 任何网站权限，用户主动启用时才按站点授权。
 */

const ENHANCED_IDS = ['ads-main', 'ads-content'];

async function hasOriginPermission(origin) {
  try {
    return await chrome.permissions.contains({ origins: [origin + '/*'] });
  } catch (e) {
    return false;
  }
}

async function registerEnhanced(origins) {
  try {
    const old = await chrome.scripting.getRegisteredContentScripts({ ids: ENHANCED_IDS });
    if (old && old.length) await chrome.scripting.unregisterContentScripts({ ids: ENHANCED_IDS });
  } catch (e) {}

  const matches = origins.map(function (o) { return o.replace(/\/\*$/, '') + '/*'; });
  if (!matches.length) return;

  await chrome.scripting.registerContentScripts([
    {
      id: 'ads-main',
      matches: matches,
      js: ['inject-main.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: false
    },
    {
      id: 'ads-content',
      matches: matches,
      js: ['content.js'],
      runAt: 'document_start',
      allFrames: false
    }
  ]);
}

/** 把所有已授权站点一次性注册进去 */
async function rebuildEnhanced() {
  const perms = await chrome.permissions.getAll();
  const origins = ((perms && perms.origins) || []).filter(function (o) {
    return /^https?:/i.test(o);
  });
  await registerEnhanced(origins);
}

/* ---------------- 双向模式授权 ----------------
 * chrome.permissions.request 要求调用发生在「用户手势」里。content script
 * 的点击经 sendMessage 到 SW 时，手势在跨进程那一步就丢了（实测报
 * "This function must be called during a user gesture"）。
 *
 * 唯一可靠的手势来源是 action.onClicked —— 浏览器亲自派发。
 * 所以面板按钮只登记意图，真正的请求放到下一次点图标时执行。
 */

const PENDING_KEY = 'pendingEnhance';
const PENDING_TTL = 5 * 60 * 1000;

async function setPendingEnhance(tabId, origin) {
  try {
    await chrome.storage.session.set({
      [PENDING_KEY]: { tabId: tabId, origin: origin, at: Date.now() }
    });
  } catch (e) {}
}

async function peekPendingEnhance() {
  try {
    const r = await chrome.storage.session.get(PENDING_KEY);
    const p = r && r[PENDING_KEY];
    if (!p || typeof p.tabId !== 'number') return null;
    if (Date.now() - (p.at || 0) > PENDING_TTL) {
      await chrome.storage.session.remove(PENDING_KEY);
      return null;
    }
    return p;
  } catch (e) {
    return null;
  }
}

async function clearPendingEnhance() {
  try { await chrome.storage.session.remove(PENDING_KEY); } catch (e) {}
}

/** 图标上打个标记，明确告诉用户「下一步点这里」 */
async function markNeedGesture(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#22d3ee', tabId: tabId });
    await chrome.action.setBadgeText({ tabId: tabId, text: '↑' });
    await chrome.action.setTitle({ tabId: tabId, title: '点一下图标，完成双向模式授权' });
  } catch (e) {}
}

async function clearNeedGesture(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId: tabId, text: '' });
    await chrome.action.setTitle({ tabId: tabId, title: '音画偏移 · 点一下接管当前标签页' });
  } catch (e) {}
}

/**
 * 面板按钮点进来。没权限就只登记，等下一次点图标。
 */
async function requestEnhance(origin, tabId) {
  if (!origin || !/^https?:/i.test(origin)) {
    return { ok: false, error: '这个页面不支持（只对 http / https 站点生效）' };
  }

  try {
    /* 可能之前在别的标签页已经授权过同一个站点。
       这里直接按 origin 注册，不依赖 getAll() 的结果 —— 后者拿不全就白跑。 */
    if (await hasOriginPermission(origin)) {
      await registerEnhanced([origin]);
      return { ok: true, needsReload: true };
    }

    if (typeof tabId !== 'number') {
      return { ok: false, error: '找不到当前标签页，刷新页面后重试。' };
    }

    await setPendingEnhance(tabId, origin);
    await markNeedGesture(tabId);

    return {
      ok: false,
      needGesture: true,
      error: '浏览器规定网站权限必须由你亲自点图标才能申请。点一下工具栏上的扩展图标，会弹出授权框——这一步只做授权，不会开始接管。'
    };
  } catch (e) {
    return { ok: false, error: '授权失败：' + ((e && e.message) || String(e)) };
  }
}

/** 由点图标触发的真正授权。这里手势是有效的。 */
async function completeEnhance(tabId, origin) {
  try {
    const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
    await clearNeedGesture(tabId);

    if (!granted) {
      await sendToTab(tabId, {
        type: 'panel-notice',
        kind: 'error',
        text: '没有授权，双向模式仍然不可用。需要时可以再点一次面板上的按钮。'
      });
      return;
    }

    await clearPendingEnhance();
    await rebuildEnhanced();

    await sendToTab(tabId, {
      type: 'panel-notice',
      kind: 'ok',
      text: '已授权当前站点。刷新一次页面，面板上就会出现「启用双向」。'
    });
  } catch (e) {
    await clearNeedGesture(tabId);
    await sendToTab(tabId, {
      type: 'panel-notice',
      kind: 'error',
      text: '授权失败：' + ((e && e.message) || String(e))
    });
  }
}

/* 每次 SW 启动把已授权站点重新注册一遍（浏览器可能清掉动态脚本） */
rebuildEnhanced().catch(function () {});

/* ---------------- 消息路由 ---------------- */

function sendToTab(tabId, msg) {
  if (tabId == null) return Promise.resolve();
  return chrome.tabs.sendMessage(tabId, Object.assign({ target: 'content' }, msg))
    .catch(function () { /* 页面里没有 content script */ });
}

function broadcast(msg) {
  sendToTab(currentTabId, msg);
}

chrome.action.onClicked.addListener(function (tab) {
  toggle(tab).catch(function () {});
});

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
    case 'requestEnhance':
      requestEnhance(msg.origin, sender && sender.tab && sender.tab.id).then(sendResponse);
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
    return '浏览器拒绝捕获这个标签页的音频。确认页面正在出声，'
      + '并避开扩展管理页、新标签页这类不允许捕获的界面。';
  }
  if (name === 'NotFoundError' || /no audio|Requested device not found/i.test(text)) {
    return '这个标签页当前没有可捕获的音频。先让视频开始播放，再点图标。';
  }
  if (name === 'InvalidStateError') {
    return '这个标签页已经被别的程序捕获了，同一时刻只能有一路。';
  }
  return text;
}

/* SW 被唤醒时把状态读进来 */
stateReady.catch(function () {});
