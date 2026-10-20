'use strict';

/* 用 CDP 的 Extensions.loadUnpacked 加载未打包扩展
 * （Chrome 137 起 --load-extension 在官方构建中被移除） */

const PORT = process.env.CDP_PORT || '9226';
const EXT_PATH = process.env.EXT_PATH || 'D:\\Desktop\\project\\extension\\AudioDelaySync';

async function main() {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => {
    const id = ++seq;
    return new Promise((res) => {
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  };

  const r = await send('Extensions.loadUnpacked', { path: EXT_PATH });
  console.log(JSON.stringify(r, null, 2));
  ws.close();
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
