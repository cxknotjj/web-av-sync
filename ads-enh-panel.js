'use strict';

/* ================================================================
 * 面板文案：把内部状态翻译成用户看得懂的一句话
 *
 * 三种显示：
 *   paintRoute      左边那条「走哪一路」指示条
 *   paintRouteMeta  右侧那截动态数字（可提前 N 秒 / 等缓冲还差 N 秒）
 *   paintModeUI     「启用双向」按钮的文案与可点状态
 *
 * 这一层只读状态、不改进度：改状态的是 route / sync，改完通知这里重画。
 * 依赖：core（状态、链路判断、缓冲余量）
 * ================================================================ */

(function () {
  window.ADS = window.ADS || {};
  const E = window.ADS.E;

  /* 每个文件都得自己挡重复注入，理由见 ads-enh-core.js 顶部 */
  if (!E || !E.core || E.panel) return;

  const S = E.S;
  const { pickVideo, pageKind } = window.ADS.detect;
  const {
    ROUTES, pickRoute, captureEnabled, routeId, bufferedLead, currentMs, wantTime
  } = E.core;

  function paintRoute() {
    if (!S.ui) return;

    /* enhMode 一旦有值就说明这条链路已经选定，哪怕还没落定也要按它显示。
       此时不能再走 pickRoute() 预告，否则 ② 降级到 ③ 的过程中，
       面板会一直挂着「将用 ②」，跟实际跑的对不上。 */
    const r = ROUTES[S.enhMode] || ROUTES[pickRoute(pageKind())];
    if (!r) { S.ui.setRoute(null); return; }

    S.ui.setRoute({
      id: routeId(S.enhMode || pickRoute(pageKind())),
      /* 「将用」是给还没点的用户看的，分清预告和生效 */
      name: S.enhMode ? r.name : '将用 ' + r.name,
      /* 链路选定了但还没出声（在等数据、等降级），别让用户以为已经生效 */
      meta: S.enhMode && !S.enhanced ? '连接中…' : r.meta,
      hint: (S.enhMode === 'src' && S.routeWhy) ? r.hint + ' ｜ 原因：' + S.routeWhy : r.hint,
      on: S.enhanced
    });

    if (S.enhanced) paintRouteMeta();
    /* 链路一选定就发布状态，别等下一次整轮重绘 */
    publishState();
  }

  function paintRouteMeta() {
    if (!S.ui || !S.enhAudio || !S.videoEl) return;
    const r = ROUTES[S.enhMode];
    if (!r) return;

    const b = S.enhAudio.buffered;
    const tail = b.length ? b.end(b.length - 1) : 0;

    /* 等缓冲时右侧那截改报「还差多少」——不然用户看到「可提前 0.0s」
       却不知道画面为什么要停在那儿 */
    if (S.stalledByUs) {
      const lead = bufferedLead(wantTime());
      /* -999 是「一段缓冲都没有」的哨兵值，别拿它算成「还差 999 秒」。
         lead 为正 = 数据其实已经够播到目标位置，只是余量还没到 RESUME_LEAD，
         这时候写「还差 0.0s」会让人以为卡死了。 */
      if (lead <= -900) S.ui.setRouteMeta('等缓冲 · 下载中…');
      else if (lead > 0) S.ui.setRouteMeta('等缓冲 · 数据已到，准备恢复');
      else S.ui.setRouteMeta('等缓冲 · 还差 ' + (-lead).toFixed(1) + 's');
      return;
    }

    const ahead = b.length ? Math.max(0, tail - S.videoEl.currentTime) : 0;
    S.ui.setRouteMeta(r.meta + ' · 可提前 ' + ahead.toFixed(1) + 's');
  }

  function publishState() {
    try {
      const v = pickVideo();
      document.documentElement.dataset.adsState = JSON.stringify({
        kind: pageKind(),
        capture: captureEnabled(),
        mux: typeof muxjs !== 'undefined',
        hookInstalled: S.hookInstalled,
        hookReady: S.hookReady,
        chunks: S.chunks.length,
        enhanced: S.enhanced,
        mode: S.enhMode,
        why: S.routeWhy,
        videoSrc: v ? String(v.currentSrc || v.src || '').slice(0, 80) : null,
        videoPaused: v ? v.paused : null,
        /* 停在暂停上是不是扩展自己按的（为了等缓冲），别和用户暂停混了 */
        delayMs: currentMs(),
        stalled: S.stalledByUs,
        bufferedLead: S.enhAudio ? +bufferedLead(wantTime()).toFixed(2) : null,
        /* 这一次写给 DelayNode 的值。排查「拖了没反应」时，先看它有没有跟着动：
           null = 还没分配过，负数 = 已归零，正数 = 这个值正在 DelayNode 上 */
        pipeMs: S.pipeMs
      });
    } catch (e) {}
  }

  function paintModeUI() {
    if (!S.ui) return;

    S.ui.setTip(S.enhanced ? '负值让声音提前 · 滚轮可调' : '只延后声音 · 滚轮可调');
    S.ui.setModeTag(S.enhanced ? '双向' : '延迟', S.enhanced);
    paintRoute();
    publishState();

    if (S.enhanced) {
      S.ui.setModeBtn('', '', true);
      return;
    }

    if (S.hookReady) {
      S.ui.setModeBtn('启用双向', '复用页面已经下载的音频片段，支持负值（声音提前）', false);
      return;
    }

    const kind = pageKind();

    if (kind === 'hls') {
      S.ui.setModeBtn('启用双向', (captureEnabled() && typeof muxjs !== 'undefined')
        ? '原生 HLS：先用调试协议取回播放器已下载的切片，不额外耗流量（浏览器顶部会提示正在调试）；取不到时自动改为重新拉一路'
        : '原生 HLS：用同一条流再播一遍（浏览器直接解码），支持负值（声音提前）。会多用一倍流量', false);
      return;
    }

    if (kind === 'direct') {
      S.ui.setModeBtn('启用双向', '用同一条流的音频再播一遍（浏览器直接解码），支持负值（声音提前）。会多用一倍流量', false);
      return;
    }

    /* DASH：<audio> 喂不进 .mpd 清单，点下去只会白等 15 秒再失败，
       所以按钮直接说明不支持，别让用户去授权、去刷新折腾一圈 */
    if (kind === 'dash') {
      S.ui.setModeBtn('此页不支持双向', 'DASH（.mpd）清单由页面自己的播放器解码，音频片段没有可复用的通道。延迟模式仍可用', false);
      return;
    }

    if (!S.hookInstalled) {
      S.ui.setModeBtn(
        S.permGranted ? '刷新页面生效' : '双向需授权',
        S.permGranted
          ? '这个站点已经授权，但当前页面加载时脚本还没注册上。刷新一次即可'
          : '需要当前站点的访问权限，点一下会弹出授权框',
        false
      );
      return;
    }

    /* 脚本装上了却没截到音频轨：要么还没开始播，要么根本不是 MSE */
    if (kind === 'mse') {
      S.ui.setModeBtn('等待音频轨', '播放器还没往 MSE 里写音频，先让视频播放几秒', false);
    } else if (kind === 'unknown') {
      S.ui.setModeBtn('等待播放', '视频还没开始加载，先点一下播放', false);
    } else {
      S.ui.setModeBtn('此页不支持双向', kind === 'hls'
        ? '视频地址是 .m3u8 直连（原生 HLS），数据不经过 JS'
        : '视频是直连的，音频数据不经过 MSE', false);
    }
  }

  function startModeWatch() {
    if (S.modeTimer) return;
    S.modeTimer = setInterval(function () {
      /* 有 video 了才显形：跨域 iframe 场景下，父框架会一直等不到 video，
         面板就保持隐藏；真正有播放器的那个 frame 会在这里显形。 */
      if (S.ui && S.ui.host.style.display === 'none' && pickVideo()) S.ui.reveal();

      /* 先重绘再判断要不要停：地址刚出现的那一次，正是需要刷新文案的时候 */
      paintModeUI();
      const k = pageKind();
      if (!S.hookInstalled || S.hookReady || S.enhanced || (k !== 'unknown' && k !== 'none')) stopModeWatch();
    }, 400);
  }

  function stopModeWatch() {
    if (S.modeTimer) { clearInterval(S.modeTimer); S.modeTimer = null; }
  }

  function updateModeUI() {
    paintModeUI();

    /* 视频地址从「空」变成 blob:/m3u8 只发生一次，但没有任何事件能可靠捕获
       （播放器可能在任意时刻给 video 赋 src，SPA 还可能稍后才插入 video）。
       unknown / none 都算「还没有定论」，需要轮询；其余状态一次就能判死。 */
    const k = pageKind();
    if (S.hookInstalled && !S.hookReady && !S.enhanced && (k === 'unknown' || k === 'none')) startModeWatch();
    else stopModeWatch();
  }

  E.panel = {
    paintRoute: paintRoute,
    paintRouteMeta: paintRouteMeta,
    publishState: publishState,
    updateModeUI: updateModeUI
  };

  /* paintModeUI / startModeWatch / stopModeWatch 只在本文件内部用：
     对外统一走 updateModeUI()，它会顺手决定要不要起轮询。 */
})();
