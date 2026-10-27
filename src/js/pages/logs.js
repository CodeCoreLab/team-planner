/* ============================================================
 * pages/logs.js —— 工作日志
 *
 * 对应 PHP 版 views/logs.php（633 行）+ api/logs.php
 *
 * 功能：
 *   - 日报 / 周报 / 月报三种类型
 *   - 一键汇总任务填入日志（task_summary）
 *   - 提交日历（近 5 周，色块表示写过没）
 *   - 统计：总数、连续天数、平均字数
 *   - 点评（有权限的人可评，带等级）
 *   - 同一天同类型自动去重（写了就覆盖）
 * ============================================================ */

(function () {
  'use strict';

  const h = () => window.UI.html;
  const e = () => window.UI.escape;
  const raw = (x) => window.UI.raw(x);

  const state = {
    type: 'daily',
    range: 'month',
    date: null,
    mine: false,
    search: '',
    page: 1,
    editingId: 0,
  };

  function ensure() {
    if (!state.date) state.date = window.Validate.today();
  }

  async function render(ctx) {
    ensure();
    const q = ctx.query || {};

    if (q.goto && q.goto.indexOf('log:') === 0) {
      const lid = Number(q.goto.split(':')[1]);
      ctx.query = {};
      setTimeout(() => openEditor(lid), 120);
    }

    const [data, stats, cal, todayLog] = await Promise.all([
      window.LogRepo.list({
        type: state.type || undefined,
        range: state.range,
        date: state.date,
        mine: state.mine,
        search: state.search || undefined,
        page: state.page,
      }),
      window.Errors.guard(() => window.LogRepo.stats(), { total: 0, streak: 0, has_today: false, avg_length: 0 }, 'logs:stats'),
      window.Errors.guard(() => window.LogRepo.calendar(35), {}, 'logs:cal'),
      window.Errors.guard(() => window.LogRepo.findByDate(window.Validate.today(), 'daily'), null, 'logs:today'),
    ]);

    return h()`
      ${renderStats(stats, todayLog)}
      ${renderCalendar(cal)}
      ${renderToolbar(data)}
      <section class="card">
        ${data.items.length ? data.items.map(l => renderLogItem(l)).join('') : window.UI.empty(emptyText())}
      </section>
      <div id="logPager"></div>
    `;
  }

  function emptyText() {
    if (state.search) return '没有匹配的日志';
    if (state.mine) return '你这段时间还没写过日志';
    return '还没有日志。点右上角「写今天的日志」开始记录。';
  }

  function renderStats(stats, todayLog) {
    const card = (v, l, s) => h()`
      <div class="stat">
        <div class="stat__v">${v}</div>
        <div class="stat__l">${l}</div>
        ${s ? h()`<div class="stat__s">${s}</div>` : ''}
      </div>`;

    return h()`
      <section class="grid4">
        ${card(stats.total, '日志总数')}
        ${card(stats.streak + ' 天', '连续提交', stats.has_today ? '今天已写' : '今天还没写')}
        ${card(stats.avg_length, '平均字数')}
        ${card(stats.reviewed, '已点评')}
      </section>
      ${todayLog ? '' : h()`
        <section class="card card--warn card--tight">
          <div class="row row--between row--wrap">
            <span>今天还没有写日报。
              ${window.Settings.getBool('log_reminder', true) && window.Settings.isWorkDay(window.Validate.today())
                ? '（侧栏「工作日志」上的红色感叹号就是这个提醒）' : ''}</span>
            <div class="row" style="gap:8px">
              <button class="btn btn--ghost btn--sm" id="muteLogReminder" type="button"
                ${window.Settings.getBool('log_reminder', true) ? '' : 'hidden'}>不再提醒</button>
              <button class="btn btn--primary btn--sm" id="writeToday" type="button">现在写</button>
            </div>
          </div>
        </section>`}
    `;
  }

  function renderCalendar(cal) {
    const today = window.Validate.today();
    const days = [];
    for (let i = 34; i >= 0; i--) {
      const d = window.Validate.addDays(today, -i);
      days.push({ date: d, has: !!cal[d], count: cal[d] || 0, isToday: d === today });
    }

    // 补齐到整周（前面留空，视觉上按周对齐）
    const firstDow = window.Validate.dayOfWeek(days[0].date);   // 0=周日
    const pad = firstDow === 0 ? 6 : firstDow - 1;              // 让周一在左上
    const blanks = Array.from({ length: pad }, () => null);

    return h()`
      <section class="card card--tight">
        <div class="card__h"><h3>近 5 周提交情况</h3><span class="muted">深色 = 写过</span></div>
        <div class="cal">
          ${['一', '二', '三', '四', '五', '六', '日'].map(w => h()`<div class="cal__w">${w}</div>`).join('')}
          ${blanks.map(() => h()`<div class="cal__blank"></div>`).join('')}
          ${days.map(d => h()`
            <div class="cal__d ${d.has ? 'cal__d--on' : ''} ${d.isToday ? 'cal__d--today' : ''}"
                 title="${d.date}${d.has ? '（已写 ' + d.count + ' 篇）' : '（未写）'}">${Number(d.date.slice(8))}</div>`).join('')}
        </div>
      </section>`;
  }

  function renderToolbar(data) {
    return h()`
      <section class="card card--tight">
        <div class="card__h">
          <div class="tabs">
            ${window.Schema.ENUMS.logType.map(t => h()`
              <button class="tab ${state.type === t ? 'tab--on' : ''}" data-ltype="${t}" type="button">
                ${window.Schema.label('logType', t)}</button>`).join('')}
          </div>
          <div class="row" style="gap:8px">
            <button class="btn btn--sm" id="exportLogs" type="button">导出 CSV</button>
            <button class="btn btn--primary btn--sm" id="newLog" type="button">+ 写日志</button>
          </div>
        </div>
        <div class="toolbar">
          <select class="input input--sm" id="lRange">
            ${[['day', '今天'], ['week', '本周'], ['month', '本月'], ['quarter', '本季'], ['year', '今年']]
              .map(([v, l]) => h()`<option value="${v}" ${state.range === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <input class="input input--sm" id="lSearch" placeholder="搜索日志内容" value="${e()(state.search)}">
          <label class="check">
            <input type="checkbox" id="lMine" ${state.mine ? 'checked' : ''}>
            <span>只看我的</span>
          </label>
          <span class="muted">共 ${data.total} 篇</span>
        </div>
      </section>`;
  }

  function renderLogItem(l) {
    const statusPill = h()`<span class="pill pill--${e()(l.status)}">${e()(l.status_name)}</span>`;
    const reviews = l.reviews || [];

    return h()`
      <article class="logitem">
        <header class="logitem__h">
          <strong>${e()(l.date_range || '')}</strong>
          <span class="pill pill--${e()(l.type)}">${e()(l.type_name)}</span>
          ${l.title ? h()`<span class="logitem__t">${e()(l.title)}</span>` : ''}
          <span class="muted">${e()(l.owner_name)}</span>
          ${statusPill}
          <span class="muted">${l.content_length} 字</span>
          <div class="logitem__act">
            <button class="btn btn--sm btn--ghost" data-lview="${l.id}" type="button">查看</button>
            ${canEdit(l) ? h()`<button class="btn btn--sm btn--ghost" data-ledit="${l.id}" type="button">编辑</button>` : ''}
            ${window.Auth.can('logs', 'review') ? h()`
              <button class="btn btn--sm btn--ghost" data-lreview="${l.id}" type="button">点评</button>` : ''}
            ${canEdit(l) ? h()`<button class="btn btn--sm btn--danger" data-ldel="${l.id}" type="button">删除</button>` : ''}
          </div>
        </header>
        <div class="logitem__c">${e()(window.Validate.clip(l.content || '', 240))}</div>
        ${reviews.length ? h()`
          <div class="logitem__reviews">
            ${reviews.map(r => h()`
              <div class="review">
                <strong>${e()(r.reviewer_name)}</strong>
                ${r.level_name ? h()`<span class="pill pill--${r.level >= 3 ? 'completed' : r.level === 2 ? 'in_progress' : 'medium'}">${e()(r.level_name)}</span>` : ''}
                <span class="review__c">${e()(r.comment)}</span>
              </div>`).join('')}
          </div>` : ''}
      </article>`;
  }

  function canEdit(l) {
    const me = window.Auth.currentUser();
    if (Number(l.user_id) === Number(me.id)) return true;
    return window.Auth.can('logs', 'edit');
  }

  /* ============================================================
   * 编辑器
   * ============================================================ */

  async function openEditor(id) {
    let log = null;
    if (id) {
      log = await window.LogRepo.get(id);
      if (!log) {
        window.UI.toast('日志不存在或已被删除', 'err');
        return;
      }
    }

    // 新建默认带出今天已有日志（实现"写了就覆盖"）
    if (!log) {
      log = await window.LogRepo.findByDate(window.Validate.today(), state.type);
    }

    const isNew = !log;
    const base = log || {
      type: state.type,
      date_range: window.Validate.today(),
      content: '',
      status: 'draft',
    };

    const body = window.UI.el('div', { class: 'form' });
    const errBox = window.UI.el('p', { class: 'fld__err' });

    const typeSel = window.UI.enumSelect('type', 'logType', base.type || 'daily');
    body.appendChild(window.UI.field('类型', typeSel, {}));

    const dateIn = window.UI.input('date_range', base.date_range || window.Validate.today(), { type: 'date' });
    body.appendChild(window.UI.field('日期', dateIn, { required: true }));

    const titleIn = window.UI.input('title', base.title || '', { maxlength: 255, placeholder: '（可选）标题' });
    body.appendChild(window.UI.field('标题', titleIn, { wide: true }));

    const contentIn = window.UI.textarea('content', base.content || '', {
      rows: 12, maxlength: 50000, placeholder: '今天做了什么、遇到什么问题、明天打算做什么…',
    });
    body.appendChild(window.UI.field('内容', contentIn, { wide: true, required: true }));

    const stSel = window.UI.enumSelect('logStatus', 'logStatus', base.status || 'draft');
    body.appendChild(window.UI.field('状态', stSel, {}));

    // 一键汇总
    const summaryBtn = window.UI.el('button', {
      class: 'btn btn--sm', type: 'button', text: '汇总本期任务',
      onclick: async (ev) => {
        ev.preventDefault();
        try {
          const r = await window.LogRepo.taskSummary(typeSel.value, dateIn.value);
          const cur = contentIn.value.trim();
          if (cur && !(await window.UI.confirm('内容里已有文字，汇总结果会追加到末尾。继续？'))) return;
          contentIn.value = (cur ? cur + '\n\n' : '') + r.text;
          window.UI.toast(`已汇总 ${r.total} 个任务（完成 ${r.done}）`, 'ok');
        } catch (err) {
          window.UI.toast(window.Errors.normalize(err).message, 'err');
        }
      },
    });
    body.appendChild(window.UI.field('任务汇总', window.UI.el('div', {}, [
      summaryBtn,
      window.UI.el('span', { class: 'muted', text: ' 按当前类型和日期自动汇总你的任务' }),
    ]), { wide: true }));

    body.appendChild(errBox);

    const m = window.UI.modal({
      title: isNew ? '写日志' : '编辑日志',
      body,
      width: 'lg',
      footer: [
        window.UI.el('button', { class: 'btn', type: 'button', text: '取消', onclick: () => m.close() }),
        window.UI.el('button', {
          class: 'btn btn--primary', type: 'button', text: '保存',
          onclick: async () => {
            errBox.textContent = '';
            try {
              await window.UI.withBusy(() => window.LogRepo.save({
                id: base.id || 0,
                type: typeSel.value,
                date_range: dateIn.value,
                title: titleIn.value,
                content: contentIn.value,
                status: stSel.value,
              }), { tag: 'log:save' });
              m.close();
              window.UI.toast('日志已保存', 'ok');
              AppShell.nav('logs');
            } catch (err) {
              const nerr = window.Errors.normalize(err);
              errBox.textContent = nerr.message;
              if (nerr.field === 'content') contentIn.focus();
            }
          },
        }),
      ],
    });

    setTimeout(() => contentIn.focus(), 80);
  }

  /* ---------------- 查看 / 点评 ---------------- */

  async function openViewer(id) {
    const log = await window.LogRepo.get(id);
    if (!log) { window.UI.toast('日志不存在', 'err'); return; }

    const body = window.UI.el('div', {});
    body.innerHTML = h()`
      <div class="viewer__meta">
        <span class="pill pill--${e()(log.type)}">${e()(log.type_name)}</span>
        <strong>${e()(log.date_range || '')}</strong>
        ${log.title ? h()`<span>${e()(log.title)}</span>` : ''}
        <span class="muted">${e()(log.owner_name)}</span>
        <span class="pill pill--${e()(log.status)}">${e()(log.status_name)}</span>
      </div>
      ${log.task_summary ? h()`<pre class="viewer__summary">${e()(log.task_summary)}</pre>` : ''}
      <pre class="viewer__content">${e()(log.content || '')}</pre>
      ${(log.reviews || []).length ? h()`
        <div class="viewer__reviews">
          <h4>点评（${log.reviews.length}）</h4>
          ${log.reviews.map(r => h()`
            <div class="review">
              <strong>${e()(r.reviewer_name)}</strong>
              <span class="muted">${e()(r.created_at || '')}</span>
              <p>${e()(r.comment)}</p>
            </div>`).join('')}
        </div>` : ''}
    `;

    const m = window.UI.modal({
      title: '查看日志',
      body,
      width: 'lg',
      footer: [
        canEdit(log) ? window.UI.el('button', {
          class: 'btn', type: 'button', text: '编辑',
          onclick: () => { m.close(); openEditor(log.id); },
        }) : null,
        window.UI.el('button', { class: 'btn btn--ghost', type: 'button', text: '关闭', onclick: () => m.close() }),
      ],
    });
  }

  async function openReviewer(id) {
    const log = await window.LogRepo.get(id);
    if (!log) { window.UI.toast('日志不存在', 'err'); return; }

    const body = window.UI.el('div', { class: 'form' });
    const errBox = window.UI.el('p', { class: 'fld__err' });

    body.appendChild(window.UI.el('div', { class: 'viewer__excerpt' }, [
      window.UI.el('strong', { text: (log.date_range || '') + ' · ' + log.owner_name }),
      window.UI.el('p', { text: window.Validate.clip(log.content || '', 300) }),
    ]));

    const commentIn = window.UI.textarea('comment', '', { rows: 5, maxlength: 5000, placeholder: '写点反馈…' });
    body.appendChild(window.UI.field('点评内容', commentIn, { wide: true, required: true }));

    const levelSel = window.UI.select('level', [
      { value: '1', label: '一般' },
      { value: '2', label: '较好' },
      { value: '3', label: '优秀' },
    ], '1');
    body.appendChild(window.UI.field('评价', levelSel, {}));

    body.appendChild(errBox);

    const m = window.UI.modal({
      title: '点评日志',
      body,
      footer: [
        window.UI.el('button', { class: 'btn', type: 'button', text: '取消', onclick: () => m.close() }),
        window.UI.el('button', {
          class: 'btn btn--primary', type: 'button', text: '提交点评',
          onclick: async () => {
            errBox.textContent = '';
            try {
              await window.LogRepo.review(id, commentIn.value, levelSel.value);
              m.close();
              window.UI.toast('点评已提交', 'ok');
              AppShell.nav('logs');
            } catch (err) {
              errBox.textContent = window.Errors.normalize(err).message;
            }
          },
        }),
      ],
    });

    setTimeout(() => commentIn.focus(), 60);
  }

  /* ============================================================ */

  function bind(pageEl) {
    const nav = () => AppShell.nav('logs');

    // 类型切换
    window.UI.delegate(pageEl, '[data-ltype]', 'click', (ev, btn) => {
      state.type = btn.dataset.ltype;
      state.page = 1;
      nav();
    });

    const bindSel = (id, key) => {
      const el = pageEl.querySelector(id);
      if (!el) return;
      el.addEventListener('change', () => {
        state[key] = el.value;
        state.page = 1;
        nav();
      });
    };
    bindSel('#lRange', 'range');

    const search = pageEl.querySelector('#lSearch');
    if (search) {
      search.addEventListener('input', window.UI.debounce(() => {
        state.search = search.value.trim();
        state.page = 1;
        nav().then(() => {
          const s = document.getElementById('lSearch');
          if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
        });
      }, 320));
    }

    const mine = pageEl.querySelector('#lMine');
    if (mine) {
      mine.addEventListener('change', () => {
        state.mine = mine.checked;
        nav();
      });
    }

    // 按钮
    const add = pageEl.querySelector('#newLog');
    if (add) add.addEventListener('click', () => openEditor(0));

    const writeToday = pageEl.querySelector('#writeToday');
    if (writeToday) writeToday.addEventListener('click', () => openEditor(0));

    // 就地关闭提醒：不用让用户去设置页找
    const mute = pageEl.querySelector('#muteLogReminder');
    if (mute) {
      mute.addEventListener('click', async () => {
        try {
          await window.Settings.save({ log_reminder: '0' });
          window.UI.toast('已关闭日报提醒，可在「系统设置 → 界面偏好」重新开启', 'ok');
          AppShell.refreshBadges();
          AppShell.nav('logs');
        } catch (err) {
          window.UI.toast(window.Errors.normalize(err).message, 'err');
        }
      });
    }

    // 列表操作
    window.UI.delegate(pageEl, '[data-lview]', 'click', (ev, btn) => {
      ev.preventDefault();
      openViewer(btn.dataset.lview);
    });

    window.UI.delegate(pageEl, '[data-ledit]', 'click', (ev, btn) => {
      ev.preventDefault();
      openEditor(btn.dataset.ledit);
    });

    window.UI.delegate(pageEl, '[data-lreview]', 'click', (ev, btn) => {
      ev.preventDefault();
      openReviewer(btn.dataset.lreview);
    });

    window.UI.delegate(pageEl, '[data-ldel]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const go = await window.UI.confirm('确定删除这篇日志？', { danger: true, okText: '删除' });
      if (!go) return;
      try {
        await window.LogRepo.remove(btn.dataset.ldel);
        window.UI.toast('已删除', 'ok');
        nav();
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });

    // 导出
    const exp = pageEl.querySelector('#exportLogs');
    if (exp) {
      exp.addEventListener('click', async () => {
        try {
          const r = await window.ExportRepo.exportCsv('logs', { view: state.range, date: state.date });
          window.FileIO.downloadText(r.content, r.filename, 'text/csv');
          window.UI.toast(`已导出 ${r.rows} 篇日志`, 'ok');
        } catch (err) {
          window.UI.toast(window.Errors.normalize(err).message, 'err');
        }
      });
    }
  }

  window.Pages.logs = { render, bind, openEditor, state };
})();
