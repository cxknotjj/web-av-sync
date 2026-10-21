'use strict';

/* bufferedLead() 的纯函数单测
 *
 *   node tools/test-buffer-lead.js
 *
 * 这个函数决定「要不要按住画面等缓冲」，改错一个符号就会表现成
 * 「画面永远卡住」或者「声音没了画面还在走」，但都不报错，只能靠断言兜住。
 *
 * 直接从 ads-enhance.js 里抽出函数体，在一个只提供 enhAudio 的沙箱里跑 ——
 * 不复制逻辑，测的和跑的永远是同一份。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'ads-enhance.js'), 'utf8');

function extract(name) {
  const head = 'function ' + name + '(';
  const at = SRC.indexOf(head);
  if (at < 0) throw new Error('找不到函数 ' + name);

  let depth = 0;
  for (let j = SRC.indexOf('{', at); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(at, j + 1);
    }
  }
  throw new Error('函数 ' + name + ' 没有正常结束');
}

/** 造一个和 TimeRanges 行为一致的假对象 */
function ranges(list) {
  return {
    length: list.length,
    start: (i) => list[i][0],
    end: (i) => list[i][1]
  };
}

function leadFor(bufferedList, t) {
  const ctx = vm.createContext({
    enhAudio: bufferedList === null ? null : { buffered: ranges(bufferedList) }
  });
  vm.runInContext(extract('bufferedLead') + '\nthis.lead = bufferedLead;', ctx);
  return ctx.lead(t);
}

let failures = 0;
function check(name, got, want) {
  const okv = typeof want === 'number'
    ? Math.abs(got - want) < 1e-6
    : got === want;
  if (!okv) failures++;
  console.log((okv ? '  ✓ ' : '  ✗ ') + name + ' → ' + JSON.stringify(got)
    + (okv ? '' : '（期望 ' + JSON.stringify(want) + '）'));
}

console.log('\n[1] 没有缓冲');
check('enhAudio 为 null', leadFor(null, 12), -999);
check('缓冲段数为 0', leadFor([], 12), -999);

console.log('\n[2] 目标落在缓冲里');
check('[10,20] 取 15 → 还能播 5s', leadFor([[10, 20]], 15), 5);
check('边界起点', leadFor([[10, 20]], 10), 10);
check('边界末尾', leadFor([[10, 20]], 20), 0);

console.log('\n[3] 目标在缓冲之外（负值 = 还差多少）');
check('末尾之后 25 → 差 5s', leadFor([[10, 20]], 25), -5);
check('开头之前 5 → 差 5s（曾错报 -999）', leadFor([[10, 20]], 5), -5);
check('两段之间 25 → 取最近边缘 -5', leadFor([[10, 20], [30, 40]], 25), -5);
check('多段且远在开头之前', leadFor([[10, 20], [30, 40]], 2), -8);

console.log('\n[4] 往回拖时数字必须可测量（等缓冲靠它判断「还在下」）');
/* 用户从 40s 拖回 12s：缓冲开头从 30 慢慢退到 10，lead 应单调变大 */
const backward = [leadFor([[30, 45]], 12), leadFor([[25, 45]], 12), leadFor([[10, 45]], 12)];
check('第一步 差 18s', backward[0], -18);
check('第二步 差 13s', backward[1], -13);
check('第三步 已覆盖，还能播 33s', backward[2], 33);
check('三步单调递增（= 会判定「还在下载」）', backward[0] < backward[1] && backward[1] < backward[2], true);

console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exit(failures === 0 ? 0 : 1);
