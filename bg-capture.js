'use strict';

/* ================================================================
 * 原生 HLS 抓切片（chrome.debugger 通道）
 *
 * 用 importScripts 挂进 SW，和 background.js 共享同一个全局环境，
 * 所以这里的函数后面可以直接调用，不需要 export。
 *
 * 为什么只能走调试协议：原生 HLS 的 ts 由浏览器媒体管线直接消费，
 * 不经过 fetch/XHR，MV3 的 webRequest 又拿不到 body。
 * ================================================================ */
/* ==================================================================
 * 链路二：原生 HLS 抓切片（chrome.debugger 通道）
 *
 * 原生 HLS（video.src 直接是 .m3u8）由浏览器内置 demuxer 处理，
 * ts 字节全程不经过 JS：没有 MediaSource、没有 appendBuffer，hook 无处可挂。
 *
 * 唯一能拿到这批字节的通道是调试协议：attach 之后监听 Network 事件，
 * 等某个切片 loadingFinished，再用 Network.getResponseBody 取回。
 * （还在流式传输时取会报 "No data found for resource with given identifier"）
 *
 * 代价：页面顶部出现「正在调试此浏览器」黄条，且每片一次 RPC。
 * 所以它排在「hls.js 复用」之后、「自己再下一路」之前。
 * ================================================================== */

const SEG_RE = /\.(ts|m4s)(\?|#|$)/i;
const capAttached = new Map();   /* tabId -> true */
const capPending = new Map();    /* requestId -> { url, tabId } */
let capSawAny = false;           /* 只用来确认「Network 事件确实通到这个 SW」 */

/* 数据要回到发起请求的那个 frame。注意 CDP 的 frameId 是字符串（如 "ABC123"），
   而 chrome.tabs.sendMessage 的 options.frameId 要数字 —— 两者不是一回事，
   直接把 CDP 的 frameId 传进去会发不出去。所以记 content 自己报上来的那个。 */
async function setCapFrame(tabId, frameId) {
  if (tabId == null || frameId == null) return;
  try { await chrome.storage.session.set({ ['capFrame:' + tabId]: frameId }); } catch (e) {}
}

async function getCapFrame(tabId) {
  try {
    const r = await chrome.storage.session.get('capFrame:' + tabId);
    return r['capFrame:' + tabId];
  } catch (e) { return undefined; }
}

function isMediaSegment(url) {
  return !!(url && SEG_RE.test(url));
}

/** 把抓取过程的节点状态回传给页面，面板调试时能直接看到卡在哪一步 */
function capDiag(tabId, text) {
  try {
    chrome.tabs.sendMessage(tabId, { target: 'content', type: 'capdiag', text: String(text).slice(0, 60) })
      .catch(function () {});
  } catch (e) {}
}

async function captureAttach(tabId, frameId) {
  if (!tabId) return { ok: false, error: '拿不到标签页' };
  await setCapFrame(tabId, frameId);
  if (capAttached.has(tabId)) return { ok: true };

  try {
    await chrome.debugger.attach({ tabId: tabId }, '1.3');
  } catch (e) {
    capDiag(tabId, 'attach-fail:' + readableError(e));
    return { ok: false, error: readableError(e) };
  }

  try {
    await chrome.debugger.sendCommand({ tabId: tabId }, 'Network.enable', {
      maxTotalBufferSize: 64 * 1024 * 1024,
      maxResourceBufferSize: 16 * 1024 * 1024
    });
    capAttached.set(tabId, true);
    capDiag(tabId, 'attach-ok');
    return { ok: true };
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: tabId }); } catch (e2) {}
    return { ok: false, error: readableError(e) };
  }
}

async function captureDetach(tabId) {
  if (!tabId) return { ok: true };
  capAttached.delete(tabId);
  for (const [id, rec] of capPending) if (rec.tabId === tabId) capPending.delete(id);
  try { await chrome.storage.session.remove('capFrame:' + tabId); } catch (e) {}
  try { await chrome.debugger.detach({ tabId: tabId }); } catch (e) {}
  return { ok: true };
}

/** 取回一片，转给发起请求的那个 frame */
async function captureTake(rec, requestId) {
  let r;
  try {
    r = await chrome.debugger.sendCommand(
      { tabId: rec.tabId },
      'Network.getResponseBody',
      { requestId: requestId }
    );
  } catch (e) {
    return;   /* 请求未完成 / body 已被回收，丢一片不影响后续 */
  }
  if (!r || typeof r.body !== 'string' || !r.body.length) {
    capDiag(rec.tabId, 'body-empty');
    return;
  }
  capDiag(rec.tabId, 'body:' + r.body.length);

  const msg = {
    target: 'content',
    type: 'seg',
    url: rec.url,
    b64: r.base64Encoded ? r.body : null,
    text: r.base64Encoded ? null : r.body
  };

  const frameId = await getCapFrame(rec.tabId);
  try {
    if (frameId != null) await chrome.tabs.sendMessage(rec.tabId, msg, { frameId: frameId });
    else await chrome.tabs.sendMessage(rec.tabId, msg);
  } catch (e) {
    /* 目标 frame 已经走了（换页/关标签），丢掉这片 */
  }
}

/**
 * 重新挂上调试会话。
 *
 * 为什么需要：标签页一进全屏，Chromium 会把扩展的 debugger 会话 detach 掉，
 * 之后 Network.requestWillBeSent / loadingFinished 一条都不来 —— 但页面该请求的
 * 切片照常在请求。表现就是「本来走链路②，一全屏就再也抓不到片」，
 * 12 秒兜底计时器一到就静默降级成「再拉一路」，用户只看到流量翻倍。
 *
 * 必须先 detach 再 attach：会话可能只是「不送事件」而没有真的断开，
 * 直接 attach 会报 "Another debugger is already attached"（实测）。
 * frameId 由 content 报上来，因为 CDP 的 frameId 是字符串，不能直接给 sendMessage。
 */
async function captureReattach(tabId, frameId) {
  if (!tabId) return { ok: false, error: '拿不到标签页' };
  await captureDetach(tabId);
  return captureAttach(tabId, frameId);
}

if (chrome.debugger && chrome.debugger.onEvent) {
  chrome.debugger.onEvent.addListener(function (source, method, params) {
    const tabId = source && source.tabId;
    if (!tabId) return;

    /* 这里不能拿 capAttached 当门槛：SW 空闲会被回收，内存里的 Map 跟着没，
       而 debugger 事件会把 SW 唤醒并重新执行本文件——那样每个事件都会被
       当成「没 attach 过」丢掉。事件本身就能说明有人在调试这个标签页。 */

    if (method === 'Network.requestWillBeSent') {
      const url = params && params.request && params.request.url;
      if (!isMediaSegment(url)) {
        if (!capSawAny) {
          capSawAny = true;
          capDiag(tabId, 'evt:' + String(url).split('/').pop().slice(0, 18));
        }
        return;
      }
      if (!capPending.size) capDiag(tabId, 'hit:' + String(url).split('/').pop().slice(0, 20));
      capPending.set(params.requestId, { url: url, tabId: tabId });
      return;
    }

    if (method === 'Network.loadingFinished') {
      const rec = capPending.get(params.requestId);
      if (!rec) return;
      capPending.delete(params.requestId);
      capDiag(rec.tabId, 'fin');
      captureTake(rec, params.requestId);
    }
  });

  chrome.debugger.onDetach.addListener(function (source) {
    if (source && source.tabId) capAttached.delete(source.tabId);
  });
}
