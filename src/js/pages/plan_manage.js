/* ============================================================
 * pages/plan_manage.js —— 计划管理
 *
 * 对应 PHP 版 views/plan_manage.php（355 行）
 *
 * 与「任务计划」的区别：
 *   任务计划管具体某天做什么；计划管理管"某个目标/项目"，
 *   计划下面挂任务（plan_tasks.plan_id）。
 * ============================================================ */

(function () {
  'use strict';

  const h = () => window.UI.html;
  const e = () => window.UI.escape;

  const state = {
    type: '',
    status: '',
    includeArchived: false,
    search: '',
    page: 1,
  };

  async function render(ctx) {
    const q = ctx.query || {};

    if (q.goto && q.goto.indexOf('plan:') === 0) {
      const pid = Number(q.goto.split(':')[1]);
      ctx.query = {};
      setTimeout(async () => {
        try {
          const p = await window.PlanRepo.get(pid);
          if (p) openEditor(p);
          else window.UI.toast('该计划可能已被删除', 'warn');
        } catch (err) {
          window.UI.toast(window.Errors.normalize(err).message, 'err');
        }
      }, 120);
    }

    const data = await window.PlanRepo.list({
      type: state.type || undefined,
      status: state.status || undefined,
      include_archived: state.includeArchived,
      search: state.search || undefined,
      page: state.page,
    });

    return h()`
      <section class="card card--tight">
        <div class="card__h">
          <h3>计划 <span class="card__n">${data.total}</span></h3>
          <div class="row" style="gap:8px">
            <button class="btn btn--sm" id="exportPlans" type="button">导出 CSV</button>
            <button class="btn btn--primary btn--sm" id="newPlan" type="button">+ 新建计划</button>
          </div>
        </div>
        <div class="toolbar">
          <input class="input input--sm" id="pSearch" placeholder="搜索计划标题/描述" value="${e()(state.search)}">
          <select class="input input--sm" id="pType">
            <option value="">全部类型</option>
            ${window.Schema.ENUMS.planType.map(t => h()`
              <option value="${t}" ${state.type === t ? 'selected' : ''}>${window.Schema.label('planType', t)}</option>`)}
          </select>
          <select class="input input--sm" id="pStatus">
            <option value="">全部状态</option>
            ${window.Schema.ENUMS.taskStatus.map(s => h()`
              <option value="${s}" ${state.status === s ? 'selected' : ''}>${window.Schema.label('taskStatus', s)}</option>`)}
          </select>
          <label class="check">
            <input type="checkbox" id="pArchived" ${state.includeArchived ? 'checked' : ''}>
            <span>含归档</span>
          </label>
        </div>
      </section>

      <section class="plan-grid">
        ${data.items.length ? data.items.map(p => renderCard(p)) : window.UI.empty('还没有计划。计划可以是一个项目、一个目标，用来归拢下面的一组任务。')}
      </section>

      <div id="planPager"></div>
    `;
  }

  function renderCard(p) {
    return h()`
      <article class="plancard ${p.archived ? 'plancard--archived' : ''}">
        <header class="plancard__h">
          <span class="pill pill--${e()(p.type)}">${e()(p.type_name)}</span>
          <span class="pill pill--${e()(p.status)}">${e()(p.status_name)}</span>
          ${p.archived ? h()`<span class="pill pill--low">已归档</span>` : ''}
          <span class="plancard__p">${p.progress || 0}%</span>
        </header>
        <h3 class="plancard__t">${e()(p.title)}</h3>
        ${p.description ? h()`<p class="plancard__d">${e()(window.Validate.clip(p.description, 90))}</p>` : ''}
        <div class="plancard__bar"><div class="plancard__fill" style="width:${p.progress || 0}%"></div></div>
        <div class="plancard__meta">
          <span>${e()(p.level_name)}</span>
          <span>任务 ${p.task_done}/${p.task_total}</span>
          <span>${e()(p.creator_name)}</span>
          ${p.start_date ? h()`<span>${e()(p.start_date)}${p.end_date ? ' ~ ' + e()(p.end_date) : ''}</span>` : ''}
        </div>
        <footer class="plancard__f">
          <button class="btn btn--sm btn--ghost" data-pedit="${p.id}" type="button">编辑</button>
          <button class="btn btn--sm btn--ghost" data-ptasks="${p.id}" type="button">看任务</button>
          <button class="btn btn--sm btn--ghost" data-parchive="${p.id}" type="button">${p.archived ? '取消归档' : '归档'}</button>
          <button class="btn btn--sm btn--danger" data-pdel="${p.id}" type="button">删除</button>
        </footer>
      </article>`;
  }

  /* ============================================================
   * 编辑器
   * ============================================================ */

  function openEditor(plan) {
    const isNew = !plan;
    const base = plan || {
      type: 'personal', level: 'week', status: 'pending',
      start_date: window.Validate.today(),
      end_date: window.Validate.addDays(window.Validate.today(), 7),
      priority: 'medium', progress: 0,
    };

    const body = window.UI.el('div', { class: 'form' });
    const errBox = window.UI.el('p', { class: 'fld__err' });

    const titleIn = window.UI.input('title', base.title || '', { maxlength: 255, required: 'required' });
    body.appendChild(window.UI.field('计划标题', titleIn, { wide: true, required: true }));

    const typeSel = window.UI.enumSelect('type', 'planType', base.type || 'personal');
    body.appendChild(window.UI.field('类型', typeSel, {}));

    const levelSel = window.UI.enumSelect('level', 'planLevel', base.level || 'week');
    body.appendChild(window.UI.field('层级', levelSel, {}));

    const stSel = window.UI.enumSelect('status', 'taskStatus', base.status || 'pending');
    body.appendChild(window.UI.field('状态', stSel, {}));

    const priSel = window.UI.enumSelect('priority', 'priority', base.priority || 'medium');
    body.appendChild(window.UI.field('优先级', priSel, {}));

    const startIn = window.UI.input('start_date', base.start_date || '', { type: 'date' });
    body.appendChild(window.UI.field('开始日期', startIn, {}));

    const endIn = window.UI.input('end_date', base.end_date || '', { type: 'date' });
    body.appendChild(window.UI.field('结束日期', endIn, {}));

    const progWrap = window.UI.el('div', { class: 'rangenum' }, [
      (() => {
        const r = window.UI.el('input', { type: 'range', min: 0, max: 100, step: 5, value: String(base.progress || 0), class: 'range' });
        return r;
      })(),
      (() => {
        const n = window.UI.el('input', { type: 'number', min: 0, max: 100, value: String(base.progress || 0), class: 'input input--num' });
        return n;
      })(),
      window.UI.el('span', { class: 'muted', text: '%' }),
    ]);
    const rangeEl = progWrap.children[0];
    const numEl = progWrap.children[1];
    rangeEl.addEventListener('input', () => { numEl.value = rangeEl.value; });
    numEl.addEventListener('input', () => {
      const v = Math.max(0, Math.min(100, Number(numEl.value) || 0));
      rangeEl.value = String(v);
    });
    body.appendChild(window.UI.field('进度', progWrap, {}));

    const descIn = window.UI.textarea('description', base.description || '', { rows: 4, maxlength: 20000 });
    body.appendChild(window.UI.field('描述', descIn, { wide: true }));

    body.appendChild(errBox);

    const m = window.UI.modal({
      title: isNew ? '新建计划' : '编辑计划',
      body,
      width: 'lg',
      footer: [
        !isNew ? window.UI.el('button', {
          class: 'btn btn--danger', type: 'button', text: '删除', style: { marginRight: 'auto' },
          onclick: async () => {
            const go = await window.UI.confirm(
              '删除计划不会删除它下面的任务（任务会变成"未关联计划"）。确定删除？',
              { danger: true, okText: '删除' }
            );
            if (!go) return;
            try {
              const r = await window.PlanRepo.remove(base.id);
              m.close();
              window.UI.toast('已删除' + (r.detached_tasks ? `，${r.detached_tasks} 条任务已解除关联` : ''), 'ok');
              AppShell.nav('plan_manage');
            } catch (err) {
              window.UI.toast(window.Errors.normalize(err).message, 'err');
            }
          },
        }) : null,
        window.UI.el('button', { class: 'btn', type: 'button', text: '取消', onclick: () => m.close() }),
        window.UI.el('button', {
          class: 'btn btn--primary', type: 'button', text: '保存',
          onclick: async () => {
            errBox.textContent = '';
            try {
              await window.UI.withBusy(() => window.PlanRepo.save({
                id: base.id || 0,
                title: titleIn.value,
                type: typeSel.value,
                level: levelSel.value,
                status: stSel.value,
                priority: priSel.value,
                start_date: startIn.value,
                end_date: endIn.value,
                progress: Number(numEl.value) || 0,
                description: descIn.value,
              }), { tag: 'plan:save' });
              m.close();
              window.UI.toast(isNew ? '计划已创建' : '已保存', 'ok');
              AppShell.nav('plan_manage');
            } catch (err) {
              const nerr = window.Errors.normalize(err);
              errBox.textContent = nerr.message;
            }
          },
        }),
      ],
    });

    setTimeout(() => titleIn.focus(), 60);
  }

  /* ============================================================ */

  function bind(pageEl) {
    const nav = () => AppShell.nav('plan_manage');

    const add = pageEl.querySelector('#newPlan');
    if (add) add.addEventListener('click', () => openEditor(null));

    const search = pageEl.querySelector('#pSearch');
    if (search) {
      search.addEventListener('input', window.UI.debounce(() => {
        state.search = search.value.trim();
        state.page = 1;
        nav().then(() => {
          const s = document.getElementById('pSearch');
          if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
        });
      }, 320));
    }

    const bindSel = (id, key) => {
      const el = pageEl.querySelector(id);
      if (!el) return;
      el.addEventListener('change', () => {
        state[key] = el.value;
        state.page = 1;
        nav();
      });
    };
    bindSel('#pType', 'type');
    bindSel('#pStatus', 'status');

    const arch = pageEl.querySelector('#pArchived');
    if (arch) {
      arch.addEventListener('change', () => {
        state.includeArchived = arch.checked;
        nav();
      });
    }

    // 卡片操作
    window.UI.delegate(pageEl, '[data-pedit]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const p = await window.PlanRepo.get(btn.dataset.pedit);
      if (p) openEditor(p);
    });

    window.UI.delegate(pageEl, '[data-ptasks]', 'click', (ev, btn) => {
      ev.preventDefault();
      window.Pages.plans.state.search = '';
      const p = window.PlanRepo.get(btn.dataset.ptasks);
      // 跳到任务页并按计划筛选（通过 query 传递）
      location.hash = '#plans';
      setTimeout(() => {
        window.UI.toast('已切到任务页，可用搜索定位该计划下的任务', 'info');
      }, 200);
      p.catch(() => {});
    });

    window.UI.delegate(pageEl, '[data-parchive]', 'click', async (ev, btn) => {
      ev.preventDefault();
      try {
        const r = await window.PlanRepo.archive(btn.dataset.parchive);
        window.UI.toast(r.archived ? '已归档' : '已取消归档', 'ok');
        nav();
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });

    window.UI.delegate(pageEl, '[data-pdel]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const go = await window.UI.confirm(
        '删除计划不会删除它下面的任务（任务会变成"未关联计划"）。确定删除？',
        { danger: true, okText: '删除' }
      );
      if (!go) return;
      try {
        const r = await window.PlanRepo.remove(btn.dataset.pdel);
        window.UI.toast('已删除' + (r.detached_tasks ? `，${r.detached_tasks} 条任务已解除关联` : ''), 'ok');
        nav();
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });

    // 导出
    const exp = pageEl.querySelector('#exportPlans');
    if (exp) {
      exp.addEventListener('click', async () => {
        try {
          const r = await window.ExportRepo.exportCsv('plans', { view: 'all' });
          window.FileIO.downloadText(r.content, r.filename, 'text/csv');
          window.UI.toast(`已导出 ${r.rows} 个计划`, 'ok');
        } catch (err) {
          window.UI.toast(window.Errors.normalize(err).message, 'err');
        }
      });
    }
  }

  window.Pages.plan_manage = { render, bind, openEditor };
})();
