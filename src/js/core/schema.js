/* ============================================================
 * core/schema.js —— 数据契约
 *
 * 作用：
 *   1. 定义每种实体的字段、类型、默认值、取值范围
 *   2. 提供 normalize()：把任意脏数据转成合法实体（导入老备份/手工改过的文件时必需）
 *   3. 提供 diff()：只把变化的字段写库，减少 IndexedDB 事务开销
 *
 * 为什么需要独立一层：
 *   现有 PHP 版把这些规则散落在 48 个 action 里，改一个字段要翻 5 个文件。
 *   集中后，新增字段只改这里一处，store 与 UI 自动跟上。
 * ============================================================ */

(function () {
  'use strict';

  const Vd = window.Validate;

  /* ------------------------------------------------------------
   * 枚举中心（同时供 UI 下拉、校验、文案使用）
   * ------------------------------------------------------------ */

  const ENUMS = {
    taskStatus: ['pending', 'in_progress', 'completed', 'delayed'],
    priority: ['urgent', 'high', 'medium', 'low'],
    recurrence: ['none', 'daily', 'weekly', 'monthly'],
    planType: ['company', 'department', 'personal'],
    planLevel: ['day', 'week', 'month', 'quarter', 'year'],
    logType: ['daily', 'weekly', 'monthly'],
    logStatus: ['draft', 'submitted', 'reviewed'],
    dataScope: ['self', 'dept', 'all'],
    reviewLevel: [1, 2, 3],
    // 权限模块清单（与 PHP 版 roles.permissions.modules 对应）
    permModules: ['dashboard', 'plans', 'logs', 'board', 'reports', 'org', 'settings', 'oplogs'],
    permActions: ['view', 'add', 'edit', 'delete', 'review', 'co_assign'],
  };

  const LABELS = {
    taskStatus: { pending: '待开始', in_progress: '进行中', completed: '已完成', delayed: '已延期' },
    priority: { urgent: '紧急', high: '高', medium: '中', low: '低' },
    recurrence: { none: '不重复', daily: '每天', weekly: '每周', monthly: '每月' },
    planType: { company: '公司级', department: '部门级', personal: '个人' },
    planLevel: { day: '日', week: '周', month: '月', quarter: '季度', year: '年' },
    logType: { daily: '日报', weekly: '周报', monthly: '月报' },
    logStatus: { draft: '草稿', submitted: '已提交', reviewed: '已点评' },
    dataScope: { self: '仅自己', dept: '本部门', all: '全部' },
    permModules: {
      dashboard: '工作台', plans: '任务计划', logs: '工作日志', board: '提醒中心',
      reports: '统计报表', org: '组织架构', settings: '系统设置', oplogs: '操作日志',
    },
    permActions: {
      view: '查看', add: '新增', edit: '编辑', delete: '删除', review: '点评', co_assign: '指派他人',
    },
  };

  /** 状态配色（与 CSS class 对应） */
  const STATUS_COLOR = {
    completed: 'emerald', in_progress: 'blue', pending: 'amber', delayed: 'red',
    approved: 'emerald', rejected: 'red', draft: 'amber', submitted: 'blue', reviewed: 'emerald',
  };

  /* ------------------------------------------------------------
   * 字段定义
   *
   * 每种实体一份，格式：字段名 → { type, default, max, enum, required }
   * type: 'str' | 'int' | 'date' | 'time' | 'enum' | 'bool' | 'json'
   * ------------------------------------------------------------ */

  const SCHEMAS = {
    tasks: {
      id: { type: 'int', sys: true },
      plan_id: { type: 'int', default: 0 },
      title: { type: 'str', max: 255, required: true, label: '任务标题' },
      description: { type: 'str', max: 20000, default: '', trim: false },
      time_slot: { type: 'str', max: 32, default: '' },
      start_time: { type: 'time', default: null },
      end_time: { type: 'time', default: null },
      end_date: { type: 'date', default: null },
      status: { type: 'enum', enum: 'taskStatus', default: 'pending' },
      assignee_id: { type: 'int', default: 0 },
      priority: { type: 'enum', enum: 'priority', default: 'medium' },
      recurrence: { type: 'enum', enum: 'recurrence', default: 'none' },
      recurrence_end_date: { type: 'date', default: null },
      recurrence_parent_id: { type: 'int', default: 0 },
      task_date: { type: 'date', default: null },
      sort_order: { type: 'int', default: 0 },
      deleted: { type: 'bool', default: false, sys: true },
      created_at: { type: 'str', max: 32, sys: true },
      updated_at: { type: 'str', max: 32, sys: true },
    },

    plans: {
      id: { type: 'int', sys: true },
      title: { type: 'str', max: 255, required: true, label: '计划标题' },
      description: { type: 'str', max: 20000, default: '', trim: false },
      type: { type: 'enum', enum: 'planType', default: 'personal' },
      level: { type: 'enum', enum: 'planLevel', default: 'week' },
      status: { type: 'enum', enum: 'taskStatus', default: 'pending' },
      progress: { type: 'int', default: 0, min: 0, max: 100 },
      start_date: { type: 'date', default: null },
      end_date: { type: 'date', default: null },
      priority: { type: 'enum', enum: 'priority', default: 'medium' },
      department_id: { type: 'int', default: 0 },
      creator_id: { type: 'int', default: 0 },
      archived: { type: 'bool', default: false },
      assignee_ids: { type: 'json', default: [] },
      deleted: { type: 'bool', default: false, sys: true },
      created_at: { type: 'str', max: 32, sys: true },
      updated_at: { type: 'str', max: 32, sys: true },
    },

    logs: {
      id: { type: 'int', sys: true },
      user_id: { type: 'int', default: 0 },
      type: { type: 'enum', enum: 'logType', default: 'daily' },
      date_range: { type: 'date', default: null },
      title: { type: 'str', max: 255, default: '' },
      content: { type: 'str', max: 50000, required: true, label: '日志内容', trim: false },
      task_summary: { type: 'str', max: 20000, default: null, trim: false },
      status: { type: 'enum', enum: 'logStatus', default: 'draft' },
      deleted: { type: 'bool', default: false, sys: true },
      created_at: { type: 'str', max: 32, sys: true },
      updated_at: { type: 'str', max: 32, sys: true },
    },

    users: {
      id: { type: 'int', sys: true },
      username: { type: 'str', max: 32, required: true },
      password: { type: 'str', max: 200, default: '' },
      real_name: { type: 'str', max: 64, required: true, label: '姓名' },
      email: { type: 'str', max: 120, default: '' },
      phone: { type: 'str', max: 20, default: '' },
      avatar: { type: 'str', max: 300, default: null },
      role_id: { type: 'int', default: 3 },
      department_id: { type: 'int', default: 0 },
      status: { type: 'int', default: 1 },
      deleted: { type: 'bool', default: false, sys: true },
      created_at: { type: 'str', max: 32, sys: true },
      updated_at: { type: 'str', max: 32, sys: true },
    },

    departments: {
      id: { type: 'int', sys: true },
      name: { type: 'str', max: 64, required: true, label: '部门名称' },
      parent_id: { type: 'int', default: 0 },
      manager_id: { type: 'int', default: 0 },
      description: { type: 'str', max: 255, default: '' },
      deleted: { type: 'bool', default: false, sys: true },
      created_at: { type: 'str', max: 32, sys: true },
    },

    roles: {
      id: { type: 'int', sys: true },
      name: { type: 'str', max: 64, required: true, label: '角色名称' },
      permissions: { type: 'json', default: { data_scope: 'self', modules: {} } },
      created_at: { type: 'str', max: 32, sys: true },
    },

    subtasks: {
      id: { type: 'int', sys: true },
      task_id: { type: 'int', required: true },
      title: { type: 'str', max: 255, required: true, label: '子任务内容' },
      done: { type: 'int', default: 0 },
      sort_order: { type: 'int', default: 0 },
      created_at: { type: 'str', max: 32, sys: true },
    },

    tags: {
      id: { type: 'int', sys: true },
      task_id: { type: 'int', required: true },
      tag: { type: 'str', max: 32, required: true },
    },

    task_assignees: {
      id: { type: 'int', sys: true },
      task_id: { type: 'int', required: true },
      user_id: { type: 'int', required: true },
    },

    work_log_reviews: {
      id: { type: 'int', sys: true },
      log_id: { type: 'int', required: true },
      reviewer_id: { type: 'int', required: true },
      comment: { type: 'str', max: 5000, required: true, label: '点评内容' },
      level: { type: 'int', default: 1, min: 1, max: 3 },
      created_at: { type: 'str', max: 32, sys: true },
    },

    notifications: {
      id: { type: 'int', sys: true },
      user_id: { type: 'int', default: 0 },
      title: { type: 'str', max: 255, required: true },
      content: { type: 'str', max: 5000, default: '' },
      type: { type: 'str', max: 50, default: 'system' },
      is_read: { type: 'int', default: 0 },
      created_at: { type: 'str', max: 32, sys: true },
    },

    operation_logs: {
      id: { type: 'int', sys: true },
      user_id: { type: 'int', default: 0 },
      username: { type: 'str', max: 64, default: '' },
      action: { type: 'str', max: 64, required: true },
      target: { type: 'str', max: 255, default: '' },
      detail: { type: 'str', max: 2000, default: '' },
      ip: { type: 'str', max: 45, default: 'local' },
      created_at: { type: 'str', max: 32, sys: true },
    },

    settings: {
      k: { type: 'str', max: 64, required: true },
      v: { type: 'str', max: 100000, default: '' },
    },

    task_order: {
      id: { type: 'int', sys: true },
      task_id: { type: 'int', required: true },
      user_id: { type: 'int', default: 0 },
      sort_order: { type: 'int', default: 0 },
    },
  };

  /* ------------------------------------------------------------
   * 默认设置（与 PHP 版 seedDefaults 完全对齐）
   * ------------------------------------------------------------ */

  const DEFAULT_SETTINGS = {
    site_name: '团队协作台',
    site_subtitle: '团队任务与工作日志一体化',
    theme_default: 'light',
    week_start: '1',
    page_size: '20',
    log_reminder: '1',
    hide_weekend: '0',
    hide_evening: '0',
    hide_saturday: '0',
    hide_sunday: '0',
    notify_enabled: '0',
    // 纯前端无服务进程，邮件提醒不可用；保留键位以便迁移兼容
    email_enabled: '0',
    work_periods: JSON.stringify([
      { n: '上午', s: '06:00', e: '12:00' },
      { n: '下午', s: '12:00', e: '18:00' },
      { n: '晚上', s: '18:00', e: '24:00' },
    ]),
    work_days: '1,2,3,4,5',
  };

  /* ------------------------------------------------------------
   * 默认角色（与 PHP 版 sql.sqlite.sql 的种子数据逐字对齐）
   * ------------------------------------------------------------ */

  const DEFAULT_ROLES = [
    {
      id: 1, name: '系统管理员',
      permissions: {
        data_scope: 'all',
        modules: {
          dashboard: { view: true },
          plans: { view: true, add: true, edit: true, delete: true, co_assign: true },
          logs: { view: true, add: true, edit: true, delete: true, review: true },
          board: { view: true }, reports: { view: true },
          org: { view: true, add: true, edit: true, delete: true },
          settings: { view: true, edit: true }, oplogs: { view: true },
        },
      },
    },
    {
      id: 2, name: '部门主管',
      permissions: {
        data_scope: 'dept',
        modules: {
          dashboard: { view: true },
          plans: { view: true, add: true, edit: true, delete: true, co_assign: true },
          logs: { view: true, add: true, edit: true, review: true },
          board: { view: true }, reports: { view: true }, org: { view: true },
        },
      },
    },
    {
      id: 3, name: '普通成员',
      permissions: {
        data_scope: 'self',
        modules: {
          dashboard: { view: true },
          plans: { view: true, add: true, edit: true },
          logs: { view: true, add: true, edit: true },
          board: { view: true }, reports: { view: true },
        },
      },
    },
  ];

  /* ------------------------------------------------------------
   * 归一化
   * ------------------------------------------------------------ */

  function nowStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
         + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /**
   * 把任意输入归一化成合法实体
   *
   * @param {string} entity  SCHEMAS 的键
   * @param {object} input   原始数据（可能来自表单、导入文件、旧版本）
   * @param {object} opts    { keepId, strict }
   * @returns {object}
   */
  function normalize(entity, input, opts) {
    const schema = SCHEMAS[entity];
    if (!schema) throw new window.Errors.AppError('未知数据类型：' + entity, 'E_SCHEMA');

    const o = opts || {};
    const src = (input && typeof input === 'object') ? input : {};
    const out = {};

    for (const key of Object.keys(schema)) {
      const def = schema[key];
      const raw = src[key];

      // 系统字段（id / 时间戳）单独处理
      if (key === 'id') {
        if (o.keepId !== false && raw !== undefined && raw !== null) {
          const n = Vd.asInt(raw, 0);
          if (n > 0) out.id = n;
        }
        continue;
      }
      if (key === 'created_at' || key === 'updated_at') {
        const s = Vd.asText(raw, key).trim();
        out[key] = s || nowStr();
        continue;
      }

      switch (def.type) {
        case 'int': {
          let n = Vd.asInt(raw, def.default === undefined ? 0 : def.default);
          if (def.min !== undefined && n < def.min) n = def.min;
          if (def.max !== undefined && n > def.max) n = def.max;
          out[key] = n;
          break;
        }
        case 'bool':
          out[key] = raw === undefined ? !!def.default : Vd.asBool(raw);
          break;
        case 'date': {
          // 可空日期（default === null）：给了非法值就归 null，绝不猜成"今天"
          // —— 否则用户填错日期会被静默改成今天，比报错更危险
          if (def.default === null) {
            if (raw === null || raw === undefined || raw === '') {
              out[key] = null;
            } else {
              const s = String(raw).trim();
              out[key] = Vd.isDate(s) ? s : null;
            }
          } else {
            out[key] = Vd.date(raw, def.default);
          }
          break;
        }
        case 'time':
          out[key] = Vd.time(raw);
          break;
        case 'enum': {
          const list = ENUMS[def.enum] || [];
          out[key] = Vd.oneOf(raw, list, def.default);
          break;
        }
        case 'json': {
          let v = raw;
          if (typeof v === 'string') {
            try { v = JSON.parse(v); } catch (_) { v = def.default; }
          }
          out[key] = (v === undefined || v === null)
            ? JSON.parse(JSON.stringify(def.default))
            : v;
          break;
        }
        case 'str':
        default: {
          let s = Vd.asText(raw, key);
          // 文本字段统一去首尾空白：数据库里存 "  abc  " 会让搜索、去重、
          // 唯一索引都出现意外。业务需要保留空白的（如日志正文）用 trim=false。
          if (def.trim !== false) s = s.trim();
          if (def.max) s = Vd.clip(s, def.max);
          if (def.default !== undefined && def.default !== null && s === '') s = def.default;
          out[key] = s;
        }
      }

      // 必填在归一化阶段不抛错（导入容忍脏数据），但记录空缺
      if (def.required && (out[key] === '' || out[key] === null || out[key] === undefined)) {
        if (o.strict) throw new window.Errors.ValidationError((def.label || key) + '不能为空', key);
        out[key] = def.type === 'str' ? '(未命名)' : out[key];
      }
    }

    return out;
  }

  /** 只保留 schema 里定义的字段（丢弃未知字段，防脏数据扩散） */
  function pick(entity, input) {
    const schema = SCHEMAS[entity] || {};
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const k of Object.keys(schema)) {
      if (input[k] !== undefined) out[k] = input[k];
    }
    return out;
  }

  /** 计算变化字段（用于增量更新） */
  function diff(entity, oldRow, newData) {
    const schema = SCHEMAS[entity] || {};
    const changed = {};
    let n = 0;
    for (const k of Object.keys(newData)) {
      if (k === 'id' || !schema[k]) continue;
      const a = oldRow ? oldRow[k] : undefined;
      const b = newData[k];
      const same = (a === b)
        || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
      if (!same) { changed[k] = b; n++; }
    }
    return { changed, count: n };
  }

  /** 校验实体必填字段（写库前调用，strict 模式） */
  function assertValid(entity, row) {
    const schema = SCHEMAS[entity] || {};
    for (const k of Object.keys(schema)) {
      const def = schema[k];
      if (!def.required) continue;
      const v = row[k];
      if (v === null || v === undefined || v === '') {
        throw new window.Errors.ValidationError((def.label || k) + '不能为空', k);
      }
      if (def.max && Array.from(String(v)).length > def.max) {
        throw new window.Errors.ValidationError((def.label || k) + '过长', k);
      }
    }
    return true;
  }

  window.Schema = {
    ENUMS, LABELS, STATUS_COLOR, SCHEMAS,
    DEFAULT_SETTINGS, DEFAULT_ROLES,
    normalize, pick, diff, assertValid, nowStr,
    /** 文案便捷方法 */
    label(group, key) {
      const m = LABELS[group];
      return (m && m[key] !== undefined) ? m[key] : String(key);
    },
    statusColor(s) { return STATUS_COLOR[s] || 'slate'; },
    has(entity) { return !!SCHEMAS[entity]; },
    fields(entity) { return Object.keys(SCHEMAS[entity] || {}); },
  };
})();
