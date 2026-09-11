/**
 * Onederz · Windows 原生能力
 * ---------------------------------------------------------------
 * 不依赖任何原生 npm 模块（避开 Electron ABI 重编译的坑），
 * 改用「PowerShell + 内联 C# 调用 Win32 API」实现：
 *
 *   · Acrylic 磨砂        SetWindowCompositionAttribute(WCA_ACCENT_POLICY)
 *   · 系统级圆角          DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE)
 *                         失败时退回 SetWindowRgn + CreateRoundRectRgn
 *   · 挂到桌面层          EnumWindows 找 WorkerW → SetParent
 *                         —— 这一条是"与系统桌面部件一致"的关键
 *   · 桌面是否在最前面    GetForegroundWindow + 窗口类名判断
 *
 * 性能要点：Add-Type 编译 C# 和进程启动都有百毫秒级开销，而层级维持需要
 * 高频查询，因此这里**常驻一个 PowerShell 宿主进程**，通过 stdin/stdout
 * 逐行收发命令（一行命令一行响应），避免反复起进程。
 */

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PS_EXE = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);

const CSHARP = `
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class Oz {
  [StructLayout(LayoutKind.Sequential)]
  public struct AccentPolicy { public int AccentState; public int AccentFlags; public int GradientColor; public int AnimationId; }

  [StructLayout(LayoutKind.Sequential)]
  public struct WindowCompositionAttributeData { public int Attribute; public IntPtr Data; public int SizeOfData; }

  [DllImport("user32.dll")]
  static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

  [DllImport("user32.dll")]
  public static extern IntPtr GetParent(IntPtr hWnd);

  /* GA_PARENT = 1：取真正的父窗口，不含所有者。
     GetParent() 对 WS_POPUP 窗口返回的是**所有者**，判定 SetParent 是否成功必须用它。 */
  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
  static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
  static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")]
  static extern IntPtr WindowFromPoint(POINT p);

  [DllImport("user32.dll")]
  static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hWnd);

  /**
   * 层级诊断。
   *
   * 关键教训：Electron 透明窗口在 Windows 上存在**两个** Chrome_WidgetWin_1 ——
   * getNativeWindowHandle() 给的那个并不承载内容，WindowFromPoint 命中的
   * Chrome_RenderWidgetHostHWND 属于另一个。因此：
   *   · "是否命中的是自己"必须按**进程归属**判断，不能比句柄；
   *   · "桌面层是否真的挂上了"必须看**真实内容窗口的祖先链**，不能看操作句柄的返回值。
   */
  public static string Probe(IntPtr self) {
    RECT r;
    if (!GetWindowRect(self, out r)) return "err:取不到窗口矩形";
    int cx = (r.Left + r.Right) / 2;
    int cy = (r.Top + r.Bottom) / 2;
    POINT p;
    p.X = cx;
    p.Y = cy;
    IntPtr hit = WindowFromPoint(p);

    StringBuilder chain = new StringBuilder();
    IntPtr h = hit;
    for (int i = 0; i < 8 && h != IntPtr.Zero; i++) {
      if (i > 0) chain.Append(" < ");
      chain.Append(ClassOf(h)).Append('@').Append(h.ToInt64());
      h = GetAncestor(h, 1);
    }

    uint selfPid, hitPid = 0;
    GetWindowThreadProcessId(self, out selfPid);
    if (hit != IntPtr.Zero) GetWindowThreadProcessId(hit, out hitPid);

    /* 同一进程 → 窗口在我方，点击不会被别的东西吃掉 */
    bool ours = hit != IntPtr.Zero && hitPid == selfPid;
    return "rect=" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom
      + "|center=" + cx + "," + cy
      + "|selfHandle=" + self.ToInt64()
      + "|selfClass=" + ClassOf(self)
      + "|selfParent=" + GetAncestor(self, 1).ToInt64()
      + "|selfPid=" + selfPid
      + "|hitHandle=" + (hit == IntPtr.Zero ? "0" : hit.ToInt64().ToString())
      + "|hitClass=" + (hit == IntPtr.Zero ? "(无)" : ClassOf(hit))
      + "|hitPid=" + hitPid
      + "|ours=" + (ours ? "1" : "0")
      + "|chain=" + chain.ToString();
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("kernel32.dll")]
  static extern void SetLastError(int err);

  [DllImport("dwmapi.dll")]
  static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

  [DllImport("user32.dll")]
  static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);

  [DllImport("gdi32.dll")]
  static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  static string ClassOf(IntPtr h) {
    StringBuilder sb = new StringBuilder(256);
    GetClassName(h, sb, 256);
    return sb.ToString();
  }

  /* 磨砂玻璃：state 4=AcrylicBlurBehind(Win10 1803+/Win11) 3=BlurBehind 0=关闭 */
  public static string Acrylic(IntPtr hwnd, int state, int flags, int a, int r, int g, int b) {
    if (!IsWindow(hwnd)) return "err:bad-window";
    AccentPolicy ap = new AccentPolicy();
    ap.AccentState = state;
    ap.AccentFlags = flags;
    ap.GradientColor = (int)(((uint)a << 24) | ((uint)b << 16) | ((uint)g << 8) | (uint)r);
    ap.AnimationId = 0;
    int size = Marshal.SizeOf(typeof(AccentPolicy));
    IntPtr p = Marshal.AllocHGlobal(size);
    Marshal.StructureToPtr(ap, p, false);
    WindowCompositionAttributeData d = new WindowCompositionAttributeData();
    d.Attribute = 19; /* WCA_ACCENT_POLICY */
    d.Data = p;
    d.SizeOfData = size;
    int hr = SetWindowCompositionAttribute(hwnd, ref d);
    Marshal.FreeHGlobal(p);
    return hr != 0 ? "ok" : "err:SetWindowCompositionAttribute 返回 0";
  }

  /* 圆角：1=DWM 成功（Win11 平滑），2=区域裁剪兜底，0=都失败 */
  public static int Round(IntPtr hwnd, int w, int h, int radius) {
    if (!IsWindow(hwnd)) return 0;
    int pref = 2; /* DWMWCP_ROUND */
    if (DwmSetWindowAttribute(hwnd, 33, ref pref, 4) == 0) return 1;
    IntPtr rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, radius * 2, radius * 2);
    if (rgn == IntPtr.Zero) return 0;
    return SetWindowRgn(hwnd, rgn, true) != 0 ? 2 : 0;
  }

  /**
   * 找桌面层窗口：
   * 优先经典的"SHELLDLL_DefView 的兄弟 WorkerW"（壁纸层，挂上去后位于桌面图标
   * 之下、壁纸之上，即 Rainmeter 那种桌面部件位置）；找不到退而用任意 WorkerW，
   * 再不行用 Progman。
   */
  public static IntPtr FindWorkerW() {
    IntPtr progman = FindWindow("Progman", null);
    IntPtr ignored;
    SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out ignored);
    SendMessageTimeout(progman, 0x052C, new IntPtr(1), IntPtr.Zero, 0, 1000, out ignored);

    IntPtr sibling = IntPtr.Zero;
    IntPtr anyWorker = IntPtr.Zero;
    EnumProc cb = delegate(IntPtr top, IntPtr param) {
      if (ClassOf(top) != "WorkerW") return true;
      anyWorker = top;
      if (FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) {
        IntPtr w = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
        if (w != IntPtr.Zero) { sibling = w; return false; }
      }
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    GC.KeepAlive(cb);
    if (sibling != IntPtr.Zero) return sibling;
    if (anyWorker != IntPtr.Zero) return anyWorker;
    return progman;
  }

  /** 找桌面层目标，返回 "W@句柄"（真·壁纸 WorkerW）或 "P@句柄"（退而求其次的 Progman）或 "none" */
  public static string FindDesktopLayer() {
    IntPtr w = FindWorkerW();
    if (w == IntPtr.Zero) return "none";
    return (ClassOf(w) == "WorkerW" ? "W" : "P") + "@" + w.ToInt64().ToString();
  }

  /**
   * 尝试把窗口挂到桌面层。返回 "ok:目标句柄:类型(W/P):错误码" 或 "err:原因"。
   *
   * 注意：这里只报告**本次 SetParent 调用本身**的结果。能否真正生效还要看
   * 承载内容的那个窗口有没有被移动 —— Electron 透明窗口有两个 Chrome_WidgetWin_1，
   * 必须由调用方用 Probe() 复核祖先链，不能只信这个返回值。
   */
  public static string AttachDesktop(IntPtr hwnd) {
    if (!IsWindow(hwnd)) return "err:窗口句柄无效";
    IntPtr target = FindWorkerW();
    if (target == IntPtr.Zero) return "err:未找到桌面层窗口";
    string kind = ClassOf(target) == "WorkerW" ? "W" : "P";

    const int GWLP_STYLE = -16;
    const long WS_POPUP = 0x80000000L;
    const long WS_CHILD = 0x40000000L;
    const uint SWP = 0x0001 | 0x0002 | 0x0004 | 0x0020; /* NOSIZE|NOMOVE|NOZORDER|FRAMECHANGED */

    SetLastError(0);
    SetParent(hwnd, target);
    int err = Marshal.GetLastWin32Error();

    if (GetAncestor(hwnd, 1) != target) {
      long style = GetWindowLongPtr(hwnd, GWLP_STYLE).ToInt64();
      SetWindowLongPtr(hwnd, GWLP_STYLE, new IntPtr((style & ~WS_POPUP) | WS_CHILD));
      SetParent(hwnd, target);
      if (GetAncestor(hwnd, 1) != target) SetWindowLongPtr(hwnd, GWLP_STYLE, new IntPtr(style));
    }
    SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP);

    return "ok:" + target.ToInt64().ToString() + ":" + kind + ":" + err;
  }

  public static string DetachDesktop(IntPtr hwnd) {
    if (!IsWindow(hwnd)) return "err:bad-window";
    SetParent(hwnd, IntPtr.Zero);
    return GetAncestor(hwnd, 1) == IntPtr.Zero ? "ok" : "err:摘除失败";
  }

  /* 0=HWND_TOP 1=HWND_BOTTOM -2=HWND_NOTOPMOST */
  public static string ZOrder(IntPtr hwnd, int which) {
    if (!IsWindow(hwnd)) return "err:bad-window";
    return SetWindowPos(hwnd, new IntPtr(which), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010) ? "ok" : "err:zorder";
  }

  /**
   * 桌面此刻是否在最前面 —— 用户按 Win+D / 点桌面时为 1，打开其他应用时为 0。
   * autohide 模式用它复刻桌面部件的显示时机。
   */
  public static string DesktopOnTop(IntPtr self) {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero) return "0";
    if (fg == self) return "1";
    string cls = ClassOf(fg);
    if (cls == "Progman" || cls == "WorkerW") return "1";
    if (FindWindowEx(fg, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) return "1";
    if (cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return "1";
    if (cls == "Windows.UI.Core.CoreWindow") return "1";
    if (cls == "XamlExplorerHostIslandWindow") return "1";
    IntPtr owner = GetParent(fg);
    if (owner != IntPtr.Zero && ClassOf(owner) == "Progman") return "1";
    return "0";
  }

  public static string Info() {
    IntPtr worker = FindWorkerW();
    IntPtr progman = FindWindow("Progman", null);
    return Environment.OSVersion.Version.ToString()
      + "|" + (worker == IntPtr.Zero ? "0" : worker.ToInt64().ToString())
      + "|" + (progman == IntPtr.Zero ? "0" : progman.ToInt64().ToString());
  }
}
`;

const PRELUDE = `param([Parameter(Mandatory=$true)][string]$Action)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${CSHARP}
'@
`;

/** 常驻模式：逐行读命令、逐行回结果 */
const PS_SCRIPT = `${PRELUDE}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  if ($line -eq 'quit') { break }
  $p = $line.Split(' ')
  $cmd = $p[0]
  $out = ''
  try {
    $h = [IntPtr]::Zero
    if ($p.Length -gt 1) { $h = [IntPtr][int64]$p[1] }
    switch ($cmd) {
      'acrylic'      { $out = [Oz]::Acrylic($h, [int]$p[2], [int]$p[3], [int]$p[4], [int]$p[5], [int]$p[6], [int]$p[7]) }
      'round'        { $out = 'ok:' + [Oz]::Round($h, [int]$p[2], [int]$p[3], [int]$p[4]) }
      'attach'       { $out = [Oz]::AttachDesktop($h) }
      'detach'       { $out = [Oz]::DetachDesktop($h) }
      'zorder'       { $out = [Oz]::ZOrder($h, [int]$p[2]) }
      'desktopontop' { $out = [Oz]::DesktopOnTop($h) }
      'hittest'      { $out = [Oz]::Probe($h) }
      'info'         { $out = [Oz]::Info() }
      'ping'         { $out = 'pong' }
      default        { $out = 'err:unknown-command' }
    }
  } catch {
    $out = 'err:' + $_.Exception.Message
  }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
`;

let scriptFile = null;
function ensureScript() {
  if (scriptFile && fs.existsSync(scriptFile)) return scriptFile;
  const file = path.join(os.tmpdir(), 'onederz-native.ps1');
  fs.writeFileSync(file, '\ufeff' + PS_SCRIPT, 'utf8');
  scriptFile = file;
  return file;
}

/* --------------------------- 常驻宿主进程 --------------------------- */

let host = null;
let queue = [];
let buffer = '';

function hostAlive() {
  return !!(host && host.exitCode === null && !host.killed && host.stdin.writable);
}

function startHost() {
  if (hostAlive()) return;
  try {
    host = spawn(
      PS_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ensureScript(), 'serve'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (err) {
    host = null;
    return;
  }
  buffer = '';
  host.stdout.setEncoding('utf8');
  host.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      const pending = queue.shift();
      if (pending) pending.resolve(line);
    }
  });
  host.stderr.setEncoding('utf8');
  host.stderr.on('data', (t) => console.warn('[native:stderr]', String(t).trim()));
  host.on('error', () => {
    drain(new Error('原生宿主启动失败'));
  });
  host.on('exit', () => {
    host = null;
    drain(new Error('原生宿主已退出'));
  });
}

function drain(err) {
  const rest = queue;
  queue = [];
  rest.forEach((p) => p.reject(err));
}

/** 向宿主发一条命令并等待单行响应 */
function invoke(cmd, timeout = 12000) {
  return new Promise((resolve, reject) => {
    startHost();
    if (!hostAlive()) return reject(new Error('原生宿主不可用'));
    const entry = { resolve, reject };
    queue.push(entry);
    const tid = setTimeout(() => {
      const i = queue.indexOf(entry);
      if (i >= 0) {
        queue.splice(i, 1);
        reject(new Error('原生调用超时：' + cmd));
      }
    }, timeout);
    const wrapped = entry.resolve;
    entry.resolve = (v) => {
      clearTimeout(tid);
      wrapped(v);
    };
    host.stdin.write(cmd + '\n');
  });
}

function shutdownHost() {
  if (host && hostAlive()) {
    try {
      host.stdin.write('quit\n');
      host.stdin.end();
    } catch {
      /* noop */
    }
  }
  host = null;
  drain(new Error('原生宿主已关闭'));
}

/** Electron 的 getNativeWindowHandle() 是 Buffer，Windows 下即 HWND 指针 */
function toHwnd(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? buf.readBigInt64LE(0) : BigInt(buf.readInt32LE(0));
}

/* ------------------------------ 对外 API ------------------------------ */

const ACCENT_ACRYLIC = 4;
const ACCENT_BLUR = 3;
const ACCENT_NONE = 0;

/**
 * 施加磨砂玻璃。
 *
 * `fill` 是**目标不透明度**（0.08–0.96）：系统亚克力就是这块面板的"填充"，
 * 滑块直接映射到它的 alpha，因此调节范围线性一致、不会和页面那层互相打架。
 * （页面在桌面端只留一层极薄的色膜，见 app.js 的 glassLayers()。）
 *
 * `base` 是玻璃基色 "r,g,b" —— 外观预设（晨雾/琥珀/松石/墨玉…）靠它
 * 给系统亚克力上色。**必须传进来**，否则亚克力永远只有白/深灰两种，
 * 用户切预设时就会"只有按钮变色、面板不变色"。
 *
 * @param {{backdrop?:string, tint?:string, fill?:number, base?:string}} opts
 */
async function applyBackdrop(win, { backdrop = 'acrylic', tint = 'light', fill = 0.62, base = '' } = {}) {
  const hwnd = toHwnd(win);
  if (backdrop === 'none') {
    const r = await invoke(`acrylic ${hwnd} ${ACCENT_NONE} 0 0 0 0 0`);
    return { ok: r.startsWith('ok'), mode: 'none' };
  }
  const state = backdrop === 'blur' ? ACCENT_BLUR : ACCENT_ACRYLIC;
  const parts = String(base || '')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n));
  const rgb = parts.length === 3 ? parts : tint === 'dark' ? [28, 31, 52] : [252, 252, 255];
  const clamped = Math.min(Math.max(Number(fill) || 0.62, 0.08), 0.96);
  // 留一个下限，保证模糊本身始终可见（alpha 过低时部分 Windows 版本会丢掉模糊）
  const alpha = Math.round(14 + 218 * clamped);
  try {
    const r = await invoke(
      `acrylic ${hwnd} ${state} 0 ${alpha} ${Math.round(rgb[0])} ${Math.round(rgb[1])} ${Math.round(rgb[2])}`
    );
    return { ok: r.startsWith('ok'), mode: backdrop, alpha, fill: clamped, tint: rgb, error: r.startsWith('ok') ? null : r };
  } catch (err) {
    return { ok: false, mode: backdrop, error: err.message };
  }
}

async function applyRounded(win, radius = 22) {
  try {
    const b = win.getBounds();
    const out = await invoke(`round ${toHwnd(win)} ${Math.round(b.width)} ${Math.round(b.height)} ${radius}`);
    return out.split(':')[1] || '0';
  } catch {
    return '0';
  }
}

/** 尝试挂到桌面层。注意：返回值只代表 SetParent 调用本身，真正生效与否要用 probeLayer 复核 */
async function attachToDesktop(win) {
  try {
    const out = (await invoke(`attach ${toHwnd(win)}`)).trim();
    if (out.startsWith('ok:')) {
      const [, target, kind, err] = out.split(':');
      return { ok: true, target, kind: kind === 'W' ? 'workerw' : 'progman', warn: err && err !== '0' ? Number(err) : null };
    }
    return { ok: false, reason: out.replace(/^err:/, '') };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function detachFromDesktop(win) {
  try {
    return (await invoke(`detach ${toHwnd(win)}`)).startsWith('ok');
  } catch {
    return false;
  }
}

/** which: 'top' | 'bottom' | 'notop' */
async function setZOrder(win, which) {
  const map = { top: 0, bottom: 1, notop: -2 };
  try {
    return (await invoke(`zorder ${toHwnd(win)} ${map[which] ?? 0}`)).startsWith('ok');
  } catch {
    return false;
  }
}

/** 桌面此刻是否在最前面（autohide 模式用） */
async function isDesktopOnTop(win) {
  try {
    return (await invoke(`desktopontop ${toHwnd(win)}`, 4000)).trim() === '1';
  } catch {
    return true; // 判断失败时保持可见，避免"消失后找不回来"
  }
}

/**
 * 层级诊断：窗口真实屏幕矩形、重心处的命中窗口、祖先链。
 * 用于验证"挂进桌面层后还能不能收到点击"。
 */
async function probeLayer(win) {
  try {
    const raw = (await invoke(`hittest ${toHwnd(win)}`, 8000)).trim();
    const f = {};
    for (const part of raw.split('|')) {
      const i = part.indexOf('=');
      if (i > 0) f[part.slice(0, i)] = part.slice(i + 1);
    }
    const rect = (f.rect || '').split(',').map(Number);
    const center = (f.center || '').split(',').map(Number);
    return {
      raw,
      rect: rect.length === 4 && rect.every(Number.isFinite) ? { x: rect[0], y: rect[1], w: rect[2] - rect[0], h: rect[3] - rect[1] } : null,
      center: center.length === 2 ? { x: center[0], y: center[1] } : null,
      selfHandle: f.selfHandle || '',
      selfClass: f.selfClass || '',
      selfParent: f.selfParent || '',
      hitHandle: f.hitHandle || '',
      hitClass: f.hitClass || '',
      ours: f.ours === '1',
      chain: f.chain || '',
      siblings: f.siblings || '',
    };
  } catch (err) {
    return { raw: '', ours: false, hitClass: 'err', chain: err.message };
  }
}

async function systemInfo() {
  try {
    const raw = await invoke('info', 20000); // 首次调用含 C# 编译，给足时间
    const [ver, worker, progman] = raw.split('|');
    return {
      osVersion: ver,
      hasWorkerW: !!worker && worker !== '0',
      workerW: worker,
      hasProgman: !!progman && progman !== '0',
    };
  } catch (err) {
    return { osVersion: 'unknown', hasWorkerW: false, error: err.message };
  }
}

/** 预热：把 C# 编译开销提前到启动阶段，避免第一次点击才卡顿 */
async function warmup() {
  try {
    await invoke('ping', 25000);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  toHwnd,
  applyBackdrop,
  applyRounded,
  attachToDesktop,
  detachFromDesktop,
  setZOrder,
  isDesktopOnTop,
  probeLayer,
  systemInfo,
  warmup,
  shutdownHost,
};
