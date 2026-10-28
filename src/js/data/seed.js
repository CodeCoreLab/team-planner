/* ============================================================
 * data/seed.js —— 首次运行初始化
 *
 * 职责：
 *   1. 建默认角色 / 部门 / 管理员账号 / 设置项
 *   2. 判断是不是"首次运行"（库是空的）
 *   3. 提供"重置所有数据"的能力（危险操作，需二次确认）
 *
 * 默认账号：管理员用户名 admin，密码在首次启动时由用户设置
 *   为什么不硬编码 admin123：
 *     纯前端的数据文件就在用户硬盘上，硬编码密码等于没有密码。
 *     首次启动要求用户自己设一个，且强制不少于 6 位。
 * ============================================================ */

(function () {
  'use strict';

  const E = window.Errors;
  const S = window.Schema;
  const DB = window.DB;
  const Repo = window.Repo;

  const META_SEEDED = 'seeded';

  /** 是否已初始化 */
  async function isSeeded() {
    const row = await DB.read('meta', c => c.get('meta', META_SEEDED));
    if (row && row.v) return true;
    // 双保险：即使标记丢了，只要有用户就不重复播种
    const users = await Repo.all('users');
    return users.length > 0;
  }

  /**
   * 播种基础数据
   *
   * @param {object} opts { adminPassword, adminName, siteName }
   */
  async function seed(opts) {
    const o = opts || {};
    if (await isSeeded()) return { seeded: false };

    // 密码必须由调用方给出（首次启动向导里让用户填）
    const plain = String(o.adminPassword || '');
    if (plain.length < 6) {
      throw new E.ValidationError('管理员密码至少 6 位', 'adminPassword');
    }
    const hash = await window.Auth.hashPassword(plain);

    const adminName = String(o.adminName || '管理员').trim().slice(0, 64) || '管理员';
    const siteName = String(o.siteName || '').trim().slice(0, 64);

    await DB.write(
      ['roles', 'departments', 'users', 'settings', 'meta'],
      async (c) => {
        // 角色
        for (const role of S.DEFAULT_ROLES) {
          await c.put('roles', {
            id: role.id,
            name: role.name,
            permissions: role.permissions,
            created_at: S.nowStr(),
          });
        }

        // 默认部门
        await c.put('departments', {
          id: 1, name: '综合部', parent_id: 0, manager_id: 0,
          description: '默认部门，可重命名', deleted: false,
          created_at: S.nowStr(),
        });

        // 管理员
        await c.put('users', {
          id: 1,
          username: 'admin',
          password: hash,
          real_name: adminName,
          email: '',
          phone: '',
          avatar: null,
          role_id: 1,
          department_id: 1,
          status: 1,
          deleted: false,
          created_at: S.nowStr(),
          updated_at: S.nowStr(),
        });

        // 设置项
        const settings = Object.assign({}, S.DEFAULT_SETTINGS);
        if (siteName) settings.site_name = siteName;
        for (const k of Object.keys(settings)) {
          await c.put('settings', { k, v: settings[k] });
        }

        // 种子标记
        await c.put('meta', { k: META_SEEDED, v: 1, at: S.nowStr() });
      }
    );

    window.Settings.invalidate();
    E.Log.info('seed', '初始化完成');
    return { seeded: true, adminUsername: 'admin' };
  }

  /** 库是否全空（判断"首次运行"用） */
  async function isEmptyDatabase() {
    const counts = await Promise.all([
      DB.read('tasks', c => c.count('tasks')),
      DB.read('logs', c => c.count('logs')),
      DB.read('plans', c => c.count('plans')),
      DB.read('users', c => c.count('users')),
    ]);
    return counts.every(n => !n);
  }

  /** 清空全部业务数据（保留角色与设置）*/
  async function clearBusinessData() {
    const entities = ['tasks', 'plans', 'logs', 'subtasks', 'tags', 'task_assignees',
      'work_log_reviews', 'notifications', 'operation_logs', 'task_order'];
    await DB.write(entities, async (c) => {
      for (const e of entities) {
        try { await c.clear(e); } catch (_) {}
      }
    });
    E.Log.warn('seed', '业务数据已清空');
    return { cleared: entities };
  }

  /** 重置所有数据（含用户/角色/设置，回到首次运行状态） */
  async function resetAll() {
    await DB.destroy();
    window.Settings.invalidate();
    window.Auth.clearSession();
    E.Log.warn('seed', '所有数据已重置');
    return { reset: true };
  }

  window.Seed = { isSeeded, seed, isEmptyDatabase, clearBusinessData, resetAll };
})();
