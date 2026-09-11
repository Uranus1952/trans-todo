#!/usr/bin/env node
/**
 * 无 GPU 启动器
 * ---------------------------------------------------------------
 * 远程桌面、虚拟机、部分集显驱动环境下，Chromium 的 GPU 进程会起不来，
 * Electron 直接以 `FATAL: GPU process isn't usable` 退出。
 * 这个启动器在这些场景下会自动退回软件渲染。
 *
 *   node scripts/launch-nogpu.js              正常启动（软件渲染）
 *   node scripts/launch-nogpu.js --selftest   启动后跑一遍端到端自检并退出
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const electron = require('electron');
const appDir = path.join(__dirname, '..');
const selftest = process.argv.includes('--selftest');

const env = { ...process.env, ONEDERZ_NO_GPU: '1' };
if (selftest) env.ONEDERZ_SELFTEST = '1';

const args = [
  appDir,
  '--no-sandbox',
  '--disable-gpu',
  '--disable-gpu-sandbox',
  '--use-gl=swiftshader',
  '--disable-dev-shm-usage',
];

const child = spawn(electron, args, { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
