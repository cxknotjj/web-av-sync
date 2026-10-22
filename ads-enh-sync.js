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
    alignAudio, seekAudioTo, trySetAudioPos, trimBuffer, currentMs,
    wantAt, wantTime, syncCapturePipe
  } = E.core;
  const { paintRouteMeta, publishState } = E.panel;
  const L = E.life;

  function onVideoSeek() {
    if (!S.enhanced || !S.videoEl || !S.enhAudio) return;
    S.seekAt = Date.now();
    S.capSeekBytes = S.capBytes;

    /* 旧位置的待 append 片段全丢 —— 它们属于用户已经跳过的那一段。
       不清的话 pump 会一片一片塞进去，正是「强制缓存跳过内容」的来源。 */
    S.appendQueue.length = 0;

    /* PTS 跨段跳变，Transmuxer 内部的 DTS 连续性假设被打破。不重建的话，
       seek 后第一批切片可能转出错误的时间戳、被 SourceBuffer 拒收 ——
       表现是「音频一直没有新数据」，和「抓不到切片」长得一模一样。
       置 null 即可，下一片到达时 getMuxer() 会新建一个。 */
    if (S.enhMode === 'capture') {
      S.muxer = null;
      S.audioSilent = false;   /* 让 captureTick 按新位置重新判定 */
    }

    const want = wantTime();
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
    /* 链路② 绝不按画面 —— 按住播放器等于断掉它自己的数据源。
       syncTick 已经把这条链路分流走了，这里只是兜底，防止以后有人
       在别处直接调 stallNow()。 */
    if (S.enhMode === 'capture') return;

    if (!S.stalledByUs) {
      S.stalledByUs = true;
      S.stallSince = Date.now();
      S.stallTail = bufferedEnd();
      S.stallTailAt = S.stallSince;
      S.stallLead = bufferedLead(wantTime());
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
    const afterGiveUp = bufferedLead(wantAt(target));
    if (target === currentMs() || afterGiveUp < -C.WAIT_GAP) {
      L.fail('这个位置的音频还没下载到，已退出双向模式，声音回到页面原声。');
      return;
    }

    S.stalledByUs = false;
    S.stallSince = 0;

    if (S.ui) S.ui.setValue(target);
    /* 这次是用户看得见的降档（面板数字跟着变小），要持久化，所以不走
       syncCapturePipe 的 transient 通道；但要记下分配结果，
       否则下一拍照样再发一遍。 */
    S.pipeMs = target;
    try {
      chrome.runtime.sendMessage({ target: 'sw', type: 'setDelay', delayMs: target })
        .catch(function () {});
    } catch (e) {}

    if (S.ui) {
      S.ui.showToast(target === 0
        ? '缓冲一直没跟上，提前量已归零，只保留延迟。'
        : '缓冲跟不上，提前量已自动降到 ' + Math.abs(target / 1000).toFixed(1) + ' 秒。');
    }

    alignAudio(wantTime());
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

  /** 跳转后这么久一条新切片都没抓到 —— 这个位置的数据这条链路拿不到，
   *  换链路③（自己重拉一路）。不碰用户的延迟设置，也不按住画面。 */
  function degradeCapture() {
    if (S.enhMode !== 'capture') return;
    const keep = S.videoEl;
    if (S.ui) S.ui.showToast('这个位置抓不到切片，已改为重新拉一路（约多一倍流量）');
    L.fail(null, function () {
      const R = window.ADS && window.ADS.E && window.ADS.E.route;
      if (!keep || !R || !R.startViaSrc) return;
      R.startViaSrc(keep);
      /* exitEnhanced 会把 routeWhy 清空，所以降级原因要在切完之后重写，
         否则面板上看不出「为什么从链路② 掉到了 ③」。 */
      S.routeWhy = '跳转后抓不到新切片，已自动降级';
      publishState();
    });
  }

  /** 链路② 的一拍：视频优先，音频异步追，追不上就静音。
   *
   *  这条链路没有「等缓冲」这个选项 —— 数据源就是播放器本身，按住画面等于
   *  断供。所以这里只做三件事：位置跟着 want 走、有数据就出声、没数据就静音。
   *  视频的暂停只由用户决定，我们绝不主动按。
   *
   *  代价是跳转后可能有一小段没声音（播放器正在重新加载新位置的切片）。
   *  这是刻意接受的：宁可无声几秒，也不让画面卡住十几秒再降档。
   */
  function captureTick() {
    /* 用户自己按的暂停 —— 注意要和「seek 之后卡在等数据」分开：
       后者 paused 也会变 true（浏览器在无数据的 seeking 里会置位），
       如果一律当成用户暂停就会直接 return，下面的饥饿检查永远轮不到。 */
    if (S.videoEl.paused && !S.videoEl.seeking) {
      if (!S.enhAudio.paused) { try { S.enhAudio.pause(); } catch (e) {} }
      if (S.audioSilent) { S.audioSilent = false; publishState(); }
      return;
    }

    /* 饥饿检查放在最前面：从跳转到现在一条新切片都没抓到，说明这个位置的
       数据这条链路根本拿不到，早点换链路③，别让用户一直听无声。 */
    if (S.seekAt && Date.now() - S.seekAt > C.CAP_STARVE_MS &&
        S.capBytes === S.capSeekBytes) {
      degradeCapture();
      return;
    }

    const want = wantTime();
    const drift = S.enhAudio.currentTime - want;

    /* ---- 第一档：位置本来就对，剩下交给 alignAudio 微调 ----
       这一档必须排在最前面。提前模式下 want 经常落在缓冲末尾之外几十毫秒，
       要是拿 bufferedHas(want) 当唯一判据，就会被误判成「没数据」而反复
       静音、反复 trySetAudioPos —— 后者会把它硬设到一个暂时没数据的位置，
       反而卡成 seeking。稳态下声音明明是好的，面板却一直闪「重新加载」。 */
    if (Math.abs(drift) < 1.0) {
      if (S.audioSilent) {
        S.audioSilent = false;
        publishState();
      }
      if (S.enhAudio.paused) {
        const p = S.enhAudio.play();
        if (p && p.catch) p.catch(function () {});
      }
      alignAudio(want);
      paintRouteMeta();
      return;
    }

    /* ---- 第二档：偏了一大截，但目标点已经有数据 → 直接对齐 ---- */
    if (bufferedHas(want)) {
      if (S.audioSilent) {
        S.audioSilent = false;
        publishState();
      }
      if (S.enhAudio.paused) {
        const p = S.enhAudio.play();
        if (p && p.catch) p.catch(function () {});
      }
      alignAudio(want);
      paintRouteMeta();
      return;
    }

    /* ---- 第三档：真没数据。静音，但绝不动视频 ----
       位置朝 want 摆：只有偏差很大时才硬设（seek 之后那种），
       小偏差由下一拍的 alignAudio 用倍速追，不折腾媒体元素。 */
    if (!S.audioSilent) {
      S.audioSilent = true;
      try { S.enhAudio.pause(); } catch (e) {}
      publishState();
    }
    if (Math.abs(drift) > 2) trySetAudioPos(want);
    paintRouteMeta();
  }

  function syncTick() {
    if (!S.enhanced || !S.videoEl || !S.enhAudio) return;
    pump();
    /* 回收播放位置之前的缓冲：MSE 不会自己释放，不删就一路攒着 */
    trimBuffer();
    /* 滑块可能刚从「提前」拖到「延后」，管子该换人干活了。
       真变了才重发状态 —— publishState 要走一次 pickVideo，别每拍都做。 */
    if (syncCapturePipe(currentMs())) publishState();
    /* 顺手把「还能提前多少」刷到面板上 */
    paintRouteMeta();

    /* ---------------- 链路②：视频优先，音频异步追 ----------------
     * 必须放在等缓冲那一段之前，而且完全不进那一段。
     * 这条链路的数据全部来自「播放器请求了哪些切片」—— 一旦按住画面，
     * 播放器就不再发请求，音频永远等不到，等于自己把自己的粮断了。
     * 详见 captureTick()。 */
    if (S.enhMode === 'capture') { captureTick(); return; }

    /* ---------------- 正在等缓冲 ----------------
     * 这一段必须放在「videoEl.paused 就停音频」前面：等缓冲时视频正是被我们自己
     * 按住的，走下面那条分支只会一直 return，再也没人把它放开。 */
    if (S.stalledByUs) {
      const need = wantTime();
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

    /* 音频该播到哪一秒由 wantTime() 统一算：负值（提前）往前挪，
       正值（延后）交给 DelayNode，音频只跟着画面。 */
    const want = wantTime();
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
