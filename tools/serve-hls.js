'use strict';

/* 本地 HLS 测试台用的静态服务。
 *
 * 为什么不用 python -m http.server：
 *   它不发 Cache-Control，单切片重新加载时浏览器会命中磁盘缓存、压根不发请求，
 *   链路②（调试协议抓切片）就一条 requestWillBeSent 都收不到 —— 现象和
 *   「attach 失败」完全一样，很容易查错方向。
 *
 * 用法：
 *   node tools/serve-hls.js                    # 服务 test-env/hls，端口 8127
 *   node tools/serve-hls.js --root ./hls --port 8127
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const ROOT = path.resolve(__dirname, '..', getArg('root', 'test-env/hls'));
const PORT = Number(getArg('port', 8127));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.aac': 'audio/aac',
  '.png': 'image/png'
};

http.createServer((req, res) => {
  const url = decodeURIComponent(String(req.url).split('?')[0]);
  const rel = url === '/' ? '/test-native.html' : url;
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));

  /* 目录穿越防护 */
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      /* 这条是重点：不缓存，保证每次重载都真的产生请求 */
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'none'
    });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('serving ' + ROOT);
  console.log('http://127.0.0.1:' + PORT + '/test-native.html');
});
