/* ============================================================
 * pages/org.js —— 组织架构
 *
 * 对应 PHP 版 views/org.php（437 行）+ api/org.php
 *
 * 三个 Tab：
 *   1. 成员：增删改查、启停、搜索、按部门/角色筛选
 *   2. 部门：树形展示、增删改、上级关系
 *   3. 角色：权限矩阵编辑（模块 × 动作）
 * ============================================================ */

(function () {
  'use strict';

  const h = () => window.UI.html;
  const e = () => window.UI.escape;

  const state = {
    tab: 'users',
    keyword: '',
    department_id: '',
    role_id: '',
    status: '',
    page: 1,
  };

  async function render(ctx) {
    const q = ctx.query || {};
    if (q.goto && q.goto.indexOf('user:') === 0) {
      const uid = Number(q.goto.split(':')[1]);
      ctx.query = {};
      setTimeout(async () => {
        try {
          const list = await window.OrgRepo.userList({ per_page: 9999 });
          const u = (list.items || []).find(x => Number(x.id) === uid);
          if (u) openUserEditor(u);
          else window.UI.toast('该成员可能已被删除', 'warn');
        } catch (err) {
          window.UI.toast(window.Errors.normalize(err).message, 'err');
        }
      }, 130);
    }

    return h()`
      <section class="card card--tight">
        <div class="tabs">
          <button class="tab ${state.tab === 'users' ? 'tab--on' : ''}" data-tab="users" type="button">成员</button>
          <button class="tab ${state.tab === 'depts' ? 'tab--on' : ''}" data-tab="depts" type="button">部门</button>
          <button class="tab ${state.tab === 'roles' ? 'tab--on' : ''}" data-tab="roles" type="button">角色权限</button>
        </div>
      </section>
      ${state.tab === 'users' ? await renderUsers() : ''}
      ${state.tab === 'depts' ? await renderDepts() : ''}
      ${state.tab === 'roles' ? await renderRoles() : ''}
    `;
  }

  /* ============================================================
   * 成员
   * ============================================================ */

  async function renderUsers() {
    const [data, depts, roles] = await Promise.all([
      window.OrgRepo.userList({
        keyword: state.keyword || undefined,
        department_id: state.department_id || undefined,
        role_id: state.role_id || undefined,
        status: state.status || undefined,
        page: state.page,
        per_page: 100,
      }),
      window.Errors.guard(() => window.OrgRepo.deptOptions(), [], 'org:depts'),
      window.Errors.guard(() => window.OrgRepo.roleList(), [], 'org:roles'),
    ]);

    return h()`
      <section class="card card--tight">
        <div class="card__h">
          <h3>成员 <span class="card__n">${data.total}</span></h3>
          ${window.Auth.can('org', 'add') ? h()`
            <button class="btn btn--primary btn--sm" id="newUser" type="button">+ 新增成员</button>` : ''}
        </div>
        <div class="toolbar">
          <input class="input input--sm" id="uKeyword" placeholder="搜索用户名/姓名/邮箱" value="${e()(state.keyword)}">
          <select class="input input--sm" id="uDept">
            <option value="">全部部门</option>
            ${depts.map(d => h()`
              <option value="${d.id}" ${String(state.department_id) === String(d.id) ? 'selected' : ''}>${e()(d.name)}</option>`).join('')}
          </select>
          <select class="input input--sm" id="uRole">
            <option value="">全部角色</option>
            ${roles.map(r => h()`
              <option value="${r.id}" ${String(state.role_id) === String(r.id) ? 'selected' : ''}>${e()(r.name)}</option>`).join('')}
          </select>
          <select class="input input--sm" id="uStatus">
            <option value="">全部状态</option>
            <option value="1" ${state.status === '1' ? 'selected' : ''}>启用</option>
            <option value="0" ${state.status === '0' ? 'selected' : ''}>停用</option>
          </select>
        </div>
      </section>

      <section class="card">
        ${data.items.length ? h()`
          <table class="tbl tbl--users">
            <thead><tr>
              <th>成员</th><th>用户名</th><th>部门</th><th>角色</th><th>联系方式</th><th>状态</th><th>操作</th>
            </tr></thead>
            <tbody>
              ${data.items.map(u => h()`
                <tr class="${Number(u.status) === 1 ? '' : 'tbl__row--off'}">
                  <td>
                    <div class="usercell">
                      <img src="${e()(u.avatar_url)}" class="avatar avatar--sm" alt="">
                      <span>${e()(u.real_name)}${u.is_self ? h()`<em class="usercell__me">（我）</em>` : ''}</span>
                    </div>
                  </td>
                  <td>${e()(u.username)}</td>
                  <td>${e()(u.department_name || '—')}</td>
                  <td><span class="pill pill--${u.role_id === 1 ? 'completed' : u.role_id === 2 ? 'in_progress' : 'medium'}">${e()(u.role_name)}</span></td>
                  <td class="tbl__muted">${e()(u.email || u.phone || '—')}</td>
                  <td>${Number(u.status) === 1 ? h()`<span class="pill pill--completed">启用</span>` : h()`<span class="pill pill--low">停用</span>`}</td>
                  <td>
                    <div class="tbl__act">
                      ${window.Auth.can('org', 'edit') ? h()`
                        <button class="btn btn--sm btn--ghost" data-uedit="${u.id}" type="button">编辑</button>
                        ${u.is_self ? '' : h()`
                          <button class="btn btn--sm btn--ghost" data-utoggle="${u.id}" type="button">
                            ${Number(u.status) === 1 ? '停用' : '启用'}</button>`}
                        <button class="btn btn--sm btn--ghost" data-upwd="${u.id}" type="button">重置密码</button>` : ''}
                      ${window.Auth.can('org', 'delete') && !u.is_self ? h()`
                        <button class="btn btn--sm btn--danger" data-udel="${u.id}" type="button">删除</button>` : ''}
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>` : window.UI.empty('没有符合条件的成员')}
      </section>`;
  }

  /* ============================================================
   * 部门
   * ============================================================ */

  async function renderDepts() {
    const d = await window.OrgRepo.deptList();

    const renderNode = (node, depth) => {
      const indent = '　'.repeat(depth);
      return h()`
        <div class="deptrow" style="padding-left:${depth * 20}px">
          <div class="deptrow__l">
            ${depth === 0 ? '▸' : '·'} <strong>${e()(node.name)}</strong>
            ${node.description ? h()`<span class="muted">${e()(node.description)}</span>` : ''}
          </div>
          <span class="muted">${node.member_count} 人</span>
          ${node.manager_name ? h()`<span class="muted">主管：${e()(node.manager_name)}</span>` : ''}
          <div class="deptrow__act">
            ${window.Auth.can('org', 'edit') ? h()`
              <button class="btn btn--sm btn--ghost" data-dedit="${node.id}" type="button">编辑</button>` : ''}
            ${window.Auth.can('org', 'add') ? h()`
              <button class="btn btn--sm btn--ghost" data-dsub="${node.id}" type="button">加子部门</button>` : ''}
            ${window.Auth.can('org', 'delete') ? h()`
              <button class="btn btn--sm btn--danger" data-ddel="${node.id}" type="button">删除</button>` : ''}
          </div>
        </div>
        ${(node.children || []).map(c => renderNode(c, depth + 1)).join('')}`;
    };

    return h()`
      <section class="card">
        <div class="card__h">
          <h3>部门结构</h3>
          ${window.Auth.can('org', 'add') ? h()`
            <button class="btn btn--primary btn--sm" id="newDept" type="button">+ 新增部门</button>` : ''}
        </div>
        ${d.tree.length ? h()`<div class="depts">${d.tree.map(n => renderNode(n, 0)).join('')}</div>` : window.UI.empty('还没有部门')}
      </section>`;
  }

  /* ============================================================
   * 角色
   * ============================================================ */

  async function renderRoles() {
    const roles = await window.OrgRepo.roleList();

    return h()`
      <section class="card">
        <div class="card__h">
          <h3>角色与权限</h3>
          ${window.Auth.can('org', 'edit') ? h()`
            <button class="btn btn--primary btn--sm" id="newRole" type="button">+ 新增角色</button>` : ''}
        </div>
        <p class="muted">「系统管理员」拥有全部权限且不可修改。数据范围决定能看到谁的数据。</p>
        <div class="roles">
          ${roles.map(r => h()`
            <div class="rolecard">
              <header class="rolecard__h">
                <strong>${e()(r.name)}</strong>
                ${r.is_admin ? h()`<span class="pill pill--completed">内置</span>` : ''}
                <span class="pill pill--medium">${window.Schema.label('dataScope', r.permissions.data_scope)}</span>
                <span class="muted">${r.user_count} 人使用</span>
                <div class="rolecard__act">
                  ${window.Auth.can('org', 'edit') && !r.is_admin ? h()`
                    <button class="btn btn--sm btn--ghost" data-redit="${r.id}" type="button">编辑</button>` : ''}
                  ${window.Auth.can('org', 'delete') && !r.is_admin ? h()`
                    <button class="btn btn--sm btn--danger" data-rdel="${r.id}" type="button">删除</button>` : ''}
                </div>
              </header>
              <div class="permgrid">
                ${window.Schema.ENUMS.permModules.map(mod => {
                  const acts = r.permissions.modules[mod] || {};
                  const list = Object.keys(acts).filter(a => acts[a]);
                  return h()`
                    <div class="permrow">
                      <span class="permrow__m">${window.Schema.label('permModules', mod)}</span>
                      <span class="permrow__a">
                        ${list.length ? list.map(a => h()`<em class="permtag">${window.Schema.label('permActions', a)}</em>`).join('') : '—'}
                      </span>
                    </div>`;
                }).join('')}
              </div>
            </div>`).join('')}
        </div>
      </section>`;
  }

  /* ============================================================
   * 编辑器
   * ============================================================ */

  async function openUserEditor(user) {
    const isNew = !user;
    const [depts, roles] = await Promise.all([
      window.Errors.guard(() => window.OrgRepo.deptOptions(), [], 'edit:depts'),
      window.Errors.guard(() => window.OrgRepo.roleList(), [], 'edit:roles'),
    ]);

    const base = user || { role_id: 3, department_id: depts[0] ? depts[0].id : 0, status: 1 };
    const body = window.UI.el('div', { class: 'form' });
    const errBox = window.UI.el('p', { class: 'fld__err' });

    const userIn = window.UI.input('username', base.username || '', {
      maxlength: 32, required: 'required', autocomplete: 'off',
    });
    body.appendChild(window.UI.field('用户名', userIn, {
      required: true, hint: '3-32 位字母数字下划线，不能是纯数字',
    }));

    const nameIn = window.UI.input('real_name', base.real_name || '', { maxlength: 64, required: 'required' });
    body.appendChild(window.UI.field('姓名', nameIn, { required: true }));

    const pwdIn = window.UI.input('password', '', {
      type: 'password', placeholder: isNew ? '必填，至少 6 位' : '留空表示不修改', autocomplete: 'new-password',
    });
    body.appendChild(window.UI.field(isNew ? '初始密码' : '新密码', pwdIn, {
      wide: true, required: isNew, hint: isNew ? '至少 6 位' : '不填则保持原密码',
    }));

    const roleSel = window.UI.select('role_id', roles.map(r => ({ value: r.id, label: r.name })),
      base.role_id || 3);
    body.appendChild(window.UI.field('角色', roleSel, {}));

    const deptSel = window.UI.select('department_id',
      [{ value: '0', label: '（不分配）' }].concat(depts.map(d => ({ value: d.id, label: d.name }))),
      base.department_id || 0);
    body.appendChild(window.UI.field('部门', deptSel, {}));

    const emailIn = window.UI.input('email', base.email || '', { maxlength: 120, type: 'email' });
    body.appendChild(window.UI.field('邮箱', emailIn, { hint: '可选' }));

    const phoneIn = window.UI.input('phone', base.phone || '', { maxlength: 11 });
    body.appendChild(window.UI.field('手机', phoneIn, { hint: '可选，11 位' }));

    body.appendChild(errBox);

    const m = window.UI.modal({
      title: isNew ? '新增成员' : '编辑成员',
      body,
      width: 'lg',
      footer: [
        window.UI.el('button', { class: 'btn', type: 'button', text: '取消', onclick: () => m.close() }),
        window.UI.el('button', {
          class: 'btn btn--primary', type: 'button', text: '保存',
          onclick: async () => {
            errBox.textContent = '';
            try {
              await window.UI.withBusy(() => window.OrgRepo.userSave({
                id: base.id || 0,
                username: userIn.value,
                real_name: nameIn.value,
                password: pwdIn.value,
                role_id: roleSel.value,
                department_id: deptSel.value,
                email: emailIn.value,
                phone: phoneIn.value,
              }), { tag: 'user:save' });
              m.close();
              window.UI.toast(isNew ? '成员已新增' : '已保存', 'ok');
              AppShell.nav('org');
            } catch (err) {
              const nerr = window.Errors.normalize(err);
              errBox.textContent = nerr.message;
              if (nerr.field) {
                const f = window.UI.$('[name="' + nerr.field + '"]', body);
                if (f) f.focus();
              }
            }
          },
        }),
      ],
    });

    setTimeout(() => (isNew ? userIn : nameIn).focus(), 60);
  }

  async function openDeptEditor(dept, parentId) {
    const isNew = !dept;
    const base = dept || { parent_id: parentId || 0, name: '' };
    const depts = await window.Errors.guard(() => window.OrgRepo.deptOptions(), [], 'edit:depts');

    const body = window.UI.el('div', { class: 'form' });
    const errBox = window.UI.el('p', { class: 'fld__err' });

    const nameIn = window.UI.input('name', base.name || '', { maxlength: 64, required: 'required' });
    body.appendChild(window.UI.field('部门名称', nameIn, { wide: true, required: true }));

    const parentSel = window.UI.select('parent_id',
      [{ value: '0', label: '（顶级部门）' }].concat(
        depts.filter(d => String(d.id) !== String(base.id))
          .map(d => ({ value: d.id, label: d.name }))
      ),
      base.parent_id || 0);
    body.appendChild(window.UI.field('上级部门', parentSel, { hint: '不能选自己或自己的下级' }));

    const descIn = window.UI.input('description', base.description || '', { maxlength: 255 });
    body.appendChild(window.UI.field('说明', descIn, { wide: true }));

    body.appendChild(errBox);

    const m = window.UI.modal({
      title: isNew ? '新增部门' : '编辑部门',
      body,
      footer: [
        window.UI.el('button', { class: 'btn', type: 'button', text: '取消', onclick: () => m.close() }),
        window.UI.el('button', {
          class: 'btn btn--primary', type: 'button', text: '保存',
          onclick: async () => {
            errBox.textContent = '';
            try {
              await window.OrgRepo.deptSave({
                id: base.id || 0,
                name: nameIn.value,
                parent_id: parentSel.value,
                description: descIn.value,
              });
              m.close();
              window.UI.toast(isNew ? '部门已创建' : '已保存', 'ok');
              AppShell.nav('org');
            } catch (err) {
              errBox.textContent = window.Errors.normalize(err).message;
            }
          },
        }),
      ],
    });
    setTimeout(() => nameIn.focus(), 60);
  }

  async function openRoleEditor(role) {
    const isNew = !role;
    const base = role || {
      name: '',
      permissions: { data_scope: 'self', modules: {} },
    };

    const body = window.UI.el('div', { class: 'form' });
    const errBox = window.UI.el('p', { class: 'fld__err' });

    const nameIn = window.UI.input('name', base.name || '', { maxlength: 64, required: 'required' });
    body.appendChild(window.UI.field('角色名称', nameIn, { wide: true, required: true }));

    const scopeSel = window.UI.enumSelect('data_scope', 'dataScope', base.permissions.data_scope || 'self');
    body.appendChild(window.UI.field('数据范围', scopeSel, {
      wide: true, hint: '仅自己 = 只看到分配给自己的；本部门 = 加上同部门成员的；全部 = 不限',
    }));

    // 权限矩阵
    const grid = window.UI.el('div', { class: 'permedit' });
    const checks = {};

    // 表头
    const head = window.UI.el('div', { class: 'permedit__row permedit__row--h' }, [
      window.UI.el('span', { class: 'permedit__m', text: '模块' }),
      ...window.Schema.ENUMS.permActions.map(a =>
        window.UI.el('span', { class: 'permedit__a', text: window.Schema.label('permActions', a) })
      ),
    ]);
    grid.appendChild(head);

    for (const mod of window.Schema.ENUMS.permModules) {
      const acts = (base.permissions.modules || {})[mod] || {};
      const row = window.UI.el('div', { class: 'permedit__row' }, [
        window.UI.el('span', { class: 'permedit__m', text: window.Schema.label('permModules', mod) }),
      ]);
      checks[mod] = {};
      for (const act of window.Schema.ENUMS.permActions) {
        const cb = window.UI.el('input', { type: 'checkbox' });
        if (acts[act]) cb.checked = true;
        checks[mod][act] = cb;
        row.appendChild(window.UI.el('label', { class: 'permedit__a' }, [cb]));
      }
      grid.appendChild(row);
    }

    body.appendChild(window.UI.field('权限明细', grid, { wide: true }));
    body.appendChild(errBox);

    const m = window.UI.modal({
      title: isNew ? '新增角色' : '编辑角色',
      body,
      width: 'lg',
      footer: [
        window.UI.el('button', { class: 'btn', type: 'button', text: '取消', onclick: () => m.close() }),
        window.UI.el('button', {
          class: 'btn btn--primary', type: 'button', text: '保存',
          onclick: async () => {
            errBox.textContent = '';
            const modules = {};
            for (const mod of window.Schema.ENUMS.permModules) {
              const picked = {};
              for (const act of window.Schema.ENUMS.permActions) {
                if (checks[mod][act].checked) picked[act] = true;
              }
              if (Object.keys(picked).length) modules[mod] = picked;
            }
            try {
              await window.OrgRepo.roleSave({
                id: base.id || 0,
                name: nameIn.value,
                permissions: { data_scope: scopeSel.value, modules },
              });
              m.close();
              window.UI.toast(isNew ? '角色已创建' : '已保存', 'ok');
              AppShell.nav('org');
            } catch (err) {
              errBox.textContent = window.Errors.normalize(err).message;
            }
          },
        }),
      ],
    });
    setTimeout(() => nameIn.focus(), 60);
  }

  /* ============================================================ */

  function bind(pageEl) {
    const nav = () => AppShell.nav('org');

    window.UI.delegate(pageEl, '[data-tab]', 'click', (ev, btn) => {
      state.tab = btn.dataset.tab;
      nav();
    });

    // ---- 成员 ----
    const kw = pageEl.querySelector('#uKeyword');
    if (kw) {
      kw.addEventListener('input', window.UI.debounce(() => {
        state.keyword = kw.value.trim();
        nav().then(() => {
          const s = document.getElementById('uKeyword');
          if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
        });
      }, 320));
    }

    ['#uDept|department_id', '#uRole|role_id', '#uStatus|status'].forEach(pair => {
      const [id, key] = pair.split('|');
      const el = pageEl.querySelector(id);
      if (el) el.addEventListener('change', () => { state[key] = el.value; nav(); });
    });

    const newUser = pageEl.querySelector('#newUser');
    if (newUser) newUser.addEventListener('click', () => openUserEditor(null));

    window.UI.delegate(pageEl, '[data-uedit]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const list = await window.OrgRepo.userList({ per_page: 9999 });
      const u = (list.items || []).find(x => String(x.id) === String(btn.dataset.uedit));
      if (u) openUserEditor(u);
    });

    window.UI.delegate(pageEl, '[data-utoggle]', 'click', async (ev, btn) => {
      ev.preventDefault();
      try {
        const r = await window.OrgRepo.userToggle(btn.dataset.utoggle);
        window.UI.toast(Number(r.status) === 1 ? '已启用' : '已停用', 'ok');
        nav();
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });

    window.UI.delegate(pageEl, '[data-upwd]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const pwd = await window.UI.prompt('输入新密码（至少 6 位）', {
        title: '重置密码', type: 'password', placeholder: '至少 6 位',
      });
      if (pwd === null) return;
      try {
        window.Validate.password(pwd, 'password');
        const list = await window.OrgRepo.userList({ per_page: 9999 });
        const u = (list.items || []).find(x => String(x.id) === String(btn.dataset.upwd));
        if (!u) return;
        await window.OrgRepo.userSave(Object.assign({}, u, {
          id: u.id, password: pwd,
        }));
        window.UI.toast('密码已重置', 'ok');
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });

    window.UI.delegate(pageEl, '[data-udel]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const go = await window.UI.confirm('删除后该成员无法登录（历史任务与日志会保留）。确定删除？', {
        danger: true, okText: '删除',
      });
      if (!go) return;
      try {
        await window.OrgRepo.userDelete(btn.dataset.udel);
        window.UI.toast('已删除', 'ok');
        nav();
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
      }
    });

    // ---- 部门 ----
    const newDept = pageEl.querySelector('#newDept');
    if (newDept) newDept.addEventListener('click', () => openDeptEditor(null, 0));

    window.UI.delegate(pageEl, '[data-dsub]', 'click', (ev, btn) => {
      ev.preventDefault();
      openDeptEditor(null, btn.dataset.dsub);
    });

    window.UI.delegate(pageEl, '[data-dedit]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const d = await window.OrgRepo.deptList();
      const node = (d.flat || []).find(x => String(x.id) === String(btn.dataset.dedit));
      if (node) openDeptEditor(node, node.parent_id);
    });

    window.UI.delegate(pageEl, '[data-ddel]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const go = await window.UI.confirm('确定删除这个部门？部门下有成员或子部门时无法删除。', {
        danger: true, okText: '删除',
      });
      if (!go) return;
      try {
        await window.OrgRepo.deptDelete(btn.dataset.ddel);
        window.UI.toast('已删除', 'ok');
        nav();
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err', { duration: 6000 });
      }
    });

    // ---- 角色 ----
    const newRole = pageEl.querySelector('#newRole');
    if (newRole) newRole.addEventListener('click', () => openRoleEditor(null));

    window.UI.delegate(pageEl, '[data-redit]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const roles = await window.OrgRepo.roleList();
      const r = roles.find(x => String(x.id) === String(btn.dataset.redit));
      if (r) openRoleEditor(r);
    });

    window.UI.delegate(pageEl, '[data-rdel]', 'click', async (ev, btn) => {
      ev.preventDefault();
      const go = await window.UI.confirm('确定删除这个角色？有成员在用该角色时无法删除。', {
        danger: true, okText: '删除',
      });
      if (!go) return;
      try {
        await window.OrgRepo.roleDelete(btn.dataset.rdel);
        window.UI.toast('已删除', 'ok');
        nav();
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err', { duration: 6000 });
      }
    });
  }

  window.Pages.org = { render, bind, openUserEditor, openDeptEditor, openRoleEditor };
})();
