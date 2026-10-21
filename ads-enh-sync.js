'use strict';

/* ================================================================
 * 同步循环：让那条隐藏的 <audio> 一直贴着画面走
 *
 * 每 250ms 一拍（syncTick），做四件事：
 *   1. 把队列里的音频片段灌进 MSE（pump）
 *   2. 回收播放位置之前的缓冲（trimBuffer）
 *   3. 位置有偏差就追 —— 小偏差改倍速，大偏差才 seek
 *   4. 数据跟不上就按住画面等（stall），够了再放开
 *
 * 所有「画面停住 / 放开」的判断都集中在这里，面板只负责显示。
 * 依赖：core（缓冲几何、对齐）、panel（指示条）、life（失败退出）
 * ================================================================ */

(function () {
  window.ADS = window.ADS || {};
  const E = window.ADS.E;

  /* 每个文件都得自己挡重复注入，理由见 ads-enh-core.js 顶部 */
  if (!E || !E.core || !E.panel || E.sync) return;

  const S = E.S;
  const C = E.C;
  const {
    pump, bufferedHas, bufferedLead, bufferedEnd,
    alignAudio, seekAudioTo, trimBuffer, currentMs
  } = E.core;
  const { paintRouteMeta, publishState } = E.panel;
  const L = E.life;

  function onVideoSeek() {
    if (!S.enhanced || !S.videoEl || !S.enhAudio) return;
    S.seekAt = Date.now();

    /* 旧位置的待 append 片段全丢 —— 它们属于用户已经跳过的那一段。
       不清的话 pump 会一片一片塞进去，正是「强制缓存跳过内容」的来源。 */
    S.appendQueue.length = 0;

    const want = S.videoEl.currentTime - currentMs() / 1000;
    try { S.enhAudio.playbackRate = 1; } catch (e) {}
    /* 位置先摆到正确的地方。没缓冲到时 seekAudioTo 会跳过 —— 硬 seek 要么
       被钳回缓冲末尾，要么卡在 seekable 与 buffered 之间的空洞里、从此不再
       接受校正。数据 append 进来后下一拍会自动纠正。 */
    seekAudioTo(want);

    /* 等待基准整体换成新位置：stallSince / stallTail 还是旧位置的，
       继续用会把「刚跳过来的等待」算成「已经等了很久」，几秒后误降档。 */
    if (S.stalledByUs) {
      S.stallSince = Date.now();
      S.stallTail = bufferedEnd();
      S.stallTailAt = S.stallSince;
      S.stallLead = bufferedLead(want);
      S.stallGiveUps = 0;
    }

    trimBuffer();
    publishState();
  }

  function stallNow() {
    if (!S.stalledByUs) {
      S.stalledByUs = true;
      S.stallSince = Date.now();
      S.stallTail = bufferedEnd();
      S.stallTailAt = S.stallSince;
      S.stallLead = bufferedLead(S.videoEl.currentTime - currentMs() / 1000);
      /* 全屏时面板多半被收起，画面突然停住得有句话解释，不然像卡死了。
         一次等待只弹一条，且 20 秒冷却 —— 网络差导致连环等待时不刷屏。 */
      if (S.ui && Date.now() - S.lastStallToast > 20000) {
        S.lastStallToast = Date.now();
        S.ui.showToast('缓冲跟不上提前量，画面暂停等待下载…');
      }
      publishState();
    }
    try { S.enhAudio.playbackRate = 1; } catch (e) {}
    try { if (!S.videoEl.paused) S.videoEl.pause(); } catch (e) {}
    try { if (!S.enhAudio.paused) S.enhAudio.pause(); } catch (e) {}
    paintRouteMeta();
  }

  function resumeNow() {
    S.stalledByUs = false;
    S.stallSince = 0;
    publishState();
    let p = null;
    try { p = S.videoEl.play(); } catch (e) {}
    if (p && p.catch) {
      p.catch(function () {
        /* 浏览器拒绝恢复播放（极罕见）。停在这儿等于把用户的视频卡死，
           不如直接退回页面原声 —— 至少画面能继续走。 */
        if (S.ui) S.ui.showToast('视频没能自动恢复播放，已退出双向模式');
        L.exit();
      });
    }
    if (S.enhAudio.paused) {
      const q = S.enhAudio.play();
      if (q && q.catch) q.catch(function () {});
    }
    paintRouteMeta();
  }

  function giveUpWait() {
    /* 第一次还给缓冲留 1.2 秒余量 —— 恢复播放的瞬间 currentTime 就在走，
       留太少等于刚放开就又得按住。降过一次还撑不住的，直接归零。 */
    const budget = S.stallGiveUps > 0
      ? 0
      : Math.max(0, bufferedEnd() - S.videoEl.currentTime - 1.2);
    const target = Math.max(-budget * 1000, currentMs());
    S.stallGiveUps++;

    /* 已经没什么可降的了：音频在这一段就是没下载下来（往回拖得太远、
       或者站点把流切走了）。再放开画面只会「停一会儿、动半秒」地循环，
       不如老实退回原声 —— 至少画面和声音都是用户熟悉的那一份。 */
    /* 降完提前量，目标位置仍然落在缓冲之外 —— 说明这段音频根本没下载下来
       （用户跳得太远，或者站点把流切走了）。这时候放开画面就是「画面在走、
       声音没有」，而且下一拍还会再 stall，变成规律的卡顿循环。
       老实退回页面原声，至少声画是配套的。 */
    const afterGiveUp = bufferedLead(S.videoEl.currentTime - target / 1000);
    if (target === currentMs() || afterGiveUp < -C.WAIT_GAP) {
      L.fail('这个位置的音频还没下载到，已退出双向模式，声音回到页面原声。');
      return;
    }

    S.stalledByUs = false;
    S.stallSince = 0;

    if (S.ui) S.ui.setValue(target);
    try {
      chrome.runtime.sendMessage({ target: 'sw', type: 'setDelay', delayMs: target })
        .catch(function () {});
    } catch (e) {}

    if (S.ui) {
      S.ui.showToast(target === 0
        ? '缓冲一直没跟上，提前量已归零，只保留延迟。'
        : '缓冲跟不上，提前量已自动降到 ' + Math.abs(target / 1000).toFixed(1) + ' 秒。');
    }

    alignAudio(S.videoEl.currentTime - currentMs() / 1000);
    publishState();
    let p = null;
    try { p = S.videoEl.play(); } catch (e) {}
    if (p && p.catch) p.catch(function () {});
    if (S.enhAudio.paused) {
      const q = S.enhAudio.play();
      if (q && q.catch) q.catch(function () {});
    }
    paintRouteMeta();
  }

  function syncTick() {
    if (!S.enhanced || !S.videoEl || !S.enhAudio) return;
    pump();
    /* 回收播放位置之前的缓冲：MSE 不会自己释放，不删就一路攒着 */
    trimBuffer();
    /* 顺手把「还能提前多少」刷到面板上 */
    paintRouteMeta();

    /* ---------------- 正在等缓冲 ----------------
     * 这一段必须放在「videoEl.paused 就停音频」前面：等缓冲时视频正是被我们自己
     * 按住的，走下面那条分支只会一直 return，再也没人把它放开。 */
    if (S.stalledByUs) {
      const need = S.videoEl.currentTime - currentMs() / 1000;
      const lead = bufferedLead(need);
      /* 缓冲已经到顶（后面不会再有数据）：剩下这点余量就是全部本钱，
         不能因为差零点几秒达不到 RESUME_LEAD 就一直按着 —— 那会一路等到
         「卡死」超时，然后把提前量清掉甚至直接退出双向。
         判据是末尾连续 2 秒没长，正常下载中不会触发。 */
      const tailStuck = Date.now() - S.stallTailAt > 2000;
      if (lead >= C.RESUME_LEAD || (lead > C.WAIT_GAP && tailStuck)) {
        alignAudio(need);
        resumeNow();
        return;
      }

      /* 等待期间必须一直按着画面。stallNow 只在第一次调用时 pause，
         而用户拖完进度条后很多播放器会自己接着播 —— 视频在走、音频还停在
         旧位置，正是「拖完之后声音对不上」的样子。 */
      try { if (!S.videoEl.paused) S.videoEl.pause(); } catch (e) {}
      try { if (!S.enhAudio.paused) S.enhAudio.pause(); } catch (e) {}
      /* 顺带把音频摆到目标位置等着。数据还没到的话 seekable 里没有这一段，
         seekAudioTo 会跳过（硬 seek 只会被钳回一个错的位置），
         等切片 append 进来后由 alignAudio 纠正。 */
      if (Math.abs(S.enhAudio.currentTime - need) > 1) {
        seekAudioTo(need);
      }

      /* 「还在下载」有两种长相：缓冲末尾在往前长（正常前进），或者目标位置
         离可播数据越来越近（用户把进度条拖回去，要从更早的地方重新下）。
         任一个在动就继续等。以前只看末尾 —— 往回拖时末尾是旧位置的高水位，
         永远不长，4 秒就误判成「下不来了」把提前量清掉。 */
      const tail = bufferedEnd();
      if (lead > S.stallLead + 0.05) {
        S.stallLead = lead;
        S.stallTailAt = Date.now();
      } else if (tail > S.stallTail + 0.05) {
        S.stallTail = tail;
        S.stallTailAt = Date.now();
      }
      const stuck = Date.now() - S.stallTailAt > C.WAIT_STUCK_MS;
      const tooLong = Date.now() - S.stallSince > C.WAIT_MAX_MS;
      /* 目标位置整个落在缓冲之外 = 在等「新位置」的切片。这种情况降提前量
         一点用都没有（降了也播不到那儿），只会把画面放开、声音留在原地。
         所以宁可多等一会儿，面板上「还差 N 秒」在动，用户看得见。
         例外：末尾连续 6 秒没长 —— 那是真的到片尾/断流了，再等也没有，
         交给 giveUpWait 去降档（它还会再确认一次降完有没有数据）。 */
      const noDataAtTarget = lead < -C.WAIT_GAP;
      const atStreamEnd = Date.now() - S.stallTailAt > C.WAIT_STUCK_MS * 1.5;
      if (tooLong || (stuck && (!noDataAtTarget || atStreamEnd))) { giveUpWait(); return; }

      paintRouteMeta();
      return;
    }

    /* 视频暂停时音频也要停，否则声音会跑到画面前面 */
    if (S.videoEl.paused) {
      if (!S.enhAudio.paused) S.enhAudio.pause();
      return;
    }
    if (S.enhAudio.paused) S.enhAudio.play().catch(function () {});

    /* currentMs 的语义是「音频延迟量」：正值 = 声音比画面晚，负值 = 提前。
       所以 audio 要播的位置是 video.currentTime - currentMs/1000：
       currentMs=-3000 → audio 跑到画面前面 3 秒的内容 → 观众提前 3 秒听到。 */
    const want = S.videoEl.currentTime - currentMs() / 1000;
    if (bufferedHas(want)) { alignAudio(want); return; }

    /* 目标位置还没缓冲到。差得多 = 下载跟不上设定的提前量。这时如果放任画面
       继续走，音频就会 underflow：画面正常、声音没了，而且越走越远，再也追不上。
       所以先按住画面，等缓冲追上来。 */
    if (bufferedLead(want) < -C.WAIT_GAP) { stallNow(); return; }

    /* 只差一丁点（网络抖一下）：原地等下一拍，别 seek，也别停画面 */
    if (Math.abs(S.enhAudio.currentTime - want) > 2.5) {
      seekAudioTo(want);
    }
  }

  E.sync = {
    syncTick: syncTick,
    onVideoSeek: onVideoSeek
  };
})();
