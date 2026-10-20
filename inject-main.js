'use strict';

/* ================================================================
 * MAIN world：在页面脚本之前劫持 MediaSource，把音频片段复制一份
 *
 * 为什么必须在 MAIN world：
 *   isolated world 里改 MediaSource.prototype 只影响扩展自己，
 *   页面播放器用的是另一份。
 *
 * 为什么必须在 document_start：
 *   init segment（moov，定义编码参数）只在每个 SourceBuffer 建好之后
 *   append 一次。错过了就永远解不出来，后面拿到的所有片段都是废数据。
 *
 * 为什么这条路能做出负偏移：
 *   拿到的 fMP4 带原始 PTS，和页面播放器同一条时间轴。新建一个只有音频的
 *   MediaSource 接住这些片段，它的 currentTime 就能设到页面播放位置之后
 *   ——那就是「声音提前」。
 * ================================================================ */

(function () {
  if (window.__adsHooked) return;
  window.__adsHooked = true;

  /* DOM 上的标记跨 world 可见，content.js 靠它判断自己是不是增强注入的实例 */
  try { document.documentElement.dataset.adsHooked = '1'; } catch (e) {}

  const OrigAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  if (typeof OrigAddSourceBuffer !== 'function') return;

  /* 当前截到的音频轨 mime，content 那边要拿它建自己的 SourceBuffer */
  let audioMime = '';

  function post(msg, transfer) {
    try {
      window.postMessage(Object.assign({ __ads: true }, msg), '*', transfer || []);
    } catch (e) {}
  }

  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = OrigAddSourceBuffer.call(this, mime);

    /* 扩展自己建的 MediaSource 不要截获，否则会自己喂自己无限套娃 */
    if (this.__adsOwn) return sb;

    if (!/^audio\//i.test(String(mime))) return sb;

    audioMime = String(mime);
    post({ type: 'track', mime: audioMime });

    const origAppend = sb.appendBuffer.bind(sb);

    sb.appendBuffer = function (data) {
      try {
        /* appendBuffer 会 detach 传进去的 ArrayBuffer，必须先复制，
           否则转发出去的是一块 0 字节的空壳。 */
        let copy = null;
        if (data instanceof ArrayBuffer) {
          copy = data.slice(0);
        } else if (data && data.buffer instanceof ArrayBuffer) {
          copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }
        if (copy && copy.byteLength) {
          post({ type: 'chunk', mime: audioMime, data: copy }, [copy]);
        }
      } catch (e) { /* 复制失败不能影响页面自己播放 */ }

      return origAppend(data);
    };

    return sb;
  };

  post({ type: 'ready' });
})();
