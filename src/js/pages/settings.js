/* ============================================================
 * pages/settings.js —— 系统设置
 *
 * 对应 PHP 版 views/settings.php（450 行）+ api/settings.php
 *
 * 分组：
 *   1. 站点信息（名称、副标题、主题）
 *   2. 工作时段与工作日
 *   3. 界面偏好（每页条数、隐藏周末/晚上）
 *   4. 数据管理（目录连接、备份、导入、回收站、清空）
 *   5. 关于（版本、存储用量、诊断）
 *
 * 注意：纯前端版没有服务进程，因此邮件提醒（SMTP）不可用，
 * 界面上明确标注而不是留一个点了没反应的按钮。
 * ============================================================ */

(function () {
  'use strict';

  const h = () => window.UI.html;
  const e = () => window.UI.escape;
  const raw = (x) => window.UI.raw(x);

  async function render() {
    const s = await window.Settings.getAll();
    const quota = await window.Errors.guard(() => window.DB.quota(), { usedMB: 0, totalMB: 0, pct: 0 }, 'settings:quota');
    const canEdit = window.Auth.can('settings', 'edit');
    const persist = await window.Errors.guard(async () => {
      if (navigator.storage && navigator.storage.persisted) return await navigator.storage.persisted();
      return false;
    }, false, 'settings:persist');

    return h()`
      ${renderSite(s, canEdit)}
      ${renderWork(s, canEdit)}
      ${renderPrefs(s, canEdit)}
      ${renderData(quota, persist)}
      ${renderAbout(quota)}
    `;
  }

  function sectionCard(title, bodyHtml, note) {
    return h()`
      <section class="card">
        <div class="card__h"><h3>${title}</h3></div>
        ${note ? h()`<p class="muted">${note}</p>` : ''}
        ${bodyHtml}
      </section>`;
  }

  function renderSite(s, canEdit) {
    const dis = canEdit ? '' : 'disabled';
    return sectionCard('站点信息', h()`
      <div class="form" id="siteForm">
        ${window.UI.field('站点名称',
          window.UI.input('site_name', s.site_name, { maxlength: 64, disabled: dis }), {})}
        ${window.UI.field('副标题',
          window.UI.input('site_subtitle', s.site_subtitle, { maxlength: 120, disabled: dis }), {})}
        ${window.UI.field('默认主题',
          window.UI.select('theme_default', [{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }],
            s.theme_default, { disabled: dis }), {})}
        <div class="fld fld--wide form-act">
          <button class="btn btn--sm" id="saveSite" type="button" ${dis}>保存站点信息</button>
        </div>
      </div>`);
  }

  function renderWork(s, canEdit) {
    const dis = canEdit ? '' : 'disabled';
    const periods = s.periods || window.Settings.defaultPeriods();
    const days = [1, 2, 3, 4, 5, 6, 7].map(n => ({
      n, label: '周' + '一二三四五六日'[n - 1],
      on: (s.work_day_list || [1, 2, 3, 4, 5]).indexOf(n) >= 0,
    }));

    return sectionCard('工作时段与工作日', h()`
      <div class="fld fld--wide">
        <span class="fld__l">工作时段（任务按此分类）</span>
        <div class="periods" id="periodList">
          ${periods.map((p, i) => h()`
            <div class="period" data-idx="${i}">
              <input class="input input--sm" data-pn value="${e()(p.n)}" maxlength="16" placeholder="名称" ${dis}>
              <input class="input input--sm" data-ps type="time" value="${e()(p.s)}" ${dis}>
              <span class="muted">至</span>
              <input class="input input--sm" data-pe type="time" value="${e()(p.e)}" ${dis}>
              <button class="btn btn--sm btn--ghost" data-pdel type="button" ${dis}>×</button>
            </div>`).join('')}
        </div>
        <button class="btn btn--sm" id="addPeriod" type="button" ${dis}>+ 添加时段</button>
      </div>

      <div class="fld fld--wide">
        <span class="fld__l">工作日（用于计算日报打卡率）</span>
        <div class="checks">
          ${days.map(d => h()`
            <label class="check">
              <input type="checkbox" data-wd="${d.n}" ${d.on ? 'checked' : ''} ${dis}>
              <span>${d.label}</span>
            </label>`).join('')}
        </div>
      </div>

      <div class="fld fld--wide form-act">
        <button class="btn btn--sm" id="saveWork" type="button" ${dis}>保存工作设置</button>
      </div>`, '修改工作时段后，任务表单里的时段选项会同步更新。');
  }

  function renderPrefs(s, canEdit) {
    const dis = canEdit ? '' : 'disabled';
    return sectionCard('界面偏好', h()`
      <div class="form">
        ${window.UI.field('每页显示条数',
          window.UI.input('page_size', s.page_size, { type: 'number', min: 5, max: 200, disabled: dis }), {})}
        <div class="fld">
          <span class="fld__l">列表显示</span>
          <div class="checks">
            <label class="check"><input type="checkbox" id="hideWeekend" ${s.hide_weekend === '1' ? 'checked' : ''} ${dis}><span>隐藏周末</span></label>
            <label class="check"><input type="checkbox" id="hideEvening" ${s.hide_evening === '1' ? 'checked' : ''} ${dis}><span>隐藏晚上时段</span></label>
          </div>
        </div>
        <div class="fld fld--wide">
          <span class="fld__l">提醒</span>
          <div class="checks">
            <label class="check">
              <input type="checkbox" id="logReminder" ${s.log_reminder === '1' ? 'checked' : ''} ${dis}>
              <span>工作日未写日报时在侧栏显示提醒</span>
            </label>
          </div>
          <span class="fld__h">关掉后侧栏「工作日志」不再出现红色感叹号；周末始终不提醒。</span>
        </div>
        <div class="fld fld--wide form-act">
          <button class="btn btn--sm" id="savePrefs" type="button" ${dis}>保存偏好</button>
        </div>
      </div>`);
  }

  function renderData(quota, persist) {
    const hasDir = window.FileIO.hasDir();
    const dirName = window.FileIO.dirName;
    const dirty = window.FileIO.isDirty();

    return sectionCard('数据管理', h()`
      <div class="datarow">
        <div class="datarow__l">
          <strong>数据目录</strong>
          <p class="muted">${hasDir
            ? '已连接到「' + e()(dirName || '') + '」，改动会自动写回 data.js'
            : '未连接。数据目前只存在浏览器里，换电脑或清缓存会丢失。'}</p>
        </div>
        <div class="datarow__r">
          <button class="btn btn--primary btn--sm" id="dlgConnect" type="button">
            ${hasDir ? '更换目录' : '连接目录'}</button>
          ${hasDir ? h()`<button class="btn btn--sm" id="dlgSaveNow" type="button">${dirty ? '立即写回（有改动）' : '立即写回'}</button>` : ''}
        </div>
      </div>

      <div class="datarow">
        <div class="datarow__l">
          <strong>备份 / 导出</strong>
          <p class="muted">导出一个 data.js 文件，放到程序目录下即可在别的电脑上自动载入。</p>
        </div>
        <div class="datarow__r">
          <button class="btn btn--sm" id="dlgExport" type="button">导出备份</button>
        </div>
      </div>

      <div class="datarow">
        <div class="datarow__l">
          <strong>导入数据</strong>
          <p class="muted">从 data.js 或 .json 文件恢复。导入会覆盖当前所有数据。</p>
        </div>
        <div class="datarow__r">
          <button class="btn btn--sm" id="dlgImport" type="button">选择文件导入</button>
        </div>
      </div>

      <div class="datarow">
        <div class="datarow__l">
          <strong>存储状态</strong>
          <p class="muted">
            已用 ${quota.usedMB} MB / 可用约 ${quota.totalMB} MB（${quota.pct}%）
            ${persist ? '· 已申请持久化（不会被自动清理）' : '· 未持久化，浏览器存储紧张时可能被自动清理'}
          </p>
          <div class="quota"><div class="quota__f" style="width:${Math.min(100, quota.pct)}%"></div></div>
        </div>
        <div class="datarow__r">
          ${!persist ? h()`<button class="btn btn--sm" id="dlgPersist" type="button">申请持久化</button>` : ''}
        </div>
      </div>

      <div class="datarow datarow--danger">
        <div class="datarow__l">
          <strong>危险操作</strong>
          <p class="muted">以下操作不可撤销，请先导出备份。</p>
        </div>
        <div class="datarow__r">
          <button class="btn btn--sm btn--danger" id="dlgClearBiz" type="button">清空业务数据</button>
          <button class="btn btn--sm btn--danger" id="dlgResetAll" type="button">重置全部（含账号）</button>
        </div>
      </div>`, '纯前端版没有服务进程，因此不支持邮件提醒（原 SMTP 功能）。如需邮件通知请使用原来的 Web 部署版。');
  }

  function renderAbout(quota) {
    return sectionCard('关于', h()`
      <div class="about">
        <p><strong>团队协作台</strong> <span class="muted">v${e()(window.APP_VERSION || '1.0.0')}</span></p>
        <p class="muted">纯前端单机版：数据保存在本机，不联网、不上传。双击 index.html 即可使用。</p>
        <p class="muted">存储：IndexedDB（工作副本，${quota.usedMB} MB）+ data.js（持久快照）</p>
        <div class="row" style="gap:8px;margin-top:10px">
          <button class="btn btn--sm" id="dlgDiag" type="button">诊断信息</button>
          <button class="btn btn--sm btn--ghost" id="dlgLogs" type="button">查看运行日志</button>
        </div>
      </div>`);
  }

  /* ============================================================ */

  function readPeriods(pageEl) {
    const rows = window.UI.$$('.period', pageEl);
    const out = [];
    for (const row of rows) {
      const n = window.UI.$('[data-pn]', row);
      const s = window.UI.$('[data-ps]', row);
      const en = window.UI.$('[data-pe]', row);
      if (!n || !s || !en) continue;
      const name = (n.value || '').trim();
      if (!name) continue;
      out.push({ n: name, s: s.value || '06:00', e: en.value || '12:00' });
    }
    return out;
  }

  function bind(pageEl) {
    const nav = () => AppShell.nav('settings');

    // 站点
    const saveSite = pageEl.querySelector('#saveSite');
    if (saveSite) {
      saveSite.addEventListener('click', async () => {
        const f = pageEl.querySelector('#siteForm');
        await window.UI.withBusy(async () => {
          await window.Settings.save({
            site_name: window.UI.$('[name="site_name"]', f).value,
            site_subtitle: window.UI.$('[name="site_subtitle"]', f).value,
            theme_default: window.UI.$('[name="theme_default"]', f).value,
          });
          window.UI.toast('站点信息已保存', 'ok');
          AppShell.applyTheme(window.Settings.get('theme_default', 'light'));
          nav();
        }, { tag: 'settings:site' });
      });
    }

    // 添加时段
    const add = pageEl.querySelector('#addPeriod');
    if (add) {
      add.addEventListener('click', () => {
        const list = pageEl.querySelector('#periodList');
        if (!list) return;
        const idx = list.children.length;
        if (idx >= 8) { window.UI.toast('最多 8 个时段', 'warn'); return; }
        const div = document.createElement('div');
        div.className = 'period';
        div.dataset.idx = String(idx);
        div.innerHTML =
          '<input class="input input--sm" data-pn maxlength="16" placeholder="名称">' +
          '<input class="input input--sm" data-ps type="time" value="08:00">' +
          '<span class="muted">至</span>' +
          '<input class="input input--sm" data-pe type="time" value="12:00">' +
          '<button class="btn btn--sm btn--ghost" data-pdel type="button">×</button>';
        list.appendChild(div);
      });
    }

    window.UI.delegate(pageEl, '[data-pdel]', 'click', (ev, btn) => {
      ev.preventDefault();
      const row = btn.closest('.period');
      if (row) row.remove();
    });

    // 工作设置
    const saveWork = pageEl.querySelector('#saveWork');
    if (saveWork) {
      saveWork.addEventListener('click', async () => {
        const periods = readPeriods(pageEl);
        if (!periods.length) { window.UI.toast('至少保留一个工作时段', 'err'); return; }

        const days = window.UI.$$('[data-wd]', pageEl)
          .filter(c => c.checked).map(c => Number(c.dataset.wd));
        if (!days.length) { window.UI.toast('至少选一个工作日', 'err'); return; }

        await window.UI.withBusy(async () => {
          await window.Settings.save({
            work_periods: JSON.stringify(periods),
            work_days: days.join(','),
          });
          window.UI.toast('工作设置已保存', 'ok');
          nav();
        }, { tag: 'settings:work' });
      });
    }

    // 偏好
    const savePrefs = pageEl.querySelector('#savePrefs');
    if (savePrefs) {
      savePrefs.addEventListener('click', async () => {
        await window.UI.withBusy(async () => {
          await window.Settings.save({
            page_size: window.UI.$('[name="page_size"]', pageEl).value,
            hide_weekend: pageEl.querySelector('#hideWeekend').checked ? '1' : '0',
            hide_evening: pageEl.querySelector('#hideEvening').checked ? '1' : '0',
            log_reminder: pageEl.querySelector('#logReminder').checked ? '1' : '0',
          });
          window.UI.toast('偏好已保存', 'ok');
        }, { tag: 'settings:prefs' });
      });
    }

    // 数据管理
    const conn = pageEl.querySelector('#dlgConnect');
    if (conn) conn.addEventListener('click', () => AppShell.onConnectDir());

    const saveNow = pageEl.querySelector('#dlgSaveNow');
    if (saveNow) saveNow.addEventListener('click', () => AppShell.onSaveFile());

    const exp = pageEl.querySelector('#dlgExport');
    if (exp) {
      exp.addEventListener('click', async () => {
        try {
          const r = await window.FileIO.exportBackup();
          if (r && r.ok) window.UI.toast('已导出 ' + r.name, 'ok', { duration: 5000 });
        } catch (err) {
          window.UI.toast(window.Errors.normalize(err).message, 'err');
        }
      });
    }

    const imp = pageEl.querySelector('#dlgImport');
    if (imp) imp.addEventListener('click', () => doImport());

    const persist = pageEl.querySelector('#dlgPersist');
    if (persist) {
      persist.addEventListener('click', async () => {
        const r = await window.DB.requestPersistence();
        if (r.persisted) window.UI.toast('已申请持久化，数据不会被自动清理', 'ok');
        else window.UI.toast('浏览器拒绝了持久化请求（可能是隐私模式）', 'warn');
        nav();
      });
    }

    const clearBiz = pageEl.querySelector('#dlgClearBiz');
    if (clearBiz) {
      clearBiz.addEventListener('click', async () => {
        const go = await window.UI.confirm(
          '这会删除所有任务、计划、日志、操作记录（保留账号与设置）。确定继续？',
          { danger: true, okText: '清空业务数据' }
        );
        if (!go) return;
        const go2 = await window.UI.confirm('再次确认：此操作不可撤销，建议先导出备份。', {
          danger: true, okText: '我已备份，继续',
        });
        if (!go2) return;
        await window.UI.withBusy(async () => {
          await window.Seed.clearBusinessData();
          window.UI.toast('业务数据已清空', 'ok');
          nav();
        }, { tag: 'settings:clear' });
      });
    }

    const resetAll = pageEl.querySelector('#dlgResetAll');
    if (resetAll) {
      resetAll.addEventListener('click', async () => {
        const go = await window.UI.confirm(
          '这会删除全部数据（含所有账号），回到首次运行状态。确定继续？',
          { danger: true, okText: '重置全部' }
        );
        if (!go) return;
        const typed = await window.UI.prompt('请输入「重置」两字确认', {
          title: '二次确认', placeholder: '重置',
        });
        if (typed !== '重置') { window.UI.toast('输入不匹配，已取消', 'warn'); return; }
        await window.UI.withBusy(async () => {
          await window.Seed.resetAll();
          window.UI.toast('已重置，正在重新载入…', 'ok');
          setTimeout(() => location.reload(), 700);
        }, { tag: 'settings:reset' });
      });
    }

    // 关于
    const diag = pageEl.querySelector('#dlgDiag');
    if (diag) diag.addEventListener('click', () => window.UI.showDiagnostics());

    const logs = pageEl.querySelector('#dlgLogs');
    if (logs) {
      logs.addEventListener('click', () => {
        const ta = document.createElement('textarea');
        ta.className = 'input';
        ta.rows = 16;
        ta.readOnly = true;
        ta.value = window.Errors.Log.toText() || '（暂无日志）';
        window.UI.modal({
          title: '运行日志',
          body: ta,
          width: 'lg',
          footer: [window.UI.el('button', {
            class: 'btn btn--ghost', type: 'button', text: '清空日志',
            onclick: () => { window.Errors.Log.clear(); window.UI.toast('已清空', 'ok'); },
          })],
        });
      });
    }
  }

  async function doImport() {
    let picked;
    try {
      picked = await window.FileIO.pickFileToImport();
    } catch (e) {
      window.UI.toast(window.Errors.normalize(e).message, 'err');
      return;
    }
    if (!picked) return;

    const counts = (picked.snapshot && picked.snapshot.counts) || {};
    const summary = Object.keys(counts).filter(k => counts[k])
      .map(k => k + ' ' + counts[k]).join('，') || '空数据';

    const go = await window.UI.confirm(
      `即将导入「${picked.filename}」\n内容：${summary}\n\n导入会覆盖当前所有数据，确定继续？`,
      { danger: true, okText: '覆盖导入', title: '确认导入' }
    );
    if (!go) return;

    await window.UI.withBusy(async () => {
      const r = await window.FileIO.importSnapshot(picked.snapshot, 'replace');
      window.UI.toast(`导入完成：${r.imported} 条` + (r.skipped ? `，跳过 ${r.skipped} 条无效数据` : ''), 'ok', { duration: 6000 });
      setTimeout(() => location.reload(), 900);
    }, { tag: 'settings:import' });
  }

  window.Pages.settings = { render, bind };
})();
