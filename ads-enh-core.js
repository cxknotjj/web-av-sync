'use strict';

/* ================================================================
 * 双向模式的底座：共享状态、常量、缓冲工具、链路选择
 *
 * 拆分前这些全在一个 1200 行的闭包里，状态靠闭包变量共享。拆成多文件后
 * 闭包没了，于是收进一个显式的 S 对象 —— 每个模块拿到的都是同一个引用，
 * 读写的是同一份，和原来的闭包变量等价。
 *
 *   S            运行时状态，字段名与拆分前一一对应
 *   C            调参常量
 *   E.core.xxx   缓冲几何、音频对齐、片段队列、链路选择，全是纯函数
 *
 * 这一层不依赖任何其他模块，route / sync / panel 都可以放心依赖它。
 * ================================================================ */

(function () {
  window.ADS = window.ADS || {};
  const E = window.ADS.E = window.ADS.E || {};

  /* 重复注入（停止后再点图标）会把这些文件再跑一遍。以前整个大 IIFE 顶部
     一个守卫就够了，拆开之后每份都得自己挡：重建 S 会丢掉正在跑的
     syncTimer 引用，旧定时器停不掉、新定时器又起一个，表现是两路音频同时出声。 */
  if (E.core) return;

  const { pageKind } = window.ADS.detect;

  /* 三条链路的展示元数据。面板上那一行「走哪一路」全靠这张表：
     meta 是代价，hint 是悬停解释。想加链路就在这儿加一条，
     判断逻辑在 pickRoute()。 */
  const ROUTES = {
    mse: {
      id: '①',
      name: '复用页面切片',
      meta: '零流量',
      hint: '播放器用 MSE 播放，音频片段已经在 appendBuffer 里被截下来了，直接复用，不额外下载'
    },
    capture: {
      id: '②',
      name: '抓取已下载切片',
      meta: '零流量',
      hint: '原生 HLS：靠调试协议取回播放器已经下过的 ts 切片，不额外下载。' +
        '代价是浏览器顶部会显示「正在调试此浏览器」，且用户自己开着 DevTools 时会失败'
    },
    src: {
      id: '③',
      name: '重新拉一路',
      meta: '约双倍流量',
      hint: '同一条流再解码一遍只取声音。不需要授权、不需要刷新，但下载量大约翻倍'
    }
  };

  const ROUTE_ORDER = ['mse', 'capture', 'src'];
  const ROUTE_IDS = ['①', '②', '③'];

  /* ---------------- 状态 ---------------- */

  const S = E.S = {
    ui: null,                 /* 面板句柄，init() 时由 content.js 注入 */
    inited: false,            /* window 消息监听器只装一次，见 init() */

    enhanced: false,
    /* hookInstalled：MAIN world 的脚本装上了
       hookReady：真的截到了 audio 轨（收到 track 消息）。
       两者必须分开 —— 原生 HLS 页面 hook 装得上，但永远截不到东西。 */
    hookInstalled: false,
    hookReady: false,
    /* 站点是否已授权。和「脚本有没有注入」是两件事：
       授权了但页面在注册完成前就加载，脚本仍然进不来。 */
    permGranted: false,

    audioMime: '',
    chunks: [],
    chunkBytes: 0,

    enhMS: null,
    enhAudio: null,
    enhBuf: null,
    appendQueue: [],
    syncTimer: null,
    videoEl: null,

    /* 链路② 的 ts 用的是**原始 PTS**，而页面原生 HLS 的 video.currentTime
       用的是播放器自己归一化后的时间轴。两者起点常常差一截（实测 1.5~1.6s），
       这就是「延迟设 0、声音仍固定晚 1.6 秒」的来源：我们一直把 audio.currentTime
       按 video.currentTime 硬对齐，位置对了，内容却整体晚了一个固定量。

       ptsOffset = 音频时间轴 − 视频时间轴（内容对齐所需的补偿）。
       由两边的 buffered 末尾差在线估计，取中位数，避免单片抖动。 */
    ptsOffset: 0,
    offSamples: [],
    offLastA: null,
    offLastV: null,
    /* 画面自己停住（缓冲断流 / 站点暂停推进）时 paused 仍是 false，
       currentTime 却不再前进。链路② 若照常放音频，声音会一路跑到画面
       前面去。这两个字段用来判定「画面是不是冻住了」，见 captureTick。 */
    vFreezePos: null,
    vFreezeAt: 0,

    /* 当前走的哪条链路，决定退出时要做哪些清理 */
    enhMode: '',
    /* 为什么落到这条链路。用户看到 ③ 却不知道为什么没用更省的那条时，
       这个字符串就是答案，会拼进指示条的悬停提示。 */
    routeWhy: '',
    enhGuard: null,           /* 试运行超时计时器，非 null 表示还在「未落定」阶段 */
    capInitDone: false,       /* 调试通道下，init segment 只需 append 一次 */
    capBytes: 0,              /* 已经解出多少音频字节，用来判断「真有数据了」 */
    guardMute: null,          /* 接管期间守住「原视频静音」的监听器 */

    /* 链路② 的流身份 / 广告插播状态。字段和方法都收在这个对象里，
       route / sync / panel 只读或调用，不再各自改顶层 S 字段。
       定义在 C 之后（方法要用常量和 segDir）。 */
    cap: null,
    /* 广告插播会把页面时间轴整体推移一个广告时长（实测这次 5:00 的广告把
       两边的 buffered 末尾差从 +1.7s 变成 −24s）。「同时增长」取样在这段
       很难错拍对上，改成等两边缓冲都静止后直接量差值，见 samplePtsOffset。 */
    adResampleUntil: 0,
    aEndSeen: 0,
    aEndSeenAt: 0,
    vEndSeen: 0,
    vEndSeenAt: 0,

    /* 等缓冲：要提前的量超过已下载的量时，音频会 underflow（画面在走、没声音）。
       这时由我们主动按住视频，等音频追上来再放开。stalledByUs 必须记住
       「这次暂停是自己按的」，否则下一拍会被当成用户暂停，永远放不开。 */
    stalledByUs: false,
    stallSince: 0,
    stallTail: 0,             /* 进等待时的缓冲末尾，用来判断「还在不在下载」 */
    stallTailAt: 0,           /* 缓冲最后一次增长的时刻 */
    stallLead: -999,          /* 进等待时「目标位置离可播数据还差多少」 */
    lastStallToast: 0,        /* 上次「等缓冲」toast 的时间，做冷却用 */

    /* 用户拖进度条。视频的 currentTime 会瞬间跳到新位置，而我们这条音频还停在
       旧位置、MSE 里还攒着旧位置的片段、appendQueue 里还排着旧位置的队列。
       不在这里一次性纠正的话会有两个后果：
         1. 画面在新位置走，声音还在旧位置 —— 完全对不上；
         2. 队列里的旧片段继续灌进 MSE，把用户刚跳过的整段都缓冲下来。
       seekAt 记下时刻，用来把「seek 之前发出的切片请求」挡在门外 ——
       那些字节属于已经跳过的那一段。 */
    seekAt: 0,
    seekHandler: null,
    trimBusy: false,
    /* 已经因为等不到而自动降档几次。降过一次还不够的，第二次直接归零 ——
       否则会「降一点、再卡四秒、再降一点」，比一直卡着还难受。 */
    stallGiveUps: 0,

    appendFails: 0,           /* 连续 append 失败计数 */
    appendFailToasted: false, /* 「连续对不上」的提示只弹一次，别刷屏 */

    /* 链路② 的「静音等数据」状态。它和 stalledByUs 是两回事：
       stalledByUs 会按住视频，链路② 绝不这么做 —— 这条链路的数据来自
       「播放器请求了哪些切片」，按住播放器等于把自己的数据源掐断。
       audioSilent 只停音频，画面照常走，几秒后数据到了自己接上。 */
    audioSilent: false,
    silentSince: 0,           /* 这一轮静音从什么时候开始，用来触发「自动降到缓冲撑得住的量」 */
    /* 这一轮静音最多等多久才降级。播放器自己预缓冲很多时，它根本不会去请求
       新切片，等 8 秒就降级属于误判 —— 实测站点一次预缓冲了 10 秒，链路②
       在数据到来前一脚被踢到链路③。按「画面还剩多少缓冲」算等待预算。 */
    silentLimit: 0,
    capSeekBytes: 0,          /* seek 那一刻已解出多少字节，用来判断「一条新片都没来」 */
    /* 上一次「把 <audio> 的位置硬摆到未缓冲区间」的时刻。
       链路② 落后太多时会这么做，但没数据时反复 seek 只会反复打断播放，
       所以同一个位置 1.5 秒内只摆一次。 */
    lastPosJump: 0,

    muxer: null,              /* Transmuxer 单例，见 ads-enh-route.js */
    muxOut: null,             /* 本次 push/flush 的输出，事件回调往里写 */

    /* 上一次写给 DelayNode 的延迟值，null = 本轮还没分配过。
       见 syncCapturePipe()：负值归零、正值由 DelayNode 承担，靠它避免
       每拍重复发消息。 */
    pipeMs: null,
    /* 写 DelayNode 连续失败几次，以及下次允许重试的时刻。
       消息发出去不等于到了：SW 冷启动、offscreen 正在重建的那个窗口里，
       setDelay 会返回 ok:false（甚至直接被 reject）。以前没人看返回值，
       pipeMs 照样记成「新值」，之后每一拍都被 20ms 阈值挡掉 ——
       DelayNode 就永久停在旧值上。这就是「点归零，面板 0.000，
       声音还晚一截」。见 pushDelay()。 */
    pipeFails: 0,
    pipeRetryAt: 0,

    modeTimer: null           /* 地址从空变成有，需要轮询一段时间 */
  };

  /* ---------------- 常量 ---------------- */

  const C = E.C = {
    MAX_CHUNK_BYTES: 48 * 1024 * 1024,

    KEEP_BEHIND: 3,           /* 播放位置之前留几秒缓冲（够回退一点就行） */
    WAIT_GAP: 0.4,            /* 目标位置落后缓冲区末尾超过这么多才值得暂停 */
    RESUME_LEAD: 1.5,         /* 缓冲领先目标位置这么多才放开 —— 要比 WAIT_GAP 大得多，
                                 否则一放开走两步又得按住，声音就是一顿一顿的 */
    DRIFT_SEEK: 0.35,         /* 音频位置偏差超过这个才 seek，小偏差用倍速慢慢追 */
    LOOP_COMP: 0.07,          /* 双向模式的声音要多走一段 tabCapture 回路：
                                 页面混音 → 捕获 → offscreen DelayNode → 扬声器。
                                 实测抓取侧 71ms、AudioContext 输出 24ms，减去画面
                                 渲染的 1~2 帧，取 70ms。让 <audio> 提前这么多，
                                 到达耳朵时正好对上画面 —— 这段延迟在 DelayNode
                                 之外，滑块归零也消不掉。单向模式不补（声音直接
                                 出扬声器，没有这段回路）。 */
    WAIT_STUCK_MS: 4000,      /* 缓冲连续这么久一点没长 = 真下不来了，别等了 */
    WAIT_MAX_MS: 15000,       /* 总等待上限。目标位置迟迟没有数据时，等 15 秒
                                 还没到就认了 —— 再久用户只会觉得播放器坏了 */

    CAP_STARVE_MS: 15000,     /* 链路② 跳转后这么久一条新切片都没抓到，就当这个
                                 位置的数据这条链路拿不到，换链路③。
                                 判据用 capBytes 增长，不用缓冲位置 —— 后者分不清
                                 「数据在路上」和「数据永远不会来」。 */
    CAP_SILENT_MAX_MS: 8000,  /* 静音多久就认赔、换链路③。前两条出口都有前提：
                                 降档只对负值有效（提前量是 0 或正值时降无可降），
                                 降级只在「跳转后 15 秒没抓到新切片」时触发（没跳转
                                 或切片在慢慢来都不成立）。缺了这一条，用户把滑块
                                 放在 0 或正值时就会一直挂着「音频重新加载中」。
                                 宁可多一倍流量，也不能让用户听无声。 */
    AD_GRACE_MS: 4000,        /* 抓到的切片来自别的目录（广告插播）时，主音轨
                                 本来就不会有新数据。这段时间内的静音不算「等
                                 不到数据」，不降档也不降级；广告结束后重新计时。 */
    AD_TOAST_GAP_MS: 15000,   /* 广告/换源提示的冷却：一段广告只打扰用户一次 */
    RESUME_NOTICE_MS: 60000,  /* 「声音已恢复」只在中断后一分钟内提示，过期不补 */
    AD_SETTLE_MS: 2000,       /* 重采样前，距最后一次广告切片至少这么久 */
    AD_SAMPLE_QUIET_MS: 1200, /* 两边缓冲都静止这么久，差值才可信 */
    AD_RESAMPLE_MS: 45000,    /* 广告结束后允许重采样的窗口 */
    AD_CATCHUP_MS: 20000,     /* 广告后允许音频硬跳到画面位置的窗口 */
    MAX_OFFSET_SHIFT_S: 180,  /* 重采样允许的最大偏移跳变（广告时长上限） */
    FEEDING_MS: 3000,         /* 多久内有新音频解出，就算「数据在来」 */
    SWAP_HINT_MS: 10000,      /* 面板上「播放源切换中」停留多久 */
    DOWNGRADE_MS: 2000        /* 静音多久才自动把提前量降到缓冲撑得住的位置 */
  };

  /* ---------------- 链路② 的流身份 / 广告状态 ----------------
   *
   * 广告插播时播放器会去拉另一条路径的切片（实测主线 /video/<剧集>/<id>/0000xx.ts，
   * 广告 /video/adjump/time/1787…ts）。异源切片带着另一条时间轴，喂进主 muxer
   * 会把解复用状态带跑；所以要有一个地方统一回答：
   *   dir          接管时锁定的主切片目录
   *   foreignAt    最近一次撞到异源切片的时刻（非 0 = 广告时段）
   *   lastAudioAt  最近一次真的解出音频的时刻（数据在来）
   * route / sync / panel 都通过这个对象判断，不再各自维护一套字段。 */
  const cap = S.cap = {
    dir: '',
    src: '',
    foreignAt: 0,
    lastForeignAt: 0,
    lastAudioAt: 0,
    catchUpUntil: 0,
    adToastAt: 0,
    resumeNotice: false,
    swapAt: 0,

    reset: function () {
      this.dir = '';
      this.src = '';
      this.foreignAt = 0;
      this.lastForeignAt = 0;
      this.lastAudioAt = 0;
      this.catchUpUntil = 0;
      this.adToastAt = 0;
      this.resumeNotice = false;
      this.swapAt = 0;
    },

    /** 锁定主切片目录（接管时调用） */
    lock: function (url) {
      this.dir = segDir(url);
      this.src = String(url || '');
    },

    isAd: function () {
      return !!this.foreignAt;
    },

    /** 广告时段内（静音不算「抓不到数据」），只持续 AD_GRACE_MS */
    isAdGrace: function () {
      return !!this.foreignAt && Date.now() - this.foreignAt < C.AD_GRACE_MS;
    },

    /** 最近有音频解出：静音只是位置还没追上缓冲，不是抓不到 */
    isFeeding: function () {
      return !!this.lastAudioAt && Date.now() - this.lastAudioAt < C.FEEDING_MS;
    },

    noteAudio: function () {
      this.lastAudioAt = Date.now();
    },

    /** 播放器换源：更新锁定目录并提示一次 */
    noteSource: function (src) {
      this.src = String(src || '');
      this.dir = segDir(src);
      this.swapAt = Date.now();
      if (!this.adToastAt || Date.now() - this.adToastAt >= C.AD_TOAST_GAP_MS) {
        this.adToastAt = Date.now();
        this.resumeNotice = true;
        if (S.ui) S.ui.showToast('视频源已切换，正在重新接入音频…');
      }
    },

    /** 撞到异源切片：进入广告时段。首次进入时提示一次。 */
    noteForeign: function () {
      if (!this.foreignAt) {
        try {
          document.documentElement.dataset.adsDiag =
            ((document.documentElement.dataset.adsDiag || '') + '|ad-skip').slice(-300);
        } catch (e) {}
        if (!this.adToastAt || Date.now() - this.adToastAt >= C.AD_TOAST_GAP_MS) {
          this.adToastAt = Date.now();
          this.resumeNotice = true;
          if (S.ui) {
            S.ui.showToast('检测到广告插播，声音会暂停，广告结束后自动恢复');
          }
        }
      }
      this.foreignAt = Date.now();
      /* 单独记「最后一次广告切片」，不随正片预取清掉：
         广告可能还在播、播放器已经预取了下一条正片，此时 foreignAt 会被
         清掉，但音频缓冲末尾还停在广告前的内容上，差值不能用来重采样。 */
      this.lastForeignAt = this.foreignAt;
    },

    /** 处理一片切片：'main' 正片 / 'ad' 广告 / 'back' 刚回到正片 */
    classify: function (url) {
      const dir = segDir(url);
      if (!this.dir && dir) this.dir = dir;
      if (this.dir && dir && dir !== this.dir) {
        this.noteForeign();
        return 'ad';
      }
      if (this.foreignAt) {
        this.foreignAt = 0;
        return 'back';
      }
      return 'main';
    }
  };

  function pageIsMSE() {
    return pageKind() === 'mse';
  }

  function captureEnabled() {
    const b = globalThis.ADS_BUILD;
    return !(b && b.capture === false);
  }

  function routeId(key) {
    const list = ROUTE_ORDER.filter(function (k) { return k !== 'capture' || captureEnabled(); });
    const i = list.indexOf(key);
    return i < 0 ? '' : ROUTE_IDS[i];
  }

  function pickRoute(kind) {
    if (S.hookReady && S.chunks.length) return 'mse';
    if (captureEnabled() && kind === 'hls' && typeof muxjs !== 'undefined') return 'capture';
    /* 只有「浏览器能自己解码的单文件流」才走 ③。<audio> 喂不进 .mpd 清单，
       DASH 页面走 ③ 只会等到 15 秒超时，所以这里明确不给链路。 */
    if (kind === 'hls' || kind === 'direct') return 'src';
    return '';
  }

  function whyNoEnhanced() {
    switch (pageKind()) {
      case 'none':
        return '这个页面没有找到视频元素。';
      case 'unknown':
        return '视频还没开始加载。先点一下播放，播几秒再试。';
      case 'stream':
        return '这个页面播的是实时媒体流（MediaStream），音频不经过 MSE，双向模式用不了。延迟模式仍可用。';
      case 'dash':
        return '这个页面是 DASH（.mpd）清单，音频片段没有可复用的通道，双向模式用不了。延迟模式仍可用。';
      default:
        return '双向模式没有覆盖这种播放方式。请刷新页面重试，若仍复现请反馈。';
    }
  }

  function pushChunk(buf) {
    if (!(buf instanceof ArrayBuffer) || !buf.byteLength) return;

    S.chunks.push(buf);
    S.chunkBytes += buf.byteLength;

    /* 太老的片段自己丢掉：留着也只会让内存一路涨上去 */
    while (S.chunkBytes > C.MAX_CHUNK_BYTES && S.chunks.length > 2) {
      S.chunkBytes -= S.chunks.shift().byteLength;
    }

    if (S.enhanced && S.enhMode === 'mse') appendChunk(buf);
  }

  function appendChunk(buf) {
    S.appendQueue.push(buf);
    pump();
  }

  function pump() {
    if (!S.enhBuf || S.enhBuf.updating || !S.appendQueue.length) return;
    if (S.enhMS && S.enhMS.readyState !== 'open') return;
    const next = S.appendQueue.shift();
    try {
      S.enhBuf.appendBuffer(next);
      if (S.appendFails) S.appendFails = 0;
    } catch (e) {
      /* 片段被拒（时间戳不连续之类）就丢掉，别让队列卡死。
         但不能完全无声无息：连续丢片用户只会觉得「声音缺了一节」，
         得给个说法，也方便从 adsDiag 里看到规律。 */
      S.appendFails++;
      try {
        document.documentElement.dataset.adsDiag =
          ((document.documentElement.dataset.adsDiag || '') +
            '|append-fail:' + String((e && e.name) || e).slice(0, 24)).slice(-300);
      } catch (e2) {}
      if (S.appendFails >= 5 && !S.appendFailToasted && S.ui) {
        S.appendFailToasted = true;
        S.ui.showToast('音频片段连续对不上（页面音轨有空洞），声音可能偶尔缺一截');
      }
      setTimeout(pump, 0);
    }
  }

  function bufferedHas(t) {
    if (!S.enhAudio) return false;
    const b = S.enhAudio.buffered;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) + 0.05 && t <= b.end(i) - 0.15) return true;
    }
    return false;
  }

  function bufferedLead(t) {
    if (!S.enhAudio) return -999;
    const b = S.enhAudio.buffered;
    if (!b.length) return -999;

    let nearest = -1;
    for (let i = 0; i < b.length; i++) {
      const s = b.start(i);
      const e = b.end(i);
      if (t >= s && t <= e) return e - t;
      const d = t < s ? s - t : t - e;
      if (nearest < 0 || d < nearest) nearest = d;
    }
    return -nearest;
  }

  function bufferedEnd() {
    if (!S.enhAudio) return 0;
    const b = S.enhAudio.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  }

  /** 切片 URL 归一到「目录」：协议 + 主机 + 路径目录。
   *
   *  广告插播时播放器会改拉一条完全不同的切片路径（实测站点主线是
   *  /video/<剧集>/<id>/0000xx.ts，广告是 /video/adjump/time/1787…ts）。
   *  广告切片带着另一条时间轴，绝不能喂给主 muxer；只靠这个目录就能把
   *  两类切片分开，而且不依赖站点具体命名。 */
  function segDir(url) {
    try {
      const base = (typeof location !== 'undefined' && location.href) ? location.href : undefined;
      const u = new URL(String(url), base);
      const p = u.pathname;
      return u.origin + p.slice(0, p.lastIndexOf('/') + 1);
    } catch (e) {
      return '';
    }
  }

  /** 这一轮「静音等数据」最多等多久才降级。
   *
   *  链路② 的数据来自播放器请求的切片。播放器自己还有几秒预缓冲时，它不会
   *  去请求下一片，我们自然什么也抓不到 —— 这不是「抓不到数据」，而是
   *  「还没轮到」。按画面剩余缓冲把等待预算放宽，否则正常的预缓冲会被
   *  8 秒超时误判成抓取失败，白白降级到双倍流量的链路③（实测站点一次
   *  预缓冲 10 秒，链路② 在数据到来前一秒被踢走）。
   *  上限 20 秒：真抓不到时也不能让用户一直无声。 */
  function silenceBudget() {
    let ms = C.CAP_SILENT_MAX_MS;
    if (!S.videoEl) return ms;
    try {
      const b = S.videoEl.buffered;
      if (b.length) {
        const lead = b.end(b.length - 1) - S.videoEl.currentTime;
        if (lead > 0.5) ms = Math.max(ms, Math.min(20000, lead * 1000 + 4000));
      }
    } catch (e) {}
    return ms;
  }

  /* ---------------- 链路② 的决策函数 ----------------
   * captureTick 原来把「等 / 降档 / 降级」和「跳 / 回退」全写在一个 200 行的
   * 分支里，改一个判据很容易碰坏另一个。这里抽成纯函数，返回动作字符串，
   * captureTick 只负责执行副作用，测试可以直接验状态表。
   */

  /** 静音阶段：继续等 / 自动降档 / 降级链路③。 */
  function decideSilence(x) {
    /* 广告期间、或者切片还在持续解出：静音是过程，不是失败 */
    if (x.adGrace || x.feeding) return 'wait';
    if (x.silentMs > x.silentLimit) return 'degrade';
    if (x.silentMs > C.DOWNGRADE_MS) return 'downgrade';
    return 'wait';
  }

  /** 静音时音频游标怎么摆：硬跳到画面位置 / 退回缓冲起点 / 不动。 */
  function decideAim(x) {
    if (!x.needSeek) return 'none';
    if (x.ahead) {
      /* 目标点还没缓冲到时，平时不硬跳（跳过去只是把落后换成静音）；
         广告结束后的追赶窗口例外 —— 不跳就永远追不回画面。 */
      if (x.catchUp || x.lead > -5) return 'jump';
      return 'none';
    }
    /* 目标在缓冲之前：接管时音频还停在 0、缓冲从十几秒开始那种 */
    if (x.hasBuffered && x.currentLead < -1) return 'rewind';
    return 'none';
  }

  /** 只清采样基线：拖进度条时用，已估出的偏移保留 */
  function resetSamples() {
    S.offSamples = [];
    S.offLastA = null;
    S.offLastV = null;
    S.aEndSeen = 0;
    S.aEndSeenAt = 0;
    S.vEndSeen = 0;
    S.vEndSeenAt = 0;
  }

  function resetVideoClock() {
    S.vFreezePos = null;
    S.vFreezeAt = 0;
  }

  /** 时间轴换了：偏移和采样全部归零，但不动流身份 */
  function resetTimebase() {
    S.ptsOffset = 0;
    resetSamples();
    /* 新时间轴下旧的重采样窗口没有意义，由 resetTimebase 负责清 */
    S.adResampleUntil = 0;
    resetVideoClock();
  }

  /** 流本身换了（接管 / 换源 / 退出）：时间轴和切片目录一起重置 */
  function resetStream() {
    cap.reset();
    resetTimebase();
  }

  /* ---------------- 链路② 的时间轴校准 ----------------
   *
   * 页面下载的 ts 带着原始 PTS，我们原样 append 进自己的 MediaSource；
   * 而原生 HLS 播放器的 video.currentTime 是它自己归一化过的。两边速率一样，
   * 差的是**常量**。固定常量会导致「位置对齐、内容错位」，听感就是固定延迟。
   *
   * 估计办法：两边缓冲的**末尾**对应同一批已下载切片。等两边都比上次长了，
   * 取 (音频末尾 − 视频末尾) 作为一个样本；中位数滤波后作为补偿量。
   * 只取「两边同时增长」的拍，避免一边领先一片时算出错的样本。
   */
  function samplePtsOffset() {
    if (S.enhMode !== 'capture' || !S.enhAudio || !S.videoEl) return;

    let a, v;
    try { a = S.enhAudio.buffered; v = S.videoEl.buffered; } catch (e) { return; }
    if (!a.length || !v.length) return;

    const ae = a.end(a.length - 1);
    const ve = v.end(v.length - 1);

    /* 记下两端「最后一次变化」的时刻，广告后要用静止差值重采样 */
    const now = Date.now();
    if (ae !== S.aEndSeen) { S.aEndSeen = ae; S.aEndSeenAt = now; }
    if (ve !== S.vEndSeen) { S.vEndSeen = ve; S.vEndSeenAt = now; }

    /* ---- 广告后的重采样 ----
       广告插播会把页面时间轴整体推移一个广告时长，两边 buffered 末尾的差
       会从 +1.7s 直接变成 −20s 这类大值；「同时增长」取样在这段时间常常
       错拍（画面一次缓冲一大段、音频在慢慢追），根本对不上。
       广告结束后等两边缓冲都静止 1.2 秒，直接量末尾差 —— 此时两边拿到的是
       同一条正片切片的末尾，差值就是新的 PTS 偏移。 */
    if (S.adResampleUntil && now < S.adResampleUntil &&
        now - S.aEndSeenAt > C.AD_SAMPLE_QUIET_MS &&
        now - S.vEndSeenAt > C.AD_SAMPLE_QUIET_MS &&
        now - S.vFreezeAt < 1500 &&
        /* 音频末尾必须在最后一次广告切片之后长过：广告期间播放器可能已经
           预取了正片，foreignAt 被清掉，但音轨末尾仍停在广告前，此时
           的 (ae-ve) 是广告画面和旧音频的差，不是新时间轴。 */
        S.aEndSeenAt > cap.lastForeignAt &&
        (!cap.foreignAt || now - cap.foreignAt > C.AD_SETTLE_MS)) {
      const sample = ae - ve;
      S.adResampleUntil = 0;
      resetSamples();
      if (isFinite(sample) && Math.abs(sample) < C.MAX_OFFSET_SHIFT_S &&
          Math.abs(sample - S.ptsOffset) > 0.4) {
        S.ptsOffset = sample;
        try {
          document.documentElement.dataset.adsDiag =
            ((document.documentElement.dataset.adsDiag || '') +
              '|ad-off:' + sample.toFixed(1)).slice(-300);
        } catch (e) {}
      }
      return;
    }

    /* 第一次只记基准，不出样本 */
    if (S.offLastA === null || S.offLastV === null) {
      S.offLastA = ae;
      S.offLastV = ve;
      return;
    }

    const da = ae - S.offLastA;
    const dv = ve - S.offLastV;
    /* 两边都没长，或者只有一边长：现在取样会把「谁先 append」算进偏移里 */
    if (da < 0.05 || dv < 0.05) return;

    S.offLastA = ae;
    S.offLastV = ve;

    /* 增长量差得太多说明至少有一边跨了不止一片，这一拍不可比 */
    if (Math.abs(da - dv) > 0.3) return;

    const sample = ae - ve;
    if (!isFinite(sample) || Math.abs(sample) > 10) return;

    S.offSamples.push(sample);
    if (S.offSamples.length > 9) S.offSamples.shift();

    const sorted = S.offSamples.slice().sort(function (x, y) { return x - y; });
    const med = sorted[Math.floor(sorted.length / 2)];
    const spread = sorted[sorted.length - 1] - sorted[0];
    /* 样本太散（切线路 / 不连续）就先不跟，等稳定；稍有变化才更新 */
    if (spread > 0.5) return;
    if (Math.abs(med - S.ptsOffset) > 0.02) S.ptsOffset = med;
  }

  function alignAudio(want) {
    const drift = S.enhAudio.currentTime - want;
    const abs = Math.abs(drift);

    if (abs > C.DRIFT_SEEK) {
      try { S.enhAudio.playbackRate = 1; } catch (e) {}
      if (seekAudioTo(want)) return true;

      /* 目标点还没缓冲到。链路② 的数据是后到的，这里如果只靠 ±10% 倍速，
         落后 1.5 秒要追 15 秒 —— 用户感知就是「一直差着一截，怎么调都回不去」。
         位置先过去：MSE 的 seekable 已经被 ensureSeekRange 撑到目标点，
         设 currentTime 会让它进入 seeking，数据一 append 就从这里续播。
         这比慢速追赶快一个数量级，代价是那一小段没声音 —— 链路② 本来就
         接受这个代价（见 captureTick 的注释）。

         领先时同样要摆。以前这里写着「只对落后做」，理由是往回 seek 到
         没数据的区间会 underflow —— 但那只发生在「目标点是历史、已经被
         trimBuffer 删掉」的时候，那种情况下面 trySetAudioPos 会因为
         seekable 不覆盖而返回 false，本来就摆不过去。
         反过来，把负值拖回 0 时 want 会往后移：音频此刻在 vT+提前量，
         要退回 vT。这一段刚好是 trimBuffer 保留着的历史，能摆进去就得
         立刻摆 —— 不摆的话只能靠 0.9 倍速磨，1.6 秒要磨 16 秒，
         听感就是「点了归零，声音还慢一截」。 */
      if (S.enhMode === 'capture') {
        if (Date.now() - S.lastPosJump > 800) {
          if (trySetAudioPos(want)) { S.lastPosJump = Date.now(); return true; }
        }
        /* 摆不过去 = 目标点既不在缓冲里、也不在 seekable 里。
           绝不能就这么播着 —— 那是一直错位，而且倍速磨得越久错得越久。
           交给 captureTick 静音，等切片到了再对齐开声。 */
        return false;
      }
    }

    if (abs < 0.04) {
      if (S.enhAudio.playbackRate !== 1) {
        try { S.enhAudio.playbackRate = 1; } catch (e) {}
      }
      return true;
    }

    /* 夹在 ±10%：seek 失败时偏差可能到 1 秒以上，不夹的话 rate 会跑到
       0.75 / 1.25 —— 那是听得出来的变速，比不同步还难受。
       原来只给 ±4%：追 1 秒要 25 秒，用户感知就是「一直有延迟」。
       ±10% 时同样的差距 10 秒能追平，而且 playbackRate 是保音高的
       time-stretch，短时间用听不太出来。 */
    const rate = Math.max(0.90, Math.min(1.10, 1 - drift / 6));
    if (Math.abs(S.enhAudio.playbackRate - rate) > 0.005) {
      try { S.enhAudio.playbackRate = rate; } catch (e) {}
    }
    return true;
  }

  function ensureSeekRange(want) {
    if (!S.enhMS || S.enhMS.readyState !== 'open') return;
    let cur;
    try { cur = S.enhMS.duration; } catch (e) { return; }
    if (cur === Infinity) return;        /* 直播流不钉时长，钉了会把时长写死 */
    if (isFinite(cur) && want + 5 <= cur) return;   /* 本来就在范围里 */

    /* 初始 duration 是 NaN。老代码写的是 !isFinite(cur) 就 return，
       于是这个函数从来没真正生效过 —— seekable 只跟着 buffered 走，
       跳转后想把音频位置先摆到目标点都摆不了。NaN 要当成 0 处理。 */
    const next = Math.max(want + 60, isFinite(cur) ? cur + 1 : 0);
    try { S.enhMS.duration = next; } catch (e) {}
  }

  function seekAudioTo(t) {
    if (!S.enhAudio) return false;
    ensureSeekRange(t);
    if (!bufferedHas(t)) return false;
    try { S.enhAudio.currentTime = t; return true; } catch (e) { return false; }
  }

  /** 把音频位置摆到 t，**不管那里有没有数据** —— 链路② 的「跟着视频移动」。
   *
   *  和 seekAudioTo 的分工：那个只在 bufferedHas(t) 为真时才动，用在「已经能播、
   *  纠一下偏差」的场合；这个是「数据还没来，但位置得先过去」，让媒体元素进入
   *  seeking，等切片 append 进来后从这个位置自己续播。链路② 跳转后如果不做
   *  这一步，音频就一直停在旧位置，数据到了也不会自己跳过去。
   *
   *  前提是 seekable 覆盖目标点。MSE 的 seekable 默认只跟着 buffered 走，
   *  所以先 ensureSeekRange 把 duration 撑大。撑不开就返回 false 下一拍再试 ——
   *  绝不能硬设，硬设会被浏览器钳回缓冲末尾，看着像过去了其实没有。
   */
  function trySetAudioPos(t) {
    if (!S.enhAudio) return false;
    ensureSeekRange(t);

    let s;
    try { s = S.enhAudio.seekable; } catch (e) { return false; }
    let cover = false;
    for (let i = 0; i < s.length; i++) {
      if (t >= s.start(i) && t <= s.end(i)) { cover = true; break; }
    }
    if (!cover) return false;

    if (Math.abs(S.enhAudio.currentTime - t) < 0.3) return true;
    try { S.enhAudio.currentTime = t; return true; } catch (e) { return false; }
  }

  function trimBuffer() {
    if (!S.enhBuf || !S.enhMS || S.enhMS.readyState !== 'open') return;
    if (S.enhBuf.updating || S.trimBusy) return;
    if (!S.enhAudio) return;

    let b;
    try { b = S.enhAudio.buffered; } catch (e) { return; }
    if (!b.length) return;

    /* 链路② 的基准要取「视频该播到哪」和「音频实际播到哪」里更小的那个：
       - 用音频位置（老写法）：seek 之后音频还停在旧位置，会把新位置要用的
         余量当成历史删掉；
       - 只用视频位置：音频落后于视频时（数据没跟上），会把音频正在播的
         那一段当成历史删掉，删完音频当场没数据，越删越卡。
       取小的那个，两个坑都避开。 */
    let base = S.enhAudio.currentTime;
    if (S.enhMode === 'capture' && S.videoEl) {
      try { base = Math.min(wantTime(), S.enhAudio.currentTime); } catch (e) {}
    }
    /* 保留量要够「归零」时把音频退回去。
       负值（声音提前）时 want 在视频前面 |ms| 秒，base 也跟着前移，
       固定只留 3 秒会让缓冲起点正好落在归零后的目标点上 ——
       seekAudioTo 差那 50ms 过不去，只能靠 0.9 倍速磨十几秒，
       听感就是「点了归零，声音还慢一截」。
       按当前延迟量多留一段：拖到 -4 秒就保留 5.5 秒历史，退得回来。 */
    const back = Math.max(C.KEEP_BEHIND, Math.abs(currentMs()) / 1000 + 1.5);
    const keepFrom = base - back;
    const firstStart = b.start(0);
    /* 少于 1 秒不值得动一次：remove 会打断 append 的节奏 */
    if (keepFrom - firstStart < 1) return;

    try {
      S.trimBusy = true;
      S.enhBuf.remove(firstStart, keepFrom);
    } catch (e) {
      S.trimBusy = false;
    }
  }

  function currentMs() {
    return S.ui ? S.ui.getValue() : 0;
  }

  /* ---------------- 两条链路怎么分工 ----------------
   *
   * 双向模式有两条能产生延迟的路径，用哪条取决于符号：
   *
   *   负值（声音提前）—— 只能靠 <audio> 的播放位置往前挪。此时 DelayNode
   *     必须归零：它只会把已经提前的音频再拖回去，两边正好抵消。
   *
   *   正值（声音延后）—— DelayNode 本身就是最省的做法：零缓冲消耗、
   *     不用提前下载，改一次 delayTime 立刻生效。这时候 <audio> 只要
   *     贴着画面走（want 不减 currentMs）。
   *
   * 早先这里不分符号，进双向一律把 DelayNode 归零，而 want 又照旧减
   * currentMs/1000 —— 结果是拖任何正值都去要「更早的数据」，缓冲区里
   * 根本没有，面板一路挂着「等缓冲 · 还差 N 秒」，听感上就是延迟失效。
   */

  /** <audio> 该播到哪一秒。只有负值才往前挪，正值交给 DelayNode。 */
  function wantAt(ms) {
    if (!S.videoEl) return 0;
    let base = S.videoEl.currentTime - Math.min(0, ms) / 1000;
    /* 链路② 的 ts 是原始 PTS，和页面时间轴差一个常量。
       不补这一下，位置看着对齐、内容却整体晚一截（实测 1.6s）。
       其他链路的时间轴天然同源，不能加。 */
    if (S.enhanced && S.enhMode === 'capture') base += S.ptsOffset;
    /* 双向模式把补偿加在这里，所有用到「音频该播到哪」的地方就都带着它了：
       alignAudio 的目标、bufferedHas 的判断、面板的余量，口径一致。
       单向模式 enhMode 为空、enhanced 为 false，不补。 */
    return base + (S.enhanced ? C.LOOP_COMP : 0);
  }

  function wantTime() {
    return wantAt(currentMs());
  }

  /** 把「这次该谁干活」落到 DelayNode 上。返回值 = 这次是否真的改了分配。
   *  syncTick 每 250ms 调一次，所以两个分支都要能重复调用而无副作用：
   *  负值只在第一次归零，正值只在数值真的变了（>20ms）才发消息。 */
  function syncCapturePipe(ms) {
    /* 刚失败过就按退避等一会儿，别每拍都去撞一堵墙。
       pending 期间 pipeMs 已被 pushDelay 清空，恢复后会自然重发。 */
    if (S.pipeRetryAt && Date.now() < S.pipeRetryAt) return false;

    const prev = S.pipeMs;

    if (ms < 0) {
      if (prev !== null && prev < 0) return false;   /* 已经归零过，别反复发 */
      S.pipeMs = ms;
      bypassCaptureDelay();
      return true;
    }

    if (prev !== null && prev >= 0 && Math.abs(prev - ms) < 20) return false;
    S.pipeMs = ms;
    syncDelayToSw(true, ms);
    return true;
  }

  /** 不管上一次分配成什么，强制再写一遍。
   *  用在「归零」这种用户能立刻听出来的动作上：正常路径由 20ms 阈值挡重复，
   *  但只要中途丢过一次消息，pipeMs 就再也对不上 DelayNode 的真实值，
   *  而阈值恰恰会把纠正的那一次也挡掉。 */
  function forcePipe(ms) {
    S.pipeMs = ms;
    S.pipeRetryAt = 0;
    S.pipeFails = 0;
    syncDelayToSw(true, ms);
  }

  /** 退出双向时把分配记录清掉，下次进入重新算一遍 */
  function resetCapturePipe() {
    S.pipeMs = null;
    S.pipeRetryAt = 0;
    S.pipeFails = 0;
  }

  /** 真正发消息的地方，唯一一处，所有写 DelayNode 的路径都从这里走。
   *
   *  以前 sendMessage(...).catch(noop) 就完了 —— 发出去当成功。
   *  但这条链路有三段（content → SW → offscreen），任何一段抖一下都会失败，
   *  而失败对用户是「点了归零，声音还晚 1.x 秒」这种完全没有线索的表现。
   *  所以这里必须看返回值：只有 offscreen 确认收到了同一个值才算数。 */
  function pushDelay(ms, transient) {
    const want = Math.round(ms);
    try {
      chrome.runtime.sendMessage({
        target: 'sw',
        type: 'setDelay',
        delayMs: want,
        transient: !!transient
      }).then(function (res) {
        const got = res && res.delayMs;
        const ok = !!res && res.ok !== false
          && (got == null || Math.abs(got - want) <= 20);
        if (ok) { S.pipeFails = 0; S.pipeRetryAt = 0; return; }

        /* 没到。清掉分配记录，让下一拍重发；连续失败就退避到 2 秒一次，
           避免 offscreen 真的没了的时候每 250ms 空转。 */
        S.pipeMs = null;
        S.pipeFails = Math.min(S.pipeFails + 1, 8);
        S.pipeRetryAt = Date.now() + Math.min(2000, 150 * S.pipeFails * S.pipeFails);
      }).catch(function () {
        S.pipeMs = null;
        S.pipeFails = Math.min(S.pipeFails + 1, 8);
        S.pipeRetryAt = Date.now() + Math.min(2000, 150 * S.pipeFails * S.pipeFails);
      });
    } catch (e) {
      S.pipeMs = null;
      S.pipeFails = Math.min(S.pipeFails + 1, 8);
      S.pipeRetryAt = Date.now() + Math.min(2000, 150 * S.pipeFails * S.pipeFails);
    }
  }

  function syncDelayToSw(transient, ms) {
    pushDelay(ms == null ? currentMs() : ms, transient);
  }

  function bypassCaptureDelay() {
    pushDelay(0, true);
  }

  /* ---------------- 对外 ----------------
   * 只导出会被别的模块用到的。ensureSeekRange / appendChunk 是内部细节，
   * 留在这一层，外面拿不到反而更安全。 */

  E.core = {
    S: S,
    C: C,
    ROUTES: ROUTES,
    pageIsMSE: pageIsMSE,
    captureEnabled: captureEnabled,
    routeId: routeId,
    pickRoute: pickRoute,
    whyNoEnhanced: whyNoEnhanced,
    pushChunk: pushChunk,
    pump: pump,
    bufferedHas: bufferedHas,
    bufferedLead: bufferedLead,
    bufferedEnd: bufferedEnd,
    segDir: segDir,
    silenceBudget: silenceBudget,
    resetStream: resetStream,
    resetTimebase: resetTimebase,
    resetSamples: resetSamples,
    decideSilence: decideSilence,
    decideAim: decideAim,
    samplePtsOffset: samplePtsOffset,
    alignAudio: alignAudio,
    seekAudioTo: seekAudioTo,
    trySetAudioPos: trySetAudioPos,
    trimBuffer: trimBuffer,
    currentMs: currentMs,
    wantAt: wantAt,
    wantTime: wantTime,
    syncCapturePipe: syncCapturePipe,
    forcePipe: forcePipe,
    resetCapturePipe: resetCapturePipe,
    syncDelayToSw: syncDelayToSw,
    bypassCaptureDelay: bypassCaptureDelay
  };

  /* 生命周期（enhFail / enhReady / exit）定义在最后加载的 ads-enhance.js 里。
     这里先摆一个空壳，route / sync 加载时就能拿到同一个引用。 */
  E.life = E.life || {};
})();
