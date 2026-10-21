'use strict';

/* ================================================================
 * 中枢：管理 offscreen 音频文档、页面悬浮面板、状态广播
 *
 * 为什么要 offscreen：MV3 的 service worker 没有 DOM，也不能持有
 * AudioContext。音频必须跑在一个隐藏的扩展页面里。
 * ================================================================ */

const OFFSCREEN_URL = 'offscreen.html';
/* 面板 + 双向逻辑拆成了几个文件，重新注入时要一起给，
 *  只给 content.js 会因为它找不到 ADS 直接 return。
 *  build-info.js 必须排第一：后面的文件要读它上面的 ADS_BUILD 标记。
 *
 *  具体清单由 bg-auth.js 的 contentScriptFiles() 提供，不要在这里再写一份：
 *  两套清单必然走岔 —— 曾经这里漏了 mux.min.js，导致「点图标」注入的页面里
 *  typeof muxjs === 'undefined'，原生 HLS 站点直接从链路② 降级到链路③，
 *  而只有走过「站点授权」那条 registerContentScripts 路径的页面才正常。
 *  函数里那个顺序也已经是对的：mux.min.js 在 content.js 之前。 */
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
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: contentScriptFiles() });
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

  /* 走到这里说明同步段没命中待授权（SW 中途被回收，内存镜像丢了）。
     绝不能在这里请求权限 —— 前面的 await 已经把这次手势耗掉了。 */
  const stale = await peekPendingEnhance();
  if (stale && stale.tabId === tabId) {
    await clearPendingEnhance();
    await clearNeedGesture(tabId);
    await sendToTab(tabId, {
      type: 'panel-notice',
      kind: 'error',
      text: '授权状态已失效，请重新点面板上的「双向需授权」。'
    });
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
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: contentScriptFiles() });
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

/* 拆出去的两块，importScripts 让它们和本文件共享同一个全局环境。
   build-info.js 必须最先加载，后面两块和消息路由都要读它的标记。 */
importScripts('build-info.js', 'bg-auth.js');

/* 上架版把链路② 整条裁掉了：包里没有 bg-capture.js，manifest 也没有
   debugger 权限，所以这个文件不能引 —— 引了会直接抛，整个 SW 起不来。 */
const CAPTURE_BUILD = !(globalThis.ADS_BUILD && globalThis.ADS_BUILD.capture === false);
if (CAPTURE_BUILD) importScripts('bg-capture.js');

/** 抓切片不可用时的统一回复（只有上架版会用到） */
const NO_CAPTURE = { ok: false, error: 'no-capture' };
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
  /* 待授权：必须在这个同步执行段里直接发起请求。
     permissions.request 只认当前任务的手势，只要 await 一次
     （哪怕只是读 storage），就会报
     "This function must be called during a user gesture"。
     所以这里读的是内存镜像 pendingCache，不是 storage。 */
  const p = pendingCache;
  if (p && p.tabId === tab.id && Date.now() - (p.at || 0) <= PENDING_TTL) {
    pendingCache = null;

    chrome.permissions.request({ origins: [p.origin + '/*'] })
      .then(function (granted) {
        return settleEnhance(tab.id, p.origin, granted, null);
      })
      .catch(function (e) {
        return settleEnhance(tab.id, p.origin, false, e);
      });
    return;
  }

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

  /* 全屏切换后调试会话被浏览器 detach 了，content 会来要一次重连。
     上架版没有链路②，这个函数根本不存在（bg-capture.js 不进包），直接回 ok:false。 */
  if (msg.target === 'sw' && msg.type === 'captureReattach') {
    if (!CAPTURE_BUILD || typeof captureReattach !== 'function') {
      sendResponse({ ok: false, error: 'no-capture' });
      return false;
    }
    captureReattach(sender && sender.tab && sender.tab.id, sender && sender.frameId)
      .then(sendResponse)
      .catch(function () { sendResponse({ ok: false }); });
    return true;
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
      return requestEnhanceInline(msg.origin, sender && sender.tab && sender.tab.id, sendResponse);
    case 'checkOrigin':
      checkOrigin(msg.origin).then(sendResponse);
      return true;
    case 'registerOnly':
      registerOnly(msg.origin, sender && sender.tab && sender.tab.id).then(sendResponse);
      return true;
    case 'captureStart':
      /* 上架版没有抓切片模块。正常也走不到这里（内容脚本的 pickRoute 会先
         把 ② 排除掉），真走到了就明确回失败，别让调用方等到超时。 */
      if (typeof captureAttach !== 'function') { sendResponse(NO_CAPTURE); return false; }
      captureAttach(sender && sender.tab && sender.tab.id, sender && sender.frameId).then(sendResponse);
      return true;
    case 'captureStop':
      if (typeof captureDetach !== 'function') { sendResponse(NO_CAPTURE); return false; }
      captureDetach(msg.tabId || (sender && sender.tab && sender.tab.id)).then(sendResponse);
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
      chrome.scripting.executeScript({ target: { tabId: tabId }, files: contentScriptFiles() })
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
