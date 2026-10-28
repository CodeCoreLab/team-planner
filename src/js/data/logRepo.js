/* ============================================================
 * data/logRepo.js —— 工作日志仓储
 *
 * 覆盖 PHP 版 api/logs.php 的 8 个 action：
 *   list / get / save / delete / review / stats / calendar / task_summary
 *
 * 关键业务规则：
 *   1. 同一天同一类型的日报只有一篇（写了就覆盖，不产生重复）
 *   2. 日报内容自动附带任务汇总（由 task_summary 生成）
 *   3. 点评只能由有 logs.review 权限的人做
 *   4. 连续提交天数（streak）用于激励
 * ============================================================ */

(function () {
  'use strict';

  const E = window.Errors;
  const V = window.Validate;
  const S = window.Schema;
  const DB = window.DB;
  const Repo = window.Repo;

  /** 装饰：补作者、点评数、状态文案 */
  async function decorate(rows) {
    if (!rows || !rows.length) return [];
    const [users, reviews] = await Promise.all([
      DB.read('users', c => c.getAll('users')),
      DB.read('work_log_reviews', c => c.getAll('work_log_reviews')),
    ]);

    const userMap = new Map(users.map(u => [Number(u.id), u]));
    const reviewMap = new Map();
    for (const r of reviews) {
      const k = Number(r.log_id);
      if (!reviewMap.has(k)) reviewMap.set(k, []);
      reviewMap.get(k).push(r);
    }

    return rows.map(l => {
      const owner = userMap.get(Number(l.user_id)) || null;
      const rv = reviewMap.get(Number(l.id)) || [];
      return Object.assign({}, l, {
        owner_name: owner ? (owner.real_name || owner.username) : '',
        owner_dept_id: owner ? Number(owner.department_id || 0) : 0,
        type_name: S.label('logType', l.type),
        status_name: S.label('logStatus', l.status),
        status_color: S.statusColor(l.status),
        review_count: rv.length,
        reviews: rv.map(r => {
          const reviewer = userMap.get(Number(r.reviewer_id)) || null;
          return Object.assign({}, r, {
            reviewer_name: reviewer ? (reviewer.real_name || reviewer.username) : '',
            level_name: ['', '一般', '较好', '优秀'][Number(r.level)] || '',
          });
        }),
        content_length: Array.from(String(l.content || '')).length,
      });
    });
  }

  /** 列表 */
  async function list(q) {
    const query = q || {};
    let rows = await Repo.all('logs');

    // 数据范围：这里只做"自己的"过滤；
    // 部门范围需要作者的部门信息，等 decorate() 之后再过滤（见下方二次过滤）
    const scope = window.Auth.dataScope();
    if (scope === 'self') {
      const uid = window.Auth.currentUserId();
      rows = rows.filter(l => Number(l.user_id) === uid);
    }

    if (query.type) rows = rows.filter(l => l.type === query.type);
    if (query.status) rows = rows.filter(l => l.status === query.status);
    if (query.user_id) {
      const uid = V.idLoose(query.user_id);
      rows = rows.filter(l => Number(l.user_id) === uid);
    }
    if (query.mine) {
      const uid = window.Auth.currentUserId();
      rows = rows.filter(l => Number(l.user_id) === uid);
    }
    if (query.range) {
      const rg = V.range(query.range, query.date || V.today());
      rows = rows.filter(l => l.date_range && l.date_range >= rg.start && l.date_range <= rg.end);
    }
    if (query.search) {
      const s = String(query.search).slice(0, 60);
      rows = rows.filter(l => Repo.matchAny(l, s, ['title', 'content', 'task_summary']));
    }

    rows = Repo.sortBy(await decorate(rows), ['-date_range', '-id']);

    // 部门范围的二次过滤（要拿到 owner 的部门）
    if (scope === 'dept') {
      const deptId = Number((window.Auth.currentUser() || {}).department_id || 0);
      const uid = window.Auth.currentUserId();
      rows = rows.filter(l => Number(l.user_id) === uid
        || (deptId > 0 && Number(l.owner_dept_id) === deptId));
    }

    return Repo.paginate(rows, query.page, query.per_page || window.Settings.get('page_size', 20));
  }

  /** 取单条（含点评明细） */
  async function get(id) {
    const lid = V.idLoose(id);
    if (!lid) return null;
    const row = await Repo.get('logs', lid);
    if (!row) return null;
    const [d] = await decorate([row]);
    return d;
  }

  /** 取某天某类型（用于"今天写过没"的判断） */
  async function findByDate(dateStr, type, userId) {
    const uid = V.idLoose(userId) || window.Auth.currentUserId();
    const day = V.date(dateStr);
    const t = V.oneOf(type, S.ENUMS.logType, 'daily');

    const rows = await Repo.byIndex('logs', 'date_type', IDBKeyRange.only([day, t]));
    return rows.find(l => Number(l.user_id) === uid) || null;
  }

  /**
   * 保存日志
   *
   * 同一 (user, date_range, type) 已存在时更新而非新增 ——
   * 这是"日报去重"的业务规则，与 PHP 版一致。
   */
  async function save(input) {
    const me = window.Auth.currentUser();
    if (!me) throw new E.AppError('请先登录', 'E_AUTH');

    const id = V.idLoose(input.id);
    if (!id && !window.Auth.can('logs', 'add')) {
      throw new E.AppError('您没有写日志的权限', 'E_PERM');
    }
    if (id && !window.Auth.can('logs', 'edit')) {
      throw new E.AppError('您没有编辑日志的权限', 'E_PERM');
    }

    const content = String(input.content || '');
    if (!content.trim()) throw new V.ValidationError('日志内容不能为空', 'content');
    V.maxLen(content, 50000, 'content', '日志内容');

    const type = V.oneOf(input.type, S.ENUMS.logType, 'daily');
    const dateRange = V.date(input.date_range, V.today());
    const title = V.clip(String(input.title || '').trim(), 255);
    const status = V.oneOf(input.status, S.ENUMS.logStatus, 'draft');

    const data = {
      user_id: Number(me.id),
      type,
      date_range: dateRange,
      title,
      content,
      task_summary: input.task_summary == null ? null : String(input.task_summary),
      status,
      deleted: false,
    };

    let targetId = id;

    if (!targetId) {
      // 去重：同人同天同类型只保留一篇
      const dup = await findByDate(dateRange, type, me.id);
      if (dup) targetId = Number(dup.id);
    }

    if (targetId) {
      const old = await Repo.get('logs', targetId);
      if (!old) throw new E.AppError('日志不存在或已被删除', 'E_NOTFOUND');
      if (Number(old.user_id) !== Number(me.id) && !window.Auth.can('logs', 'edit')) {
        throw new E.AppError('您没有编辑他人日志的权限', 'E_PERM');
      }
      // 编辑他人日志时不改归属
      const patch = Object.assign({}, data, { user_id: Number(old.user_id) });
      const saved = await Repo.save('logs', Object.assign({}, old, patch, { id: targetId }));
      window.OpLog && window.OpLog.write('更新日志', String(targetId), dateRange);
      return saved;
    }

    const saved = await Repo.save('logs', data, { strict: true });
    window.OpLog && window.OpLog.write('写工作日志', String(saved.id), dateRange);
    return saved;
  }

  /** 删除 */
  async function remove(id) {
    const lid = V.idLoose(id);
    const log = await Repo.get('logs', lid);
    if (!log) throw new E.AppError('日志不存在', 'E_NOTFOUND');

    const me = window.Auth.currentUser();
    const isOwner = Number(log.user_id) === Number(me.id);
    if (!isOwner && !window.Auth.can('logs', 'delete')) {
      throw new E.AppError('您没有删除该日志的权限', 'E_PERM');
    }

    await Repo.softDelete('logs', lid);
    window.OpLog && window.OpLog.write('删除日志', String(lid), log.date_range || '');
    return { id: lid };
  }

  /** 点评 */
  async function review(logId, comment, level) {
    const lid = V.idLoose(logId);
    if (!window.Auth.can('logs', 'review')) {
      throw new E.AppError('您没有点评日志的权限', 'E_PERM');
    }
    const log = await Repo.get('logs', lid);
    if (!log) throw new E.AppError('日志不存在', 'E_NOTFOUND');

    const text = V.required(comment, 'comment', '点评内容');
    V.maxLen(text, 5000, 'comment', '点评内容');

    const lv = Math.max(1, Math.min(3, V.asInt(level, 1)));
    const me = window.Auth.currentUser();

    const id = await DB.write(['work_log_reviews', 'logs'], async (c) => {
      const rid = await c.add('work_log_reviews', {
        log_id: lid,
        reviewer_id: Number(me.id),
        comment: text,
        level: lv,
        created_at: S.nowStr(),
      });
      // 被点评后状态推进到 reviewed
      const row = await c.get('logs', lid);
      if (row) {
        row.status = 'reviewed';
        row.updated_at = S.nowStr();
        await c.put('logs', row);
      }
      return rid;
    });

    Repo.emitChange('logs', 'update', lid);
    window.OpLog && window.OpLog.write('点评日志', String(lid), text.slice(0, 50));
    return { id, log_id: lid };
  }

  /** 提交日志（草稿 → 已提交） */
  async function submit(id) {
    const lid = V.idLoose(id);
    const log = await Repo.get('logs', lid);
    if (!log) throw new E.AppError('日志不存在', 'E_NOTFOUND');
    const saved = await Repo.save('logs', Object.assign({}, log, { status: 'submitted' }));
    return saved;
  }

  /**
   * 统计（对应 logs/stats）
   *
   * 连续天数算法与 PHP 版一致：
   *   今天没写不打断连续（当天还没结束），往前逐日检查。
   */
  async function stats() {
    const uid = window.Auth.currentUserId();
    const rows = (await Repo.all('logs')).filter(l =>
      Number(l.user_id) === uid && l.type === 'daily'
    );

    const total = rows.length;
    const submitted = rows.filter(l => l.status === 'submitted' || l.status === 'reviewed').length;
    const reviewed = rows.filter(l => l.status === 'reviewed').length;
    const avgLen = total
      ? Math.round(rows.reduce((s, l) => s + Array.from(String(l.content || '')).length, 0) / total)
      : 0;

    // 近 30 天
    const cut30 = V.addDays(V.today(), -30);
    const recent = rows.filter(l => l.date_range >= cut30).length;

    // 连续天数
    const daySet = new Set(rows.map(l => l.date_range));
    let streak = 0;
    const today = V.today();
    for (let i = 0; i < 60; i++) {
      const d = V.addDays(today, -i);
      if (daySet.has(d)) { streak++; continue; }
      if (i === 0) continue;   // 今天未写，不算断
      break;
    }

    return {
      total, submitted, reviewed,
      daily: total,
      recent_30: recent,
      avg_length: avgLen,
      streak: Math.min(streak, 60),
      has_today: daySet.has(today),
    };
  }

  /** 提交日历（近 N 天哪些天写过） */
  async function calendar(days) {
    const n = Math.max(7, Math.min(120, V.asInt(days, 35)));
    const uid = window.Auth.currentUserId();
    const start = V.addDays(V.today(), -n);

    const rows = (await Repo.all('logs')).filter(l =>
      Number(l.user_id) === uid && l.type === 'daily' && l.date_range >= start
    );

    const map = {};
    for (const l of rows) {
      map[l.date_range] = (map[l.date_range] || 0) + 1;
    }
    return map;
  }

  /**
   * 生成任务汇总文本（对应 logs/task_summary）
   *
   * PHP 版返回拼好的 HTML 字符串；这里返回结构化数据 + 纯文本两份：
   *   - structured 给 UI 渲染（可高亮、可交互）
   *   - text 存进日志的 task_summary 字段（便于导出与搜索）
   */
  async function taskSummary(type, refDate) {
    const t = V.oneOf(type, S.ENUMS.logType, 'daily');
    const ref = V.date(refDate, V.today());
    const scopePeriod = t === 'daily' ? 'day' : t === 'weekly' ? 'week' : 'month';
    const rg = V.range(scopePeriod, ref);

    const rows = await Repo.byIndex('tasks', 'by_date', IDBKeyRange.bound(rg.start, rg.end));
    const decorated = (window.TaskRepo.decorate ? await window.TaskRepo.decorate(rows) : rows);
    const mine = decorated.filter(x => Number(x.assignee_id) === window.Auth.currentUserId()
      || (x.co_assignees || []).indexOf(window.Auth.currentUserId()) >= 0);

    const done = mine.filter(x => x.status === 'completed');
    const undone = mine.filter(x => x.status !== 'completed');

    const line = (t) => `- [${t.status === 'completed' ? '已完成' : t.status_name}] ${t.title}` +
      (t.time_slot ? `（${t.time_slot}）` : '');

    const text = [
      `【${S.label('logType', t)}任务汇总】${rg.start}${rg.start === rg.end ? '' : ' ~ ' + rg.end}`,
      `完成 ${done.length} 项 / 共 ${mine.length} 项`,
      done.length ? '\n已完成：\n' + done.map(line).join('\n') : '',
      undone.length ? '\n未完成：\n' + undone.map(line).join('\n') : '',
    ].filter(Boolean).join('\n');

    return {
      type: t, start: rg.start, end: rg.end,
      total: mine.length, done: done.length, undone: undone.length,
      rate: mine.length ? Math.round(done.length / mine.length * 100) : 0,
      items: { done, undone },
      text,
    };
  }

  window.LogRepo = {
    list, get, save, remove, review, submit, findByDate,
    stats, calendar, taskSummary, decorate,
  };
})();
