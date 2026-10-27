/* ============================================================
 * pages/dashboard.js —— 工作台
 *
 * 对应 PHP 版 views/dashboard.php + api/dashboard.php 的 overview
 *
 * 内容：
 *   - 问候区（日期、周、今日/本周完成率）
 *   - 4 个统计卡（今日任务、今日完成、本周任务、已延期）
 *   - 今日待办列表（可勾选完成）
 *   - 逾期与即将到期提醒
 *   - 今日日志状态 + 快捷写日志
 *   - 近期计划进度
 * ============================================================ */

(function () {
  'use strict';

  const h = () => window.UI.html;
  const e = () => window.UI.escape;
  const raw = (x) => window.UI.raw(x);

  function greeting() {
    const hh = new Date().getHours();
    if (hh < 5) return '夜深了';
    if (hh < 9) return '早上好';
    if (hh < 12) return '上午好';
    if (hh < 14) return '中午好';
    if (hh < 18) return '下午好';
    if (hh < 22) return '晚上好';
    return '夜深了';
  }

  async function render(ctx) {
    const today = window.Validate.today();
    const wk = window.Validate.weekRange(today, window.Settings.getNumber('week_start', 1));
    const me = window.Auth.currentUser();

    // 并行取数，任一项失败不影响其他（用 guard 降级）
    const [overview, todayTasks, up, logStats, plans] = await Promise.all([
      window.Errors.guard(() => buildOverview(today, wk), {
        today: { total: 0, done: 0, rate: 0, delayed: 0 },
        week: { total: 0, done: 0, rate: 0 },
      }, 'dashboard:overview'),

      window.Errors.guard(async () => {
        const rows = await window.Repo.byIndex('tasks', 'by_date', IDBKeyRange.only(today));
        return window.TaskRepo.decorate(rows).then(list => window.TaskRepo.scopeFilter(list));
      }, [], 'dashboard:today'),

      window.Errors.guard(() => window.TaskRepo.upcoming(7), {
        overdue: [], today: [], soon: [], days: 7,
      }, 'dashboard:upcoming'),

      window.Errors.guard(() => window.LogRepo.stats(), {
        total: 0, streak: 0, has_today: false,
      }, 'dashboard:logstats'),

      window.Errors.guard(async () => {
        const r = await window.PlanRepo.list({ per_page: 5 });
        return r.items || [];
      }, [], 'dashboard:plans'),
    ]);

    const sortedToday = window.Repo.sortBy(todayTasks, ['start_time', 'sort_order', 'id']);

    // 子渲染函数返回的已是安全 HTML，必须 raw() 标记，
    // 否则会被模板当普通字符串二次转义，整页显示成标签源码。
    return h()`
      ${renderHero(today, wk, overview, me)}
      ${renderStats(overview, up, logStats)}
      ${renderTodayTasks(sortedToday, today)}
      ${renderAlerts(up)}
      ${renderPlans(plans)}
    `;
  }

  async function buildOverview(today, wk) {
    const [t, w] = await Promise.all([
      window.Repo.byIndex('tasks', 'by_date', IDBKeyRange.only(today)),
      window.Repo.byIndex('tasks', 'by_date', IDBKeyRange.bound(wk.start, wk.end)),
    ]);

    /* 今天的任务必然落在本周内，concat 会出现重复行。
     * 之前只用一个 Set 做"判断"，却忘了对结果去重 ——
     * 结果"今日任务 8"但列表里只有 4 条。这里按 id 去重后再统计。 */
    const merged = dedupeById(t.concat(w));
    const decorated = await window.TaskRepo.decorate(merged);
    const inScope = window.TaskRepo.scopeFilter(decorated);

    const tIds = new Set(t.map(x => Number(x.id)));
    const todayRows = inScope.filter(x => tIds.has(Number(x.id)));
    const weekRows = inScope;

    const agg = (rows, withDelayed) => {
      const total = rows.length;
      const done = rows.filter(x => x.status === 'completed').length;
      const delayed = withDelayed ? rows.filter(x => x.status === 'delayed').length : 0;
      return { total, done, delayed, rate: total ? Math.round(done / total * 100) : 0 };
    };

    return { today: agg(todayRows, true), week: agg(weekRows, false) };
  }

  /** 按 id 去重（保留首次出现的） */
  function dedupeById(rows) {
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const id = Number(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(r);
    }
    return out;
  }

  function renderHero(today, wk, o, me) {
    return h()`
      <section class="hero">
        <div class="hero__l">
          <h2>${greeting()}，${e()(me.real_name || me.username)}</h2>
          <p>${window.Validate.date(today)} 星期${'日一二三四五六'[window.Validate.dayOfWeek(today)]}
             · 第 ${window.Validate.weekNumber(today)} 周
             · ${wk.start.slice(5)} ~ ${wk.end.slice(5)}</p>
        </div>
        <div class="hero__r">
          <div class="hero__num">
            <b>${o.today.done}<span>/${o.today.total}</span></b>
            <small>今日完成</small>
          </div>
          <div class="hero__num">
            <b>${o.week.done}<span>/${o.week.total}</span></b>
            <small>本周完成</small>
          </div>
        </div>
      </section>`;
  }

  function renderStats(o, up, logs) {
    const card = (val, label, sub, cls) => h()`
      <div class="stat ${cls || ''}">
        <div class="stat__v">${val}</div>
        <div class="stat__l">${label}</div>
        ${sub ? h()`<div class="stat__s">${sub}</div>` : ''}
      </div>`;

    return h()`
      <section class="grid4">
        ${card(o.today.total, '今日任务', o.today.rate + '% 完成')}
        ${card(o.today.done, '今日完成')}
        ${card(up.overdue.length, '已逾期', up.overdue.length ? '需要处理' : '没有逾期', up.overdue.length ? 'stat--warn' : '')}
        ${card(logs.streak + ' 天', '连续写日志', logs.has_today ? '今天已写' : '今天还没写', logs.has_today ? 'stat--ok' : 'stat--warn')}
      </section>`;
  }

  function renderTodayTasks(tasks, today) {
    if (!tasks.length) {
      return h()`
        <section class="card">
          <div class="card__h">
            <h3>今日待办</h3>
            <button class="btn btn--primary btn--sm" id="quickAdd" type="button">+ 新建任务</button>
          </div>
          ${window.UI.empty('今天还没有任务。点「新建任务」加一条，或去「任务计划」规划本周。')}
        </section>`;
    }

    const rows = tasks.map(t => h()`
      <div class="row ${t.status === 'completed' ? 'row--done' : ''}" data-task="${t.id}">
        <button class="chk ${t.status === 'completed' ? 'chk--on' : ''}"
                data-toggle="${t.id}" type="button" title="切换完成">${t.status === 'completed' ? '✓' : ''}</button>
        <span class="row__slot">${e()(t.time_slot || '')}</span>
        <span class="row__t">${e()(t.title)}</span>
        ${t.subtask_total ? h()`<span class="row__sub">${t.subtask_done}/${t.subtask_total}</span>` : ''}
        ${(t.tags || []).slice(0, 2).map(g => h()`<span class="tag">${e()(g)}</span>`).join('')}
        <span class="pill pill--${e()(t.priority)}">${e()(t.priority_name)}</span>
        <span class="pill pill--${e()(t.status)}">${e()(t.status_name)}</span>
        <button class="btn btn--sm btn--ghost" data-edit="${t.id}" type="button">编辑</button>
      </div>`).join('');

    return h()`
      <section class="card">
        <div class="card__h">
          <h3>今日待办 <span class="card__n">${tasks.length}</span></h3>
          <div class="row" style="gap:8px">
            <button class="btn btn--sm" id="bulkDone" type="button">全部完成</button>
            <button class="btn btn--primary btn--sm" id="quickAdd" type="button">+ 新建任务</button>
          </div>
        </div>
        <div class="list">${rows}</div>
      </section>`;
  }

  function renderAlerts(up) {
    const block = (title, items, cls) => {
      if (!items.length) return '';
      const list = items.slice(0, 5).map(t => h()`
        <div class="row row--sm">
          <button class="chk ${t.status === 'completed' ? 'chk--on' : ''}" data-toggle="${t.id}" type="button">
            ${t.status === 'completed' ? '✓' : ''}</button>
          <span class="row__date">${e()(t.task_date || '')}</span>
          <span class="row__t">${e()(t.title)}</span>
          <span class="pill pill--${e()(t.status)}">${e()(t.status_name)}</span>
        </div>`).join('');

      return h()`
        <section class="card card--${cls}">
          <div class="card__h"><h3>${title} <span class="card__n">${items.length}</span></h3></div>
          <div class="list">${list}</div>
          ${items.length > 5 ? h()`<p class="muted">还有 ${items.length - 5} 条，去「提醒中心」查看全部</p>` : ''}
        </section>`;
    };

    const html = block('已逾期', up.overdue, 'warn') + block('即将到期（7 天内）', up.soon, 'info');
    return html || '';
  }

  function renderPlans(plans) {
    if (!plans.length) return '';
    const rows = plans.map(p => h()`
      <div class="planrow">
        <div class="planrow__l">
          <span class="pill pill--${e()(p.type)}">${e()(p.type_name)}</span>
          <strong>${e()(p.title)}</strong>
        </div>
        <div class="planrow__bar">
          <div class="planrow__fill" style="width:${p.progress || 0}%"></div>
        </div>
        <span class="planrow__n">${p.task_done}/${p.task_total}</span>
      </div>`).join('');

    return h()`
      <section class="card">
        <div class="card__h">
          <h3>近期计划</h3>
          <a class="btn btn--sm btn--ghost" href="#plan_manage" type="button">全部</a>
        </div>
        <div class="plans">${rows}</div>
      </section>`;
  }

  /* ---------------- 事件绑定（在 boundary 外挂） ---------------- */

  function bind(pageEl) {
    const today = window.Validate.today();

    // 新建
    const add = pageEl.querySelector('#quickAdd');
    if (add) {
      add.addEventListener('click', () => {
        window.Pages.plans.openTaskEditor(null, { task_date: today });
      });
    }

    // 勾选完成
    window.UI.delegate(pageEl, '[data-toggle]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const id = btn.dataset.toggle;
      try {
        await window.TaskRepo.toggle(id);
        await AppShell.nav('dashboard');
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });

    // 编辑
    window.UI.delegate(pageEl, '[data-edit]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const t = await window.TaskRepo.get(btn.dataset.edit);
      if (t) window.Pages.plans.openTaskEditor(t);
    });

    // 全部完成
    const bulk = pageEl.querySelector('#bulkDone');
    if (bulk) {
      bulk.addEventListener('click', async () => {
        const ids = window.UI.$$('[data-toggle]', pageEl)
          .map(b => Number(b.dataset.toggle)).filter(n => n > 0);
        if (!ids.length) return;
        const go = await window.UI.confirm(`把今天这 ${ids.length} 条任务全部标为完成？`);
        if (!go) return;
        try {
          await window.TaskRepo.bulkComplete(ids, true);
          window.UI.toast('已全部完成', 'ok');
          await AppShell.nav('dashboard');
        } catch (err) {
          window.UI.toast(window.Errors.normalize(err).message, 'err');
        }
      });
    }
  }

  window.Pages.dashboard = { render, bind };
})();
