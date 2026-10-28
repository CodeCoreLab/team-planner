/* ============================================================
 * data/auth.js —— 会话与权限
 *
 * 纯前端方案下"权限"的性质要说清楚：
 *   没有服务端，JS 里的判断挡不住懂技术的人（改一行代码就能绕过）。
 *   它的真实作用是：
 *     1. 多用户共用一个程序时，界面上不显示无权使用的功能
 *     2. 防止误操作（普通成员不会手滑删掉别人的任务）
 *     3. 数据范围过滤（只看自己 / 本部门 / 全部）
 *   如果以后要真正的安全边界，必须回到有服务端的形态。
 *
 * 与 PHP 版对齐：
 *   - 角色权限结构：{ data_scope, modules: { 模块: { 动作: bool } } }
 *   - 超级管理员（role_id=1）拥有全部权限
 *   - 兼容老格式：permissions 是字符串数组时按旧规则解释
 * ============================================================ */

(function () {
  'use strict';

  const E = window.Errors;
  const SESSION_KEY = 'tp.session.v1';
  const THROTTLE_KEY = 'tp.throttle.v1';

  const THROTTLE_WINDOW_MS = 5 * 60 * 1000;  // 5 分钟
  const THROTTLE_MAX = 10;                    // 同账号最多失败 10 次

  let _session = null;

  /* ------------------------------------------------------------
   * 会话持久化
   *
   * 为什么要持久化：纯前端刷新页面就丢内存状态，
   * 不存的话每次刷新都要重新登录，体验极差。
   * 只存 user_id（不存密码/令牌）——本地单机场景，
   * 用户能直接改 localStorage，存再多也不增加安全性。
   * ------------------------------------------------------------ */

  function loadSession() {
    if (_session !== null) return _session;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return (_session = null);
      const d = JSON.parse(raw);
      if (d && typeof d === 'object' && Number(d.user_id) > 0) {
        _session = { user_id: Number(d.user_id), at: Number(d.at) || 0 };
        return _session;
      }
    } catch (_) { /* 损坏则当作未登录 */ }
    return (_session = null);
  }

  function saveSession(userId) {
    _session = { user_id: Number(userId), at: Date.now() };
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(_session));
    } catch (e) {
      E.Log.warn('auth', '会话无法持久化（可能是隐私模式）');
    }
  }

  function clearSession() {
    _session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  /* ------------------------------------------------------------
   * 登录节流
   *
   * 键 = 用户名（单机场景无需按 IP）。
   * 与 PHP 版一样按"账号"计数，避免误伤其他用户。
   * ------------------------------------------------------------ */

  function throttleMap() {
    try {
      const raw = localStorage.getItem(THROTTLE_KEY);
      const d = raw ? JSON.parse(raw) : {};
      return (d && typeof d === 'object') ? d : {};
    } catch (_) {
      return {};
    }
  }

  function throttleSave(map) {
    try { localStorage.setItem(THROTTLE_KEY, JSON.stringify(map)); } catch (_) {}
  }

  function throttleKey(username) {
    return String(username || '').toLowerCase().slice(0, 64);
  }

  /** @returns {{blocked:boolean, retry_after:number, remaining:number}} */
  function throttleCheck(username) {
    const key = throttleKey(username);
    const map = throttleMap();
    const now = Date.now();
    const arr = (Array.isArray(map[key]) ? map[key] : [])
      .filter(t => typeof t === 'number' && t > now - THROTTLE_WINDOW_MS);
    map[key] = arr;
    throttleSave(map);

    if (arr.length >= THROTTLE_MAX) {
      const retry = Math.max(1, Math.ceil((arr[0] + THROTTLE_WINDOW_MS - now) / 1000));
      return { blocked: true, retry_after: retry, remaining: 0 };
    }
    return { blocked: false, retry_after: 0, remaining: THROTTLE_MAX - arr.length };
  }

  function throttleFail(username) {
    const key = throttleKey(username);
    const map = throttleMap();
    const now = Date.now();
    const arr = (Array.isArray(map[key]) ? map[key] : [])
      .filter(t => typeof t === 'number' && t > now - THROTTLE_WINDOW_MS);
    arr.push(now);
    map[key] = arr;
    throttleSave(map);
  }

  function throttleClear(username) {
    const key = throttleKey(username);
    const map = throttleMap();
    delete map[key];
    throttleSave(map);
  }

  /* ------------------------------------------------------------
   * 密码
   *
   * 单机应用没有传输环节，理论上可以明文比较。但：
   *   1. data.js 可能被同事看到，明文密码太难看
   *   2. 用户常复用密码，泄露影响面大
   * 因此口令以「加盐 + 多轮派生」的形式存储，不落明文。
   *
   * 算法演进（2026-10-28 加固）：
   *   旧格式  salt$SHA256(salt|pwd)     —— 单轮，弱口令可被离线爆破
   *   新格式  pbkdf2$<iter>$<salt>$<派生> —— PBKDF2-HMAC-SHA256，10 万轮
   * 旧格式**继续可校验**（不升级就等于让所有人重新设密码），
   * 但新设/新改的密码一律用新格式。
   *
   * 兼容 PHP 版迁移来的 bcrypt 哈希（$2y$ 开头）：
   *   纯前端无法验证 bcrypt，首次登录时要求改密码。
   * ------------------------------------------------------------ */

  const SALT_LEN = 16;
  const PBKDF2_ITER = 100000;
  const PBKDF2_PREFIX = 'pbkdf2$';

  /**
   * 脱敏备份里账号口令被剥离后留下的标记值
   *
   * 背景：对外导出的备份会抹掉 users.password（防止备份文件被离线爆破）。
   * 抹掉之后账号没法登录，所以导入时统一写成这个标记，
   * 登录时识别到它就走「首次设置新口令」流程。
   */
  const PWD_RESET_MARK = '__reset_required__';

  function hasSubtle() {
    return !!(window.crypto && window.crypto.subtle
      && window.crypto.subtle.importKey && window.crypto.subtle.deriveBits);
  }

  /** 账号是否处于「需重设口令」状态 */
  function isPasswordReset(stored) {
    return String(stored || '') === PWD_RESET_MARK;
  }

  function randomHex(bytes) {
    const arr = new Uint8Array(bytes);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(arr);
    } else {
      // 极端降级：无 crypto 的环境（老浏览器 / 非安全上下文）
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function sha256(text) {
    if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
      const buf = new TextEncoder().encode(text);
      const hash = await window.crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // 降级：file:// 在部分浏览器下 crypto.subtle 不可用，用简单散列兜底
    // （强度不足，但至少不是明文；会在日志里提示用户）
    E.Log.warn('auth', 'crypto.subtle 不可用，使用降级散列');
    return 'weak$' + weakHash(text);
  }

  /** 降级散列（FNV-1a 变体 + 多轮），仅在没有 SubtleCrypto 时使用 */
  function weakHash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    let h2 = 0x12345678;
    for (let i = text.length - 1; i >= 0; i--) {
      h2 = ((h2 ^ text.charCodeAt(i)) * 0x85ebca6b) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * PBKDF2-HMAC-SHA256 派生（WebCrypto）
   *
   * @param {string} plain 明文口令
   * @param {string} salt  盐（十六进制字符串）
   * @param {number} iter  迭代轮数
   * @returns {Promise<string>} 十六进制派生值
   */
  async function pbkdf2(plain, salt, iter) {
    const enc = new TextEncoder();
    const key = await window.crypto.subtle.importKey(
      'raw', enc.encode(String(plain)), 'PBKDF2', false, ['deriveBits']);
    const bits = await window.crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(String(salt)), iterations: iter, hash: 'SHA-256' },
      key, 256);
    return Array.from(new Uint8Array(bits))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 生成密码记录
   *
   * 新格式：pbkdf2$<iter>$<salt>$<hash>
   * 无 WebCrypto 时退回旧格式（salt$weak$hash），强度不足但至少不是明文。
   */
  async function hashPassword(plain) {
    const salt = randomHex(SALT_LEN);
    if (hasSubtle()) {
      const hash = await pbkdf2(plain, salt, PBKDF2_ITER);
      return PBKDF2_PREFIX + PBKDF2_ITER + '$' + salt + '$' + hash;
    }
    E.Log.warn('auth', 'crypto.subtle 不可用，使用降级散列（强度不足）');
    const hash = await sha256(salt + '|' + plain);
    return salt + '$' + hash;
  }

  /**
   * 校验密码
   *
   * 同时支持三种存储格式：
   *   pbkdf2$<iter>$<salt>$<hash>  新格式
   *   <salt>$<sha256>              旧格式（单轮，兼容存量数据）
   *   <salt>$weak$<hash>           降级格式
   * 以及 $2y$ 开头的 PHP bcrypt 哈希（无法校验，报错提示重置）。
   */
  async function verifyPassword(plain, stored) {
    if (!stored) return false;
    const s = String(stored);
    // PHP bcrypt 哈希：纯前端无法校验
    if (/^\$2[aby]\$/.test(s)) {
      throw new E.AppError(
        '这个账号的密码来自旧版本，无法在当前版本校验。请用管理员账号在「组织架构」里重置一次密码。',
        'E_BCRYPT'
      );
    }
    // 脱敏备份导入的账号：口令被剥离，走「首次设置新口令」流程
    if (s === PWD_RESET_MARK) {
      throw new E.AppError(
        '这个账号的口令在备份导出时已被移除，请先设置新口令。',
        'E_PWD_RESET'
      );
    }
    // 新格式：pbkdf2$<iter>$<salt>$<hash>
    if (s.startsWith(PBKDF2_PREFIX)) {
      const parts = s.split('$');
      const iter = Number(parts[1]);
      const salt = parts[2] || '';
      const want = parts[3] || '';
      if (!Number.isFinite(iter) || iter <= 0 || !salt || !want) return false;
      if (!hasSubtle()) {
        throw new E.AppError(
          '当前环境不支持 WebCrypto，无法校验此账号口令。请换用 Chrome/Edge 打开，或用管理员账号重置口令。',
          'E_NO_SUBTLE'
        );
      }
      const got = await pbkdf2(plain, salt, iter);
      return timingSafeEqual(got, want);
    }
    // 旧格式：<salt>$<hash>
    const i = s.indexOf('$');
    if (i < 0) return false;
    const salt = s.slice(0, i);
    const want = s.slice(i + 1);
    const got = await sha256(salt + '|' + plain);
    return timingSafeEqual(got, want) || ('weak$' + weakHash(salt + '|' + plain)) === want;
  }

  /** 常数时间比较（避免通过响应时间猜哈希） */
  function timingSafeEqual(a, b) {
    const sa = String(a), sb = String(b);
    if (sa.length !== sb.length) return false;
    let diff = 0;
    for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
    return diff === 0;
  }

  /* ------------------------------------------------------------
   * 当前用户
   * ------------------------------------------------------------ */

  let _user = null;         // 完整用户行
  let _permissions = null;  // 解析后的权限对象

  function currentUser() {
    return _user;
  }

  function currentUserId() {
    return _user ? Number(_user.id) : 0;
  }

  /**
   * 登入（在校验通过后调用）
   *
   * 把用户与权限放内存，避免每次权限判断都查库
   * （权限判断在渲染中会调用几十次）
   */
  function setUser(user, roleRow) {
    _user = user || null;
    _permissions = parsePermissions(roleRow ? roleRow.permissions : null);
    if (_user) saveSession(_user.id);
    else clearSession();
    window.Bus && window.Bus.emit(window.Bus.EVENTS.USER_CHANGED, { user: _user });
  }

  /** 刷新权限（角色被修改后调用，避免缓存不失效） */
  function refreshPermissions(roleRow) {
    _permissions = parsePermissions(roleRow ? roleRow.permissions : null);
  }

  /**
   * 解析角色权限
   *
   * 兼容三种历史格式：
   *   1. { data_scope, modules: { m: { a: true } } }  ← 当前格式
   *   2. ['plans','logs','*']                        ← 早期字符串数组
   *   3. JSON 字符串 / null                          ← 库里存的原始值
   */
  function parsePermissions(raw) {
    let p = raw;
    if (typeof p === 'string') {
      try { p = JSON.parse(p); } catch (_) { p = null; }
    }
    const out = { data_scope: 'self', modules: {}, legacy: false };

    if (Array.isArray(p)) {
      out.legacy = true;
      if (p.indexOf('*') >= 0) {
        out.data_scope = 'all';
        for (const m of window.Schema.ENUMS.permModules) {
          out.modules[m] = { view: true, add: true, edit: true, delete: true, review: true, co_assign: true };
        }
      } else {
        for (const m of p) {
          if (typeof m === 'string') out.modules[m] = { view: true };
        }
      }
      return out;
    }

    if (p && typeof p === 'object') {
      if (['self', 'dept', 'all'].indexOf(p.data_scope) >= 0) out.data_scope = p.data_scope;
      if (p.modules && typeof p.modules === 'object') {
        for (const m of Object.keys(p.modules)) {
          const acts = p.modules[m];
          if (!acts || typeof acts !== 'object') continue;
          out.modules[m] = {};
          for (const a of Object.keys(acts)) {
            if (acts[a]) out.modules[m][a] = true;
          }
        }
      }
    }
    return out;
  }

  /** 是否可执行某动作 */
  function can(module, action) {
    const act = action || 'view';
    if (!_user) return false;
    if (Number(_user.role_id) === 1) return true;   // 超级管理员
    const m = _permissions && _permissions.modules && _permissions.modules[module];
    if (!m) return false;
    if (m[act]) return true;
    // 老格式：非 view 动作要求 role_id === 2（部门主管）
    if (_permissions && _permissions.legacy && act !== 'view') {
      return !!m.view && Number(_user.role_id) === 2;
    }
    return false;
  }

  /** 数据范围：self / dept / all */
  function dataScope() {
    if (!_user) return 'self';
    if (Number(_user.role_id) === 1) return 'all';
    const s = _permissions && _permissions.data_scope;
    if (['self', 'dept', 'all'].indexOf(s) >= 0) return s;
    return Number(_user.role_id) === 2 ? 'dept' : 'self';
  }

  /**
   * 无权时的统一处理
   *
   * UI 层在渲染页面前调用 requirePerm()，
   * 抛出的错误会被错误边界捕获并显示友好提示。
   */
  function requirePerm(module, action) {
    if (can(module, action)) return true;
    throw new E.AppError('您没有使用「' + window.Schema.label('permModules', module) + '」的权限', 'E_PERM');
  }

  /** 是否有任意管理权限（决定侧栏是否显示"管理"分组） */
  function isManager() {
    if (!_user) return false;
    if (Number(_user.role_id) === 1) return true;
    return ['plans', 'org', 'settings', 'oplogs', 'reports'].some(m => can(m, 'view'));
  }

  window.Auth = {
    loadSession, saveSession, clearSession,
    currentUser, currentUserId, setUser, refreshPermissions, parsePermissions,
    can, dataScope, requirePerm, isManager,
    // 密码
    hashPassword, verifyPassword, randomHex, sha256,
    isPasswordReset, pbkdf2, hasSubtle,
    PWD_RESET_MARK, PBKDF2_ITER,
    // 节流
    throttleCheck, throttleFail, throttleClear,
    THROTTLE_MAX,
    SESSION_KEY,
  };
})();
