/**
 * Onederz · 列表渲染
 * 纯渲染层：只负责把状态变成 DOM，不含业务规则（规则都在 lib/model.js）。
 */

import {
  TASK_DAILY,
  TASK_TEMP,
  hhmm,
  dayKey,
  isDone,
  isTiming,
  formatCountdown,
  countdownLevel,
  durationText,
  taskProgress,
} from '../lib/model.js';

const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 13l4.5 4.5L19 7"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
  hourglass:
    '<svg viewBox="0 0 24 24"><path d="M7 4h10M7 20h10M8 4v3.5L12 11l4-3.5V4M8 20v-3.5L12 13l4 3.5V20"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M4 13l2.5-7h11L20 13v5H4z"/><path d="M4 13h4l1.5 2.5h5L16 13h4"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5l10 6.5-10 6.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
};

export const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const esc = escapeHtml;

function reminderText(ts, today) {
  const d = new Date(ts);
  const t = hhmm(ts);
  return dayKey(d) === today ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

function chipsHtml(task, now, today) {
  const out = [];
  if (task.countdownTo) {
    const ms = task.countdownTo - now;
    const lvl = countdownLevel(ms);
    out.push(`<span class="chip cd ${lvl}">${ICON.hourglass}${esc(formatCountdown(ms))}</span>`);
  } else if (task.durationMs && task.startedAt == null) {
    // 设了时长还没开始：预告一下，提醒用户按 ▶
    out.push(`<span class="chip dur">${ICON.clock}${esc(durationText(task.durationMs))}</span>`);
  }
  if (task.remindAt) {
    const fired = task.remindFiredOn === today;
    out.push(
      `<span class="chip rm ${fired ? 'fired' : ''}">${ICON.bell}${esc(reminderText(task.remindAt, today))}${
        fired ? ' 已提醒' : ''
      }</span>`
    );
  }
  return out.length ? `<div class="chips">${out.join('')}</div>` : '';
}

function rowHtml(task, ctx) {
  const { now, today, editingId } = ctx;
  const done = isDone(task, today);
  const editing = editingId === task.id;
  const hasMeta = !editing && (task.note || task.remindAt || task.countdownTo || task.durationMs);
  const timing = isTiming(task, now);
  // 计时中的任务给一条进度线，一眼看出"做多久了"
  const progress = timing ? taskProgress(task, now) : 0;

  return `<div class="row ${done ? 'is-done' : ''} ${timing ? 'is-timing' : ''}" data-id="${esc(
    task.id
  )}" data-type="${esc(task.type)}">
  <button class="chk" data-act="toggle" title="${done ? '取消完成' : '标记完成'}">${ICON.check}</button>
  <div class="body">
    ${
      editing
        ? `<input class="edit-input" data-edit="1" value="${esc(task.title)}" maxlength="200">`
        : `<div class="title">${esc(task.title) || '<i style="opacity:.55">（空）</i>'}</div>`
    }
    ${
      hasMeta
        ? (task.note ? `<div class="note">${esc(task.note)}</div>` : '') +
          chipsHtml(task, now, today) +
          (timing
            ? `<div class="prog"><i style="width:${(progress * 100).toFixed(1)}%"></i></div>`
            : '')
        : ''
    }
  </div>
  <div class="row-acts">
    ${
      task.durationMs && !done
        ? `<button class="ic ${timing ? 'on' : ''}" data-act="${
            timing ? 'stop' : 'start'
          }" title="${timing ? '停止计时' : '开始计时'}">${timing ? ICON.stop : ICON.play}</button>`
        : ''
    }
    <button class="ic ${task.remindAt ? 'on' : ''}" data-act="remind" title="设置提醒时间">${ICON.bell}</button>
    <button class="ic ${task.countdownTo ? 'on' : ''}" data-act="countdown" title="设置倒计时">${ICON.clock}</button>
    <button class="ic" data-act="menu" title="更多操作">${ICON.more}</button>
  </div>
</div>`;
}

const emptyHtml = (addType) => `<div class="empty">
  ${ICON.inbox}
  <b>${addType === TASK_TEMP ? '今天还没有临时任务' : '还没有常驻任务'}</b>
  <span>在下方输入内容后回车即可添加。<br>「常驻」每天自动出现，「临时」仅今天有效。</span>
</div>`;

/**
 * @param {HTMLElement} root  列表容器
 * @param {object} ctx { grouped, now, today, editingId, addType, hideCompleted }
 */
export function renderList(root, ctx) {
  const { grouped, addType, hideCompleted } = ctx;
  const parts = [];

  if (!grouped.total) parts.push(emptyHtml(addType));

  if (grouped.daily.length) {
    parts.push(
      `<div class="sec">常驻任务<span class="n">${grouped.daily.length}</span></div>` +
        grouped.daily.map((t) => rowHtml(t, ctx)).join('')
    );
  }
  if (grouped.temp.length) {
    parts.push(
      `<div class="sec">今日临时<span class="n">${grouped.temp.length}</span></div>` +
        grouped.temp.map((t) => rowHtml(t, ctx)).join('')
    );
  }
  if (grouped.done.length && !hideCompleted) {
    parts.push(
      `<div class="sec done-sec">已完成<span class="n">${grouped.done.length}</span></div>` +
        grouped.done.map((t) => rowHtml(t, ctx)).join('')
    );
  }

  root.innerHTML = parts.join('');

  if (ctx.editingId) {
    const input = root.querySelector('[data-edit="1"]');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

/**
 * 顶部进度环、日期、待完成数量
 * @param {object} el { ringFg, ringTxt, dateText, pendingText, progressBar }
 */
export function renderHeader(el, ctx) {
  const { grouped, now } = ctx;
  const { total, doneCount } = grouped;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  const pending = total - doneCount;

  el.ringFg.style.strokeDashoffset = String(97.4 * (1 - pct / 100));
  el.ringTxt.textContent = total ? `${pct}%` : '—';

  const d = new Date(now);
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  el.dateText.textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
  el.pendingText.textContent = total === 0 ? '暂无待办' : pending === 0 ? '全部完成' : `还有 ${pending} 项`;

  el.progressBar.style.width = `${pct}%`;
  el.progressBar.style.opacity = total ? '1' : '0';
}

/** 同步状态指示 */
export function renderSync(el, status, lastError, syncedAt) {
  const map = {
    online: '已同步',
    syncing: '同步中',
    connecting: '连接中',
    offline: '本地',
    error: '同步失败',
  };
  el.syncState.dataset.s = status;
  el.syncText.textContent = map[status] || '本地';
  el.syncText.title =
    status === 'error' ? lastError || '同步失败' : syncedAt ? '上次同步 ' + new Date(syncedAt).toLocaleTimeString() : '';
}
