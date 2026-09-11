/**
 * 本地预览：node scripts/serve-app.js [port]
 * 直接在浏览器里打开这套 UI（磨砂玻璃效果会用 CSS 环境光晕模拟）。
 * 手机上访问电脑的局域网 IP 即可当作 PWA 使用。
 */
const path = require('node:path');
const os = require('node:os');
const { startStaticServer } = require('../tools/static-server');

const PORT = Number(process.argv[2] || process.env.PORT || 4317);

(async () => {
  // 必须监听 0.0.0.0，否则手机访问打印出来的局域网地址会 connection refused
  const srv = await startStaticServer(path.join(__dirname, '..', 'app'), {
    port: PORT,
    host: '0.0.0.0',
    quiet: true,
  });
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  Onederz · 界面预览                           │');
  console.log('└──────────────────────────────────────────────┘');
  console.log(`  本机   ${srv.url}`);
  lan.forEach((ip) => console.log(`  手机   http://${ip}:${PORT}/`));
  console.log('  提示   手机上打开后可用「添加到主屏幕」当 PWA 用\n');
})();
