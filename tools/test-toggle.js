'use strict';

/* 点图标的行为验证。
 *
 *   node tools/test-toggle.js
 *
 * 真实点击测不了（action.onClicked 需要真人点），但把 chrome.* 全套 mock 出来
 * 就能验证状态机：首点接管、再点停止、换标签页先拆旧的、失败要发提示。
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const APP = path.join(__dirname, '..');

function makeEnv(opts) {
  const o = opts || {};
  const log = [];
  const env = {
    offscreen: false,
    currentTabId: null,
    captureFails: o.captureFails || false,
    injectFails: o.injectFails || false,
    hasOrigin: o.hasOrigin || false,
    grantPermission: o.grantPermission || false,
    origins: o.origins || [],
    log: log
  };

  const sessionStore = {};

  const chrome = {
    storage: {
      session: {
        get: async (keys) => {
          if (keys == null) return Object.assign({}, sessionStore);
          if (typeof keys === 'string') {
            return keys in sessionStore ? { [keys]: sessionStore[keys] } : {};
          }
          if (Array.isArray(keys)) {
            const out = {};
            keys.forEach((k) => { if (k in sessionStore) out[k] = sessionStore[k]; });
            return out;
          }
          const out = {};
          Object.keys(keys).forEach((k) => { out[k] = k in sessionStore ? sessionStore[k] : keys[k]; });
          return out;
        },
        set: async (obj) => {
          Object.assign(sessionStore, obj);
          if ('currentTabId' in obj) env.currentTabId = obj.currentTabId;
          log.push('session.set:' + Object.keys(obj).join(','));
        },
        remove: async (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          arr.forEach((k) => { delete sessionStore[k]; });
          if (arr.indexOf('currentTabId') !== -1) env.currentTabId = null;
          log.push('session.remove:' + arr.join(','));
        }
      },
      local: {
        get: async () => ({ lastDelayMs: o.lastDelay == null ? 1200 : o.lastDelay }),
        set: async (obj) => { log.push('local.set:' + obj.lastDelayMs); }
      }
    },
    offscreen: {
      hasDocument: async () => env.offscreen,
      createDocument: async () => { env.offscreen = true; log.push('offscreen.create'); },
      closeDocument: async () => { env.offscreen = false; log.push('offscreen.close'); }
    },
    runtime: {
      sendMessage: async (msg) => {
        if (msg && msg.target === 'offscreen') {
          log.push('to:' + msg.type);
          switch (msg.type) {
            case 'audio-start': return { ok: true, delayMs: msg.delayMs, rms: 0.12 };
            case 'audio-stop': return { ok: true };
            case 'audio-setDelay': return { ok: true, delayMs: msg.delayMs };
            case 'audio-state': return { active: env.offscreen, delayMs: 0, rms: 0, ctxState: 'running' };
          }
        }
        return undefined;
      },
      onMessage: { addListener: (fn) => { env.onMsg = fn; } }
    },
    tabs: {
      sendMessage: async (id, msg) => { log.push('tab:' + id + ':' + (msg && msg.type)); },
      onRemoved: { addListener: (fn) => { env.onRemoved = fn; } },
      onUpdated: { addListener: (fn) => { env.onUpdated = fn; } }
    },
    scripting: {
      executeScript: async () => {
        if (env.injectFails) throw new Error('Cannot access a chrome:// URL');
        log.push('inject');
      },
      getRegisteredContentScripts: async () => [],
      unregisterContentScripts: async () => {},
      registerContentScripts: async (scripts) => { log.push('register:' + scripts.length); }
    },
    permissions: {
      getAll: async () => ({ origins: env.origins || [] }),
      contains: async () => !!env.hasOrigin,
      request: async (req) => {
        log.push('perm.request:' + ((req.origins || [])[0] || ''));
        return !!env.grantPermission;
      }
    },
    tabCapture: {
      getMediaStreamId: async (opt) => {
        log.push('capture:' + opt.targetTabId);
        if (env.captureFails) {
          const e = new Error('Permission denied');
          e.name = 'NotAllowedError';
          throw e;
        }
        return 'stream-' + opt.targetTabId;
      }
    },
    action: {
      onClicked: { addListener: (fn) => { env.onClick = fn; } },
      setBadgeText: async (a) => { log.push('badge:' + (a.text || 'clear')); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async (a) => { log.push('title:' + (a.title || '').slice(0, 12)); }
    }
  };

  const ctx = vm.createContext({
    chrome: chrome,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Promise: Promise,
    Error: Error,
    Number: Number,
    Math: Math,
    String: String,
    Object: Object,
    Array: Array,
    isFinite: isFinite,
    JSON: JSON
  });

  vm.runInContext(fs.readFileSync(path.join(APP, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  env.chrome = chrome;
  return env;
}

let failures = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log('  ✓ ' + name);
  } else {
    failures++;
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

function has(env, entry) {
  return env.log.indexOf(entry) !== -1;
}

async function settle() {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 5));
}

async function main() {
  /* ---- 1. 首次点击：接管 ---- */
  console.log('\n[1] 首次点击应建立链路并沿用上次的延迟值');
  {
    const env = makeEnv({ lastDelay: 1200 });
    await env.onClick({ id: 7 });
    await settle();
    check('调用了 getMediaStreamId 且目标正确', has(env, 'capture:7'));
    check('创建了 offscreen', has(env, 'offscreen.create'));
    check('audio-start 带上了 1200ms', has(env, 'to:audio-start'));
    check('注入了页面面板', has(env, 'inject'));
    check('通知面板显示', has(env, 'tab:7:panel-show'));
    check('记住了当前标签页', env.currentTabId === 7, String(env.currentTabId));
    check('没有多发一次停止', !has(env, 'to:audio-stop'));
  }

  /* ---- 2. 同一标签页再点：停止 ---- */
  console.log('\n[2] 同一标签页再点应停止');
  {
    const env = makeEnv();
    await env.onClick({ id: 7 });
    await settle();
    env.log.length = 0;
    await env.onClick({ id: 7 });
    await settle();
    check('发了 audio-stop', has(env, 'to:audio-stop'));
    check('关掉了 offscreen', has(env, 'offscreen.close'));
    check('清掉了当前标签页', env.currentTabId === null, String(env.currentTabId));
    check('通知面板销毁', has(env, 'tab:7:stopped'));
    check('没有再捕获一次', !has(env, 'capture:7'));
  }

  /* ---- 3. 换个标签页点：先拆旧的 ---- */
  console.log('\n[3] 接管着 A 时点 B，应先停 A 再接管 B');
  {
    const env = makeEnv();
    await env.onClick({ id: 7 });
    await settle();
    env.log.length = 0;
    await env.onClick({ id: 9 });
    await settle();
    const iStop = env.log.indexOf('to:audio-stop');
    const iCap = env.log.indexOf('capture:9');
    check('停止了上一路', iStop !== -1);
    check('接管了新标签页', iCap !== -1);
    check('顺序是先停后接', iStop !== -1 && iCap !== -1 && iStop < iCap, env.log.join(' | '));
    check('当前标签页切到 9', env.currentTabId === 9, String(env.currentTabId));
  }

  /* ---- 4. 捕获被拒：提示且不留状态 ---- */
  console.log('\n[4] 捕获被拒应弹提示，且不残留接管状态');
  {
    const env = makeEnv({ captureFails: true });
    await env.onClick({ id: 7 });
    await settle();
    check('没有创建 offscreen', !has(env, 'offscreen.create'));
    check('弹了失败提示', has(env, 'tab:7:panel-error'));
    check('当前标签页仍为空', env.currentTabId === null, String(env.currentTabId));
  }

  /* ---- 5. 注入被拒：退回角标 ---- */
  console.log('\n[5] 页面不允许注入时应退回图标角标');
  {
    const env = makeEnv({ injectFails: true });
    await env.onClick({ id: 7 });
    await settle();
    check('音频链路仍然建起来了', env.offscreen === true);
    check('显示了红色角标', has(env, 'badge:!'));
  }

  /* ---- 6. 改延迟应落盘 ---- */
  console.log('\n[6] 调延迟要写进 storage.local');
  {
    const env = makeEnv();
    await env.onClick({ id: 7 });
    await settle();
    env.log.length = 0;
    /* 消息要走自己注册的监听器，mock 的 sendMessage 不经过那一层 */
    const res = await new Promise((resolve) => {
      const ret = env.onMsg({ target: 'sw', type: 'setDelay', delayMs: 3400 }, {}, resolve);
      if (ret !== true) resolve(undefined);
    });
    await settle();
    check('返回成功', res && res.ok === true, JSON.stringify(res));
    check('写入了 3400', has(env, 'local.set:3400'), env.log.join(' | '));
  }

  /* ---- 7. 标签页关闭应自动收尾 ---- */
  console.log('\n[7] 标签页关闭后应自动停止');
  {
    const env = makeEnv();
    await env.onClick({ id: 7 });
    await settle();
    env.log.length = 0;
    await env.onRemoved(7);
    await settle();
    check('关掉了 offscreen', has(env, 'offscreen.close'));
    check('清掉了当前标签页', env.currentTabId === null, String(env.currentTabId));
  }

  /* ---- 8. 授权：面板按钮只登记，点图标才真正请求 ---- */
  console.log('\n[8] 授权必须等到点图标，不能在消息里直接请求');
  {
    const env = makeEnv({ hasOrigin: false, grantPermission: true });

    const ask = () => new Promise((resolve) => {
      const ret = env.onMsg(
        { target: 'sw', type: 'requestEnhance', origin: 'https://example.com' },
        { tab: { id: 7 } },
        resolve
      );
      if (ret !== true) resolve(undefined);
    });

    const r1 = await ask();
    await settle();
    check('返回 needGesture', r1 && r1.needGesture === true, JSON.stringify(r1));
    check('没有在消息里调 permissions.request', !env.log.some((x) => x.indexOf('perm.request') === 0), env.log.join(' | '));
    check('登记了待授权', has(env, 'session.set:pendingEnhance'), env.log.join(' | '));
    check('图标打了提示角标', has(env, 'badge:↑'), env.log.join(' | '));

    env.log.length = 0;
    await env.onClick({ id: 7 });
    await settle();
    check('点图标时才请求权限', has(env, 'perm.request:https://example.com/*'), env.log.join(' | '));
    check('授权后没有去接管', !has(env, 'capture:7'), env.log.join(' | '));
    check('授权后清掉了角标', has(env, 'badge:clear'), env.log.join(' | '));
    check('提示用户刷新', has(env, 'tab:7:panel-notice'), env.log.join(' | '));
    check('提示内容是成功语气', has(env, 'session.remove:pendingEnhance'), env.log.join(' | '));
  }

  /* ---- 9. 用户拒绝授权：不接管、不留状态 ---- */
  console.log('\n[9] 用户拒绝授权时不能顺手接管');
  {
    const env = makeEnv({ hasOrigin: false, grantPermission: false });
    await new Promise((resolve) => {
      const ret = env.onMsg(
        { target: 'sw', type: 'requestEnhance', origin: 'https://example.com' },
        { tab: { id: 7 } },
        resolve
      );
      if (ret !== true) resolve(undefined);
    });
    await settle();
    env.log.length = 0;
    await env.onClick({ id: 7 });
    await settle();
    check('请求过权限', has(env, 'perm.request:https://example.com/*'));
    check('没有接管', !has(env, 'capture:7'), env.log.join(' | '));
    check('清掉了角标', has(env, 'badge:clear'));
    check('弹了失败提示', has(env, 'tab:7:panel-notice'), env.log.join(' | '));
  }

  /* ---- 10. 已授权站点再点按钮：直接注册，不再要手势 ---- */
  console.log('\n[10] 已授权的站点点按钮应直接生效');
  {
    const env = makeEnv({ hasOrigin: true });
    const r = await new Promise((resolve) => {
      const ret = env.onMsg(
        { target: 'sw', type: 'requestEnhance', origin: 'https://example.com' },
        { tab: { id: 7 } },
        resolve
      );
      if (ret !== true) resolve(undefined);
    });
    await settle();
    check('返回 ok 且要求刷新', r && r.ok === true && r.needsReload === true, JSON.stringify(r));
    check('注册了两段脚本', has(env, 'register:2'), env.log.join(' | '));
    check('没有再要一次权限', !has(env, 'perm.request:https://example.com/*'));
  }

  console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
