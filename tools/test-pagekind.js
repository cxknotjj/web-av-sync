#!/usr/bin/env node
/**
 * pageKind() 的分支测试。
 *
 * 这个函数决定面板给用户看哪句话：「等待播放」「等待音频轨」「此页不支持双向」。
 * 判错会让人以为站点不支持，而实际只是还没加载 —— 所以六个分支逐个核对。
 *
 * 直接从源码里抽出函数体来跑，不复制逻辑，避免测的和跑的不是同一份。
 * pageKind / pickVideo 在 ads-detect.js（2026-10-21 拆出），pickRoute / captureEnabled
 * 仍在 ads-enhance.js。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DETECT_SRC = fs.readFileSync(path.join(ROOT, 'ads-detect.js'), 'utf8');
const ENH_SRC = fs.readFileSync(path.join(ROOT, 'ads-enhance.js'), 'utf8');

/** 从源码里按函数名截出完整定义（按花括号配平，不依赖缩进） */
function extract(src, name) {
  const head = 'function ' + name + '(';
  const at = src.indexOf(head);
  if (at < 0) throw new Error('找不到函数 ' + name);

  let i = src.indexOf('{', at);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(at, j + 1);
    }
  }
  throw new Error('函数 ' + name + ' 没有正常结束');
}

const PAGE_KIND = extract(DETECT_SRC, 'pageKind');

/** 造一个最小环境：只提供 pageKind 需要的 pickVideo 和 MediaSource */
function run(video, mediaSourceCtor) {
  const ctx = vm.createContext({
    pickVideo: function () { return video; },
    MediaSource: mediaSourceCtor === undefined ? function MediaSource() {} : mediaSourceCtor
  });
  vm.runInContext(PAGE_KIND + '\nthis.pageKind = pageKind;', ctx);
  return ctx.pageKind();
}

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + ' → ' + JSON.stringify(actual) +
    (ok ? '' : '（期望 ' + JSON.stringify(expected) + '）'));
}

function fakeVideo(extra) {
  const v = { currentSrc: '', src: '', srcObject: null, clientWidth: 640, clientHeight: 360 };
  Object.assign(v, extra || {});
  return v;
}

console.log('\n[1] 没有视频元素');
check('返回 none', run(null), 'none');

console.log('\n[2] 还没开始加载，地址为空');
check('返回 unknown', run(fakeVideo()), 'unknown');

console.log('\n[3] MSE：blob 地址');
check('返回 mse', run(fakeVideo({ currentSrc: 'blob:https://a.com/8f3c-1d2e' })), 'mse');

console.log('\n[4] MSE：MediaSource 挂在 srcObject 上');
{
  function MS() {}
  check('返回 mse', run(fakeVideo({ srcObject: new MS() }), MS), 'mse');
}

console.log('\n[5] 原生 HLS：m3u8 直连');
check('index.m3u8', run(fakeVideo({ currentSrc: 'https://cdn.x.com/a/index.m3u8' })), 'hls');
check('带 query 参数', run(fakeVideo({ currentSrc: 'https://cdn.x.com/a/index.m3u8?token=abc' })), 'hls');
check('只有 src 没有 currentSrc', run(fakeVideo({ src: 'https://cdn.x.com/live.m3u8' })), 'hls');

console.log('\n[6] 整段文件直连');
check('mp4', run(fakeVideo({ currentSrc: 'https://cdn.x.com/a.mp4' })), 'direct');
check('mp4 带 query', run(fakeVideo({ currentSrc: 'https://cdn.x.com/a.mp4?v=2' })), 'direct');
check('无扩展名（签名地址）', run(fakeVideo({ currentSrc: 'https://cdn.x.com/play/2093?sign=x' })), 'direct');

console.log('\n[6b] DASH 清单（.mpd）');
check('a.mpd', run(fakeVideo({ currentSrc: 'https://cdn.x.com/a.mpd' })), 'dash');
check('带 query', run(fakeVideo({ currentSrc: 'https://cdn.x.com/a.mpd?token=abc' })), 'dash');
check('带 hash', run(fakeVideo({ currentSrc: 'https://cdn.x.com/a.mpd#t=0' })), 'dash');
check('文件名里恰好含 .mpd 但扩展名是 mp4', run(fakeVideo({ currentSrc: 'https://cdn.x.com/a.mpdiamond.mp4' })), 'direct');

console.log('\n[7] 实时媒体流，不是 MSE');
{
  function Stream() {}
  const s = new Stream();
  s.getTracks = function () { return []; };
  check('MediaStream 返回 stream', run(fakeVideo({ srcObject: s }), function MS() {}), 'stream');
}

console.log('\n[8] 边界：浏览器连 MediaSource 都没有');
check('blob 仍判 mse', run(fakeVideo({ currentSrc: 'blob:https://a.com/x' }), null), 'mse');

/* ---- 构建标记：上架版没有链路② ---- */

const PICK_ROUTE = extract(ENH_SRC, 'pickRoute');
const CAPTURE_ENABLED = extract(ENH_SRC, 'captureEnabled');

/** hookReady / chunks / muxjs 在真身里是闭包变量，这里作为全局注入即可 */
function runRoute(kindName, build, hook, chunkCount) {
  const ctx = vm.createContext({
    hookReady: !!hook,
    chunks: new Array(chunkCount || 0),
    muxjs: {}
  });
  vm.runInContext(CAPTURE_ENABLED + '\n' + PICK_ROUTE + '\nthis.pickRoute = pickRoute;', ctx);
  ctx.ADS_BUILD = build;
  return ctx.pickRoute(kindName);
}

console.log('\n[9] 链路选择：完整版三条都在');
check('hls + 有 mux', runRoute('hls', undefined), 'capture');
check('direct', runRoute('direct', undefined), 'src');
check('dash 不给链路（<audio> 喂不进清单）', runRoute('dash', undefined), '');
check('mse 已截到片段', runRoute('mse', undefined, true, 3), 'mse');
check('stream 不支持', runRoute('stream', undefined), '');

console.log('\n[10] 链路选择：上架版没有链路②');
check('hls 不走 capture', runRoute('hls', { capture: false }), 'src');
check('即使 mse 片段在手也优先复用', runRoute('mse', { capture: false }, true, 3), 'mse');
check('direct 不变', runRoute('direct', { capture: false }), 'src');
check('dash 仍然不给链路', runRoute('dash', { capture: false }), '');

console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exit(failures === 0 ? 0 : 1);
