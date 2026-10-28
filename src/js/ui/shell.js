/* ============================================================
 * ui/shell.js —— 应用外壳：路由、布局、全局交互
 *
 * 职责：
 *   - hash 路由（file:// 下 history API 不可靠）
 *   - 侧边栏 / 顶栏 / 主题 / 全局搜索 / 快捷键
 *   - 登录态守卫、首启向导
 *   - 自动保存调度、退出前提醒
 *
 * 设计原则：
 *   页面模块（pages/*.js）只负责"渲染自己那块内容"，
 *   不关心导航、主题、保存。这样新增页面只需注册到 ROUTES。
 * ============================================================ */

(function () {
  'use strict';

  const E = window.Errors;

  /* UI 常用方法：解构出来避免每处都写 UI.xxx
   * 注意必须在所有调用点之前绑定，否则会出现 "toast is not defined"。 */
  const {
    raw, toast, confirm: uiConfirm, modal, el, escape: esc,
    $, $$, mount, spinner, errorBlock, busy, delegate,
  } = window.UI;

  /** 路由表：id → { title, perm, render, hideInNav } */
  const ROUTES = {
    dashboard: { id: 'dashboard', title: '工作台', perm: ['dashboard', 'view'], icon: 'grid' },
    plans: { id: 'plans', title: '任务计划', perm: ['plans', 'view'], icon: 'list' },
    plan_manage: { id: 'plan_manage', title: '计划管理', perm: ['plans', 'view'], icon: 'chart', group: '管理' },
    board: { id: 'board', title: '提醒中心', perm: ['board', 'view'], icon: 'bell' },
    logs: { id: 'logs', title: '工作日志', perm: ['logs', 'view'], icon: 'doc' },
    reports: { id: 'reports', title: '统计报表', perm: ['reports', 'view'], icon: 'pie', group: '管理' },
    org: { id: 'org', title: '组织架构', perm: ['org', 'view'], icon: 'users', group: '管理' },
    settings: { id: 'settings', title: '系统设置', perm: ['settings', 'view'], icon: 'gear', group: '管理' },
    oplogs: { id: 'oplogs', title: '操作日志', perm: ['oplogs', 'view'], icon: 'clock', group: '管理' },
    profile: { id: 'profile', title: '用户中心', perm: null, icon: 'user' },
    trash: { id: 'trash', title: '回收站', perm: ['plans', 'edit'], icon: 'trash', group: '管理' },
  };

  const ICONS = {
    grid: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z',
    list: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
    bell: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
    doc: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    chart: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    pie: 'M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z',
    users: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
    gear: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    clock: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
    user: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
    trash: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
  };

  const App = {
    route: 'dashboard',
    user: null,
    settings: null,
    autoSaveTimer: null,
    AUTO_SAVE_MS: 1200,
    _bound: false,

    /* ---------------- 启动 ---------------- */

    async start() {
      E.Log.info('shell', '应用启动');

      // 1. 打开库 + 载入设置
      await window.DB.open();
      await window.Settings.ensureSettings();
      // 申请持久化，降低被浏览器清掉的概率
      window.DB.requestPersistence().then(r => {
        if (r && r.persisted) E.Log.info('shell', '存储已申请持久化');
      }).catch(() => {});

      // 2. 页面内嵌的 data.js 优先导入（换电脑场景）
      let boot = null;
      try {
        boot = await window.FileIO.bootstrapFromScript();
      } catch (e) {
        E.Log.error('shell', '自动载入数据失败：' + e.message);
      }

      // 3. 是否已初始化
      const seeded = await window.Seed.isSeeded();
      if (!seeded) {
        await this.showFirstRun();
        return;
      }

      // 4. 恢复上次的目录句柄
      let dirState = { state: 'none' };
      try {
        dirState = await window.FileIO.init();
      } catch (e) {
        E.Log.warn('shell', '恢复目录授权失败：' + e.message);
      }

      // 5. 恢复会话
      const restored = await this.restoreSession();

      if (boot && boot.imported) {
        this._importedFromFile = true;
        this._importedSummary = this.countsText(boot.counts);
        toast('已从 data.js 载入数据（' + this._importedSummary + '）', 'ok');
      }

      if (!restored) {
        await this.showLogin();
        return;
      }

      await this.enterMain(dirState);
    },

    countsText(counts) {
      if (!counts) return '';
      const parts = [];
      const map = { tasks: '任务', plans: '计划', logs: '日志', users: '成员' };
      for (const k of Object.keys(map)) {
        if (counts[k]) parts.push(map[k] + ' ' + counts[k]);
      }
      return parts.join('，') || '空数据';
    },

    /** 恢复上次登录（用户被删/停用则失效） */
    async restoreSession() {
      const s = window.Auth.loadSession();
      if (!s) return false;
      try {
        const user = await window.Repo.get('users', s.user_id);
        if (!user || Number(user.status) !== 1) {
          window.Auth.clearSession();
          return false;
        }
        const role = await window.Repo.get('roles', user.role_id);
        window.Auth.setUser(user, role);
        this.user = user;
        return true;
      } catch (e) {
        E.Log.warn('shell', '恢复会话失败：' + e.message);
        return false;
      }
    },

    /* ---------------- 首启向导 ---------------- */

    async showFirstRun() {
      const root = document.getElementById('root');
      root.innerHTML = '';

      const form = UI.el('form', { class: 'firstrun', id: 'firstRunForm' });
      const errBox = UI.el('p', { class: 'fld__err', id: 'frErr' });

      const pwd = UI.input('adminPassword', '', {
        type: 'password', placeholder: '至少 6 位', autocomplete: 'new-password', required: 'required',
      });
      const pwd2 = UI.input('adminPassword2', '', {
        type: 'password', placeholder: '再输一次', autocomplete: 'new-password', required: 'required',
      });
      const name = UI.input('adminName', '管理员', { maxlength: 64 });
      const site = UI.input('siteName', '团队协作台', { maxlength: 64 });

      form.appendChild(UI.el('div', { class: 'firstrun__card' }, [
        UI.el('h1', { class: 'firstrun__title', text: '欢迎使用团队协作台' }),
        UI.el('p', { class: 'firstrun__sub', text: '这是第一次运行，请设置一个管理员密码。密码只保存在你自己电脑上。' }),
        UI.field('管理员姓名', name, {}),
        UI.field('站点名称', site, {}),
        UI.field('设置密码', pwd, { hint: '至少 6 位字符' }),
        UI.field('确认密码', pwd2, {}),
        errBox,
        UI.el('button', { class: 'btn btn--primary btn--block', type: 'submit', text: '开始使用' }),
      ]));

      root.appendChild(form);

      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        errBox.textContent = '';
        const a = pwd.value;
        const b = pwd2.value;
        if (a.length < 6) { errBox.textContent = '密码至少 6 位'; return; }
        if (a !== b) { errBox.textContent = '两次输入的密码不一致'; return; }

        try {
          UI.busy(true, '正在初始化…');
          await window.Seed.seed({
            adminPassword: a,
            adminName: name.value || '管理员',
            siteName: site.value || '团队协作台',
          });
          UI.busy(false);

          // 自动登录
          const user = await window.Repo.get('users', 1);
          const role = await window.Repo.get('roles', 1);
          window.Auth.setUser(user, role);
          this.user = user;

          toast('初始化完成，已自动登录', 'ok');
          const dirState = await window.FileIO.init().catch(() => ({ state: 'none' }));
          await this.enterMain(dirState);
        } catch (e) {
          UI.busy(false);
          const err = E.normalize(e);
          errBox.textContent = err.message;
          E.Log.error('firstrun', err.message);
        }
      });

      setTimeout(() => pwd.focus(), 100);
    },

    /* ---------------- 登录 ---------------- */

    async showLogin() {
      const root = document.getElementById('root');
      root.innerHTML = '';

      const form = UI.el('form', { class: 'login', id: 'loginForm' });
      const errBox = UI.el('p', { class: 'fld__err', id: 'loginErr' });
      const userIn = UI.input('username', '', { placeholder: '用户名', autocomplete: 'username', required: 'required' });
      const pwdIn = UI.input('password', '', { type: 'password', placeholder: '密码', autocomplete: 'current-password', required: 'required' });
      const submit = UI.el('button', { class: 'btn btn--primary btn--block', type: 'submit', text: '登录' });

      /* 刚从 data.js 载入数据时，给一句明确的提示：
       * 用户换了电脑、看到登录页，很容易以为"数据丢了"。
       * 这里告诉他数据已在，只需登录。 */
      const bootNotice = this._importedFromFile
        ? UI.el('div', { class: 'login__notice' }, [
            UI.el('strong', { text: '数据已载入' }),
            UI.el('p', { text: '已从 data.js 恢复 ' + this._importedSummary + '。请用原来的账号登录。' }),
            UI.el('p', { class: 'muted', text: '忘记密码可用管理员账号在「组织架构」里重置；若管理员密码也忘了，只能重新初始化（会清空数据）。' }),
          ])
        : null;

      form.appendChild(UI.el('div', { class: 'login__card' }, [
        UI.el('div', { class: 'login__brand' }, [
          UI.el('h1', { text: this.settings ? window.Settings.get('site_name', '团队协作台') : '团队协作台' }),
          UI.el('p', { text: window.Settings.get('site_subtitle', '团队任务与工作日志') }),
        ]),
        bootNotice,
        UI.field('用户名', userIn, {}),
        UI.field('密码', pwdIn, {}),
        errBox,
        submit,
        UI.el('p', { class: 'login__foot', text: '数据保存在本机，不联网、不上传' }),
      ]));

      root.appendChild(form);

      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        errBox.textContent = '';

        const username = userIn.value.trim();
        const password = pwdIn.value;

        if (!username || !password) {
          errBox.textContent = '请输入用户名和密码';
          return;
        }

        // 节流检查（按账号）
        const th = window.Auth.throttleCheck(username);
        if (th.blocked) {
          errBox.textContent = `尝试次数过多，请 ${th.retry_after} 秒后再试`;
          return;
        }

        submit.disabled = true;
        try {
          const user = await this.findUserByUsername(username);
          if (!user || Number(user.status) !== 1) {
            window.Auth.throttleFail(username);
            errBox.textContent = '用户名或密码不正确';
            return;
          }

          // 脱敏备份导入的账号：口令在导出时被剥离，需要先设置新口令。
          // 这条路径**不校验旧口令** —— 旧口令根本不存在于文件里。
          // 安全性由「谁拿到了这个备份文件」决定，与直接拿到文件本身同级别。
          if (window.Auth.isPasswordReset(user.password)) {
            const newHash = await this.setFirstPassword(user);
            if (!newHash) {
              errBox.textContent = '尚未设置新口令，无法登录';
              return;
            }
            user.password = newHash;
            window.Auth.throttleClear(username);
            const role2 = await window.Repo.get('roles', user.role_id);
            window.Auth.setUser(user, role2);
            this.user = user;
            await window.OpLog.write('首次设置口令并登录', username);
            toast('口令已设置，欢迎回来，' + (user.real_name || user.username), 'ok');
            const dirState2 = await window.FileIO.init().catch(() => ({ state: 'none' }));
            await this.enterMain(dirState2);
            return;
          }

          let ok = false;
          try {
            ok = await window.Auth.verifyPassword(password, user.password);
          } catch (e) {
            // bcrypt 密码（从 PHP 版迁移）
            errBox.textContent = e.message;
            return;
          }

          if (!ok) {
            window.Auth.throttleFail(username);
            const left = window.Auth.throttleCheck(username);
            errBox.textContent = '用户名或密码不正确' + (left.remaining <= 3 ? `（再错 ${left.remaining} 次将锁定）` : '');
            return;
          }

          window.Auth.throttleClear(username);
          const role = await window.Repo.get('roles', user.role_id);
          window.Auth.setUser(user, role);
          this.user = user;
          await window.OpLog.write('登录系统', username);

          toast('欢迎回来，' + (user.real_name || user.username), 'ok');
          const dirState = await window.FileIO.init().catch(() => ({ state: 'none' }));
          await this.enterMain(dirState);
        } catch (e) {
          const err = E.normalize(e);
          errBox.textContent = err.message;
          E.Log.error('login', err.message);
        } finally {
          submit.disabled = false;
        }
      });

      setTimeout(() => userIn.focus(), 100);
    },

    /** 按用户名查用户（用索引，大小写敏感由索引保证） */
    async findUserByUsername(username) {
      const rows = await window.Repo.byIndex('users', 'by_username', username);
      return (rows || []).find(u => !u.deleted) || null;
    },

    /**
     * 首次设置口令（脱敏备份导入的账号）
     *
     * 场景：备份文件在导出时剥离了口令哈希，导入后账号处于「需重设口令」状态。
     * 这里弹两个输入框收新口令，写回 users 表，然后放行登录。
     *
     * @returns {string|null} 新口令哈希；null 表示用户取消或输入无效
     */
    async setFirstPassword(user) {
      const pwd1 = await window.UI.prompt(
        '这个账号的口令在备份导出时已被移除（防止备份文件泄露口令）。请设置一个新口令（至少 6 位）。',
        { title: '设置新口令', type: 'password', placeholder: '至少 6 位' }
      );
      if (pwd1 === null) return null;
      const pwd2 = await window.UI.prompt('请再输入一次以确认。', {
        title: '确认新口令', type: 'password', placeholder: '再输一次',
      });
      if (pwd2 === null) return null;
      if (pwd1 !== pwd2) {
        window.UI.toast('两次输入的口令不一致', 'err');
        return null;
      }
      try {
        window.Validate.password(pwd1, 'password');
      } catch (err) {
        window.UI.toast(window.Errors.normalize(err).message, 'err');
        return null;
      }
      const hash = await window.Auth.hashPassword(pwd1);
      await window.Repo.save('users', Object.assign({}, user, { password: hash }));
      return hash;
    },

    /* ---------------- 主界面 ---------------- */

    async enterMain(dirState) {
      this.settings = await window.Settings.getAll();
      this.renderShell();
      this.bindShell();
      this.updateDirState(dirState);
      this.startAutoSaveLoop();
      this.checkDirtyOnExit();

      // 路由
      const route = this.parseHash();
      await this.nav(route, true);
    },

    parseHash() {
      const h = (location.hash || '#dashboard').replace(/^#/, '');
      const q = {};
      let id = h;
      const qi = h.indexOf('?');
      if (qi >= 0) {
        id = h.slice(0, qi);
        for (const pair of h.slice(qi + 1).split('&')) {
          const [k, v] = pair.split('=');
          if (k) q[decodeURIComponent(k)] = decodeURIComponent(v || '');
        }
      }
      this.routeQuery = q;
      return ROUTES[id] ? id : 'dashboard';
    },

    /** 渲染外壳（只做一次） */
    renderShell() {
      const root = document.getElementById('root');
      const user = this.user;
      const siteName = window.Settings.get('site_name', '团队协作台');
      const siteSub = window.Settings.get('site_subtitle', '');

      // 导航分组
      const groups = { '': [] };
      for (const id of Object.keys(ROUTES)) {
        const r = ROUTES[id];
        if (r.hideInNav) continue;
        if (r.perm && !window.Auth.can(r.perm[0], r.perm[1])) continue;
        if (id === 'profile') continue;
        const g = r.group || '';
        if (!groups[g]) groups[g] = [];
        groups[g].push(r);
      }

      const navHtml = Object.keys(groups).map(g => {
        if (!groups[g].length) return '';
        return `<div class="navgroup">
          ${g ? `<div class="navgroup__t">${UI.escape(g)}</div>` : '<div class="navgroup__t">核心</div>'}
          ${groups[g].map(r => `
            <a href="#${r.id}" class="navitem" data-route="${r.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="${ICONS[r.icon] || ICONS.grid}"/></svg>
              <span>${UI.escape(r.title)}</span>
              <em class="navitem__badge" data-badge="${r.id}" hidden></em>
            </a>`).join('')}
        </div>`;
      }).join('');

      const avatarUrl = user.avatar || window.OrgRepo.avatarDataUri(user.real_name || user.username);

      root.innerHTML = `
        <div class="app">
          <aside class="side" id="sidebar">
            <div class="brand">
              <span class="brand__logo">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${ICONS.list}"/></svg>
              </span>
              <div class="brand__text">
                <strong>${UI.escape(siteName)}</strong>
                <small>${UI.escape(siteSub)}</small>
              </div>
            </div>
            <nav class="nav" id="nav">${navHtml}</nav>
            <div class="side__foot">
              <div class="dirstate" id="dirState">未连接数据目录</div>
              <button class="btn btn--primary btn--block btn--sm" id="btnConnect" type="button">连接目录</button>
              <a href="#profile" class="userchip" data-route="profile">
                <img src="${UI.escapeAttr(avatarUrl)}" class="avatar" alt="">
                <span class="userchip__t">
                  <strong>${UI.escape(user.real_name || user.username)}</strong>
                  <small>${UI.escape((this.roleName() || ''))}</small>
                </span>
              </a>
              <button class="iconbtn iconbtn--full" id="btnLogout" type="button" title="退出登录">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
                <span>退出</span>
              </button>
            </div>
          </aside>

          <div class="main">
            <header class="top">
              <div class="top__l">
                <button class="iconbtn only-mobile" id="btnMenu" type="button" title="菜单">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
                </button>
                <div class="crumb">
                  <span>${UI.escape(siteName)}</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5l7 7-7 7"/></svg>
                  <strong id="pageTitle">工作台</strong>
                </div>
                <span class="dirty" id="dirtyDot" hidden title="有未写回文件的改动">●</span>
              </div>
              <div class="top__r">
                <div class="search" id="searchBox">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
                  <input type="search" id="globalSearch" placeholder="搜索任务、计划、日志… (Ctrl+K)" autocomplete="off">
                  <div class="search__panel" id="searchPanel" hidden></div>
                </div>
                <button class="iconbtn" id="btnTheme" type="button" title="切换主题">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" id="themeIcon"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
                </button>
                <button class="iconbtn" id="btnDiag" type="button" title="诊断信息">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.5 0L3.16 16.25A2 2 0 005 19z"/></svg>
                </button>
                <button class="btn btn--primary btn--sm" id="btnSaveFile" type="button">保存到目录</button>
              </div>
            </header>
            <main class="page" id="page"></main>
            <footer class="foot">
              <span id="footLeft">${UI.escape(siteName)}</span>
              <span class="foot__dot">·</span>
              <span id="footRight">数据保存在本机</span>
            </footer>
          </div>
        </div>
        <div class="overlay" id="sideOverlay"></div>`;

      // 主题
      this.applyTheme(this.settings.theme_default === 'dark' ? 'dark' : 'light');

      // 标题
      document.title = siteName;
    },

    roleName() {
      // 从角色缓存拿名字；只在登录时读一次
      return this._roleName || '';
    },

    async loadRoleName() {
      if (!this.user) return;
      const role = await window.Repo.get('roles', this.user.role_id);
      this._roleName = role ? role.name : '';
    },

    /* ---------------- 事件绑定（只绑一次） ---------------- */

    bindShell() {
      if (this._bound) return;
      this._bound = true;

      window.addEventListener('hashchange', () => {
        this.nav(this.parseHash());
      });

      // 侧栏导航
      document.getElementById('nav').addEventListener('click', (ev) => {
        const a = ev.target.closest('[data-route]');
        if (!a) return;
        this.closeSidebar();
      });

      // 退出
      document.getElementById('btnLogout').addEventListener('click', async () => {
        if (window.FileIO.isDirty()) {
          const go = await UI.confirm('还有改动没有写回文件，确定直接退出吗？', { danger: true, okText: '直接退出' });
          if (!go) return;
        }
        await window.OpLog.write('退出登录', this.user.username);
        window.Auth.clearSession();
        location.hash = '';
        location.reload();
      });

      // 移动端菜单
      const btnMenu = document.getElementById('btnMenu');
      if (btnMenu) btnMenu.addEventListener('click', () => this.toggleSidebar());
      const ov = document.getElementById('sideOverlay');
      if (ov) ov.addEventListener('click', () => this.closeSidebar());

      // 主题
      document.getElementById('btnTheme').addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        this.applyTheme(cur === 'dark' ? 'light' : 'dark');
      });

      // 诊断
      document.getElementById('btnDiag').addEventListener('click', () => UI.showDiagnostics());

      // 连接目录 / 保存
      document.getElementById('btnConnect').addEventListener('click', () => this.onConnectDir());
      document.getElementById('btnSaveFile').addEventListener('click', () => this.onSaveFile());

      // 全局搜索
      this.bindSearch();

      // 快捷键
      document.addEventListener('keydown', (ev) => {
        const tag = (ev.target && ev.target.tagName) || '';
        const inField = /INPUT|TEXTAREA|SELECT/.test(tag) || (ev.target && ev.target.isContentEditable);

        // Ctrl/Cmd + K 搜索
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
          ev.preventDefault();
          const s = document.getElementById('globalSearch');
          if (s) { s.focus(); s.select(); }
          return;
        }
        // Ctrl/Cmd + S 保存
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
          ev.preventDefault();
          this.onSaveFile();
          return;
        }
        // / 聚焦搜索
        if (ev.key === '/' && !inField) {
          ev.preventDefault();
          const s = document.getElementById('globalSearch');
          if (s) s.focus();
          return;
        }
        // n 新建（在任务页）
        if ((ev.key === 'n' || ev.key === 'N') && !inField && !ev.ctrlKey && !ev.metaKey) {
          if (this.route === 'plans' || this.route === 'dashboard') {
            ev.preventDefault();
            if (window.Pages && window.Pages.plans && window.Pages.plans.openEditor) {
              window.Pages.plans.openEditor(null);
            }
          }
        }
      });

      // 退出前提醒
      window.addEventListener('beforeunload', (ev) => {
        if (window.FileIO.isDirty()) {
          ev.preventDefault();
          ev.returnValue = '';
        }
      });

      // 网络状态
      window.addEventListener('online', () => {
        window.Bus.emit(window.Bus.EVENTS.NET_ONLINE, {});
        toast('网络已恢复（本程序不依赖网络）', 'info');
      });
      window.addEventListener('offline', () => {
        window.Bus.emit(window.Bus.EVENTS.NET_OFFLINE, {});
        toast('网络已断开（不影响使用）', 'info');
      });

      // 订阅数据变更 → 更新角标
      window.Bus.on(window.Bus.EVENTS.TASK_CHANGED, () => this.refreshBadges());
      window.Bus.on(window.Bus.EVENTS.LOG_CHANGED, () => this.refreshBadges());
      window.Bus.on(window.Bus.EVENTS.SETTINGS_CHANGED, async () => {
        this.settings = await window.Settings.getAll();
        this.applyTheme(document.documentElement.getAttribute('data-theme'));
      });
      window.Bus.on(window.Bus.EVENTS.QUOTA_WARN, () => {
        toast('存储空间快满了，请尽快「保存到目录」备份数据', 'err', { duration: 8000 });
      });
      window.Bus.on(window.Bus.EVENTS.FATAL, (err) => {
        if (err && !err.expected) toast('出现未预期的错误，可点右上角「诊断」查看详情', 'err');
      });

      this.loadRoleName()
        .then(() => this.renderUserChip && this.renderUserChip())
        .catch((err) => {
          // 角色名取不到只影响用户名牌上的小字，不能连带影响启动。
          window.Errors && window.Errors.Log
            && window.Errors.Log.warn('shell', '加载角色名失败：' + (err && err.message));
        });
      this.refreshBadges();
    },

    renderUserChip() {
      const chip = document.querySelector('.userchip small');
      if (chip) chip.textContent = this._roleName || '';
    },

    /* ---------------- 主题 ---------------- */

    applyTheme(theme) {
      const t = theme === 'dark' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', t);
      const icon = document.getElementById('themeIcon');
      if (icon) {
        icon.innerHTML = t === 'dark'
          ? '<path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>'
          : '<path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>';
      }
      try { localStorage.setItem('tp.theme', t); } catch (_) {}
      window.Bus.emit(window.Bus.EVENTS.THEME_CHANGED, { theme: t });
    },

    /* ---------------- 路由 ---------------- */

    async nav(routeId, isInitial) {
      const r = ROUTES[routeId] || ROUTES.dashboard;
      this.route = r.id;

      // 权限检查
      if (r.perm && !window.Auth.can(r.perm[0], r.perm[1])) {
        const pageEl = document.getElementById('page');
        pageEl.innerHTML = UI.errorBlock(
          new E.AppError('您没有访问「' + r.title + '」的权限', 'E_PERM')
        );
        this.setTitle('无权限');
        return;
      }

      // 导航高亮
      UI.$$('.navitem').forEach(a => {
        a.classList.toggle('is-active', a.dataset.route === r.id);
      });
      this.setTitle(r.title);
      this.closeSidebar();

      const pageEl = document.getElementById('page');

      /* 换页前清掉上一页挂在容器上的委托监听器。
       * #page 是复用容器，innerHTML 替换不影响容器自身的监听器，
       * 不清理就会累积 —— 导航 N 次后一次点击触发 N 次业务操作。 */
      UI.clearDelegates(pageEl);

      UI.mount(pageEl, UI.spinner());

      const mod = window.Pages && window.Pages[r.id];
      if (!mod || typeof mod.render !== 'function') {
        UI.mount(pageEl, UI.errorBlock(new E.AppError('页面「' + r.title + '」尚未实现', 'E_NOPAGE')));
        return;
      }

      await UI.boundary(pageEl, () => mod.render({ query: this.routeQuery || {} }), { tag: 'page:' + r.id });

      // 渲染成功后绑定事件（bind 内部自己捕获异常，不影响已经画好的界面）
      if (typeof mod.bind === 'function') {
        try {
          mod.bind(pageEl, { query: this.routeQuery || {} });
        } catch (e) {
          const err = E.normalize(e);
          E.Log.error('page:bind:' + r.id, err.message, { stack: String(err.stack || '').slice(0, 600) });
        }
      }

      // 部分页面需要在渲染后聚焦某个输入（如搜索跳转）
      if (typeof mod.afterRender === 'function') {
        try { mod.afterRender(pageEl, { query: this.routeQuery || {} }); } catch (_) {}
      }

      window.Bus.emit(window.Bus.EVENTS.ROUTE_CHANGED, { route: r.id });
      // 回到顶部
      pageEl.scrollTop = 0;
    },

    setTitle(t) {
      const el = document.getElementById('pageTitle');
      if (el) el.textContent = t;
      document.title = t + ' · ' + window.Settings.get('site_name', '团队协作台');
    },

    /** 刷新导航角标（提醒数 / 待办数） */
    async refreshBadges() {
      try {
        const up = await window.TaskRepo.upcoming(0);
        const n = up.overdue.length;
        const badge = document.querySelector('[data-badge="board"]');
        if (badge) {
          if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.hidden = false; }
          else badge.hidden = true;
        }
        // 同步到标签页标题（托盘的替代方案）
        if (window.FileIO) window.FileIO.setOverdue(n);

        const stats = await window.LogRepo.stats();
        /* 日报提醒角标
         *
         * 受设置项 log_reminder 控制（设置 → 界面偏好）。
         * 之前这个设置项只定义没被读取，导致红点关不掉 —— 用户反馈"能否取消"，
         * 所以这里必须真正消费它，而不是写死。
         *
         * 只在工作日提醒：周末不写日报是正常的，不该一直挂红点。 */
        const logBadge = document.querySelector('[data-badge="logs"]');
        if (logBadge) {
          const wantRemind = window.Settings.getBool('log_reminder', true);
          const isWorkDay = window.Settings.isWorkDay(window.Validate.today());
          const shouldShow = wantRemind && isWorkDay && !stats.has_today;
          if (shouldShow) {
            logBadge.textContent = '!';
            logBadge.hidden = false;
            logBadge.title = '今天还没写日报';
          } else {
            logBadge.hidden = true;
          }
        }
      } catch (e) {
        E.Log.warn('shell', '刷新角标失败：' + e.message);
      }
    },

    /* ---------------- 侧边栏（移动端） ---------------- */

    toggleSidebar() {
      const s = document.getElementById('sidebar');
      const o = document.getElementById('sideOverlay');
      if (!s) return;
      const open = s.classList.toggle('is-open');
      if (o) o.hidden = !open;
      document.body.classList.toggle('is-side', open);
    },

    closeSidebar() {
      const s = document.getElementById('sidebar');
      const o = document.getElementById('sideOverlay');
      if (s) s.classList.remove('is-open');
      if (o) o.hidden = true;
      document.body.classList.remove('is-side');
    },

    /* ---------------- 全局搜索 ---------------- */

    bindSearch() {
      const box = document.getElementById('searchBox');
      const input = document.getElementById('globalSearch');
      const panel = document.getElementById('searchPanel');
      if (!input || !panel) return;

      const run = UI.debounce(async () => {
        const q = input.value.trim();
        if (q.length < 1) {
          panel.hidden = true;
          panel.innerHTML = '';
          return;
        }

        panel.hidden = false;
        panel.innerHTML = UI.spinner('搜索中…').toString();

        try {
          const r = await window.SearchRepo.search(q, 6);
          if (!r.total) {
            panel.innerHTML = '<div class="search__empty">没有找到匹配内容</div>';
            return;
          }

          // items 必须是数组：参数传错时静默跳过该段，
          // 而不是让整个搜索面板崩成"搜索出错"（这个 bug 真实发生过）
          const sec = (title, items, fmt) => {
            if (!Array.isArray(items) || !items.length) return '';
            return `<div class="search__sec">
              <div class="search__t">${UI.escape(title)}</div>
              ${items.map(fmt).join('')}
            </div>`;
          };

          panel.innerHTML =
            sec('任务', r.tasks, t => `<a class="search__item" href="#plans" data-goto="task:${t.id}">
                <span class="search__name">${UI.escape(t.title)}</span>
                <span class="pill pill--${UI.escapeAttr(t.status)}">${UI.escape(t.status_name)}</span>
                <span class="search__meta">${UI.escape(t.task_date || '')}</span></a>`) +
            sec('计划', r.plans, p => `<a class="search__item" href="#plan_manage" data-goto="plan:${p.id}">
                <span class="search__name">${UI.escape(p.title)}</span>
                <span class="search__meta">${UI.escape(p.type_name)}</span></a>`) +
            sec('日志', r.logs, l => `<a class="search__item" href="#logs" data-goto="log:${l.id}">
                <span class="search__name">${UI.escape(l.excerpt)}</span>
                <span class="search__meta">${UI.escape(l.date_range || '')}</span></a>`) +
            sec('成员', r.users, u => `<a class="search__item" href="#org" data-goto="user:${u.id}">
                <span class="search__name">${UI.escape(u.real_name || u.username)}</span></a>`);
        } catch (e) {
          panel.innerHTML = '<div class="search__empty">搜索出错：' + UI.escape(e.message) + '</div>';
        }
      }, 260);

      input.addEventListener('input', run);
      input.addEventListener('focus', () => {
        if (input.value.trim()) run();
      });

      // 点击结果
      panel.addEventListener('click', (ev) => {
        const a = ev.target.closest('[data-goto]');
        if (a) {
          this.routeQuery = Object.assign({}, this.routeQuery, { goto: a.dataset.goto });
          panel.hidden = true;
        }
      });

      // 点空白处收起
      document.addEventListener('click', (ev) => {
        if (!box.contains(ev.target)) panel.hidden = true;
      });

      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          panel.hidden = true;
          input.blur();
        }
      });
    },

    /* ---------------- 数据目录 ---------------- */

    updateDirState(st) {
      const el = document.getElementById('dirState');
      const btn = document.getElementById('btnConnect');
      if (!el) return;

      if (st && st.state === 'granted' && st.name) {
        el.textContent = '数据目录：' + st.name;
        el.className = 'dirstate dirstate--ok';
        if (btn) btn.textContent = '更换目录';
      } else if (st && st.state === 'prompt' && st.name) {
        el.textContent = '目录待授权：' + st.name;
        el.className = 'dirstate dirstate--warn';
        if (btn) btn.textContent = '授权';
      } else if (st && st.name) {
        el.textContent = '目录：' + st.name;
        el.className = 'dirstate dirstate--warn';
        if (btn) btn.textContent = '重新授权';
      } else {
        el.textContent = '未连接数据目录';
        el.className = 'dirstate dirstate--none';
        if (btn) btn.textContent = '连接目录';
      }
    },

    async onConnectDir() {
      if (!window.FileIO.capability().picker) {
        toast('当前浏览器不支持选择文件夹。请用 Edge / Chrome，或点「导出备份」手动保存数据。', 'warn', { duration: 7000 });
        return;
      }
      try {
        const r = await window.FileIO.pickDirectory();
        this.updateDirState({ state: 'granted', name: r.name });
        if (r.wrote) {
          toast('已连接「' + r.name + '」，数据已写入 ' + r.file, 'ok');
          window.Bus.emit(window.Bus.EVENTS.FILE_CONNECTED, { name: r.name });
        } else {
          toast('已连接「' + r.name + '」，但首次写入失败，请点「保存到目录」重试', 'warn');
        }
      } catch (e) {
        const err = E.normalize(e);
        if (err.code === 'E_CANCEL') return;
        toast(err.message, 'err');
      }
    },

    async onSaveFile() {
      if (window.FileIO.hasDir()) {
        const r = await window.FileIO.writeNow();
        if (r.ok) {
          toast('已写回 ' + r.file + '（' + this.countsText(r.counts) + '）', 'ok');
        } else {
          toast('写回失败：' + (r.message || '请重新连接目录'), 'err', {
            action: { label: '重新连接', fn: () => this.onConnectDir() },
          });
        }
        return;
      }

      // 没连目录 → 导出备份
      try {
        const r = await window.FileIO.exportBackup();
        if (r && r.ok) {
          toast('已导出 ' + r.name + '，放到程序目录下即可自动载入', 'ok', { duration: 6000 });
        }
      } catch (e) {
        toast(E.normalize(e).message, 'err');
      }
    },

    /* ---------------- 自动保存 ---------------- */

    startAutoSaveLoop() {
      window.Bus.on(window.Bus.EVENTS.DIRTY_CHANGED, ({ dirty }) => {
        if (!dirty) return;
        if (!window.FileIO.hasDir()) return;    // 没连目录只置脏标记
        this.scheduleAutoSave();
      });

      // 定期检查配额
      setInterval(async () => {
        const q = await window.DB.quota();
        if (q.total && q.pct >= 85) {
          window.Bus.emit(window.Bus.EVENTS.QUOTA_WARN, q);
        }
      }, 60000);
    },

    scheduleAutoSave() {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = setTimeout(async () => {
        if (!window.FileIO.isDirty()) return;
        const r = await window.FileIO.writeNow();
        if (r.ok) {
          E.Log.info('autosave', '自动写回完成');
        } else if (r.reason === 'E_PERM_DENIED' || r.reason === 'E_NO_DIR') {
          // 权限掉了不刷屏，只在状态栏提示
          E.Log.warn('autosave', '自动写回被拒，需要重新授权');
        }
      }, this.AUTO_SAVE_MS);
    },

    checkDirtyOnExit() {
      window.addEventListener('beforeunload', (ev) => {
        if (window.FileIO.isDirty()) {
          ev.preventDefault();
          ev.returnValue = '';
        }
      });
    },
  };

  window.AppShell = App;
  window.ROUTES = ROUTES;
  window.ICONS = ICONS;
  window.Pages = window.Pages || {};
})();
