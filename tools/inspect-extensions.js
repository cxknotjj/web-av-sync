'use strict';

/* 通过 CDP 读取 chrome://extensions-internals，确认扩展是否被加载 */

const BASE = 'http://127.0.0.1:9223';

async function main() {
  const res = await fetch(BASE + '/json/new?chrome://extensions-internals', { method: 'PUT' });
  const target = await res.json();
  const wsUrl = target.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('没有拿到 ws 地址');

  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };

  function send(method, params) {
    const mid = ++id;
    return new Promise((resolve) => {
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  }

  /* 等页面加载完 */
  await new Promise((r) => setTimeout(r, 1200));

  const r = await send('Runtime.evaluate', {
    expression: 'document.body.innerText',
    returnByValue: true
  });

  const text = (r.result && r.result.result && r.result.result.value) || '';
  ws.close();

  let data;
  try { data = JSON.parse(text); } catch (e) {
    console.log('原始输出前 800 字：\n' + text.slice(0, 800));
    return;
  }

  const list = Array.isArray(data) ? data : [data];
  console.log('已加载扩展数：' + list.length + '\n');
  for (const ext of list) {
    const name = (ext.name || '').slice(0, 46);
    const ver = ext.version || '';
    const state = ext.state;
    const id = ext.id || (ext.manifest && ext.manifest.id) || '';
    console.log(`${id.padEnd(34)} ${String(name).padEnd(48)} v${ver}  state=${state}`);
  }
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
