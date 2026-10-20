#!/usr/bin/env node
/**
 * pageKind() 的分支测试。
 *
 * 这个函数决定面板给用户看哪句话：「等待播放」「等待音频轨」「此页不支持双向」。
 * 判错会让人以为站点不支持，而实际只是还没加载 —— 所以六个分支逐个核对。
 *
 * 直接从 content.js 里抽出函数体来跑，不复制逻辑，避免测的和跑的不是同一份。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

/** 从源码里按函数名截出完整定义（按花括号配平，不依赖缩进） */
function extract(name) {
  const head = 'function ' + name + '(';
  const at = SRC.indexOf(head);
  if (at < 0) throw new Error('找不到函数 ' + name);

  let i = SRC.indexOf('{', at);
  let depth = 0;
  for (let j = i; j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return SRC.slice(at, j + 1);
    }
  }
  throw new Error('函数 ' + name + ' 没有正常结束');
}

const PAGE_KIND = extract('pageKind');

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

console.log('\n[7] 实时媒体流，不是 MSE');
{
  function Stream() {}
  const s = new Stream();
  s.getTracks = function () { return []; };
  check('MediaStream 返回 stream', run(fakeVideo({ srcObject: s }), function MS() {}), 'stream');
}

console.log('\n[8] 边界：浏览器连 MediaSource 都没有');
check('blob 仍判 mse', run(fakeVideo({ currentSrc: 'blob:https://a.com/x' }), null), 'mse');

console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exit(failures === 0 ? 0 : 1);
