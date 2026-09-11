/**
 * Onederz · 提醒通知
 * 优先用系统通知（Windows 通知中心 / Android 通知栏），
 * 同时返回一个应用内 toast，保证任何权限状态下用户都能看到。
 */

const hasNotification = typeof window !== 'undefined' && 'Notification' in window;

export async function ensurePermission() {
  if (!hasNotification) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * @param {{title:string, body:string, tag?:string, silent?:boolean}} opts
 * @returns {boolean} 是否成功弹出系统通知
 */
export function systemNotify(opts) {
  if (!hasNotification || Notification.permission !== 'granted') return false;
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      icon: './icon-192.png',
      silent: !!opts.silent,
      requireInteraction: false,
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* noop */
      }
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

/** 用 WebAudio 合成一个柔和的提示音，免去音频资源文件 */
export function chime(times = 2) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const notes = [
      [880, 0],
      [1174.7, 0.16],
    ];
    for (let i = 0; i < times; i++) {
      for (const [freq, offset] of notes) {
        const t = now + i * 0.5 + offset;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.3);
      }
    }
    setTimeout(() => ctx.close().catch(() => {}), (times * 500 + 600) | 0);
  } catch {
    /* 静默失败即可 */
  }
}

/** 轻量触感反馈（Android）。需已有用户交互，否则浏览器会拦并刷控制台日志。 */
export function haptic(ms = 12) {
  try {
    if (navigator.userActivation && navigator.userActivation.hasBeenActive === false) return;
    navigator.vibrate?.(ms);
  } catch {
    /* noop */
  }
}
