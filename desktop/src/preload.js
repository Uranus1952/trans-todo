/**
 * Onederz · 预加载脚本
 * 通过 contextBridge 暴露**最小必要**的原生能力，
 * 渲染进程始终运行在 contextIsolation 下，不开启 nodeIntegration。
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const send = (channel, ...args) => ipcRenderer.send(channel, ...args);

contextBridge.exposeInMainWorld('onederz', {
  isDesktop: true,
  platform: process.platform,

  /* 配置 */
  getConfig: () => invoke('app:get-config'),
  setConfig: (patch) => send('app:set-config', patch),

  /* 窗口拖拽（用屏幕光标位置计算，比 -webkit-app-region 更可控） */
  dragStart: () => send('win:drag-start'),
  dragMove: () => send('win:drag-move'),
  dragEnd: () => send('win:drag-end'),

  /* 八向缩放 */
  resizeStart: (dir) => send('win:resize-start', dir),
  resizeMove: () => send('win:resize-move'),
  resizeEnd: () => send('win:resize-end'),

  /* 窗口行为 */
  hide: () => send('win:hide'),
  show: () => send('win:show'),
  minimize: () => send('win:minimize'),
  quit: () => send('app:quit'),

  /* 模式切换（桌面层 / 置底 / 置顶） */
  setMode: (mode) => invoke('win:set-mode', mode),
  setBackdrop: (backdrop) => invoke('win:set-backdrop', backdrop),
  setAutoStart: (flag) => invoke('app:set-auto-start', flag),
  applyNow: () => invoke('win:apply-native'),

  /* 文件保存（导出备份时弹出系统对话框） */
  saveFile: (name, content) => invoke('app:save-file', { name, content }),

  /* 让主进程调用系统通知（比渲染进程的 Notification 在 Windows 上更可靠） */
  notify: (title, body) => send('app:notify', { title, body }),

  /* 主进程 → 渲染进程 */
  onCommand: (cb) => {
    const handler = (_e, cmd) => cb(cmd);
    ipcRenderer.on('app:command', handler);
    return () => ipcRenderer.removeListener('app:command', handler);
  },
  onConfigChange: (cb) => {
    const handler = (_e, cfg) => cb(cfg);
    ipcRenderer.on('app:config', handler);
    return () => ipcRenderer.removeListener('app:config', handler);
  },
});
