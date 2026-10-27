/* ============================================================
 * pages/reports.js —— 统计报表
 *
 * 对应 PHP 版 views/reports.php + api/reports.php
 *   summary / by_dept / by_user
 *
 * 三个维度：
 *   1. 总体：任务完成率、准时率、日报打卡率
 *   2. 按部门：各部门任务量与完成情况
 *   3. 按成员：各成员任务量与完成情况
 * ============================================================ */

(function () {
  'use strict';

  const h = () => window.UI.html;
  const e = () => window.UI.escape;
  const raw = (x) => window.UI.raw(x);

  const state = { period: 'week', date: null };
  let chartInstances = [];

  function ensure() {
    if (!state.date) state.date = window.Validate.today();
  }

  async function render() {
    ensure();
    const rg = window.Validate.range(state.period, state.date, window.Settings.getNumber('week_start', 1));

    const [summary, byDept, byUser, trend] = await Promise.all([
      window.Errors.guard(() => buildSummary(rg), defaultSummary(), 'reports:summary'),
      window.Errors.guard(() => buildByDept(rg), [], 'reports:dept'),
      window.Errors.guard(() => buildByUser(rg), [], 'reports:user'),
      window.Errors.guard(() => buildTrend(), [], 'reports:trend'),
    ]);

    destroyCharts();

    return h()`
      <section class="card card--tight">
        <div class="card__h">
          <h3>统计周期</h3>
          <div class="row" style="gap:6px">
            <button class="btn btn--sm" id="rPrev" type="button">←</button>
            <button class="btn btn--sm" id="rToday" type="button">今天</button>
            <button class="btn btn--sm" id="rNext" type="button">→</button>
          </div>
        </div>
        <div class="toolbar">
          <div class="tabs">
            ${[['day', '日'], ['week', '周'], ['month', '月'], ['quarter', '季'], ['year', '年']]
              .map(([v, l]) => h()`
                <button class="tab ${state.period === v ? 'tab--on' : ''}" data-period="${v}" type="button">${l}</button>`).join('')}
          </div>
          <span class="muted">${rg.start} ~ ${rg.end}</span>
        </div>
      </section>

      ${renderSummaryCards(summary)}
      ${renderTrendCard(trend)}
      ${renderDeptCard(byDept)}
      ${renderUserCard(byUser)}
    `;
  }

  function defaultSummary() {
    return {
      tasks: { total: 0, completed: 0, in_progress: 0, delayed: 0, overdue: 0, rate: 0, on_time_rate: 100 },
      logs: { count: 0, work_days: 0, rate: 0 },
    };
  }

  async function buildSummary(rg) {
    const rows = await window.Repo.byIndex('tasks', 'by_date', IDBKeyRange.bound(rg.start, rg.end));
    const decorated = window.TaskRepo.scopeFilter(await window.TaskRepo.decorate(rows));

    const today = window.Validate.today();
    const total = decorated.length;
    const completed = decorated.filter(t => t.status === 'completed').length;
    const inProgress = decorated.filter(t => t.status === 'in_progress').length;
    const delayed = decorated.filter(t => t.status === 'delayed').length;
    const overdue = decorated.filter(t => t.task_date && t.task_date < today && t.status !== 'completed').length;

    // 日报打卡：统计期内应写天数、实写天数
    const workDays = window.Validate.countWorkDays(
      rg.start, rg.end, window.Settings.parseWorkDays(window.Settings.get('work_days'))
    );
    const logs = await window.Repo.all('logs');
    const uid = window.Auth.currentUserId();
    const scope = window.Auth.dataScope();
    const myDaily = logs.filter(l =>
      l.type === 'daily' && l.date_range >= rg.start && l.date_range <= rg.end
      && (scope === 'all' || Number(l.user_id) === uid)
    );
    const logCount = new Set(myDaily.map(l => l.date_range + '#' + l.user_id)).size;

    return {
      tasks: {
        total, completed, in_progress: inProgress, delayed, overdue,
        rate: total ? Math.round(completed / total * 100) : 0,
        on_time_rate: total ? Math.round((total - overdue) / total * 100) : 100,
      },
      logs: {
        count: logCount, work_days: workDays,
        rate: workDays ? Math.min(100, Math.round(logCount / workDays * 100)) : 0,
      },
    };
  }

  function renderSummaryCards(s) {
    const card = (v, l, sub, cls) => h()`
      <div class="stat ${cls || ''}">
        <div class="stat__v">${v}</div>
        <div class="stat__l">${l}</div>
        ${sub ? h()`<div class="stat__s">${sub}</div>` : ''}
      </div>`;

    return h()`
      <section class="grid4">
        ${card(s.tasks.total, '任务总数')}
        ${card(s.tasks.completed, '已完成', s.tasks.rate + '% 完成率', 'stat--ok')}
        ${card(s.tasks.on_time_rate + '%', '准时率', s.tasks.overdue ? s.tasks.overdue + ' 条逾期' : '无逾期',
          s.tasks.overdue ? 'stat--warn' : '')}
        ${card(s.logs.rate + '%', '日报打卡率', `${s.logs.count}/${s.logs.work_days} 个工作日`)}
      </section>`;
  }

  /** 近 8 周趋势（用简单的条形，不引图表库） */
  async function buildTrend() {
    const today = window.Validate.today();
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const wk = window.Validate.weekRange(window.Validate.addDays(today, -i * 7),
        window.Settings.getNumber('week_start', 1));
      weeks.push(wk);
    }

    const all = await window.Repo.all('tasks');
    const decorated = window.TaskRepo.scopeFilter(await window.TaskRepo.decorate(all));

    return weeks.map(wk => {
      const rows = decorated.filter(t => t.task_date && t.task_date >= wk.start && t.task_date <= wk.end);
      const done = rows.filter(t => t.status === 'completed').length;
      return {
        start: wk.start,
        label: wk.start.slice(5),
        total: rows.length,
        done,
        rate: rows.length ? Math.round(done / rows.length * 100) : 0,
      };
    });
  }

  function renderTrendCard(trend) {
    if (!trend.length) return '';
    const max = Math.max(1, ...trend.map(t => t.total));

    const cols = trend.map(t => {
      const hTotal = Math.round(t.total / max * 100);
      const hDone = Math.round(t.done / max * 100);
      return h()`
        <div class="trend__col" title="${t.start} 共 ${t.total} 完成 ${t.done}">
          <div class="trend__bars">
            <div class="trend__bar trend__bar--total" style="height:${hTotal}%"></div>
            <div class="trend__bar trend__bar--done" style="height:${hDone}%"></div>
          </div>
          <span class="trend__l">${t.label}</span>
          <span class="trend__n">${t.done}/${t.total}</span>
        </div>`;
    }).join('');

    return h()`
      <section class="card">
        <div class="card__h">
          <h3>近 8 周趋势</h3>
          <span class="muted">
            <i class="dot dot--total"></i> 总数
            <i class="dot dot--done"></i> 完成
          </span>
        </div>
        <div class="trend">${cols}</div>
      </section>`;
  }

  async function buildByDept(rg) {
    const [rows, users, depts] = await Promise.all([
      window.Repo.byIndex('tasks', 'by_date', IDBKeyRange.bound(rg.start, rg.end)),
      window.Repo.all('users'),
      window.Repo.all('departments'),
    ]);
    const decorated = window.TaskRepo.scopeFilter(await window.TaskRepo.decorate(rows));

    const deptMap = new Map(depts.map(d => [Number(d.id), d.name]));
    const userDept = new Map(users.map(u => [Number(u.id), Number(u.department_id || 0)]));

    const agg = new Map();
    for (const t of decorated) {
      const did = userDept.get(Number(t.assignee_id)) || 0;
      if (!agg.has(did)) agg.set(did, { total: 0, done: 0, overdue: 0 });
      const a = agg.get(did);
      a.total++;
      if (t.status === 'completed') a.done++;
      if (t.is_overdue) a.overdue++;
    }

    return Array.from(agg.entries()).map(([did, v]) => ({
      department_id: did,
      name: deptMap.get(did) || '（未分配部门）',
      total: v.total, done: v.done, overdue: v.overdue,
      rate: v.total ? Math.round(v.done / v.total * 100) : 0,
    })).sort((a, b) => b.total - a.total);
  }

  function renderDeptCard(list) {
    if (!list.length) {
      return h()`<section class="card">${window.UI.empty('本期没有任务数据')}</section>`;
    }
    return h()`
      <section class="card">
        <div class="card__h"><h3>按部门</h3></div>
        <table class="tbl">
          <thead><tr><th>部门</th><th>任务数</th><th>已完成</th><th>逾期</th><th>完成率</th></tr></thead>
          <tbody>
            ${list.map(d => h()`
              <tr>
                <td>${e()(d.name)}</td>
                <td>${d.total}</td>
                <td>${d.done}</td>
                <td class="${d.overdue ? 'tbl__warn' : ''}">${d.overdue}</td>
                <td>
                  <div class="tbl__bar"><div class="tbl__fill" style="width:${d.rate}%"></div></div>
                  <span>${d.rate}%</span>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </section>`;
  }

  async function buildByUser(rg) {
    const [rows, users] = await Promise.all([
      window.Repo.byIndex('tasks', 'by_date', IDBKeyRange.bound(rg.start, rg.end)),
      window.Repo.all('users'),
    ]);
    const decorated = window.TaskRepo.scopeFilter(await window.TaskRepo.decorate(rows));
    const userMap = new Map(users.map(u => [Number(u.id), u]));

    const agg = new Map();
    for (const t of decorated) {
      const uid = Number(t.assignee_id) || 0;
      if (!agg.has(uid)) agg.set(uid, { total: 0, done: 0, overdue: 0 });
      const a = agg.get(uid);
      a.total++;
      if (t.status === 'completed') a.done++;
      if (t.is_overdue) a.overdue++;
    }

    return Array.from(agg.entries()).map(([uid, v]) => {
      const u = userMap.get(uid);
      return {
        user_id: uid,
        name: u ? (u.real_name || u.username) : '（未指派）',
        total: v.total, done: v.done, overdue: v.overdue,
        rate: v.total ? Math.round(v.done / v.total * 100) : 0,
      };
    }).sort((a, b) => b.done - a.done || b.total - a.total);
  }

  function renderUserCard(list) {
    if (!list.length) {
      return h()`<section class="card">${window.UI.empty('本期没有成员任务数据')}</section>`;
    }
    return h()`
      <section class="card">
        <div class="card__h"><h3>按成员</h3></div>
        <table class="tbl">
          <thead><tr><th>成员</th><th>任务数</th><th>已完成</th><th>逾期</th><th>完成率</th></tr></thead>
          <tbody>
            ${list.map(d => h()`
              <tr>
                <td>${e()(d.name)}</td>
                <td>${d.total}</td>
                <td>${d.done}</td>
                <td class="${d.overdue ? 'tbl__warn' : ''}">${d.overdue}</td>
                <td>
                  <div class="tbl__bar"><div class="tbl__fill" style="width:${d.rate}%"></div></div>
                  <span>${d.rate}%</span>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </section>`;
  }

  function destroyCharts() {
    chartInstances.forEach(c => { try { c.destroy && c.destroy(); } catch (_) {} });
    chartInstances = [];
  }

  /* ============================================================ */

  function bind(pageEl) {
    const nav = () => AppShell.nav('reports');

    window.UI.delegate(pageEl, '[data-period]', 'click', (ev, btn) => {
      state.period = btn.dataset.period;
      nav();
    });

    const shift = (dir) => {
      const step = { day: 1, week: 7, month: 30, quarter: 91, year: 365 }[state.period] || 7;
      state.date = window.Validate.addDays(state.date, step * dir);
      nav();
    };

    const prev = pageEl.querySelector('#rPrev');
    const next = pageEl.querySelector('#rNext');
    const todayBtn = pageEl.querySelector('#rToday');
    if (prev) prev.addEventListener('click', () => shift(-1));
    if (next) next.addEventListener('click', () => shift(1));
    if (todayBtn) todayBtn.addEventListener('click', () => {
      state.date = window.Validate.today();
      nav();
    });
  }

  window.Pages.reports = { render, bind, state };
})();
