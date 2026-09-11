/**
 * Onederz · 极简静态服务器（零依赖）
 * ---------------------------------------------------------------
 * 为什么要它：前端用的是原生 ES Module，file:// 协议下浏览器会因 CORS 拒绝加载模块。
 * 所以在桌面端与本地预览里，统一用 loopback HTTP 提供页面，和手机端 / PWA 完全一致，
 * 避免为不同端维护两套加载方式。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * @param {string} rootDir 静态根目录
 * @param {{port?:number, host?:string, quiet?:boolean}} [opts]
 * @returns {Promise<{port:number, url:string, close:()=>Promise<void>, server:import('http').Server}>}
 */
function startStaticServer(rootDir, opts = {}) {
  const root = path.resolve(rootDir);
  const host = opts.host || '127.0.0.1';

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || host}`);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';

      // 防目录穿越
      const target = path.resolve(root, '.' + rel);
      if (!target.startsWith(root)) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      let file = target;
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        file = path.join(file, 'index.html');
      }
      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 · ' + rel);
        return;
      }

      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 · ' + err.message);
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const port = server.address().port;
      const url = `http://${host}:${port}/`;
      if (!opts.quiet) console.log(`[static] ${root} → ${url}`);
      resolve({
        port,
        url,
        server,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

module.exports = { startStaticServer, MIME };
