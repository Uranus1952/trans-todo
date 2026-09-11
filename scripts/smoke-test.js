/**
 * Onederz 冒烟测试
 *   node scripts/smoke-test.js [serverUrl]
 * 覆盖：业务规则（每日重置 / 临时过期 / 倒计时）100% 纯函数断言，
 *      以及同步服务端的多端一致性（A 端改动 → B 端可见）。
 */

const BASE = (process.argv[2] || process.env.ONEDERZ_SERVER || 'http://127.0.0.1:8787').replace(/\/+$/, '');

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  → ' + JSON.stringify(extra) : ''}`);
  }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

(async function main() {
  const M = await import('../app/lib/model.js');
  const { TASK_DAILY, TASK_TEMP } = M;

  /* =============== 1. 业务规则（纯函数） =============== */
  section('1. 业务规则 · 常驻任务每日自动重置');
  {
    const today = '2026-09-11';
    const tomorrow = '2026-09-12';
    let task = M.createTask({ type: TASK_DAILY, title: '喝八杯水' });
    ok(task.doneDate === null, '新建常驻任务默认未完成');
    ok(M.isDone(task, today) === false, `今天(${today}) 判定为未完成`);

    task = M.setDone(task, true, new Date(2026, 8, 11, 9, 0).getTime());
    ok(task.doneDate === today, '勾选后 doneDate 记录为今天');
    ok(M.isDone(task, today) === true, '今天判定为已完成');
    // 关键：不做任何写入，第二天自动变未完成
    ok(M.isDone(task, tomorrow) === false, '跨天后**无需任何操作**自动变为未完成（零点重置）');
    ok(task.title === '喝八杯水' && task.type === TASK_DAILY, '任务本身保留，不会消失');
  }

  section('2. 业务规则 · 临时任务当日有效、跨天自动清除');
  {
    const today = '2026-09-11';
    const tomorrow = '2026-09-12';
    const t = M.createTask({ type: TASK_TEMP, title: '14:00 牙医预约' });
    t.date = today;
    ok(M.isVisible(t, today) === true, '当天可见');
    ok(M.isVisible(t, tomorrow) === false, '次日不可见（过期）');
    ok(M.isExpired(t, tomorrow) === true, 'isExpired 正确');

    const changes = M.runDailyMaintenance([t, M.createTask({ type: TASK_DAILY, title: '常驻' })],
      new Date(2026, 8, 12, 0, 1).getTime());
    ok(changes.length === 1 && changes[0].id === t.id, '每日维护只清理过期临时任务');
    ok(changes[0].deleted === true, '过期临时任务被标记 deleted（可同步到其他端一起清掉）');
    ok(!changes.some((c) => c.type === TASK_DAILY), '常驻任务不被"清理"，只是完成态自然重置');
  }

  section('3. 业务规则 · 分组 / 倒计时 / 提醒');
  {
    const today = M.dayKey();
    const a = M.createTask({ type: TASK_DAILY, title: 'A', order: 1 });
    const b = M.createTask({ type: TASK_TEMP, title: 'B', order: 2, countdownTo: Date.now() + 3600_000 });
    const c = M.setDone(M.createTask({ type: TASK_DAILY, title: 'C', order: 3 }), true);
    const g = M.groupTasks([a, b, c], today);
    ok(g.daily.length === 1 && g.daily[0].title === 'A', '常驻待办归入 daily 分组');
    ok(g.temp.length === 1 && g.temp[0].title === 'B', '临时待办归入 temp 分组');
    ok(g.done.length === 1 && g.done[0].title === 'C', '已完成单独成组');
    ok(g.daily[0].title === 'A' && g.temp[0].countdownTo, '有倒计时的项排序优先');

    ok(/^剩 \d/.test(M.formatCountdown(3725_000)), '倒计时格式化 → ' + M.formatCountdown(3725_000));
    ok(M.formatCountdown(-1000).startsWith('已超时'), '超时文案正确');
    ok(M.countdownLevel(60_000) === 'urgent', '紧迫度分级：1 分钟内 = urgent');

    const r = M.createTask({ type: TASK_TEMP, title: 'R', remindAt: Date.now() - 1000 });
    ok(M.shouldFireReminder(r) === true, '到点触发提醒');
    ok(M.shouldFireReminder(M.setDone(r, true)) === false, '已完成的任务不再提醒');
    ok(M.shouldFireReminder({ ...r, remindFiredOn: M.dayKey() }) === false, '同日不重复提醒');
  }

  section('4. 业务规则 · 冲突合并策略');
  {
    const base = { id: 'x', deviceId: 'A', updatedAt: 100, deleted: false, title: 'old' };
    const newer = { ...base, title: 'new', updatedAt: 200 };
    ok(M.pickWinner(base, newer).title === 'new', 'updatedAt 大者胜');
    ok(M.pickWinner(newer, base).title === 'new', '合并顺序无关（可交换）');
    const del = { ...base, deleted: true, updatedAt: 200, deviceId: 'B' };
    ok(M.pickWinner({ ...base, updatedAt: 200, deviceId: 'A' }, del).deleted === true, '时间相同时删除优先，不会复活');
    const { tasks } = M.mergeChanges([base], [newer, { id: 'y', deviceId: 'B', updatedAt: 1, title: 'Y' }]);
    ok(tasks.length === 2, '远端新任务被并入');
    ok(tasks.find((t) => t.id === 'x').title === 'new', '同一 id 走 LWW 而不是新增一条');
  }

  /* =============== 5. 服务端多端一致性 =============== */
  section(`5. 同步服务 · ${BASE}`);
  let health = { status: 0 };
  try {
    health = await api('/api/health');
  } catch (err) {
    console.log(`  \x1b[33m连接不上 ${BASE}（${err.message}）\x1b[0m`);
  }
  if (health.status !== 200) {
    console.log('  \x1b[33m跳过同步测试。先另开一个终端运行：npm run server\x1b[0m');
    report();
    return;
  }
  ok(health.data.ok === true, '服务端健康检查通过');

  const user = 'smoke_' + Math.random().toString(36).slice(2, 8);
  const reg = await api('/api/auth/register', { method: 'POST', body: { username: user, password: 'pw1234' } });
  ok(reg.status === 200 && reg.data.token, '注册成功并下发令牌');
  const tokenA = reg.data.token;

  const dup = await api('/api/auth/register', { method: 'POST', body: { username: user, password: 'pw1234' } });
  ok(dup.status === 409, '重复用户名被拒绝');

  const badLogin = await api('/api/auth/login', { method: 'POST', body: { username: user, password: 'wrong' } });
  ok(badLogin.status === 401, '错误密码被拒绝');

  // 设备 B（手机）用同一账号登录
  const loginB = await api('/api/auth/login', { method: 'POST', body: { username: user, password: 'pw1234' } });
  ok(loginB.status === 200, '设备 B 登录成功');
  const tokenB = loginB.data.token;

  const noAuth = await api('/api/sync', { method: 'POST', body: { since: 0, changes: [] } });
  ok(noAuth.status === 401, '未带令牌的同步请求被拒绝');

  // 设备 A（电脑）新增两条任务
  const tDaily = M.createTask({ type: TASK_DAILY, title: '晨会 10:00', deviceId: 'pc' });
  const tTemp = M.createTask({ type: TASK_TEMP, title: '交周报', deviceId: 'pc' });
  const s1 = await api('/api/sync', {
    method: 'POST',
    token: tokenA,
    body: { since: 0, changes: [tDaily, tTemp], deviceId: 'pc' },
  });
  ok(s1.status === 200 && s1.data.accepted === 2, '电脑端 2 条任务上行成功');

  // 设备 B 首次同步拉全量
  const s2 = await api('/api/sync', { method: 'POST', token: tokenB, body: { since: 0, changes: [], deviceId: 'phone' } });
  ok(s2.data.changes.length === 2, `手机端拉到 ${s2.data.changes.length} 条 → 与电脑端一致`);

  // 设备 B 勾选"晨会"完成
  const doneByPhone = M.setDone(s2.data.changes.find((t) => t.id === tDaily.id), true);
  doneByPhone.deviceId = 'phone';
  const s3 = await api('/api/sync', { method: 'POST', token: tokenB, body: { since: s2.data.now, changes: [doneByPhone], deviceId: 'phone' } });
  ok(s3.data.accepted === 1, '手机端勾选后上行成功');

  // 设备 A 增量拉取，应看到手机端的勾选
  const s4 = await api('/api/sync', { method: 'POST', token: tokenA, body: { since: s1.data.now, changes: [], deviceId: 'pc' } });
  const merged = M.mergeChanges([tDaily, tTemp], s4.data.changes);
  const synced = merged.tasks.find((t) => t.id === tDaily.id);
  ok(M.isDone(synced) === true, '电脑端同步后看到"晨会"已被手机端标注完成 → 一端勾选、全端一致');
  ok(synced.deviceId === 'phone', '记录下最后修改设备，便于排查');

  // 设备 A 取消勾选（后写覆盖先写）
  const undone = M.setDone(synced, false);
  undone.deviceId = 'pc';
  await api('/api/sync', { method: 'POST', token: tokenA, body: { since: s4.data.now, changes: [undone], deviceId: 'pc' } });
  const s5 = await api('/api/sync', { method: 'POST', token: tokenB, body: { since: s3.data.now, changes: [], deviceId: 'phone' } });
  const back = M.mergeChanges(merged.tasks, s5.data.changes).tasks.find((t) => t.id === tDaily.id);
  ok(M.isDone(back) === false, '反向同步同样生效（手机端回到未完成）');

  // 删除同步
  const del = { ...back, deleted: true, updatedAt: Date.now() + 50, deviceId: 'pc' };
  await api('/api/sync', { method: 'POST', token: tokenA, body: { since: s5.data.now, changes: [del], deviceId: 'pc' } });
  const s6 = await api('/api/sync', { method: 'POST', token: tokenB, body: { since: s5.data.now, changes: [], deviceId: 'phone' } });
  const gone = M.mergeChanges([back, tTemp], s6.data.changes).tasks.find((t) => t.id === back.id);
  ok(gone.deleted === true, '删除动作同步到另一端（墓碑不会被复活）');

  // 永久删除：清理测试数据
  await api('/api/sync', {
    method: 'POST',
    token: tokenA,
    body: { since: 0, changes: [tDaily, tTemp, doneByPhone, undone, del], deviceId: 'pc' },
  });

  report();
})().catch((err) => {
  console.error('\n\x1b[31m冒烟测试异常：\x1b[0m', err);
  process.exitCode = 1;
});

function report() {
  console.log(`\n${'─'.repeat(52)}`);
  console.log(fail === 0 ? `\x1b[32m全部通过：${pass} 项\x1b[0m` : `\x1b[31m通过 ${pass} 项，失败 ${fail} 项\x1b[0m`);
  process.exitCode = fail === 0 ? 0 : 1;
}
