/* ============================================================
 * pages/oplogs.js + pages/trash.js —— 操作日志 / 回收站
 *
 * 两个页面都很小，合并在一个文件里减少加载项。
 * ============================================================ */

(function () {
  'use strict';

  const h = () => window.UI.html;
  const e = () => window.UI.escape;

  /* ============================================================
   * 操作日志
   * ============================================================ */

  const opState = { action: '', search: '', range: 'month', page: 1 };

  async function renderOpLogs() {
    const [data, actions] = await Promise.all([
      window.OpLog.list({
        action: opState.action || undefined,
        search: opState.search || undefined,
        range: opState.range,
        page: opState.page,
      }),
      window.Errors.guard(() => window.OpLog.actions(), [], 'oplogs:actions'),
    ]);

    return h()`
      <section class="card card--tight">
        <div class="card__h">
          <h3>操作日志 <span class="card__n">${data.total}</span></h3>
          <div class="row" style="gap:8px">
            <button class="btn btn--sm" id="opExport" type="button">导出 CSV</button>
            <button class="btn btn--sm btn--danger" id="opClear" type="button">清理旧记录</button>
          </div>
        </div>
        <div class="toolbar">
          <input class="input input--sm" id="opSearch" placeholder="搜索动作/对象/详情" value="${e()(opState.search)}">
          <select class="input input--sm" id="opAction">
            <option value="">全部动作</option>
            ${actions.map(a => h()`
              <option value="${e()(a.action)}" ${opState.action === a.action ? 'selected' : ''}>
                ${e()(a.action)} (${a.count})</option>`).join('')}
          </select>
          <select class="input input--sm" id="opRange">
            ${[['day', '今天'], ['week', '本周'], ['month', '本月'], ['year', '今年']]
              .map(([v, l]) => h()`<option value="${v}" ${opState.range === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </section>

      <section class="card">
        ${data.items.length ? h()`
          <table class="tbl">
            <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>
            <tbody>
              ${data.items.map(r => h()`
                <tr>
                  <td class="tbl__muted">${e()(r.created_at || '')}</td>
                  <td>${e()(r.username || '—')}</td>
                  <td><span class="pill pill--medium">${e()(r.action)}</span></td>
                  <td class="tbl__muted">${e()(r.target || '—')}</td>
                  <td class="tbl__detail">${e()(window.Validate.clip(r.detail || '', 120))}</td>
                </tr>`).join('')}
            </tbody>
          </table>` : window.UI.empty('这段时间没有操作记录')}
      </section>
      <div id="opPager"></div>`;
  }

  function bindOpLogs(pageEl) {
    const nav = () => AppShell.nav('oplogs');

    const search = pageEl.querySelector('#opSearch');
    if (search) {
      search.addEventListener('input', window.UI.debounce(() => {
        opState.search = search.value.trim();
        opState.page = 1;
        nav().then(() => {
          const s = document.getElementById('opSearch');
          if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
        });
      }, 320));
    }

    ['#opAction|action', '#opRange|range'].forEach(pair => {
      const [id, key] = pair.split('|');
      const el = pageEl.querySelector(id);
      if (el) el.addEventListener('change', () => { opState[key] = el.value; opState.page = 1; nav(); });
    });

    const exp = pageEl.querySelector('#opExport');
    if (exp) {
      exp.addEventListener('click', async () => {
        try {
          const r = await window.OpLog.list({ range: opState.range, page: 1, per_page: 10000 });
          const csv = window.ExportRepo.toCsv(
            ['时间', '操作人', '动作', '对象', '详情'],
            r.items.map(x => ({
              时间: x.created_at, 操作人: x.username, 动作: x.action,
              对象: x.target, 详情: x.detail,
            }))
          );
          window.FileIO.downloadText(csv, `操作日志-${window.Validate.today()}.csv`, 'text/csv');
          window.UI.toast(`已导出 ${r.items.length} 条`, 'ok');
        } catch (err) {
          window.UI.toast(window.Errors.normalize(err).message, 'err');
        }
      });
    }

    const clr = pageEl.querySelector('#opClear');
    if (clr) {
      clr.addEventListener('click', async () => {
        const days = await window.UI.prompt('保留最近多少天的记录？更早的会被删除。', {
          title: '清理操作日志', value: '90', type: 'number',
        });
        if (days === null) return;
        const n = Number(days);
        if (!(n >= 1)) { window.UI.toast('请输入大于 0 的天数', 'err'); return; }

        const go = await window.UI.confirm(`将删除 ${n} 天之前的操作记录，此操作不可撤销。确定？`, {
          danger: true, okText: '清理',
        });
        if (!go) return;

        await window.UI.withBusy(async () => {
          const r = await window.OpLog.clear(n);
          window.UI.toast(`已清理 ${r.removed} 条，保留最近 ${r.kept_days} 天`, 'ok');
          nav();
        }, { tag: 'oplogs:clear' });
      });
    }
  }

  /* ============================================================
   * 回收站
   *
   * 纯前端版做了软删除（deleted 标记），这里提供恢复入口。
   * 不做"清空回收站"的自动定时清理 —— 单机数据量小，留着更安全。
   * ============================================================ */

  async function renderTrash() {
    const [tasks, logs] = await Promise.all([
      window.Errors.guard(async () => {
        const rows = await window.Repo.all('tasks', { withDeleted: true });
        return rows.filter(r => r.deleted);
      }, [], 'trash:tasks'),
      window.Errors.guard(async () => {
        const rows = await window.Repo.all('logs', { withDeleted: true });
        return rows.filter(r => r.deleted);
      }, [], 'trash:logs'),
    ]);

    const tbl = (title, items, kind) => {
      if (!items.length) return '';
      return h()`
        <section class="card">
          <div class="card__h"><h3>${title} <span class="card__n">${items.length}</span></h3></div>
          <table class="tbl">
            <thead><tr><th>内容</th><th>删除时间</th><th>操作</th></tr></thead>
            <tbody>
              ${items.map(x => h()`
                <tr>
                  <td>${e()(x.title || window.Validate.clip(x.content || '', 60) || ('#' + x.id))}</td>
                  <td class="tbl__muted">${e()(x.updated_at || '')}</td>
                  <td>
                    <div class="tbl__act">
                      <button class="btn btn--sm" data-restore="${kind}:${x.id}" type="button">恢复</button>
                      <button class="btn btn--sm btn--danger" data-purge="${kind}:${x.id}" type="button">彻底删除</button>
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </section>`;
    };

    const body = tbl('已删除任务', tasks, 'tasks') + tbl('已删除日志', logs, 'logs');
    return body || window.UI.empty('回收站是空的。删除的任务与日志会先放到这里，可以恢复。');
  }

  /**
   * 回收站允许操作的实体白名单。
   *
   * kind 来自 DOM 的 data 属性，理论上可被篡改。若不校验，
   * 一个被改过的 data-restore="users:1" 就能恢复任意表的数据——
   * 包括本不该由普通成员碰的成员表与角色表。
   */
  const TRASH_KINDS = ['tasks', 'logs'];

  /** 解析并校验 data-* 里的 kind:id，返回 null 表示非法。 */
  function parseTrashRef(raw) {
    const parts = String(raw || '').split(':');
    if (parts.length !== 2) return null;
    const kind = parts[0];
    const id = Number(parts[1]);
    if (TRASH_KINDS.indexOf(kind) < 0) return null;
    if (!(id > 0)) return null;
    return { kind, id };
  }

  function bindTrash(pageEl) {
    window.UI.delegate(pageEl, '[data-restore]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const ref = parseTrashRef(btn.dataset.restore);
      if (!ref) {
        window.UI.toast('无法识别的记录类型，已忽略', 'err');
        return;
      }
      await window.UI.withBusy(async () => {
        await window.Repo.restore(ref.kind, ref.id);
        window.UI.toast('已恢复', 'ok');
        AppShell.nav('trash');
      }, { tag: 'trash:restore' });
    });

    window.UI.delegate(pageEl, '[data-purge]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const ref = parseTrashRef(btn.dataset.purge);
      if (!ref) {
        window.UI.toast('无法识别的记录类型，已忽略', 'err');
        return;
      }
      const go = await window.UI.confirm('彻底删除后无法恢复，确定？', { danger: true, okText: '彻底删除' });
      if (!go) return;
      await window.UI.withBusy(async () => {
        await window.Repo.hardDelete(ref.kind, ref.id);
        window.UI.toast('已彻底删除', 'ok');
        AppShell.nav('trash');
      }, { tag: 'trash:purge' });
    });
  }

  window.Pages.oplogs = { render: renderOpLogs, bind: bindOpLogs, state: opState };
  window.Pages.trash = { render: renderTrash, bind: bindTrash };
})();
