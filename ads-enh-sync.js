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
    wantAt, wantTime, syncCapturePipe, forcePipe, syncDelayToSw,
    samplePtsOffset, silenceBudget, resetSamples, resetVideoClock, resetStream,
    decideSilence, decideAim
  } = E.core;
  const { paintRouteMeta, publishState } = E.panel;
  const L = E.life;

  /* adsState 上一次发布的时刻。只在状态跳变时发布会让排查现场过期，
     见 syncTick 里的每秒刷新。 */
  let lastPubAt = 0;

  /** 音频重新出声：清静音标记；如果这段中断提示过用户，再报一声恢复。 */
  function markAudible() {
    if (!S.audioSilent) return;
    S.audioSilent = false;
    S.silentSince = 0;
    S.cap.swapAt = 0;
    publishState();
    if (S.cap.resumeNotice) {
      S.cap.resumeNotice = false;
      /* 超过一分钟就别报了：用户早忘了那次中断，突然弹「已恢复」反而莫名其妙 */
      if (S.ui && Date.now() - S.cap.adToastAt < C.RESUME_NOTICE_MS) {
        S.ui.showToast('声音已恢复');
      }
    }
  }

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
      S.silentSince = 0;
      /* 跳转后两边缓冲都换到新位置：基准重取，但已估出的偏移保留，
         避免每次拖进度条都重新经历一遍校准期。 */
      resetSamples();
      resetVideoClock();
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
    syncDelayToSw(false, target);

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
    if (S.ui) S.ui.showToast('音频一直等不到数据，已改为重新拉一路（约多一倍流量）');
    L.fail(null, function () {
      const R = window.ADS && window.ADS.E && window.ADS.E.route;
      if (!keep || !R || !R.startViaSrc) return;
      R.startViaSrc(keep);
      /* exitEnhanced 会把 routeWhy 清空，所以降级原因要在切完之后重写，
         否则面板上看不出「为什么从链路② 掉到了 ③」。 */
      S.routeWhy = '抓不到足够的切片，已自动降级';
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
      if (S.audioSilent) { S.audioSilent = false; S.silentSince = 0; publishState(); }
      return;
    }

    /* ---- 播放器换源（切集 / 切线路 / 广告接管同一个 video）----
       新的流有自己的时间轴和 PID，旧 muxer / 旧样本基线继续用只会解不出音频。
       把链路上下文按「重新接管」处理；广告回到正片时 onSegChunk 还会再清一次。 */
    const src = String(S.videoEl.currentSrc || S.videoEl.src || '');
    if (S.cap.src && src && src !== S.cap.src) {
      S.appendQueue.length = 0;
      S.muxer = null;
      S.audioSilent = false;
      S.silentSince = 0;
      S.capSeekBytes = S.capBytes;
      S.lastPosJump = 0;
      resetStream();
      /* 更新锁定目录 + 提示用户「换源了」 */
      S.cap.noteSource(src);
      /* 让 SW 侧的广告过滤也跟着换目录 */
      try {
        chrome.runtime.sendMessage({
          target: 'sw', type: 'captureSetPath', baseDir: S.cap.dir
        }).catch(function () {});
      } catch (e) {}
    }

    /* 广告插播期间（抓到过异目录切片）：正片音轨本来就不会有新数据。
       下面的「抓不到切片」和「静音太久」两个降级判据都要暂停计时。 */
    const adGrace = S.cap.isAdGrace();
    /* 切片还在持续解出音频：这段静音是「位置在缓冲前面等数据」，不是抓不到。
       此时降级到③只会更糟（③ 从 0 秒起播，在几分钟处根本追不回来）。 */
    const feeding = S.cap.isFeeding();

    /* 饥饿检查放在最前面：从跳转到现在一条新切片都没抓到，说明这个位置的
       数据这条链路根本拿不到，早点换链路③，别让用户一直听无声。 */
    if (!adGrace && !feeding && S.seekAt && Date.now() - S.seekAt > C.CAP_STARVE_MS &&
        S.capBytes === S.capSeekBytes) {
      degradeCapture();
      return;
    }

    /* ---- 画面冻住：音频跟着停 ----
       播放器断流 / 站点自己暂停推进时 `paused` 仍是 false，只是 currentTime
       不再前进。链路② 不按画面，但也不能让声音独自往前跑 —— 画面停几秒，
       声音就甩出几秒，之后只能靠 seek 硬拽回来。
       连续 0.7 秒没动就停音频；画面一动立刻复位，下一拍照常对齐。 */
    const vt = S.videoEl.currentTime;
    if (S.vFreezePos === null || Math.abs(vt - S.vFreezePos) > 0.01) {
      S.vFreezePos = vt;
      S.vFreezeAt = Date.now();
    } else if (Date.now() - S.vFreezeAt > 700) {
      if (!S.enhAudio.paused) { try { S.enhAudio.pause(); } catch (e) {} }
      return;
    }

    /* 每拍校准一次链路② 的 PTS 偏移：ts 的原始时间轴和页面时间轴差一个常量，
       不补就会「位置对齐、内容固定晚一截」（实测 1.6s）。 */
    samplePtsOffset();

    const want = wantTime();
    const drift = S.enhAudio.currentTime - want;

    /* ---- 第一档：位置本来就对，剩下交给 alignAudio 微调 ----
       这一档必须排在最前面。提前模式下 want 经常落在缓冲末尾之外几十毫秒，
       要是拿 bufferedHas(want) 当唯一判据，就会被误判成「没数据」而反复
       静音、反复 trySetAudioPos —— 后者会把它硬设到一个暂时没数据的位置，
       反而卡成 seeking。稳态下声音明明是好的，面板却一直闪「重新加载」。 */
    if (Math.abs(drift) < 1.0) {
      /* 先对齐，再决定出不出声。
         alignAudio 返回 false = 位置挪不过去（目标点既不在缓冲里，也不在
         seekable 里）。这时候把声音放出来就是「一直在错位」：偏差 1 秒以内
         用 0.9 倍速磨，磨回来要十秒，用户听到的是「点了归零，声音还慢一截」。
         宁可落下去静音，等切片 append 进来再对齐开声 —— 断一下比错十秒好。 */
      const ok = alignAudio(want);
      /* 位置对 ≠ 有声音：trySetAudioPos 能把游标摆到还没数据的区间，
         这时 readyState 仍是 HAVE_NOTHING，play() 只是挂在 seeking 上。
         面板会显示「已同步」，用户却听不到声音还找不到原因 —— 之前
         「一直挂在重新加载中」有一半是这个。所以位置对了还要确认
         目标点附近真有数据，否则照样按「没数据」处理。 */
      const hasData = S.enhAudio.readyState >= 2 && bufferedLead(want) > -0.6;
      if (ok !== false && hasData) {
        /* 只有手上真有数据才算「恢复」：位置对但 readyState 还低，说明仍在等
           第一片。这时候清掉 silentSince 会让下面的静音超时永远数不到 8 秒，
           表现就是面板一直显示「重新加载中」却永远不降级。 */
        if (S.audioSilent && S.enhAudio.readyState >= 2) markAudible();
        if (S.enhAudio.paused) {
          const p = S.enhAudio.play();
          if (p && p.catch) p.catch(function () {});
        }
        paintRouteMeta();
        return;
      }
    }

    /* ---- 第二档：偏了一大截，但目标点已经有数据 → 直接对齐 ---- */
    if (bufferedHas(want)) {
      markAudible();
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
      S.silentSince = Date.now();
      /* 玩家还在预缓冲时，下一片要等它的缓冲快播完才会被请求 —— 等待预算
         按画面剩余缓冲放宽，别把「还没轮到」误判成「抓不到」。 */
      S.silentLimit = silenceBudget();
      try { S.enhAudio.pause(); } catch (e) {}
      publishState();
    }

    /* ---- 广告插播：静音是正常的，别降档也别降级 ----
       广告切片来自另一条路径（onSegChunk 已挡掉），正片音轨在这段时间
       本来就不会有新数据。把计时按住，等正片切片回来再重新算 —— 否则
       广告一播十几秒，正好踩中「静音 8 秒降级③」，而 ③ 从 0 秒起播，
       在 5 分钟处根本追不回来，只能退出双向。 */
    if (adGrace && S.audioSilent) S.silentSince = Date.now();

    const plan = decideSilence({
      adGrace: adGrace,
      feeding: feeding,
      silentMs: S.silentSince ? Date.now() - S.silentSince : 0,
      silentLimit: S.silentLimit || C.CAP_SILENT_MAX_MS
    });

    /* ---- 静音太久：换链路③ ----
       上面两条出口都有前提：降档只对负值成立（提前量是 0 或正值时降无可降），
       降级只在「跳转后 15 秒一条新切片都没抓到」时触发（没跳转、或者切片
       在慢慢来都不成立）。缺了这一条，用户把滑块归零或放在正值、网络又慢，
       就会一直挂着「音频重新加载中」—— 实测限速 12KB/s 时静音了 10.5 秒，
       期间 capBytes 一动不动（一片 173KB，按这个速率要 14 秒才下得完）。
       宁可多一倍流量，也不能让用户听无声。 */
    if (plan === 'degrade') {
      degradeCapture();
      return;
    }

    /* ---- 静音两秒还没数据：把提前量降到缓冲撑得住的位置 ----
       不降的话，音频要 video+3 的数据，而缓冲只到 video+1，中间那截永远不来。
       实测（test-env/diag-starve.js，限速 12KB/s、seek 到 30s）：
       不降要干等 20.5 秒，降到 0 之后 10 秒就能出声。

       链路② 不按住画面，所以这里只改延迟量，既不暂停视频也不退出双向。
       带 transient 是为了不落盘 —— 用户重新进双向时还是他自己设的值。 */
    if (plan === 'downgrade') {
      /* 缓冲末尾是音频 PTS 轴，video.currentTime 是页面轴，两个轴的零点
         差着 ptsOffset。不减掉这一截，会把「已经播到头」误算成「还能再提前
         1.6 秒」，降档永远降不到位，声音一直卡在重新加载中。 */
      const budget = bufferedEnd() - S.ptsOffset - S.videoEl.currentTime - 0.8;
      const target = Math.max(-Math.max(0, budget) * 1000, currentMs());
      if (target > currentMs() + 200) {
        if (S.ui) S.ui.setValue(target);
        /* 走 forcePipe 而不是直接 sendMessage：这条通道要和别处一样
           确认送到了，否则降档会静默失败，面板写着新值、声音还是旧的。 */
        forcePipe(target);
        if (S.ui) {
          S.ui.showToast('缓冲跟不上，提前量已自动降到 '
            + Math.abs(target / 1000).toFixed(1) + ' 秒');
        }
      }
    }

    /* 降档之后 aim 变了，重新算一次再决定要不要摆位置。
       这里原来只在偏差 > 2 秒时才动，1~2 秒的落后正好落进死区：
       音频停在原地、视频一直在往前走，落后只会越等越大，永远追不回来。

       只能「往前贴、不能往后跳」：bufferedEnd() 是整段缓冲的最末尾，
       音频落后时它可能远在目标点之后（接管时抓到的都是预加载段）。
       无条件跳过去等于把十几秒后的声音提前放出来 —— 实测 aT-vT 直接
       变成 +8.5 秒。所以只在 「缓冲末尾还没到目标点」 时才贴。 */
    const aim = wantTime();
    const cur = S.enhAudio.currentTime;
    const needSeek = Math.abs(cur - aim) > C.DRIFT_SEEK;
    const catchUp = S.cap.catchUpUntil && Date.now() < S.cap.catchUpUntil;

    if (needSeek && !seekAudioTo(aim)) {
      const aimPlan = decideAim({
        needSeek: needSeek,
        ahead: aim > cur,
        catchUp: catchUp,
        lead: bufferedLead(aim),
        hasBuffered: S.enhAudio.buffered.length > 0,
        currentLead: bufferedLead(cur)
      });
      if (aimPlan === 'jump' && Date.now() - S.lastPosJump > 1500) {
        /* 落后，而且目标点还没缓冲到 —— 位置先过去（seekable 已经被
           ensureSeekRange 撑到那儿），等切片 append 进来就从这里续播。
           老代码是挪到 bufferedEnd()-0.25：那等于把音频扔到缓冲区最边上，
           下一拍必然 underflow，然后原地干等，落后一点没减小。
           差得太多（5 秒以上）就别硬跳了，交给上面的降档/降级去处理 ——
           跳过去也只是把「落后」换成「静音」。
           例外：广告刚结束的追赶窗口内必须跳过去，否则每拍只能靠略高于
           1 倍速挪，永远追不回画面。 */
        if (trySetAudioPos(aim)) {
          S.lastPosJump = Date.now();
          if (catchUp) S.cap.catchUpUntil = 0;
        }
      } else if (aimPlan === 'rewind') {
        /* 领先且目标点在缓冲之外 —— 通常发生在接管的那一刻：音频还停在 0，
           而缓冲从 10.x 秒才开始（开头那截在接管前就下载完了，永远拿不到）。
           MSE 不会自己跳过去，主动站到缓冲起点等着，视频一进入这个区间
           就能立刻出声。 */
        trySetAudioPos(S.enhAudio.buffered.start(0) + 0.05);
      }
    }
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
    /* adsState 是排查「固定延迟」的唯一现场（video 位置、PTS 偏移、缓冲）。
       只在状态跳变时发布的话，现场会停在几秒前，读出来全是过期的。
       前台一秒刷一次：开销可以忽略，排查时拿到的是当前值。
       标签页在后台时没人看也没人排查，降到 5 秒 —— 一次发布要选 video、
       绕一遍缓冲区间、整包 JSON.stringify + 写 dataset，
       多个标签页同时挂着时这笔开销是白给的。 */
    const pubGap = document.hidden ? 5000 : 1000;
    if (Date.now() - lastPubAt > pubGap) {
      lastPubAt = Date.now();
      publishState();
    }
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
