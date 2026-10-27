/* ============================================================
 * pages/board.js —— 提醒中心 / 看板
 *
 * 对应 PHP 版 views/board.php（182 行）
 *
 * 两个视图：
 *   1. 提醒视图：逾期 / 今天 / 即将到期 三段清单
 *   2. 看板视图：按状态分四列，卡片可拖拽换列改状态
 * ============================================================ */

(function () {
  'use strict';

  const h = () => window.UI.html;
  const e = () => window.UI.escape;

  const state = {
    mode: 'board',      // 'board' | 'remind'
    days: 7,
  };

  const COLUMNS = [
    { key: 'pending', label: '待开始', cls: 'pending' },
    { key: 'in_progress', label: '进行中', cls: 'progress' },
    { key: 'delayed', label: '已延期', cls: 'delayed' },
    { key: 'completed', label: '已完成', cls: 'done' },
  ];

  async function render() {
    if (state.mode === 'remind') return renderRemind();
    return renderBoard();
  }

  /* ============================================================
   * 看板
   * ============================================================ */

  async function renderBoard() {
    // 看板取本周 + 逾期（不拉全库，避免卡片过多卡顿）
    const today = window.Validate.today();
    const wk = window.Validate.weekRange(today, window.Settings.getNumber('week_start', 1));
    const start = wk.start < today ? wk.start : today;

    const rows = await window.Repo.byIndex('tasks', 'by_date', IDBKeyRange.bound(start, wk.end));
    const decorated = window.TaskRepo.scopeFilter(await window.TaskRepo.decorate(rows));

    // 逾期任务单独纳入"已延期"列
    const overdueRows = await window.Repo.byIndex('tasks', 'by_date', IDBKeyRange.upperBound(
      window.Validate.addDays(today, -1)
    ));
    const overdue = window.TaskRepo.scopeFilter(await window.TaskRepo.decorate(overdueRows))
      .filter(t => t.status !== 'completed');

    const merged = dedupeById(decorated.concat(overdue));

    const byCol = {};
    for (const c of COLUMNS) byCol[c.key] = [];
    for (const t of merged) {
      const key = COLUMNS.some(c => c.key === t.status) ? t.status : 'pending';
      byCol[key].push(t);
    }

    return h()`
      <section class="card card--tight">
        <div class="card__h">
          <div class="tabs">
            <button class="tab ${state.mode === 'board' ? 'tab--on' : ''}" data-mode="board" type="button">看板</button>
            <button class="tab ${state.mode === 'remind' ? 'tab--on' : ''}" data-mode="remind" type="button">提醒清单</button>
          </div>
          <div class="row" style="gap:8px">
            <span class="muted">${wk.start} ~ ${wk.end}</span>
            <button class="btn btn--primary btn--sm" id="boardNew" type="button">+ 新建任务</button>
          </div>
        </div>
        <p class="muted">拖动卡片到别的列即可改变状态。拖到「已完成」会自动标记完成。</p>
      </section>

      <section class="kanban">
        ${COLUMNS.map(c => renderColumn(c, byCol[c.key])).join('')}
      </section>
    `;
  }

  function dedupeById(rows) {
    const m = new Map();
    for (const r of rows) m.set(Number(r.id), r);
    return Array.from(m.values());
  }

  function renderColumn(col, items) {
    const sorted = window.Repo.sortBy(items, ['task_date', 'start_time', 'id']);

    return h()`
      <div class="kcol" data-col="${col.key}">
        <header class="kcol__h kcol__h--${col.cls}">
          <span>${col.label}</span>
          <em>${sorted.length}</em>
        </header>
        <div class="kcol__body" data-drop="${col.key}">
          ${sorted.length ? sorted.map(t => renderCard(t)).join('') : h()`<div class="kcol__empty">拖到这里</div>`}
        </div>
      </div>`;
  }

  function renderCard(t) {
    const overdue = t.is_overdue;
    return h()`
      <article class="kcard ${overdue ? 'kcard--overdue' : ''}" draggable="true" data-card="${t.id}">
        <div class="kcard__h">
          <span class="pill pill--${e()(t.priority)}">${e()(t.priority_name)}</span>
          ${overdue ? h()`<span class="pill pill--delayed">逾期</span>` : ''}
          <span class="kcard__date">${e()((t.task_date || '').slice(5))}</span>
        </div>
        <p class="kcard__t">${e()(t.title)}</p>
        <div class="kcard__f">
          ${t.time_slot ? h()`<span class="tag">${e()(t.time_slot)}</span>` : ''}
          ${(t.tags || []).slice(0, 2).map(g => h()`<span class="tag">${e()(g)}</span>`).join('')}
          ${t.subtask_total ? h()`<span class="tag">${t.subtask_done}/${t.subtask_total}</span>` : ''}
          <button class="btn btn--sm btn--ghost" data-kedit="${t.id}" type="button">编辑</button>
        </div>
      </article>`;
  }

  /* ============================================================
   * 提醒清单
   * ============================================================ */

  async function renderRemind() {
    const up = await window.TaskRepo.upcoming(state.days);
    const stats = await window.LogRepo.stats();

    const section = (title, items, cls, note) => {
      if (!items.length) return '';
      return h()`
        <section class="card card--${cls}">
          <div class="card__h"><h3>${title} <span class="card__n">${items.length}</span></h3></div>
          ${note ? h()`<p class="muted">${note}</p>` : ''}
          <div class="list">
            ${items.map(t => h()`
              <div class="row">
                <button class="chk ${t.status === 'completed' ? 'chk--on' : ''}"
                  data-toggle="${t.id}" type="button">${t.status === 'completed' ? '✓' : ''}</button>
                <span class="row__date">${e()(t.task_date || '')}</span>
                <span class="row__t">${e()(t.title)}</span>
                ${t.assignee_name ? h()`<span class="row__who">${e()(t.assignee_name)}</span>` : ''}
                <span class="pill pill--${e()(t.status)}">${e()(t.status_name)}</span>
                <button class="btn btn--sm btn--ghost" data-kedit="${t.id}" type="button">编辑</button>
              </div>`).join('')}
          </div>
        </section>`;
    };

    const logCard = h()`
      <section class="card card--tight">
        <div class="card__h">
          <h3>今日日志</h3>
          <span class="pill pill--${stats.has_today ? 'completed' : 'pending'}">
            ${stats.has_today ? '已写' : '未写'}</span>
        </div>
        <p class="muted">连续写日志 ${stats.streak} 天，累计 ${stats.total} 篇。</p>
        ${stats.has_today ? '' : h()`<a class="btn btn--primary btn--sm" href="#logs" type="button">去写今天的日志</a>`}
      </section>`;

    return h()`
      <section class="card card--tight">
        <div class="card__h">
          <div class="tabs">
            <button class="tab" data-mode="board" type="button">看板</button>
            <button class="tab tab--on" data-mode="remind" type="button">提醒清单</button>
          </div>
          <div class="row" style="gap:6px">
            <span class="muted">未来</span>
            <select class="input input--sm" id="remindDays">
              ${[3, 7, 14, 30].map(d => h()`
                <option value="${d}" ${state.days === d ? 'selected' : ''}>${d} 天</option>`).join('')}
            </select>
          </div>
        </div>
      </section>
      ${logCard}
      ${section('已逾期', up.overdue, 'warn', '这些任务已过日期还没完成，建议优先处理或改期。')}
      ${section('今天', up.today, 'info')}
      ${section('即将到期', up.soon, '')}
      ${!up.overdue.length && !up.today.length && !up.soon.length
        ? window.UI.empty('未来 ' + state.days + ' 天没有待办任务，很清爽。') : ''}
    `;
  }

  /* ============================================================ */

  function bind(pageEl) {
    // 视图切换
    window.UI.delegate(pageEl, '[data-mode]', 'click', (ev, btn) => {
      state.mode = btn.dataset.mode;
      AppShell.nav('board');
    });

    // 天数
    const days = pageEl.querySelector('#remindDays');
    if (days) {
      days.addEventListener('change', () => {
        state.days = Number(days.value) || 7;
        AppShell.nav('board');
      });
    }

    // 新建
    const add = pageEl.querySelector('#boardNew');
    if (add) add.addEventListener('click', () => window.Pages.plans.openEditor(null));

    // 勾选
    window.UI.delegate(pageEl, '[data-toggle]', 'click', async (ev, btn) => {
      ev.preventDefault();
      try {
        await window.TaskRepo.toggle(btn.dataset.toggle);
        AppShell.nav('board');
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });

    // 编辑
    window.UI.delegate(pageEl, '[data-kedit]', 'click', async (ev, btn) => {
      ev.preventDefault();
      try {
        const t = await window.TaskRepo.get(btn.dataset.kedit);
        if (t) window.Pages.plans.openEditor(t);
        else window.UI.toast('该任务可能已被删除', 'warn');
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });

    bindKanbanDnD(pageEl);
  }

  /** 看板拖拽：卡片拖到别的列 → 改状态 */
  function bindKanbanDnD(pageEl) {
    let dragging = null;

    window.UI.delegate(pageEl, '[data-card]', 'dragstart', (ev, card) => {
      dragging = card;
      card.classList.add('is-drag');
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', card.dataset.card || '');
      } catch (_) {}
    });

    window.UI.delegate(pageEl, '[data-card]', 'dragend', (ev, card) => {
      card.classList.remove('is-drag');
      window.UI.$$('.kcol__body.is-over', pageEl).forEach(c => c.classList.remove('is-over'));
      dragging = null;
    });

    window.UI.delegate(pageEl, '[data-drop]', 'dragover', (ev, body) => {
      if (!dragging) return;
      ev.preventDefault();
      body.classList.add('is-over');
    });

    window.UI.delegate(pageEl, '[data-drop]', 'dragleave', (ev, body) => {
      body.classList.remove('is-over');
    });

    window.UI.delegate(pageEl, '[data-drop]', 'drop', async (ev, body) => {
      ev.preventDefault();
      body.classList.remove('is-over');
      if (!dragging) return;

      const taskId = Number(dragging.dataset.card);
      const target = body.dataset.drop;
      if (!taskId || !target) return;

      try {
        // 复用 toggle 会来回切，这里直接按目标状态写
        const t = await window.TaskRepo.get(taskId);
        if (!t) return;
        if (t.status === target) return;

        await window.TaskRepo.save(Object.assign({}, t, {
          id: taskId,
          status: target,
        }));
        window.UI.toast('状态已改为「' + window.Schema.label('taskStatus', target) + '」', 'ok');
        AppShell.nav('board');
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });
  }

  window.Pages.board = { render, bind, state };
})();
