/* ============================================================
 * data/orgRepo.js —— 组织架构：用户 / 部门 / 角色
 *
 * 覆盖 PHP 版 api/org.php 的 9 个 action：
 *   dept_list / dept_save / dept_delete
 *   role_list / role_save / role_delete
 *   user_list / user_save / user_toggle
 *
 * 关键约束：
 *   - 不能删除自己（会把自己锁在门外）
 *   - 不能删除最后一个管理员
 *   - 部门有下属成员时不允许删除（可先转移）
 *   - 角色有成员在用时不允删除
 *   - 用户名唯一（靠索引 + 显式检查双保险）
 * ============================================================ */

(function () {
  'use strict';

  const E = window.Errors;
  const V = window.Validate;
  const S = window.Schema;
  const DB = window.DB;
  const Repo = window.Repo;

  /* ============================================================
   * 用户
   * ============================================================ */

  /** 装饰：补角色名、部门名、头像 */
  async function decorateUsers(rows) {
    if (!rows || !rows.length) return [];
    const [roles, depts] = await Promise.all([
      DB.read('roles', c => c.getAll('roles')),
      DB.read('departments', c => c.getAll('departments')),
    ]);
    const roleMap = new Map(roles.map(r => [Number(r.id), r]));
    const deptMap = new Map(depts.map(d => [Number(d.id), d]));

    return rows.map(u => {
      const role = roleMap.get(Number(u.role_id)) || null;
      const dept = deptMap.get(Number(u.department_id)) || null;
      return Object.assign({}, u, {
        role_name: role ? role.name : '',
        department_name: dept ? dept.name : '',
        avatar_url: u.avatar || avatarDataUri(u.real_name || u.username),
        status_name: Number(u.status) === 1 ? '启用' : '停用',
        is_self: Number(u.id) === window.Auth.currentUserId(),
        password: undefined,        // 绝不把密码哈希带给 UI
      });
    });
  }

  /**
   * 生成头像（本地 SVG data URI，零外部请求）
   *
   * 与 PHP 版 avatarFallback 一致：中文取最后一个字，英文取首字母大写。
   */
  function avatarDataUri(name, palette) {
    const n = String(name || 'U').trim() || 'U';
    const hasCjk = /[\u4e00-\u9fa5]/.test(n);
    const chars = Array.from(n);
    const ch = hasCjk ? chars[chars.length - 1] : chars[0].toUpperCase();
    const colors = {
      tech: '#16a34a', blue: '#2563eb', indigo: '#4f46e5',
      purple: '#7c3aed', rose: '#e11d48', amber: '#d97706',
    };
    // 按名字散列选色，同一人始终同色
    let h = 0;
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    const keys = Object.keys(colors);
    const bg = colors[palette] || colors[keys[h % keys.length]];

    const esc = String(ch).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
      + '<rect width="64" height="64" rx="14" fill="' + bg + '"/>'
      + '<text x="32" y="32" dy=".36em" text-anchor="middle" fill="#fff" '
      + 'font-family="-apple-system,Segoe UI,Microsoft YaHei,sans-serif" '
      + 'font-size="30" font-weight="600">' + esc + '</text></svg>';
    try {
      return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    } catch (_) {
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }
  }

  /** 用户列表 */
  async function userList(q) {
    window.Auth.requirePerm('org', 'view');
    const query = q || {};
    let rows = await Repo.all('users');

    if (query.keyword) {
      const s = String(query.keyword).slice(0, 60);
      rows = rows.filter(u => Repo.matchAny(u, s, ['username', 'real_name', 'email', 'phone']));
    }
    if (query.department_id) {
      const did = V.idLoose(query.department_id);
      rows = rows.filter(u => Number(u.department_id) === did);
    }
    if (query.role_id) {
      const rid = V.idLoose(query.role_id);
      rows = rows.filter(u => Number(u.role_id) === rid);
    }
    if (query.status !== undefined && query.status !== '') {
      const st = V.asInt(query.status, -1);
      if (st >= 0) rows = rows.filter(u => Number(u.status) === st);
    }

    rows = Repo.sortBy(await decorateUsers(rows), ['role_id', 'department_id', 'id']);
    return Repo.paginate(rows, query.page, query.per_page || 100);
  }

  /** 保存用户（新建或编辑） */
  async function userSave(input) {
    const me = window.Auth.currentUser();
    if (!me) throw new E.AppError('请先登录', 'E_AUTH');

    const id = V.idLoose(input.id);
    const canAdd = window.Auth.can('org', 'add');
    const canEdit = window.Auth.can('org', 'edit');
    if (!id && !canAdd) throw new E.AppError('您没有新增成员的权限', 'E_PERM');
    if (id && !canEdit) throw new E.AppError('您没有编辑成员的权限', 'E_PERM');

    const username = V.username(input.username);
    const realName = V.required(input.real_name, 'real_name', '姓名');
    V.maxLen(realName, 64, 'real_name', '姓名');
    const email = V.email(input.email);
    const phone = V.phone(input.phone);
    const roleId = V.idLoose(input.role_id) || 3;
    const deptId = V.idLoose(input.department_id);
    const password = String(input.password || '');

    // 角色与部门必须存在
    const role = await Repo.get('roles', roleId);
    if (!role) throw new E.AppError('所选角色不存在', 'E_ROLE');
    if (deptId) {
      const dept = await Repo.get('departments', deptId);
      if (!dept) throw new E.AppError('所选部门不存在', 'E_DEPT');
    }

    if (id) {
      const old = await Repo.get('users', id);
      if (!old) throw new E.AppError('成员不存在或已被删除', 'E_NOTFOUND');

      // 用户名改了要查重
      if (old.username !== username) {
        await assertUsernameFree(username, id);
      }
      // 不允许把最后一个管理员降级
      if (Number(old.role_id) === 1 && roleId !== 1) {
        await assertNotLastAdmin(id);
      }
      // 不能停用自己
      if (Number(id) === Number(me.id) && Number(input.status) === 0) {
        throw new E.AppError('不能停用当前登录的账号', 'E_SELF');
      }

      const patch = {
        username, real_name: realName, email, phone,
        role_id: roleId, department_id: deptId,
        status: input.status === undefined ? Number(old.status) : (V.asInt(input.status, 1) ? 1 : 0),
        avatar: input.avatar === undefined ? old.avatar : (input.avatar || null),
      };

      if (password) {
        V.password(password, 'password');
        patch.password = await window.Auth.hashPassword(password);
      }

      const saved = await Repo.save('users', Object.assign({}, old, patch, { id }));

      // 改的是自己 → 刷新内存中的权限
      if (Number(id) === Number(me.id)) {
        window.Auth.setUser(saved, role);
      }

      window.OpLog && window.OpLog.write('编辑成员', String(id), username);
      return sanitizeUser(saved);
    }

    await assertUsernameFree(username, 0);
    if (!password) throw new V.ValidationError('请为成员设置初始密码', 'password');
    V.password(password, 'password');

    const row = {
      username, real_name: realName, email, phone,
      password: await window.Auth.hashPassword(password),
      role_id: roleId, department_id: deptId,
      status: 1, avatar: null, deleted: false,
    };

    const saved = await Repo.save('users', row, { strict: true });
    window.OpLog && window.OpLog.write('新增成员', String(saved.id), username);
    return sanitizeUser(saved);
  }

  /**
   * 保存自己的资料（个人中心用）
   *
   * 为什么不能复用 userSave：userSave 要求「组织管理」权限，
   * 普通成员改自己的姓名也会被权限拦下 —— 这是 2026-10-28 修复的缺陷。
   *
   * 边界：只允许改 3 个纯个人字段，**不允许**碰 username / role_id /
   * department_id / status / password —— 越权改角色等于自己给自己升权。
   */
  async function profileSelfSave(input) {
    const me = window.Auth.currentUser();
    if (!me) throw new E.AppError('请先登录', 'E_AUTH');

    const id = V.idLoose(me.id);
    const old = await Repo.get('users', id);
    if (!old) throw new E.AppError('成员不存在或已被删除', 'E_NOTFOUND');

    const realName = V.required(input.real_name, 'real_name', '姓名');
    V.maxLen(realName, 64, 'real_name', '姓名');
    const email = V.email(input.email);
    const phone = V.phone(input.phone);

    // 只挑这 3 个字段进 patch，其余一律沿用旧值（白名单式更新）
    const patch = { real_name: realName, email, phone };
    const saved = await Repo.save('users', Object.assign({}, old, patch, { id }));

    window.OpLog && window.OpLog.write('修改个人资料', String(id), old.username);
    return sanitizeUser(saved);
  }

  /** 启用 / 停用 */
  async function userToggle(id) {
    const me = window.Auth.currentUser();
    window.Auth.requirePerm('org', 'edit');
    const uid = V.idLoose(id);
    const user = await Repo.get('users', uid);
    if (!user) throw new E.AppError('成员不存在', 'E_NOTFOUND');
    if (Number(uid) === Number(me.id)) {
      throw new E.AppError('不能停用当前登录的账号', 'E_SELF');
    }
    if (Number(user.role_id) === 1 && Number(user.status) === 1) {
      await assertNotLastAdmin(uid);
    }

    const saved = await Repo.save('users', Object.assign({}, user, {
      status: Number(user.status) === 1 ? 0 : 1,
    }));
    window.OpLog && window.OpLog.write(saved.status === 1 ? '启用成员' : '停用成员', String(uid), user.username);
    return sanitizeUser(saved);
  }

  /** 删除成员（软删除） */
  async function userDelete(id) {
    const me = window.Auth.currentUser();
    window.Auth.requirePerm('org', 'delete');
    const uid = V.idLoose(id);
    if (Number(uid) === Number(me.id)) {
      throw new E.AppError('不能删除当前登录的账号', 'E_SELF');
    }
    const user = await Repo.get('users', uid);
    if (!user) throw new E.AppError('成员不存在', 'E_NOTFOUND');
    if (Number(user.role_id) === 1) await assertNotLastAdmin(uid);

    await Repo.softDelete('users', uid);
    window.OpLog && window.OpLog.write('删除成员', String(uid), user.username);
    return { id: uid };
  }

  async function assertUsernameFree(username, exceptId) {
    const rows = await Repo.byIndex('users', 'by_username', username);
    const hit = (rows || []).find(u => Number(u.id) !== Number(exceptId || 0) && !u.deleted);
    if (hit) throw new E.AppError('用户名「' + username + '」已被占用', 'E_DUP');
  }

  async function assertNotLastAdmin(exceptId) {
    const users = (await Repo.all('users')).filter(u =>
      Number(u.role_id) === 1 && Number(u.status) === 1 && Number(u.id) !== Number(exceptId)
    );
    if (!users.length) {
      throw new E.AppError('这是最后一个管理员账号，不能停用或降级', 'E_LAST_ADMIN');
    }
  }

  /** 剥掉密码字段再交给 UI */
  function sanitizeUser(u) {
    const out = Object.assign({}, u);
    delete out.password;
    return out;
  }

  /* ============================================================
   * 部门
   * ============================================================ */

  async function deptList() {
    const [rows, users] = await Promise.all([
      Repo.all('departments'),
      Repo.all('users'),
    ]);

    const memberCount = new Map();
    for (const u of users) {
      const d = Number(u.department_id);
      if (!d) continue;
      memberCount.set(d, (memberCount.get(d) || 0) + 1);
    }

    const list = rows.map(d => Object.assign({}, d, {
      member_count: memberCount.get(Number(d.id)) || 0,
      manager_name: (users.find(u => Number(u.id) === Number(d.manager_id)) || {}).real_name || '',
    }));

    return buildTree(Repo.sortBy(list, ['parent_id', 'id']));
  }

  /** 构造树形结构（支持多级） */
  function buildTree(flat) {
    const map = new Map();
    const roots = [];
    for (const d of flat) map.set(Number(d.id), Object.assign({}, d, { children: [] }));
    for (const d of flat) {
      const node = map.get(Number(d.id));
      const pid = Number(d.parent_id);
      if (pid > 0 && map.has(pid)) {
        map.get(pid).children.push(node);
      } else {
        roots.push(node);
      }
    }
    return { tree: roots, flat };
  }

  async function deptSave(input) {
    const id = V.idLoose(input.id);
    const canAdd = window.Auth.can('org', 'add');
    const canEdit = window.Auth.can('org', 'edit');
    if (!id && !canAdd) throw new E.AppError('您没有新增部门的权限', 'E_PERM');
    if (id && !canEdit) throw new E.AppError('您没有编辑部门的权限', 'E_PERM');

    const name = V.required(input.name, 'name', '部门名称');
    V.maxLen(name, 64, 'name', '部门名称');
    const parentId = V.idLoose(input.parent_id);

    // 父部门不能是自己，也不能是自己的后代（否则树成环）
    if (id) {
      if (parentId === id) throw new E.AppError('上级部门不能是自己', 'E_CYCLE');
      const all = await Repo.all('departments');
      let cur = parentId;
      let guard = 0;
      while (cur > 0 && guard++ < 20) {
        if (cur === id) throw new E.AppError('不能把部门移动到它自己的下级里', 'E_CYCLE');
        const p = all.find(x => Number(x.id) === cur);
        cur = p ? Number(p.parent_id) : 0;
      }
    }

    // 同级同名检查
    const siblings = (await Repo.all('departments')).filter(d =>
      Number(d.parent_id) === parentId && Number(d.id) !== Number(id || 0)
    );
    if (siblings.some(d => d.name === name)) {
      throw new E.AppError('同级下已有同名部门', 'E_DUP');
    }

    const row = {
      name, parent_id: parentId,
      manager_id: V.idLoose(input.manager_id),
      description: V.clip(String(input.description || ''), 255),
      deleted: false,
    };

    if (id) {
      const old = await Repo.get('departments', id);
      if (!old) throw new E.AppError('部门不存在', 'E_NOTFOUND');
      const saved = await Repo.save('departments', Object.assign({}, old, row, { id }));
      window.OpLog && window.OpLog.write('编辑部门', String(id), name);
      return saved;
    }
    const saved = await Repo.save('departments', row, { strict: true });
    window.OpLog && window.OpLog.write('新建部门', String(saved.id), name);
    return saved;
  }

  async function deptDelete(id) {
    window.Auth.requirePerm('org', 'delete');
    const did = V.idLoose(id);
    const dept = await Repo.get('departments', did);
    if (!dept) throw new E.AppError('部门不存在', 'E_NOTFOUND');

    // 有成员不允许删（先转移，避免出现无归属成员）
    const users = (await Repo.all('users')).filter(u => Number(u.department_id) === did);
    if (users.length) {
      throw new E.AppError(
        `该部门下还有 ${users.length} 位成员，请先把他们移到其他部门再删除`,
        'E_HAS_MEMBERS'
      );
    }

    // 有子部门不允许删
    const children = (await Repo.all('departments')).filter(d => Number(d.parent_id) === did);
    if (children.length) {
      throw new E.AppError(`该部门下还有 ${children.length} 个子部门，请先删除子部门`, 'E_HAS_CHILDREN');
    }

    await Repo.hardDelete('departments', did);
    window.OpLog && window.OpLog.write('删除部门', String(did), dept.name);
    return { id: did };
  }

  /* ============================================================
   * 角色
   * ============================================================ */

  async function roleList() {
    const rows = await Repo.all('roles');
    const users = await Repo.all('users');

    const countMap = new Map();
    for (const u of users) {
      const r = Number(u.role_id);
      countMap.set(r, (countMap.get(r) || 0) + 1);
    }

    return Repo.sortBy(rows.map(r => Object.assign({}, r, {
      permissions: window.Auth.parsePermissions(r.permissions),
      user_count: countMap.get(Number(r.id)) || 0,
      is_admin: Number(r.id) === 1,
    })), ['id']);
  }

  async function roleSave(input) {
    window.Auth.requirePerm('org', 'edit');
    const id = V.idLoose(input.id);
    const name = V.required(input.name, 'name', '角色名称');
    V.maxLen(name, 64, 'name', '角色名称');

    // 权限对象要做白名单清洗，防止塞入未知模块/动作
    const raw = input.permissions;
    let perms;
    if (typeof raw === 'string') {
      try { perms = JSON.parse(raw); } catch (_) { perms = null; }
    } else {
      perms = raw;
    }
    if (!perms || typeof perms !== 'object') {
      throw new V.ValidationError('权限配置格式不正确', 'permissions');
    }

    const clean = {
      data_scope: V.oneOf(perms.data_scope, S.ENUMS.dataScope, 'self'),
      modules: {},
    };
    if (perms.modules && typeof perms.modules === 'object') {
      for (const mod of S.ENUMS.permModules) {
        const acts = perms.modules[mod];
        if (!acts || typeof acts !== 'object') continue;
        const picked = {};
        for (const a of S.ENUMS.permActions) {
          if (acts[a]) picked[a] = true;
        }
        if (Object.keys(picked).length) clean.modules[mod] = picked;
      }
    }

    if (id === 1) {
      // 超管的权限不可改（否则可能把自己锁死）
      const old = await Repo.get('roles', 1);
      if (!old) throw new E.AppError('角色不存在', 'E_NOTFOUND');
      const saved = await Repo.save('roles', Object.assign({}, old, { name, permissions: old.permissions }));
      window.OpLog && window.OpLog.write('重命名角色', '1', name);
      return saved;
    }

    if (id) {
      const old = await Repo.get('roles', id);
      if (!old) throw new E.AppError('角色不存在', 'E_NOTFOUND');
      const saved = await Repo.save('roles', Object.assign({}, old, { name, permissions: clean }));
      window.OpLog && window.OpLog.write('编辑角色', String(id), name);
      // 当前用户所在角色被改 → 刷新权限
      if (Number((window.Auth.currentUser() || {}).role_id) === Number(id)) {
        window.Auth.refreshPermissions(saved);
      }
      return saved;
    }

    const saved = await Repo.save('roles', { name, permissions: clean }, { strict: true });
    window.OpLog && window.OpLog.write('新建角色', String(saved.id), name);
    return saved;
  }

  async function roleDelete(id) {
    window.Auth.requirePerm('org', 'delete');
    const rid = V.idLoose(id);
    if (rid === 1) throw new E.AppError('系统管理员角色不能删除', 'E_PROTECTED');

    const role = await Repo.get('roles', rid);
    if (!role) throw new E.AppError('角色不存在', 'E_NOTFOUND');

    const users = (await Repo.all('users')).filter(u => Number(u.role_id) === rid);
    if (users.length) {
      throw new E.AppError(`还有 ${users.length} 位成员使用该角色，请先调整他们的角色`, 'E_IN_USE');
    }

    await Repo.hardDelete('roles', rid);
    window.OpLog && window.OpLog.write('删除角色', String(rid), role.name);
    return { id: rid };
  }

  /* ============================================================
   * 精简选项（供任务表单的选择器使用）
   * ============================================================ */

  async function userOptions() {
    const rows = (await Repo.all('users')).filter(u => Number(u.status) === 1);
    return Repo.sortBy(rows.map(u => ({
      id: Number(u.id),
      name: u.real_name || u.username,
      username: u.username,
      department_id: Number(u.department_id || 0),
      avatar_url: u.avatar || avatarDataUri(u.real_name || u.username),
    })), ['id']);
  }

  async function deptOptions() {
    const rows = Repo.sortBy(await Repo.all('departments'), ['parent_id', 'id']);
    return rows.map(d => ({
      id: Number(d.id),
      name: d.name,
      parent_id: Number(d.parent_id || 0),
    }));
  }

  window.OrgRepo = {
    userList, userSave, userToggle, userDelete, userOptions,
    profileSelfSave,
    deptList, deptSave, deptDelete, deptOptions, buildTree,
    roleList, roleSave, roleDelete,
    avatarDataUri, sanitizeUser,
  };
})();
