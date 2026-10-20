'use strict';

/* 打开扩展的某个页面，收集控制台错误并截图 */

const fs = require('fs');
const PORT = process.env.CDP_PORT || '9226';
const URL_TO_OPEN = process.env.PAGE_URL;
const OUT = process.env.OUT || 'shot.png';

async function main() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURI(URL_TO_OPEN)}`, { method: 'PUT' });
  const target = await res.json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let seq = 0;
  const pending = new Map();
  const errors = [];

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push('[log] ' + m.params.entry.text);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push('[exception] ' + (d.exception && d.exception.description || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('[console] ' + m.params.args.map(a => a.value || a.description || '').join(' '));
    }
  };

  const send = (method, params) => {
    const id = ++seq;
    return new Promise((r) => {
      pending.set(id, r);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await new Promise((r) => setTimeout(r, 2000));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
    console.log('截图: ' + OUT);
  } else {
    console.log('截图失败');
  }

  const info = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title,
      num: (document.querySelector('#num')||{}).textContent,
      main: (document.querySelector('#main')||{}).textContent,
      tag: (document.querySelector('#tag')||{}).textContent,
      msg: (document.querySelector('#msg')||{}).textContent
    })`,
    returnByValue: true
  });
  console.log('页面状态: ' + (info.result && info.result.result && info.result.result.value));

  console.log(errors.length ? '错误:\n  ' + errors.join('\n  ') : '无控制台错误');
  ws.close();
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
