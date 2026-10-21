'use strict';

/* ================================================================
 * 页面检测：挑 video、判断播放方式
 *
 * 从 ads-enhance.js 拆出来的纯函数（不依赖任何模块内部状态），
 * 供 ads-enhance.js 和未来的调用方共用。依赖 window.ADS 命名空间。
 * ================================================================ */

(function () {

  /** 挑「最像主播放器」的 video。
   *  页面处于全屏时优先选全屏元素子树里的 —— 否则按可视面积挑，
   *  预加载小窗 / 画中画广告位面积更大的页面会挑错。 */
  function pickVideo() {
    let fsEl = null;
    try { fsEl = document.fullscreenElement || null; } catch (e) {}
    if (fsEl) {
      const inFs = fsEl.querySelector('video');
      if (inFs) return inFs;
    }

    let best = null;
    let bestArea = 0;
    document.querySelectorAll('video').forEach(function (v) {
      const area = (v.clientWidth || 0) * (v.clientHeight || 0);
      if (area > bestArea) { bestArea = area; best = v; }
    });
    return best || document.querySelector('video');
  }

  /** 判断这一页的播放方式。返回值同时决定双向模式走哪条链路：
   *  mse → ①；hls → ②③；dash / direct → ③；stream / unknown / none → 不支持。 */
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
    if (/\.mpd([?#]|$)/i.test(src)) return 'dash';
    return 'direct';
  }

  window.ADS = window.ADS || {};
  window.ADS.detect = { pickVideo: pickVideo, pageKind: pageKind };
})();
