/**
 * Onederz · 设置面板
 * 分区：同步账号 / 外观 / 数据 / 关于
 */

import { escapeHtml as esc } from './render.js';
import { probeServer } from '../lib/sync.js';

const ACCENTS = ['#5b6bff', '#7c5cff', '#0ea5e9', '#10b981', '#f0813c', '#ef4a5a'];

/**
 * 外观预设：不只是明暗，而是"玻璃基色 + 主题色 + 浓度"的一整套组合。
 * 点一下就是一套调好的观感，之后仍可用浓度滑块和主题色微调。
 *
 * 基色要**足够饱和**：如果都是接近白的，在 Windows 上系统亚克力会把它们
 * 调成差不多的白玻璃，用户只会看到按钮变色、面板没变 —— 那就是白做了。
 */
export const APPEARANCE_PRESETS = [
  { id: 'mist', name: '晨雾', tint: 'light', accent: '#4f6bff', glassBase: '236,240,255', glassOpacity: 0.6, swatch: 'linear-gradient(135deg,#eef2ff,#c3ceff)' },
  { id: 'amber', name: '琥珀', tint: 'light', accent: '#b45309', glassBase: '255,213,158', glassOpacity: 0.62, swatch: 'linear-gradient(135deg,#ffd9a0,#e8934a)' },
  { id: 'jade', name: '松石', tint: 'light', accent: '#0b7d6e', glassBase: '196,240,229', glassOpacity: 0.6, swatch: 'linear-gradient(135deg,#a9ecdc,#3fb9a2)' },
  { id: 'ink', name: '墨玉', tint: 'dark', accent: '#a78bfa', glassBase: '24,26,48', glassOpacity: 0.78, swatch: 'linear-gradient(135deg,#2e3160,#0f1024)' },
];

/** 玻璃浓度的三档预设，覆盖"几乎全透 → 厚实磨砂" */
const GLASS_PRESETS = [
  { name: '通透', v: 0.18 },
  { name: '标准', v: 0.55 },
  { name: '厚实', v: 0.86 },
];

export function renderPanel(body, ctx) {
  const {
    settings,
    onPatch,
    onLive,
    onLogin,
    onRegister,
    onLogout,
    onExport,
    onImport,
    onClearDone,
    onWipe,
    onTest,
    onToast,
    status,
  } = ctx;
  const logged = !!settings.token;
  const pct = Math.round((settings.glassOpacity ?? 0.62) * 100);

  body.innerHTML = `
  <div class="grp">
    <h3>同步账号（多端一致的关键）</h3>
    <div class="field">
      <label>服务器</label>
      <input id="fServer" type="text" placeholder="http://192.168.1.10:8787" value="${esc(settings.serverUrl)}">
    </div>
    <div class="btn-row">
      <button class="btn" id="btnTest">测试连接</button>
      <span class="badge" id="testBadge">${
        status === 'online' ? '<span class="dot"></span>已连接' : logged ? '未连接' : '未登录'
      }</span>
    </div>
    ${
      logged
        ? `
      <div class="field" style="margin-top:12px">
        <label>账号</label>
        <input type="text" value="${esc(settings.username)}" disabled>
      </div>
      <div class="btn-row">
        <button class="btn danger" id="btnLogout">退出登录</button>
      </div>
      <p class="hint">当前设备已登录，待办会自动与其他设备双向同步。同一账号在电脑、平板、手机上登录即可看到同一份待办集。</p>`
        : `
      <div class="field" style="margin-top:12px">
        <label>用户名</label>
        <input id="fUser" type="text" placeholder="2–32 位，字母数字等" autocomplete="username">
      </div>
      <div class="field">
        <label>密码</label>
        <input id="fPass" type="password" placeholder="至少 4 位" autocomplete="current-password">
      </div>
      <div class="btn-row">
        <button class="btn primary" id="btnLogin">登录</button>
        <button class="btn" id="btnRegister">注册新账号</button>
      </div>
      <p class="hint" id="authHint">第一次使用：填好服务器地址与用户名密码，点「注册新账号」。<br>在手机端用<b>同一个账号登录</b>，两端就会自动同步。</p>`
    }
  </div>

  <div class="grp">
    <h3>背景玻璃</h3>
    <div class="presets">
      ${APPEARANCE_PRESETS.map(
        (p) => `
      <button class="preset ${settings.theme === p.id ? 'on' : ''}" data-theme="${p.id}" title="${p.name}">
        <i style="background:${p.swatch}"></i><span>${p.name}</span>
      </button>`
      ).join('')}
    </div>
    <div class="field">
      <label>浓度</label>
      <input id="fOpacity" type="range" min="8" max="96" step="1" value="${pct}">
      <span class="val" id="fOpacityOut">${pct}%</span>
    </div>
    <div class="btn-row" style="margin:0 0 4px 68px;gap:5px">
      ${GLASS_PRESETS.map(
        (p) =>
          `<button class="btn ${Math.abs(p.v - settings.glassOpacity) < 0.04 ? 'primary' : ''}" data-preset="${p.v}">${p.name}</button>`
      ).join('')}
    </div>
    <div class="glass-demo" title="拖动上面的滑块，这块玻璃会立刻跟着变">
      <span class="demo-swirl"></span>
      <span class="demo-txt">玻璃预览</span>
    </div>
    <div class="field" style="margin-top:12px">
      <label>主题色</label>
      <div class="btn-row" style="margin:0;gap:5px">
        ${ACCENTS.map(
          (c) =>
            `<button class="btn" data-accent="${c}" style="width:26px;height:26px;padding:0;border-radius:50%;background:${c};border-color:${
              settings.accent === c ? 'var(--ink)' : 'transparent'
            }"></button>`
        ).join('')}
      </div>
    </div>
    <div class="switch">
      <span>动态高光（跟随鼠标的镜面反光）</span>
      <input type="checkbox" id="fSpec" ${settings.dynamicSheen ? 'checked' : ''}>
    </div>
    <div class="switch">
      <span>隐藏已完成的任务</span>
      <input type="checkbox" id="fHideDone" ${settings.hideCompleted ? 'checked' : ''}>
    </div>
    <div class="switch">
      <span>到点弹出系统通知</span>
      <input type="checkbox" id="fNotify" ${settings.notifyOn ? 'checked' : ''}>
    </div>
    <div class="switch">
      <span>提醒时播放提示音</span>
      <input type="checkbox" id="fSound" ${settings.soundOn ? 'checked' : ''}>
    </div>
  </div>

  ${
    ctx.desktop
      ? `
  <div class="grp">
    <h3>桌面部件行为（Windows）</h3>
    <div class="field">
      <label>显示层级</label>
      <select id="fMode">
        <option value="autohide" ${ctx.desktop.mode === 'autohide' ? 'selected' : ''}>跟随桌面显示 / 隐藏（推荐）</option>
        <option value="bottom" ${ctx.desktop.mode === 'bottom' ? 'selected' : ''}>普通窗口 · 一直显示在最底层</option>
        <option value="top" ${ctx.desktop.mode === 'top' ? 'selected' : ''}>始终置顶</option>
        <option value="desktop" ${ctx.desktop.mode === 'desktop' ? 'selected' : ''}>桌面层挂载（实验性）</option>
      </select>
    </div>
    <p class="hint">「跟随桌面显示 / 隐藏」= 前台是桌面时出现，打开其他应用或网页时自动隐藏，与系统桌面部件的出现时机一致。</p>
    ${
      ctx.desktop.fallback
        ? `<p class="hint" style="color:var(--warn)">桌面层挂载未成功（${esc(
            ctx.desktop.fallback
          )}），已自动回落到「跟随桌面显示 / 隐藏」，两者可见行为一致。</p>`
        : ''
    }
    <div class="field">
      <label>磨砂</label>
      <select id="fBackdrop">
        <option value="acrylic" ${ctx.desktop.backdrop === 'acrylic' ? 'selected' : ''}>系统亚克力（推荐）</option>
        <option value="blur" ${ctx.desktop.backdrop === 'blur' ? 'selected' : ''}>仅模糊（性能更好）</option>
        <option value="none" ${ctx.desktop.backdrop === 'none' ? 'selected' : ''}>关闭系统模糊</option>
      </select>
    </div>
    <div class="switch">
      <span>开机自动启动</span>
      <input type="checkbox" id="fAutoStart" ${ctx.desktop.autoStart ? 'checked' : ''}>
    </div>
    <p class="hint">快捷键 <code>${esc(ctx.desktop.hotkey || 'Alt+Space')}</code> 可随时显示 / 隐藏部件；托盘图标右键也有全部选项。</p>
  </div>`
      : ''
  }

  <div class="grp">
    <h3>数据</h3>
    <div class="btn-row">
      <button class="btn" id="btnExport">导出备份</button>
      <button class="btn" id="btnImport">导入备份</button>
      <button class="btn" id="btnClearDone">清空已完成</button>
    </div>
    <p class="hint">备份是包含全部待办的 JSON 文件，可手工拷到另一端导入，作为同步服务的兜底方案。</p>
    <div class="btn-row">
      <button class="btn danger ghost" id="btnWipe">清除本机全部数据</button>
    </div>
  </div>

  <div class="grp">
    <h3>关于</h3>
    <p class="hint">
      <b>Onederz 1.0.0</b> — 跨平台桌面悬浮待办部件<br>
      Windows（Electron · 系统亚克力磨砂 · 桌面层挂载）<br>
      Android（Capacitor · 悬浮窗服务）<br>
      常驻任务每日零点自动重置；临时任务跨天自动清除。
    </p>
  </div>`;

  /* --------------------------- 事件绑定 --------------------------- */
  const $ = (id) => body.querySelector('#' + id);

  $('btnTest')?.addEventListener('click', async () => {
    const badge = $('testBadge');
    const url = $('fServer').value.trim().replace(/\/+$/, '');
    badge.className = 'badge';
    badge.textContent = '连接中…';
    try {
      const info = await probeServer(url);
      badge.className = 'badge ok';
      badge.textContent = `连接成功 · 已注册 ${info.stats?.users ?? 0} 个账号`;
      onPatch({ serverUrl: url });
    } catch (err) {
      badge.className = 'badge err';
      badge.textContent = '连接失败：' + err.message;
    }
  });

  $('fServer')?.addEventListener('change', (e) => onPatch({ serverUrl: e.target.value.trim().replace(/\/+$/, '') }));

  const auth = async (fn) => {
    /* 关键：只能通过 $() 现取元素，不能提前缓存引用 ——
       onPatch({ serverUrl }) 会重建整个面板 DOM，缓存的引用会变成脱离文档的旧节点，
       往里写错误信息用户什么都看不到（表现为"点了没反应"）。 */
    let { hint, bLogin, bReg, url, username, password } = readAuth();

    if (!username || !password) {
      if (hint) hint.innerHTML = '<span style="color:var(--danger)">请先填写用户名和密码</span>';
      return;
    }

    // 先提交服务器地址（可能触发面板重绘），之后所有元素引用必须重新获取
    onPatch({ serverUrl: url });
    ({ hint, bLogin, bReg } = readAuth());

    const reset = () => {
      [readAuth().bLogin, readAuth().bReg].forEach((b) => {
        if (b) {
          b.disabled = false;
          if (b.dataset.label) b.textContent = b.dataset.label;
        }
      });
    };
    [bLogin, bReg].forEach((b) => {
      if (b) {
        b.dataset.label = b.dataset.label || b.textContent;
        b.disabled = true;
      }
    });
    if (hint) hint.textContent = `正在连接 ${url || '(未填服务器地址)'} …`;

    try {
      await fn(username, password);
    } catch (err) {
      const msg = err?.message || String(err);
      const h = readAuth().hint;
      if (h) {
        h.innerHTML = `<span style="color:var(--danger)">连接失败：${esc(msg)}<br>服务器地址 = ${esc(
          url || '(空)'
        )}，请确认同步服务已启动、且手机与电脑在同一 WiFi。</span>`;
      }
      // 提示栏在设置面板里容易被忽略 —— 再弹一条明显的
      onToast?.('连接失败', msg.slice(0, 80), 'del');
    } finally {
      reset();
    }
  };

  /** 每次都从 DOM 现取，避免引用过期 */
  function readAuth() {
    return {
      hint: $('authHint'),
      bLogin: $('btnLogin'),
      bReg: $('btnRegister'),
      url: ($('fServer')?.value || '').trim().replace(/\/+$/, ''),
      username: ($('fUser')?.value || '').trim(),
      password: $('fPass')?.value || '',
    };
  }

  $('btnLogin')?.addEventListener('click', () => auth(onLogin));
  $('btnRegister')?.addEventListener('click', () => auth(onRegister));
  $('fPass')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') auth(onLogin);
  });
  $('btnLogout')?.addEventListener('click', onLogout);

  body.querySelectorAll('[data-theme]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = APPEARANCE_PRESETS.find((x) => x.id === b.dataset.theme);
      if (p) onPatch({ theme: p.id, tint: p.tint, accent: p.accent, glassBase: p.glassBase, glassOpacity: p.glassOpacity });
    })
  );
  body.querySelectorAll('[data-accent]').forEach((b) =>
    b.addEventListener('click', () => onPatch({ accent: b.dataset.accent }))
  );

  // 玻璃浓度：拖动时走 liveSettings（不重建 DOM，滑块才拖得动），松手才落盘 + 重绘
  const slider = $('fOpacity');
  const out = $('fOpacityOut');
  const markPresets = (v) =>
    body.querySelectorAll('[data-preset]').forEach((b) =>
      b.classList.toggle('primary', Math.abs(Number(b.dataset.preset) - v) < 0.04)
    );

  slider?.addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    onLive?.({ glassOpacity: v });
    if (out) out.textContent = `${e.target.value}%`;
    markPresets(v);
  });
  slider?.addEventListener('change', (e) => {
    onPatch({ glassOpacity: Number(e.target.value) / 100 });
  });

  body.querySelectorAll('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => onPatch({ glassOpacity: Number(b.dataset.preset) }))
  );

  $('fHideDone')?.addEventListener('change', (e) => onPatch({ hideCompleted: e.target.checked }));
  $('fSpec')?.addEventListener('change', (e) => onPatch({ dynamicSheen: e.target.checked }));
  $('fNotify')?.addEventListener('change', (e) => onPatch({ notifyOn: e.target.checked }));
  $('fSound')?.addEventListener('change', (e) => onPatch({ soundOn: e.target.checked }));

  $('btnExport')?.addEventListener('click', onExport);
  $('btnImport')?.addEventListener('click', onImport);
  $('btnClearDone')?.addEventListener('click', onClearDone);
  $('btnWipe')?.addEventListener('click', onWipe);

  /* ------------------------ 桌面部件专属 ------------------------ */
  if (ctx.desktop) {
    $('fMode')?.addEventListener('change', (e) => ctx.desktop.onMode(e.target.value));
    $('fBackdrop')?.addEventListener('change', (e) => ctx.desktop.onBackdrop(e.target.value));
    $('fAutoStart')?.addEventListener('change', (e) => ctx.desktop.onAutoStart(e.target.checked));
  }

  /* ------------------------ Android 悬浮窗 ------------------------ */
  if (ctx.android) {
    $('btnFloat')?.addEventListener('click', async () => {
      const btn = $('btnFloat');
      btn.disabled = true;
      try {
        await ctx.android.onToggle();
      } finally {
        btn.disabled = false;
      }
    });
  }
}
