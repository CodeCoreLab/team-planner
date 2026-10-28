/* ============================================================
 * data/planRepo.js —— 计划仓储
 *
 * 覆盖 PHP 版 api/plans.php 的 7 个 action：
 *   list / get / save / delete / archive / options / manage_list
 *
 * 计划与任务的关系：
 *   计划是一组任务的容器（plan_tasks.plan_id → plans.id）。
 *   删除计划时任务不级联删除，而是把 plan_id 置 0（避免误删数据）。
 * ============================================================ */

(function () {
  'use strict';

  const E = window.Errors;
  const V = window.Validate;
  const S = window.Schema;
  const DB = window.DB;
  const Repo = window.Repo;

  /** 装饰：补创建人、部门名、下属任务统计 */
  async function decorate(rows) {
    if (!rows || !rows.length) return [];

    const [users, depts, tasks] = await Promise.all([
      DB.read('users', c => c.getAll('users')),
      DB.read('departments', c => c.getAll('departments')),
      DB.read('tasks', c => c.getAll('tasks')),
    ]);

    const userMap = new Map(users.map(u => [Number(u.id), u]));
    const deptMap = new Map(depts.map(d => [Number(d.id), d]));

    const taskAgg = new Map();
    for (const t of tasks) {
      if (t.deleted) continue;
      const pid = Number(t.plan_id);
      if (!pid) continue;
      if (!taskAgg.has(pid)) taskAgg.set(pid, { total: 0, done: 0 });
      const rec = taskAgg.get(pid);
      rec.total++;
      if (t.status === 'completed') rec.done++;
    }

    return rows.map(p => {
      const creator = userMap.get(Number(p.creator_id)) || null;
      const dept = deptMap.get(Number(p.department_id)) || null;
      const agg = taskAgg.get(Number(p.id)) || { total: 0, done: 0 };
      return Object.assign({}, p, {
        creator_name: creator ? (creator.real_name || creator.username) : '',
        department_name: dept ? dept.name : '',
        task_total: agg.total,
        task_done: agg.done,
        task_rate: agg.total ? Math.round(agg.done / agg.total * 100) : 0,
        type_name: S.label('planType', p.type),
        level_name: S.label('planLevel', p.level),
        status_name: S.label('taskStatus', p.status),
        status_color: S.statusColor(p.status),
        assignee_ids: Array.isArray(p.assignee_ids) ? p.assignee_ids : [],
      });
    });
  }

  /** 列表 */
  async function list(q) {
    const query = q || {};
    let rows = await Repo.all('plans');

    const scope = window.Auth.dataScope();
    if (scope !== 'all') {
      const uid = window.Auth.currentUserId();
      const deptId = Number((window.Auth.currentUser() || {}).department_id || 0);
      rows = rows.filter(p => {
        if (Number(p.creator_id) === uid) return true;
        if (scope === 'dept' && deptId > 0 && Number(p.department_id) === deptId) return true;
        return false;
      });
    }

    // 默认排除归档
    if (!query.include_archived) {
      rows = rows.filter(p => !p.archived);
    }
    if (query.archived === true || query.archived === '1') {
      rows = rows.filter(p => p.archived);
    }
    if (query.type) rows = rows.filter(p => p.type === query.type);
    if (query.status) rows = rows.filter(p => p.status === query.status);
    if (query.level) rows = rows.filter(p => p.level === query.level);
    if (query.search) {
      const s = String(query.search).slice(0, 60);
      rows = rows.filter(p => Repo.matchAny(p, s, ['title', 'description']));
    }

    rows = Repo.sortBy(await decorate(rows), ['-updated_at', '-id']);

    const page = Repo.paginate(rows, query.page, query.per_page || window.Settings.get('page_size', 20));
    return page;
  }

  /** 管理用列表（含归档，按类型分组统计） */
  async function manageList() {
    const rows = Repo.sortBy(await decorate(await Repo.all('plans')), ['-updated_at']);
    const stats = { total: rows.length, archived: 0, byType: {}, byStatus: {} };
    for (const p of rows) {
      if (p.archived) stats.archived++;
      stats.byType[p.type] = (stats.byType[p.type] || 0) + 1;
      stats.byStatus[p.status] = (stats.byStatus[p.status] || 0) + 1;
    }
    return { items: rows, stats };
  }

  /** 单条详情 */
  async function get(id) {
    const pid = V.idLoose(id);
    if (!pid) return null;
    const row = await Repo.get('plans', pid);
    if (!row) return null;
    const [d] = await decorate([row]);

    // 挂上关联任务摘要
    const tasks = await Repo.byIndex('tasks', 'by_plan', pid);
    const { TaskRepo } = window;
    const decorated = TaskRepo && TaskRepo.decorate
      ? await TaskRepo.decorate(tasks)
      : tasks;
    d.tasks = Repo.sortBy(decorated, ['task_date', 'id']);
    return d;
  }

  /** 下拉选项（供任务表单选择所属计划） */
  async function options() {
    const rows = (await Repo.all('plans')).filter(p => !p.archived);
    const scope = window.Auth.dataScope();
    const uid = window.Auth.currentUserId();
    const deptId = Number((window.Auth.currentUser() || {}).department_id || 0);

    const visible = rows.filter(p => {
      if (scope === 'all') return true;
      if (Number(p.creator_id) === uid) return true;
      if (scope === 'dept' && deptId > 0 && Number(p.department_id) === deptId) return true;
      return false;
    });

    return Repo.sortBy(visible, ['-updated_at'])
      .map(p => ({ id: p.id, title: p.title, type: p.type, type_name: S.label('planType', p.type) }));
  }

  /** 保存 */
  async function save(input) {
    const me = window.Auth.currentUser();
    if (!me) throw new E.AppError('请先登录', 'E_AUTH');

    const id = V.idLoose(input.id);
    if (!id && !window.Auth.can('plans', 'add')) {
      throw new E.AppError('您没有新建计划的权限', 'E_PERM');
    }
    if (id && !window.Auth.can('plans', 'edit')) {
      throw new E.AppError('您没有编辑计划的权限', 'E_PERM');
    }

    const title = V.required(input.title, 'title', '计划标题');
    V.maxLen(title, 255, 'title', '计划标题');

    const data = {
      title,
      description: String(input.description || ''),
      type: V.oneOf(input.type, S.ENUMS.planType, 'personal'),
      level: V.oneOf(input.level, S.ENUMS.planLevel, 'week'),
      status: V.oneOf(input.status, S.ENUMS.taskStatus, 'pending'),
      progress: V.progress(input.progress),
      start_date: input.start_date ? V.date(input.start_date, null) : null,
      end_date: input.end_date ? V.date(input.end_date, null) : null,
      priority: V.oneOf(input.priority, S.ENUMS.priority, 'medium'),
      archived: !!input.archived,
      assignee_ids: V.idList(input.assignee_ids, 50),
    };

    // 结束日期早于开始日期 → 忽略结束（与任务一致，不猜）
    if (data.start_date && data.end_date && data.end_date < data.start_date) {
      data.end_date = null;
    }

    if (id) {
      const old = await Repo.get('plans', id);
      if (!old) throw new E.AppError('计划不存在或已被删除', 'E_NOTFOUND');
      const saved = await Repo.save('plans', Object.assign({}, old, data, { id }));
      window.OpLog && window.OpLog.write('编辑计划', String(id), title);
      return saved;
    }

    data.creator_id = Number(me.id);
    data.department_id = Number(input.department_id) || Number(me.department_id || 0);
    const saved = await Repo.save('plans', data, { strict: true });
    window.OpLog && window.OpLog.write('新建计划', String(saved.id), title);
    return saved;
  }

  /** 删除（解除任务关联，不级联删任务） */
  async function remove(id) {
    const pid = V.idLoose(id);
    if (!window.Auth.can('plans', 'delete')) {
      throw new E.AppError('您没有删除计划的权限', 'E_PERM');
    }
    const plan = await Repo.get('plans', pid);
    if (!plan) throw new E.AppError('计划不存在', 'E_NOTFOUND');

    // 先把关联任务的 plan_id 置 0，避免出现"孤儿任务"
    const tasks = await Repo.byIndex('tasks', 'by_plan', pid);
    if (tasks.length) {
      await DB.write('tasks', async (c) => {
        for (const t of tasks) {
          const row = await c.get('tasks', Number(t.id));
          if (!row) continue;
          row.plan_id = 0;
          row.updated_at = S.nowStr();
          await c.put('tasks', row);
        }
      });
    }

    await Repo.hardDelete('plans', pid);
    window.OpLog && window.OpLog.write('删除计划', String(pid), plan.title);
    return { id: pid, detached_tasks: tasks.length };
  }

  /** 归档 / 取消归档 */
  async function archive(id, flag) {
    const pid = V.idLoose(id);
    if (!window.Auth.can('plans', 'edit')) {
      throw new E.AppError('您没有归档计划的权限', 'E_PERM');
    }
    const plan = await Repo.get('plans', pid);
    if (!plan) throw new E.AppError('计划不存在', 'E_NOTFOUND');

    const to = flag === undefined ? !plan.archived : !!flag;
    const saved = await Repo.save('plans', Object.assign({}, plan, { archived: to }));
    window.OpLog && window.OpLog.write(to ? '归档计划' : '取消归档计划', String(pid), plan.title);
    return saved;
  }

  window.PlanRepo = { list, manageList, get, options, save, remove, archive, decorate };
})();
