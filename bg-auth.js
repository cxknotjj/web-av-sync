'use strict';

/* sendToTab 在 background.js 里（同一个 SW 全局作用域）；下面几个导出给
   background.js 的消息分发用，本文件内部不调用。 */
/* global sendToTab */
/* exported contentScriptFiles, registerEnhanced, ensureEnhanced, registerOnly,
            checkOrigin, requestEnhanceInline, settleEnhance, peekPendingEnhance,
            clearPendingEnhance, clearNeedGesture, pendingCache, PENDING_TTL */

/* ================================================================
 * 站点授权与增强脚本注册
 *
 * 这里最要命的一条：permissions.request 只认当前任务的手势。
 * 所以取待授权状态的 takePending() 必须是同步调用，中间不能有 await，
 * 哪怕只是读一次 storage。
 * ================================================================ */
const ENHANCED_IDS = ['ads-main', 'ads-content'];

/** 内容脚本的注入顺序。build-info.js 必须第一个：后面几个都要读 ADS_BUILD。
 *  双向模式那五块也必须按依赖顺序排：它们加载时会直接解构上一个模块导出的
 *  函数，顺序错了拿到的是 undefined，而且要到用户点按钮才报错。
 *
 *  mux.min.js（112KB）**不在这里**。它只服务链路②，而注册是 allFrames 的 ——
 *  放进来意味着每个授权页面的每个 iframe 都要在 document_start 解析一遍，
 *  其中绝大多数根本不会走链路②。改成进链路② 之前由 SW 用
 *  chrome.scripting.executeScript 按需注入（见 background.js 的 loadMux）。
 *  上架版本来就没有这个文件，按需注入时 CAPTURE_BUILD 会直接回失败。 */
function contentScriptFiles() {
  return [
    'build-info.js',
    /* i18n 必须排在所有会输出文案的模块前面：它们加载时就要拿到 T */
    'ads-i18n.js',
    'ads-template.js', 'ads-ui.js', 'ads-detect.js',
    /* core → panel → route → sync → enhance：单向依赖，没有回头箭头 */
    'ads-enh-core.js', 'ads-enh-panel.js', 'ads-enh-route.js',
    'ads-enh-sync.js', 'ads-enhance.js',
    /* 入口必须最后：它要读前面挂到 window.ADS 上的东西 */
    'content.js'
  ];
}

async function registerEnhanced(origins) {
  const matches = (origins || [])
    .map(function (o) { return String(o).replace(/\/\*$/, '') + '/*'; })
    .filter(function (m) { return /^https?:/i.test(m); });

  /* 没有可注册的站点就什么都不做。
     绝不能在这里顺手 unregister —— 那会把已有注册删掉却不补回来。 */
  if (!matches.length) return;

  try {
    const old = await chrome.scripting.getRegisteredContentScripts({ ids: ENHANCED_IDS });
    if (old && old.length) await chrome.scripting.unregisterContentScripts({ ids: ENHANCED_IDS });
  } catch (e) {}

  /* allFrames 必须是 true：大量影视站把播放器放在跨域 iframe 里
     （父页面只有外壳，video 元素在嵌进来的第三方播放器中），
     只注入顶层框架的话，panel 挂在一个没有 video 的页面上，双向模式永远不可用。
     多层 iframe 里的面板由 content.js 自行判断要不要显形。 */
  await chrome.scripting.registerContentScripts([
    {
      id: 'ads-main',
      matches: matches,
      js: ['inject-main.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true
    },
    {
      id: 'ads-content',
      matches: matches,
      /* 顺序有讲究：构建标记 → 样式常量 → 面板 → 双向 →（可选）mux.js → 入口。
         入口最后跑，前面几个都挂到 window.ADS 上。 */
      js: contentScriptFiles(),
      runAt: 'document_start',
      allFrames: true
    }
  ]);
}

/**
 * 已授权站点的本地账本。
 * 不依赖 chrome.permissions.getAll() —— 它返回什么、什么时候返回，
 * 不同版本行为不一致；曾经出现过拿到空数组导致注册被清掉的情况。
 */
async function rememberEnhancedOrigin(origin) {
  if (!origin) return;
  try {
    const r = await chrome.storage.local.get('enhancedOrigins');
    const list = Array.isArray(r.enhancedOrigins) ? r.enhancedOrigins.slice() : [];
    if (list.indexOf(origin) === -1) {
      list.push(origin);
      await chrome.storage.local.set({ enhancedOrigins: list });
    }
  } catch (e) {}
}

async function forgetEnhancedOrigin(origin) {
  try {
    const r = await chrome.storage.local.get('enhancedOrigins');
    const list = (Array.isArray(r.enhancedOrigins) ? r.enhancedOrigins : [])
      .filter(function (o) { return o !== origin; });
    await chrome.storage.local.set({ enhancedOrigins: list });
  } catch (e) {}
}

/**
 * SW 启动时校准一次注册状态：只补，不重建。
 *
 * 动态注册默认 persistAcrossSessions，本来就跨 SW 重启保留。
 * 每次启动都 unregister + register 会留出窗口期——页面恰好在那时加载就
 * 注入不到，表现正是「授权了，刷新后还提示需要授权」。
 */
async function ensureEnhanced() {
  try {
    const stored = await chrome.storage.local.get('enhancedOrigins');
    const remembered = Array.isArray(stored.enhancedOrigins) ? stored.enhancedOrigins : [];

    /* getAll() 作为补充来源，两个来源取并集 */
    let granted = [];
    try {
      const perms = await chrome.permissions.getAll();
      granted = ((perms && perms.origins) || []).filter(function (o) {
        return /^https?:/i.test(o);
      });
    } catch (e) {}

    const origins = [];
    remembered.concat(granted).forEach(function (o) {
      const base = String(o).replace(/\/\*$/, '');
      if (/^https?:/i.test(base) && origins.indexOf(base) === -1) origins.push(base);
    });

    if (!origins.length) return;

    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ENHANCED_IDS });
    if (existing && existing.length === ENHANCED_IDS.length) return;

    await registerEnhanced(origins);
  } catch (e) {}
}

/**
 * 只补注册，不申请权限。
 * 用在「站点早就授权了，只是脚本没注册上」的情况——这条路不需要手势，
 * 因为 permissions.request 即使权限已存在也照样要求 user gesture。
 */
async function registerOnly(origin, tabId) {
  if (!origin || !/^https?:/i.test(origin)) {
    return { ok: false, error: '这个页面不支持（只对 http / https 站点生效）' };
  }

  try {
    await rememberEnhancedOrigin(origin);
    await registerEnhanced([origin]);

    if (typeof tabId === 'number') {
      setTimeout(function () {
        chrome.tabs.reload(tabId).catch(function () {});
      }, 350);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: '注册失败：' + ((e && e.message) || String(e)) };
  }
}

/**
 * 面板问「这个站点到底授权了没有」。
 * 授权了但脚本没注入（页面在注册完成前就加载了）和压根没授权，
 * 是两种完全不同的情况，提示不能一样。
 * 顺便补一次注册，让用户下次刷新就能用上。
 */
async function checkOrigin(origin) {
  if (!origin || !/^https?:/i.test(origin)) return { granted: false };
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [origin + '/*'] });
  } catch (e) {}

  if (granted) {
    ensureEnhanced().catch(function () {});
  }
  return { granted: granted };
}

/* 权限被撤销时把失效的站点从注册里摘掉 */
if (chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener(function (removed) {
    const gone = ((removed && removed.origins) || []).map(function (o) {
      return String(o).replace(/\/\*$/, '');
    });
    Promise.all(gone.map(forgetEnhancedOrigin))
      .then(function () {
        return chrome.permissions.getAll();
      })
      .then(function (perms) {
        const origins = ((perms && perms.origins) || []).filter(function (o) {
          return /^https?:/i.test(o);
        });
        if (!origins.length) {
          return chrome.scripting.unregisterContentScripts({ ids: ENHANCED_IDS });
        }
        return registerEnhanced(origins);
      })
      .catch(function () {});
  });
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

/* 内存镜像。onClicked 里必须「同步」拿到 origin —— 只要 await 一次，
   手势就被判失效，permissions.request 会报 "must be called during a user gesture"。 */
let pendingCache = null;

function setPendingEnhance(tabId, origin) {
  pendingCache = { tabId: tabId, origin: origin, at: Date.now() };
  return chrome.storage.session
    .set({ [PENDING_KEY]: pendingCache })
    .catch(function () {});
}

async function peekPendingEnhance() {
  if (pendingCache && Date.now() - (pendingCache.at || 0) <= PENDING_TTL) return pendingCache;
  try {
    const r = await chrome.storage.session.get(PENDING_KEY);
    const p = r && r[PENDING_KEY];
    if (!p || typeof p.tabId !== 'number') return null;
    if (Date.now() - (p.at || 0) > PENDING_TTL) {
      await chrome.storage.session.remove(PENDING_KEY);
      return null;
    }
    pendingCache = p;
    return p;
  } catch (e) {
    return null;
  }
}

function clearPendingEnhance() {
  pendingCache = null;
  return chrome.storage.session.remove(PENDING_KEY).catch(function () {});
}

/* SW 启动时预热缓存：万一上次的 pending 还没处理完 */
peekPendingEnhance().catch(function () {});

/** 图标上打个标记，明确告诉用户「下一步点这里」 */
async function markNeedGesture(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#22d3ee', tabId: tabId });
    await chrome.action.setBadgeText({ tabId: tabId, text: '↑' });
    await chrome.action.setTitle({
      tabId: tabId,
      title: chrome.i18n.getMessage('actionTitleAuth') || '点一下图标，完成双向模式授权'
    });
  } catch (e) {}
}

async function clearNeedGesture(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId: tabId, text: '' });
    await chrome.action.setTitle({
      tabId: tabId,
      title: chrome.i18n.getMessage('actionTitle') || '音画不同步调节器 · 点一下接管当前标签页'
    });
  } catch (e) {}
}

/**
 * 面板按钮直接授权。
 *
 * 关键：permissions.request 必须是这个消息处理器里「第一个异步操作」。
 * 手势能撑过 content script → service worker 这一跳，但撑不过任何 await。
 * 旧代码先 await permissions.contains()，手势就没了，必然报
 * "This function must be called during a user gesture"。
 *
 * 已授权的站点再调 request 会立即返回 true 且不弹框，所以不需要先 contains。
 */
function requestEnhanceInline(origin, tabId, sendResponse) {
  if (!origin || !/^https?:/i.test(origin)) {
    sendResponse({ ok: false, error: '这个页面不支持（只对 http / https 站点生效）' });
    return false;
  }

  chrome.permissions.request({ origins: [origin + '/*'] })
    .then(function (granted) {
      if (!granted) {
        sendResponse({ ok: false, error: '没有授权。想用双向模式时可以再点一次。' });
        return undefined;
      }
      return rememberEnhancedOrigin(origin)
        .then(function () { return registerEnhanced([origin]); })
        .then(function () {
          sendResponse({ ok: true, needsReload: true });

          /* 脚本是 document_start 注入的，不刷新当前页等于没装。
             让用户自己刷很容易刷早（注册还没落），干脆替他把这步做掉。 */
          if (typeof tabId === 'number') {
            setTimeout(function () {
              chrome.tabs.reload(tabId).catch(function () {});
            }, 350);
          }
        });
    })
    .catch(function (e) {
      const msg = (e && e.message) || String(e);

      /* 万一某些版本没把手势传过来：退回「点图标」这条路，别让用户卡死 */
      if (/user gesture/i.test(msg) && typeof tabId === 'number') {
        setPendingEnhance(tabId, origin);
        markNeedGesture(tabId);
        sendResponse({
          ok: false,
          needGesture: true,
          error: '这个环境下手势没能传过来。点一下工具栏图标即可完成授权（图标角标已亮）。'
        });
        return;
      }

      sendResponse({ ok: false, error: '授权失败：' + msg });
    });

  return true; /* 异步 sendResponse */
}

/**
 * 授权的收尾：只处理结果，不发起请求。
 * 请求本身必须在 onClicked 的同步段里发起（见下面的 onClicked）。
 */
async function settleEnhance(tabId, origin, granted, err) {
  await clearNeedGesture(tabId);
  await clearPendingEnhance();

  if (err) {
    await sendToTab(tabId, {
      type: 'panel-notice',
      kind: 'error',
      text: '授权失败：' + ((err && err.message) || String(err))
    });
    return;
  }

  if (!granted) {
    await sendToTab(tabId, {
      type: 'panel-notice',
      kind: 'error',
      text: '没有授权，双向模式仍然不可用。需要时可以再点一次面板上的按钮。'
    });
    return;
  }

  await registerEnhanced([origin]);
  await sendToTab(tabId, {
    type: 'panel-notice',
    kind: 'ok',
    text: '已授权，正在刷新页面…'
  });

  /* 同 requestEnhanceInline：不刷新等于没装 */
  setTimeout(function () {
    chrome.tabs.reload(tabId).catch(function () {});
  }, 350);
}

/* 每次 SW 启动把已授权站点重新注册一遍（浏览器可能清掉动态脚本） */
ensureEnhanced();

