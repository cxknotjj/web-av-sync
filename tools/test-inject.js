'use strict';

/* inject-main.js 的劫持逻辑验证。
 *
 *   node tools/test-inject.js
 *
 * 重点验证三件事：
 *   1. audio 轨被截获、video 轨被跳过
 *   2. 副本内容完整（appendBuffer 会 detach 原 buffer，复制早一步晚一步都拿不到数据）
 *   3. 扩展自己建的 MediaSource 不会被自己截获，否则无限套娃
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = path.join(__dirname, '..', 'inject-main.js');
const code = fs.readFileSync(SRC, 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

function makeEnv() {
  const received = [];
  let detachedCount = 0;

  class FakeSourceBuffer {
    constructor(mime) { this.mime = mime; this.updating = false; this.appended = []; }
    appendBuffer(data) {
      /* 模拟规范行为：传进去的 ArrayBuffer 会被转移走 */
      const len = data && data.byteLength;
      this.appended.push(len);
      if (data instanceof ArrayBuffer && len > 0) detachedCount++;
    }
  }

  class FakeMediaSource {
    addSourceBuffer(mime) { return new FakeSourceBuffer(mime); }
  }

  const win = {
    postMessage(msg, origin, transfer) {
      received.push({ msg, transfer: (transfer || []).length });
    },
    addEventListener() {},
    __adsHooked: false
  };

  const doc = { documentElement: { dataset: {} } };

  const ctx = vm.createContext({
    window: win,
    document: doc,
    MediaSource: FakeMediaSource,
    ArrayBuffer: ArrayBuffer,
    Object: Object,
    String: String,
    console: console,
    setTimeout: setTimeout
  });

  vm.runInContext(code, ctx, { filename: 'inject-main.js' });

  return {
    received,
    win,
    doc,
    MediaSource: FakeMediaSource,
    detachCount: () => detachedCount
  };
}

function payloadOf(received, type) {
  return received.filter((r) => r.msg && r.msg.type === type).map((r) => r.msg);
}

console.log('\n[1] 启动后应先声明 hook 就绪');
{
  const env = makeEnv();
  const ready = payloadOf(env.received, 'ready');
  check('发出了 ready 消息', ready.length === 1);
  check('DOM 上留了标记给 content 判断', env.doc.documentElement.dataset.adsHooked === '1');
}

console.log('\n[2] audio 轨应被截获');
{
  const env = makeEnv();
  const ms = new env.MediaSource();
  const sb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');

  const chunk = new Uint8Array([1, 2, 3, 4, 5]).buffer;
  sb.appendBuffer(chunk);

  const tracks = payloadOf(env.received, 'track');
  const chunks = payloadOf(env.received, 'chunk');

  check('上报了 audio mime', tracks.length === 1 && /audio\//.test(tracks[0].mime));
  check('转发了一个片段', chunks.length === 1);
  check('副本长度和原数据一致', chunks.length === 1 && chunks[0].data.byteLength === 5,
    chunks[0] ? String(chunks[0].data.byteLength) : 'none');
  check('副本内容正确', chunks.length === 1
    && Array.from(new Uint8Array(chunks[0].data)).join(',') === '1,2,3,4,5');
  check('副本与原 buffer 不是同一块内存', chunks.length === 1 && chunks[0].data !== chunk);
  check('transfer 列表带上了副本', env.received.some((r) => r.msg.type === 'chunk' && r.transfer === 1));
  check('页面自己的 append 照常执行', sb.appended.length === 1);
}

console.log('\n[3] video 轨应被跳过');
{
  const env = makeEnv();
  const ms = new env.MediaSource();
  const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
  sb.appendBuffer(new Uint8Array([9, 9]).buffer);

  check('没有转发任何片段', payloadOf(env.received, 'chunk').length === 0);
  check('没有上报 video mime', payloadOf(env.received, 'track').length === 0);
  check('页面 append 正常', sb.appended.length === 1);
}

console.log('\n[4] 扩展自己建的 MediaSource 不能被自己截获');
{
  const env = makeEnv();
  const mine = new env.MediaSource();
  mine.__adsOwn = true;
  const sb = mine.addSourceBuffer('audio/mp4');

  sb.appendBuffer(new Uint8Array([7, 7, 7]).buffer);

  check('没有转发片段（否则会无限套娃）', payloadOf(env.received, 'chunk').length === 0);
  check('页面 append 仍执行', sb.appended.length === 1);
}

console.log('\n[5] ArrayBufferView 也要能正确切出来');
{
  const env = makeEnv();
  const ms = new env.MediaSource();
  const sb = ms.addSourceBuffer('audio/mp4');

  const backing = new Uint8Array([0, 0, 5, 6, 7, 0]);
  sb.appendBuffer(backing.subarray(2, 5));

  const chunks = payloadOf(env.received, 'chunk');
  check('截出 3 字节', chunks.length === 1 && chunks[0].data.byteLength === 3,
    chunks[0] ? String(chunks[0].data.byteLength) : 'none');
  check('截的位置正确', chunks.length === 1
    && Array.from(new Uint8Array(chunks[0].data)).join(',') === '5,6,7');
}

console.log('\n[6] 重复注入不应重复挂 hook');
{
  const env = makeEnv();
  const before = env.received.length;
  vm.runInContext(code, vm.createContext({
    window: env.win,
    document: env.doc,
    MediaSource: env.MediaSource,
    ArrayBuffer: ArrayBuffer,
    Object: Object,
    String: String,
    console: console,
    setTimeout: setTimeout
  }), { filename: 'inject-main.js' });

  check('第二次注入直接退出', env.received.length === before,
    '新增 ' + (env.received.length - before) + ' 条');
}

console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exit(failures === 0 ? 0 : 1);
