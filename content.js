'use strict';

/* ================================================================
 * 内容脚本入口
 *
 * 三块分工：
 *   ads-template.js  样式与结构模板（纯字符串）
 *   ads-ui.js        面板、提示、交互        → window.ADS.ui
 *   ads-enhance.js   双向模式三条链路        → window.ADS.enh
 *   本文件           消息路由、初始化、把两者接起来
 * ================================================================ */

(function () {
  const U = window.ADS && window.ADS.ui;
  const E = window.ADS && window.ADS.enh;

  /* 重复注入时直接复用，避免叠出好几个面板 */
  if (!U || !E) return;
  if (window.__adsWired) {
    try { U.reveal(); } catch (e) {}
    return;
  }
  window.__adsWired = true;

  function teardown() {
    try { if (E.isEnhanced()) E.exit(); } catch (e) {}
    try { U.destroy(); } catch (e) {}
  }

  /* ---------------- 后台 / MAIN world 的消息 ---------------- */

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.target !== 'content') return;

    if (msg.type === 'panel-show') {
      U.reveal();
      U.setValue(msg.delayMs || 0);
      if (typeof msg.rms === 'number') U.paintMeter(msg.rms);
      return;
    }

    if (msg.type === 'meter') {
      U.paintMeter(msg.rms);
      return;
    }

    /* 调试通道送来的原生 HLS 切片 */
    if (msg.type === 'seg') {
      E.onSegChunk(msg);
      return;
    }

    /* 抓取链路各节点的状态，写到 DOM 上方便排查 */
    if (msg.type === 'capdiag') {
      try {
        const prev = document.documentElement.dataset.adsDiag || '';
        document.documentElement.dataset.adsDiag = (prev + '|' + msg.text).slice(-300);
      } catch (e) {}
      return;
    }

    if (msg.type === 'panel-notice') {
      U.showToast(msg.text || '', msg.kind);
      return;
    }

    if (msg.type === 'panel-error') {
      U.showToast(msg.text || '接管失败，原因未知');
      return;
    }

    if (msg.type === 'stopped') {
      teardown();
    }
  });

  /* ---------------- 初始化 ---------------- */

  E.init(U);
  U.setValue(0);

  /* 面板有可能比 panel-show 消息更晚就绪，主动拉一次真实状态。
     如果那边其实已经没在接管，就不要再挂个空面板误导人。
     例外：被注册成增强脚本注入时（DOM 上有标记），面板要留着当双向模式的入口。 */
  chrome.runtime.sendMessage({ target: 'sw', type: 'getState' })
    .then(function (st) {
      if (st && st.active) {
        U.reveal();
        U.setValue(st.delayMs || 0);
        if (typeof st.rms === 'number') U.paintMeter(st.rms);
        return;
      }
      if (document.documentElement.dataset.adsHooked === '1') {
        E.setHookInstalled(true);
        /* 脚本现在注入到所有 iframe，同一个页面会有多个 frame 各跑一份。
           只有真的含有 video 的那个 frame 才该出面版——父框架通常只有播放器外壳，
           在那里显示面板会得到一句「此页不支持双向」，纯属误导。
           没 video 就先藏着，交给轮询等它出现。 */
        if (E.pickVideo()) U.reveal();
        return;
      }
      teardown();
    })
    .catch(function () {});

  /* 这个站点到底授权没有：决定按钮显示「双向需授权」还是「刷新页面生效」 */
  chrome.runtime.sendMessage({ target: 'sw', type: 'checkOrigin', origin: location.origin })
    .then(function (r) { E.setPermGranted(!!(r && r.granted)); })
    .catch(function () {});
})();
