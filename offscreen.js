'use strict';

/* ================================================================
 * 真正干活的地方：拿标签页音频流，过 DelayNode，再接回扬声器
 *
 *   tabCapture stream → source → delay ──→ destination
 *                                    └──→ analyser（只测电平，不出声）
 *
 * ⚠ 捕获期间标签页本身是静音的（Chrome 强制），所以这条链路是
 *   用户能听到声音的唯一通道。任何一步抛错都必须回滚，否则就是
 *   彻底没声音，而页面上的音量条看起来还正常。
 * ================================================================ */

const MAX_DELAY_SEC = 10.5;      // UI 上限 10s，留一点余量给 ramp
const METER_INTERVAL = 150;

let ctx = null;
let stream = null;
let source = null;
let delayNode = null;
let analyser = null;

let meterTimer = null;
let meterBuf = null;
let lastRms = 0;

let currentDelayMs = 0;
let active = false;

/* ---------------- 主流程 ---------------- */

async function start(streamId, delayMs) {
  await stop();

  if (!streamId) throw new Error('缺少 streamId，无法捕获');

  /* 这是 Chrome 特有的约束写法，标准 MediaTrackConstraints 里没有 mandatory */
  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  };

  stream = await navigator.mediaDevices.getUserMedia(constraints);

  /* 捕获期间原标签页已静音，从这里开始必须保证链路能出声 */
  try {
    ctx = new AudioContext({ latencyHint: 'interactive' });

    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) { /* 下面统一判定 */ }
    }
    if (ctx.state !== 'running') {
      throw new Error('AudioContext 没能启动（' + ctx.state + '），页面可能仍处于静音');
    }

    source = ctx.createMediaStreamSource(stream);
    delayNode = ctx.createDelay(MAX_DELAY_SEC);
    delayNode.delayTime.value = clampDelay(delayMs) / 1000;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;

    source.connect(delayNode);
    delayNode.connect(analyser);        // 旁路，只用于测电平
    delayNode.connect(ctx.destination); // 真正的输出

    currentDelayMs = clampDelay(delayMs);
    active = true;

    watchTrackEnd();
    startMeter();
  } catch (e) {
    await stop();
    throw e;
  }
}

async function stop() {
  stopMeter();

  if (stream) {
    stream.getTracks().forEach(function (t) {
      try { t.stop(); } catch (e) {}
    });
    stream = null;
  }

  [source, delayNode, analyser].forEach(function (n) {
    if (n) { try { n.disconnect(); } catch (e) {} }
  });
  source = null;
  delayNode = null;
  analyser = null;

  if (ctx) {
    const c = ctx;
    ctx = null;
    try { await c.close(); } catch (e) {}
  }

  active = false;
  lastRms = 0;
  currentDelayMs = 0;
}

/* ---------------- 延迟控制 ---------------- */

function clampDelay(ms) {
  const v = Number(ms);
  if (!isFinite(v)) return 0;
  return Math.min(10000, Math.max(0, Math.round(v)));
}

function setDelay(ms) {
  currentDelayMs = clampDelay(ms);
  if (!ctx || !delayNode) return currentDelayMs;

  const t = ctx.currentTime;
  const p = delayNode.delayTime;
  const target = currentDelayMs / 1000;

  try {
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    /* 直接赋值会让读游标跳变，产生咔哒声；60ms 爬过去听不出来 */
    p.linearRampToValueAtTime(target, t + 0.06);
  } catch (e) {
    p.value = target;
  }
  return currentDelayMs;
}

/* ---------------- 电平 ---------------- */

function startMeter() {
  stopMeter();
  if (!analyser) return;
  meterBuf = new Float32Array(analyser.fftSize);
  meterTimer = setInterval(tick, METER_INTERVAL);
}

function stopMeter() {
  if (meterTimer) {
    clearInterval(meterTimer);
    meterTimer = null;
  }
  meterBuf = null;
}

function tick() {
  if (!analyser || !ctx) return;

  /* 系统休眠 / 设备切换会把上下文挂起，静默拉起来 */
  if (ctx.state === 'suspended') {
    ctx.resume().catch(function () {});
  }

  let rms = 0;
  try {
    analyser.getFloatTimeDomainData(meterBuf);
    let sum = 0;
    for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
    rms = Math.sqrt(sum / meterBuf.length);
  } catch (e) { /* 缓冲区异常时保持上一次读数 */ }

  lastRms = rms;

  chrome.runtime.sendMessage({
    target: 'sw',
    type: 'meter',
    rms: rms,
    ctxState: ctx.state,
    delayMs: currentDelayMs
  }).catch(function () {});
}

/* ---------------- 轨道意外结束 ---------------- */

function watchTrackEnd() {
  if (!stream) return;
  const track = stream.getAudioTracks()[0];
  if (!track) return;
  track.addEventListener('ended', function () {
    chrome.runtime.sendMessage({ target: 'sw', type: 'stream-ended' }).catch(function () {});
    stop().catch(function () {});
  });
}

/* ---------------- 消息 ---------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.target !== 'offscreen') return false;

  switch (msg.type) {
    case 'audio-start':
      start(msg.streamId, msg.delayMs)
        .then(function () {
          sendResponse({ ok: true, delayMs: currentDelayMs, rms: lastRms });
        })
        .catch(function (e) {
          sendResponse({ ok: false, error: readable(e) });
        });
      return true;

    case 'audio-stop':
      stop()
        .then(function () { sendResponse({ ok: true }); })
        .catch(function () { sendResponse({ ok: true }); });
      return true;

    case 'audio-setDelay':
      sendResponse({ ok: true, delayMs: setDelay(msg.delayMs) });
      return false;

    case 'audio-state':
      sendResponse({
        active: active,
        delayMs: currentDelayMs,
        rms: lastRms,
        ctxState: ctx ? ctx.state : 'none'
      });
      return false;

    default:
      return false;
  }
});

/* ---------------- 工具 ---------------- */

function readable(e) {
  const name = (e && e.name) || '';
  const text = String((e && e.message) || e || '未知错误');

  if (name === 'NotAllowedError' || /Permission denied|not allowed/i.test(text)) {
    return '浏览器拒绝捕获这个标签页。请直接点工具栏图标后立刻重试。';
  }
  if (name === 'NotFoundError' || /Requested device not found/i.test(text)) {
    return '这个标签页没有可捕获的音频，先让视频开始播放。';
  }
  if (name === 'InvalidStateError') {
    return '该标签页已被另一路捕获占用，同一时刻只能有一路。';
  }
  if (/AudioContext 没能启动/.test(text)) {
    return '音频上下文被浏览器挂起了，请点一下页面再重试。';
  }
  return text;
}
