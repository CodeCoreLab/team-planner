/* ============================================================
 * pages/plans.js —— 任务计划（最复杂的页面）
 *
 * 对应 PHP 版 views/plans.php（925 行）+ api/tasks.php
 *
 * 功能：
 *   - 日/周/月/季/年 五种视图切换与前后翻页
 *   - 分组列表（周视图按天、月视图按天、季/年按月份）
 *   - 筛选：状态、优先级、负责人、标签、关键词
 *   - 任务编辑器（含循环规则、协助人、标签、子任务）
 *   - 批量完成、拖拽排序
 *   - 导出 CSV
 * ============================================================ */

(function () {
  'use strict';

  const h = () => window.UI.html;
  const e = () => window.UI.escape;
  const raw = (x) => window.UI.raw(x);

  // 页面内状态（跨渲染保留）
  const state = {
    view: 'week',
    date: null,
    status: '',
    priority: '',
    assignee_id: '',
    tag: '',
    search: '',
    page: 1,
  };

  function ensureState() {
    if (!state.date) state.date = window.Validate.today();
  }

  async function render(ctx) {
    ensureState();
    const q = ctx.query || {};

    // 从全局搜索跳进来时带 goto=task:ID
    if (q.goto && q.goto.indexOf('task:') === 0) {
      const tid = Number(q.goto.split(':')[1]);
      ctx.query = {};
      setTimeout(async () => {
        try {
          const t = await window.TaskRepo.get(tid);
          if (t) openEditor(t);
          else window.UI.toast('该任务可能已被删除', 'warn');
        } catch (err) {
          window.UI.toast(window.Errors.normalize(err).message, 'err');
        }
      }, 120);
    }

    const [data, tagList, users] = await Promise.all([
      window.TaskRepo.list({
        view: state.view,
        date: state.date,
        status: state.status || undefined,
        assignee_id: state.assignee_id || undefined,
        tag: state.tag || undefined,
        search: state.search || undefined,
      }),
      window.Errors.guard(() => window.TaskRepo.allTags(), [], 'plans:tags'),
      window.Errors.guard(() => window.OrgRepo.userOptions(), [], 'plans:users'),
    ]);

    // 优先级过滤（前端做，因为 list 没暴露该参数）
    let items = data.items;
    if (state.priority) items = items.filter(t => t.priority === state.priority);

    return h()`
      ${renderToolbar(data)}
      ${renderSummary(data.stats)}
      <section class="card">
        ${items.length ? renderGroups(data.view, data.groups, items) : window.UI.empty(emptyText())}
      </section>
      ${renderFooterBar(items, tagList, users)}
    `;
  }

  function emptyText() {
    if (state.search) return '没有符合条件的任务，试试换个关键词';
    if (state.status || state.priority || state.assignee_id || state.tag) return '当前筛选条件下没有任务';
    return '这个时间段还没有任务。点右上角「新建任务」开始。';
  }

  function viewLabel(v) {
    return { day: '日', week: '周', month: '月', quarter: '季', year: '年' }[v] || v;
  }

  function renderToolbar(data) {
    const views = ['day', 'week', 'month', 'quarter', 'year'];
    const tabs = views.map(v => h()`
      <button class="tab ${state.view === v ? 'tab--on' : ''}" data-view="${v}" type="button">${viewLabel(v)}</button>`).join('');

    const periodText = data.start === data.end
      ? data.start
      : `${data.start} ~ ${data.end}`;

    return h()`
      <section class="card card--tight">
        <div class="card__h">
          <div class="tabs">${tabs}</div>
          <div class="row" style="gap:6px">
            <button class="btn btn--sm" id="prevPeriod" type="button" title="上一期">←</button>
            <button class="btn btn--sm" id="todayBtn" type="button">今天</button>
            <button class="btn btn--sm" id="nextPeriod" type="button" title="下一期">→</button>
            <button class="btn btn--primary btn--sm" id="newTask" type="button">+ 新建任务</button>
          </div>
        </div>
        <div class="toolbar">
          <span class="toolbar__period">${e()(periodText)}</span>
          <input class="input input--sm" id="fSearch" placeholder="搜索标题/描述/标签" value="${e()(state.search)}">
          <select class="input input--sm" id="fStatus">
            <option value="">全部状态</option>
            ${window.Schema.ENUMS.taskStatus.map(s => h()`
              <option value="${s}" ${state.status === s ? 'selected' : ''}>${window.Schema.label('taskStatus', s)}</option>`).join('')}
          </select>
          <select class="input input--sm" id="fPriority">
            <option value="">全部优先级</option>
            ${window.Schema.ENUMS.priority.map(p => h()`
              <option value="${p}" ${state.priority === p ? 'selected' : ''}>${window.Schema.label('priority', p)}</option>`).join('')}
          </select>
          <button class="btn btn--sm btn--ghost" id="fClear" type="button">清除筛选</button>
        </div>
      </section>`;
  }

  function renderSummary(stats) {
    if (!stats || !stats.total) return '';
    const bar = (label, n, cls) => {
      const pct = stats.total ? Math.round(n / stats.total * 100) : 0;
      return h()`
        <div class="minibar">
          <span class="minibar__l">${label}</span>
          <div class="minibar__t"><div class="minibar__f minibar__f--${cls}" style="width:${pct}%"></div></div>
          <span class="minibar__n">${n}</span>
        </div>`;
    };
    return h()`
      <section class="card card--tight">
        <div class="card__h">
          <h3>本${viewLabel(state.view)}期 <span class="card__n">${stats.total}</span></h3>
          <span class="muted">完成率 ${stats.rate}%</span>
        </div>
        <div class="minibars">
          ${bar('待开始', stats.pending, 'pending')}
          ${bar('进行中', stats.in_progress, 'progress')}
          ${bar('已完成', stats.done, 'done')}
          ${bar('已延期', stats.delayed, 'delayed')}
        </div>
      </section>`;
  }

  function renderGroups(view, groups, items) {
    // 只渲染有内容的分组（日视图/周视图保留空天以便看出分布）
    const keepEmpty = view === 'day' || view === 'week';

    return groups.map(g => {
      const list = g.items || [];
      if (!list.length && !keepEmpty) return '';

      const head = h()`
        <div class="grouphead ${g.is_weekend ? 'grouphead--we' : ''} ${g.is_today ? 'grouphead--today' : ''}">
          <strong>${e()(g.label || g.key)}</strong>
          ${g.weekday ? h()`<span class="grouphead__w">${e()(g.weekday)}</span>` : ''}
          <span class="grouphead__n">${list.length}</span>
        </div>`;

      if (!list.length) {
        return h()`${head}<div class="groupempty">无任务</div>`;
      }

      return h()`${head}${list.map(t => renderTaskRow(t)).join('')}`;
    }).join('');
  }

  function renderTaskRow(t) {
    const done = t.status === 'completed';
    return h()`
      <div class="row ${done ? 'row--done' : ''} ${t.is_overdue ? 'row--overdue' : ''}"
           data-task="${t.id}" draggable="true">
        <span class="grip" title="拖动排序">⋮⋮</span>
        <button class="chk ${done ? 'chk--on' : ''}" data-toggle="${t.id}" type="button"
                title="切换完成">${done ? '✓' : ''}</button>
        <span class="row__slot">${e()(t.time_slot || '')}</span>
        <span class="row__t">${e()(t.title)}</span>
        ${t.is_instance ? h()`<span class="tag tag--rec" title="循环任务实例">循环</span>` : ''}
        ${t.is_template ? h()`<span class="tag tag--rec" title="循环任务模板（${e()(t.recurrence_name)}）">${e()(t.recurrence_name)}</span>` : ''}
        ${t.subtask_total ? h()`<span class="row__sub">${t.subtask_done}/${t.subtask_total}</span>` : ''}
        ${(t.tags || []).slice(0, 3).map(g => h()`<span class="tag">${e()(g)}</span>`).join('')}
        ${t.assignee_name ? h()`<span class="row__who">${e()(t.assignee_name)}</span>` : ''}
        <span class="pill pill--${e()(t.priority)}">${e()(t.priority_name)}</span>
        <span class="pill pill--${e()(t.status)}">${e()(t.status_name)}</span>
        <button class="btn btn--sm btn--ghost" data-edit="${t.id}" type="button">编辑</button>
        <button class="btn btn--sm btn--danger" data-del="${t.id}" type="button">删除</button>
      </div>`;
  }

  function renderFooterBar(items, tagList, users) {
    const pend = items.filter(t => t.status !== 'completed');

    return h()`
      <section class="card card--tight">
        <div class="row row--between row--wrap" style="gap:10px">
          <div class="row" style="gap:8px">
            <button class="btn btn--sm" id="bulkDoneAll" type="button"
              ${pend.length ? '' : 'disabled'}>全部标记完成（${pend.length}）</button>
            <button class="btn btn--sm" id="exportCsv" type="button">导出 CSV</button>
          </div>
          <div class="row" style="gap:8px">
            ${tagList.length ? h()`
              <select class="input input--sm" id="fTag">
                <option value="">全部标签</option>
                ${tagList.map(x => h()`<option value="${e()(x.tag)}" ${state.tag === x.tag ? 'selected' : ''}>${e()(x.tag)} (${x.count})</option>`).join('')}
              </select>` : ''}
            ${users.length > 1 ? h()`
              <select class="input input--sm" id="fAssignee">
                <option value="">全部负责人</option>
                ${users.map(u => h()`<option value="${u.id}" ${String(state.assignee_id) === String(u.id) ? 'selected' : ''}>${e()(u.name)}</option>`).join('')}
              </select>` : ''}
          </div>
        </div>
      </section>`;
  }

  /* ============================================================
   * 任务编辑器
   * ============================================================ */

  /**
   * 打开任务编辑框
   * @param {object|null} task  已有任务（null = 新建）
   * @param {object} defaults   新建时的预设（如 task_date）
   */
  async function openEditor(task, defaults) {
    const isNew = !task;
    const base = task || Object.assign({
      task_date: window.Validate.today(),
      priority: 'medium',
      status: 'pending',
      recurrence: 'none',
      time_slot: window.Settings.periodNames()[0] || '上午',
    }, defaults || {});

    const [users, plans] = await Promise.all([
      window.Errors.guard(() => window.OrgRepo.userOptions(), [], 'editor:users'),
      window.Errors.guard(() => window.PlanRepo.options(), [], 'editor:plans'),
    ]);

    const body = window.UI.el('div', { class: 'form' });
    const errBox = window.UI.el('p', { class: 'fld__err' });
    let subtaskBox = null;

    // 标题
    const titleIn = window.UI.input('title', base.title || '', {
      maxlength: 255, placeholder: '要做什么？', required: 'required',
    });
    body.appendChild(window.UI.field('任务标题', titleIn, { wide: true, required: true }));

    // 日期 + 时段
    const dateIn = window.UI.input('task_date', base.task_date || window.Validate.today(), { type: 'date' });
    body.appendChild(window.UI.field('日期', dateIn, { required: true }));

    const slotSel = window.UI.select('time_slot', window.Settings.periodNames(), base.time_slot || '上午');
    body.appendChild(window.UI.field('时段', slotSel, {}));

    // 开始/结束时间
    const startIn = window.UI.input('start_time', base.start_time || '', { type: 'time' });
    body.appendChild(window.UI.field('开始时间', startIn, { hint: '可选' }));

    const endIn = window.UI.input('end_time', base.end_time || '', { type: 'time' });
    body.appendChild(window.UI.field('结束时间', endIn, { hint: '可选' }));

    // 结束日期（跨天任务）
    const endDateIn = window.UI.input('end_date', base.end_date || '', { type: 'date' });
    body.appendChild(window.UI.field('结束日期', endDateIn, { hint: '跨天任务才填' }));

    // 优先级
    const priSel = window.UI.enumSelect('priority', 'priority', base.priority || 'medium');
    body.appendChild(window.UI.field('优先级', priSel, {}));

    // 状态
    const stSel = window.UI.enumSelect('status', 'taskStatus', base.status || 'pending');
    body.appendChild(window.UI.field('状态', stSel, {}));

    // 负责人
    const asgSel = window.UI.select('assignee_id',
      [{ value: '', label: '（我自己）' }].concat(users.map(u => ({ value: u.id, label: u.name }))),
      base.assignee_id || ''
    );
    body.appendChild(window.UI.field('负责人', asgSel, {}));

    // 所属计划
    const planSel = window.UI.select('plan_id',
      [{ value: '', label: '（不关联）' }].concat(plans.map(p => ({ value: p.id, label: p.title }))),
      base.plan_id || ''
    );
    body.appendChild(window.UI.field('所属计划', planSel, {}));

    // 标签
    const tagIn = window.UI.input('tags', (base.tags || []).join(','), {
      maxlength: 300, placeholder: '多个用逗号分隔',
    });
    body.appendChild(window.UI.field('标签', tagIn, { hint: '最多 10 个，每个不超过 32 字' }));

    // 协助人（多选，用 checkbox 列表）
    const coWrap = window.UI.el('div', { class: 'checks' });
    const coIds = base.co_assignees || [];
    for (const u of users) {
      if (String(u.id) === String(base.assignee_id)) continue;  // 负责人不用勾
      const cid = 'co_' + u.id;
      const cb = window.UI.el('input', { type: 'checkbox', id: cid, value: String(u.id) });
      if (coIds.indexOf(Number(u.id)) >= 0) cb.checked = true;
      coWrap.appendChild(window.UI.el('label', { class: 'check', for: cid }, [cb, window.UI.el('span', { text: u.name })]));
    }
    if (users.length > 1) {
      body.appendChild(window.UI.field('协助人', coWrap, { wide: true, hint: '被协助人也能看到并编辑这个任务' }));
    }

    // 循环规则（仅模板可设）
    const recSel = window.UI.enumSelect('recurrence', 'recurrence', base.recurrence || 'none');
    const recEndIn = window.UI.input('recurrence_end_date', base.recurrence_end_date || '', { type: 'date' });
    const recWrap = window.UI.el('div', { class: 'row', style: { gap: '8px' } }, [
      recSel, recEndIn,
    ]);

    if (!isNew && base.is_instance) {
      // 编辑实例时循环规则也可改（会同步回模板）
      body.appendChild(window.UI.field('循环规则', recWrap, {
        wide: true, hint: '改这里会影响整条循环链；留空结束日期则默认生成 60 天',
      }));
    } else {
      body.appendChild(window.UI.field('循环规则', recWrap, {
        wide: true, hint: '设为"每天/每周/每月"会自动生成后续实例；结束日期留空则默认 60 天',
      }));
    }

    // 描述
    const descIn = window.UI.textarea('description', base.description || '', { rows: 3, maxlength: 20000 });
    body.appendChild(window.UI.field('描述', descIn, { wide: true }));

    // 子任务（仅编辑已有任务时显示）
    if (!isNew) {
      subtaskBox = window.UI.el('div', { class: 'subs' });
      const subList = base.subtask_items || [];
      if (subList.length) {
        for (const s of subList) {
          const row = window.UI.el('div', { class: 'sub' }, [
            window.UI.el('button', {
              class: 'chk chk--sm ' + (s.done ? 'chk--on' : ''), type: 'button',
              text: s.done ? '✓' : '',
              onclick: async (ev) => {
                ev.preventDefault();
                await window.Errors.guard(() => window.TaskRepo.toggleSubtask(s.id), null, 'subtoggle');
                const fresh = await window.TaskRepo.get(base.id);
                if (fresh) { m.close(); openEditor(fresh); }
              },
            }),
            window.UI.el('span', { class: s.done ? 'row__t--done' : '', text: s.title }),
            window.UI.el('button', {
              class: 'btn btn--sm btn--ghost', type: 'button', text: '×',
              onclick: async (ev) => {
                ev.preventDefault();
                await window.Errors.guard(() => window.TaskRepo.deleteSubtask(s.id), null, 'subdel');
                const fresh = await window.TaskRepo.get(base.id);
                if (fresh) { m.close(); openEditor(fresh); }
              },
            }),
          ]);
          subtaskBox.appendChild(row);
        }
      } else {
        subtaskBox.appendChild(window.UI.el('p', { class: 'muted', text: '还没有子任务' }));
      }

      const subIn = window.UI.input('newSubtask', '', { placeholder: '加一条子任务', maxlength: 255 });
      const subAdd = window.UI.el('button', {
        class: 'btn btn--sm', type: 'button', text: '添加',
        onclick: async (ev) => {
          ev.preventDefault();
          const v = subIn.value.trim();
          if (!v) return;
          try {
            await window.TaskRepo.saveSubtask(base.id, v);
            const fresh = await window.TaskRepo.get(base.id);
            if (fresh) { m.close(); openEditor(fresh); }
          } catch (err) {
            window.UI.toast(window.Errors.normalize(err).message, 'err');
          }
        },
      });

      body.appendChild(window.UI.field('子任务', window.UI.el('div', {}, [
        subtaskBox,
        window.UI.el('div', { class: 'sub-add' }, [subIn, subAdd]),
      ]), { wide: true }));
    }

    body.appendChild(errBox);

    const m = window.UI.modal({
      title: isNew ? '新建任务' : '编辑任务',
      body,
      width: 'lg',
      footer: [
        !isNew ? window.UI.el('button', {
          class: 'btn btn--danger', type: 'button', text: '删除',
          style: { marginRight: 'auto' },
          onclick: async () => {
            const go = await window.UI.confirm('确定删除这条任务？' + (base.is_template ? '（会连带删除生成的循环实例）' : ''), {
              danger: true, okText: '删除',
            });
            if (!go) return;
            try {
              await window.TaskRepo.remove(base.id, false);
              m.close();
              window.UI.toast('已删除', 'ok');
              AppShell.nav('plans');
            } catch (err) {
              window.UI.toast(window.Errors.normalize(err).message, 'err');
            }
          },
        }) : null,
        window.UI.el('button', { class: 'btn', type: 'button', text: '取消', onclick: () => m.close() }),
        window.UI.el('button', {
          class: 'btn btn--primary', type: 'button', text: '保存',
          onclick: () => doSave(),
        }),
      ],
    });

    async function doSave() {
      errBox.textContent = '';

      const co = [];
      window.UI.$$('input[type=checkbox]', coWrap).forEach(cb => {
        if (cb.checked) co.push(Number(cb.value));
      });

      const payload = {
        id: base.id || 0,
        title: titleIn.value,
        task_date: dateIn.value,
        time_slot: slotSel.value,
        start_time: startIn.value,
        end_time: endIn.value,
        end_date: endDateIn.value,
        priority: priSel.value,
        status: stSel.value,
        assignee_id: asgSel.value,
        plan_id: planSel.value,
        tags: tagIn.value,
        co_assignees: co,
        recurrence: recSel.value,
        recurrence_end_date: recEndIn.value,
        description: descIn.value,
      };

      try {
        await window.UI.withBusy(() => window.TaskRepo.save(payload), { tag: 'task:save' });
        m.close();
        window.UI.toast(isNew ? '任务已创建' : '已保存', 'ok');
        await AppShell.nav('plans');
      } catch (err) {
        const nerr = window.Errors.normalize(err);
        errBox.textContent = nerr.message;
        if (nerr.field) {
          const f = window.UI.$('[name="' + nerr.field + '"]', body);
          if (f) f.focus();
        }
      }
    }

    setTimeout(() => titleIn.focus(), 60);
  }

  /* ============================================================
   * 事件绑定
   * ============================================================ */

  function bind(pageEl) {
    // 视图切换
    window.UI.delegate(pageEl, '[data-view]', 'click', (ev, btn) => {
      state.view = btn.dataset.view;
      state.page = 1;
      AppShell.nav('plans');
    });

    // 前后翻页
    const prev = pageEl.querySelector('#prevPeriod');
    const next = pageEl.querySelector('#nextPeriod');
    const todayBtn = pageEl.querySelector('#todayBtn');

    const shift = (dir) => {
      const stepMap = { day: 1, week: 7, month: 30, quarter: 91, year: 365 };
      const step = (stepMap[state.view] || 7) * dir;
      state.date = window.Validate.addDays(state.date, step);
      AppShell.nav('plans');
    };

    if (prev) prev.addEventListener('click', () => shift(-1));
    if (next) next.addEventListener('click', () => shift(1));
    if (todayBtn) todayBtn.addEventListener('click', () => {
      state.date = window.Validate.today();
      AppShell.nav('plans');
    });

    // 新建
    const add = pageEl.querySelector('#newTask');
    if (add) add.addEventListener('click', () => openEditor(null, { task_date: state.date }));

    // 搜索（防抖）
    const search = pageEl.querySelector('#fSearch');
    if (search) {
      search.addEventListener('input', window.UI.debounce(() => {
        state.search = search.value.trim();
        AppShell.nav('plans').then(() => {
          const s = document.getElementById('fSearch');
          if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
        });
      }, 320));
    }

    // 状态 / 优先级 / 标签 / 负责人
    const bindSelect = (id, key) => {
      const el = pageEl.querySelector(id);
      if (!el) return;
      el.addEventListener('change', () => {
        state[key] = el.value;
        AppShell.nav('plans');
      });
    };
    bindSelect('#fStatus', 'status');
    bindSelect('#fPriority', 'priority');
    bindSelect('#fTag', 'tag');
    bindSelect('#fAssignee', 'assignee_id');

    // 清除筛选
    const clear = pageEl.querySelector('#fClear');
    if (clear) {
      clear.addEventListener('click', () => {
        state.status = ''; state.priority = ''; state.tag = '';
        state.assignee_id = ''; state.search = '';
        AppShell.nav('plans');
      });
    }

    // 勾选完成
    window.UI.delegate(pageEl, '[data-toggle]', 'click', async (ev, btn) => {
      ev.preventDefault();
      try {
        await window.TaskRepo.toggle(btn.dataset.toggle);
        AppShell.nav('plans');
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });

    // 编辑
    window.UI.delegate(pageEl, '[data-edit]', 'click', async (ev, btn) => {
      ev.preventDefault();
      try {
        const t = await window.TaskRepo.get(btn.dataset.edit);
        if (t) openEditor(t);
        else window.UI.toast('该任务可能已被删除', 'warn');
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });

    // 删除
    window.UI.delegate(pageEl, '[data-del]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const go = await window.UI.confirm('确定删除这条任务？', { danger: true, okText: '删除' });
      if (!go) return;
      try {
        await window.TaskRepo.remove(btn.dataset.del, false);
        window.UI.toast('已删除', 'ok');
        AppShell.nav('plans');
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });

    // 全部完成
    const bulkAll = pageEl.querySelector('#bulkDoneAll');
    if (bulkAll) {
      bulkAll.addEventListener('click', async () => {
        const pend = window.UI.$$('[data-toggle]', pageEl)
          .filter(b => !b.classList.contains('chk--on'))
          .map(b => Number(b.dataset.toggle)).filter(n => n > 0);
        if (!pend.length) return;
        const go = await window.UI.confirm(`把当前列表里 ${pend.length} 条未完成任务全部标为完成？`);
        if (!go) return;
        try {
          await window.TaskRepo.bulkComplete(pend, true);
          window.UI.toast('已全部完成', 'ok');
          AppShell.nav('plans');
        } catch (err) {
          window.UI.toast(window.Errors.normalize(err).message, 'err');
        }
      });
    }

    // 导出
    const exp = pageEl.querySelector('#exportCsv');
    if (exp) {
      exp.addEventListener('click', async () => {
        try {
          const r = await window.ExportRepo.exportCsv('tasks', { view: state.view, date: state.date });
          window.FileIO.downloadText(r.content, r.filename, 'text/csv');
          window.UI.toast(`已导出 ${r.rows} 条任务`, 'ok');
        } catch (err) {
          window.UI.toast(window.Errors.normalize(err).message, 'err');
        }
      });
    }

    bindDrag(pageEl);
  }

  /** 拖拽排序（HTML5 DnD，桌面端可用；移动端不启用） */
  function bindDrag(pageEl) {
    let dragging = null;

    window.UI.delegate(pageEl, '.row[draggable]', 'dragstart', (ev, row) => {
      dragging = row;
      row.classList.add('is-drag');
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', row.dataset.task || '');
      } catch (_) {}
    });

    window.UI.delegate(pageEl, '.row[draggable]', 'dragend', (ev, row) => {
      row.classList.remove('is-drag');
      window.UI.$$('.row.is-over', pageEl).forEach(r => r.classList.remove('is-over'));
      dragging = null;
    });

    window.UI.delegate(pageEl, '.row[draggable]', 'dragover', (ev, row) => {
      if (!dragging || dragging === row) return;
      ev.preventDefault();
      row.classList.add('is-over');
    });

    window.UI.delegate(pageEl, '.row[draggable]', 'dragleave', (ev, row) => {
      row.classList.remove('is-over');
    });

    window.UI.delegate(pageEl, '.row[draggable]', 'drop', async (ev, row) => {
      ev.preventDefault();
      row.classList.remove('is-over');
      if (!dragging || dragging === row) return;

      const fromId = Number(dragging.dataset.task);
      const toId = Number(row.dataset.task);
      if (!fromId || !toId) return;

      // 用当前 DOM 顺序算出新次序，交给 repo 落库
      const order = window.UI.$$('.row[draggable]', pageEl).map(r => Number(r.dataset.task)).filter(n => n > 0);
      const fi = order.indexOf(fromId);
      const ti = order.indexOf(toId);
      if (fi < 0 || ti < 0) return;
      order.splice(fi, 1);
      order.splice(ti, 0, fromId);

      try {
        await window.TaskRepo.reorder(order);
        AppShell.nav('plans');
      } catch (err) {
        window.UI.toast('排序保存失败：' + window.Errors.normalize(err).message, 'err');
      }
    });
  }

  window.Pages.plans = { render, bind, openEditor, openTaskEditor: openEditor, state };
})();
