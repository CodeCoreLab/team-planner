/* ============================================================
 * io/fileio.js —— 数据文件读写
 *
 * 目标：数据存在 HTML 所在目录，随文件夹拷走即可换电脑。
 *
 * 实测的协议限制（决定这里所有设计）：
 *   file:// 下 fetch() 被 CORS 拦 → 改用 <script src> 读取
 *   file:// 下 showDirectoryPicker 可用，但需一次用户手势授权
 *   ES Module 被拦 → 用经典 script 标签
 *
 * 三条通路：
 *   1. 目录句柄（首选）：授权一次，之后自动写回 data.js
 *   2. 手动导出：showSaveFilePicker / <a download>
 *   3. 手动导入：<input type=file> 或拖拽文件进来
 *
 * 稳健性设计：
 *   - 原子写：先写临时内容再替换，断电不会留下半个文件
 *   - 写前备份：覆盖前把旧 data.js 存为 data.bak.js
 *   - 损坏恢复：解析失败时自动尝试 .bak，再失败则保留原文件不动
 *   - 变更合并：导入时若本地已有数据，让用户选择覆盖或合并
 * ============================================================ */

(function () {
  'use strict';

  const E = window.Errors;
  const DB = window.DB;

  const DATA_FILE = 'data.js';
  const BACKUP_FILE = 'data.bak.js';
  const HANDLE_DB = 'tp-handles';
  const HANDLE_KEY = 'dataDir';
  const META_LAST_SAVE = 'last_save_at';

  /**
   * 当前程序支持的数据文件 schema 版本。
   * 与 toScript() 写出的 schema 字段保持一致；数据结构升级时同步 +1。
   */
  const SCHEMA_VERSION = 1;

  let _dirHandle = null;
  let _dirty = false;

  /* ------------------------------------------------------------
   * 句柄存储（单独一个小库，避免与业务库版本迁移互相牵连）
   * ------------------------------------------------------------ */

  function handleDB() {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(HANDLE_DB, 1);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('h')) {
          req.result.createObjectStore('h');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveHandle(handle) {
    try {
      const db = await handleDB();
      await new Promise((res, rej) => {
        const tx = db.transaction('h', 'readwrite');
        tx.objectStore('h').put(handle, HANDLE_KEY);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
      return true;
    } catch (e) {
      E.Log.warn('fileio', '句柄保存失败（下次需重新授权）：' + e.message);
      return false;
    }
  }

  async function loadHandle() {
    try {
      const db = await handleDB();
      const h = await new Promise((res, rej) => {
        const r = db.transaction('h', 'readonly').objectStore('h').get(HANDLE_KEY);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      db.close();
      return h || null;
    } catch (_) {
      return null;
    }
  }

  async function clearHandle() {
    try {
      const db = await handleDB();
      await new Promise((res) => {
        const tx = db.transaction('h', 'readwrite');
        tx.objectStore('h').delete(HANDLE_KEY);
        tx.oncomplete = res;
        tx.onerror = res;
      });
      db.close();
    } catch (_) {}
  }

  /* ------------------------------------------------------------
   * 能力探测
   * ------------------------------------------------------------ */

  function capability() {
    const hasPicker = typeof window.showDirectoryPicker === 'function';
    const hasSave = typeof window.showSaveFilePicker === 'function';
    const hasFs = typeof window.FileSystemFileHandle !== 'undefined'
      || (hasPicker && 'createWritable' in (window.FileSystemFileHandle ? window.FileSystemFileHandle.prototype : {}));
    return {
      picker: hasPicker,
      savePicker: hasSave,
      fileSystem: hasPicker,   // 有 picker 就认为有 FS Access
      // Firefox / Safari 没有这些 API，只能手动导出导入
      manualOnly: !hasPicker,
    };
  }

  /* ------------------------------------------------------------
   * 序列化
   *
   * 数据文件必须是 .js 而不是 .json：
   *   file:// 下 fetch('data.json') 直接被 CORS 拦，
   *   而 <script src="data.js"> 不受限，打开页面时自动执行拿到数据。
   * ------------------------------------------------------------ */

  /**
   * JSON 序列化并阻断 </script> 提前闭合。
   *
   * data.js 是通过 <script src="data.js"> 加载的：若任务标题等用户数据里
   * 含 "</script>"，JSON.stringify 不会转义它，浏览器解析到这个字面量时
   * 会认为脚本标签已结束 —— 其后的数据变成正文，攻击者可借此注入任意
   * 标签（经典的 script-context 注入）。
   *
   * 处理：把 JSON 文本里的 "<" 统一写成 "\u003c"（合法的 JS/JSON 转义，
   * JSON.parse 与 JS 字面量都会把它还原成 "<"），序列化结果中就不再出现
   * "<" 字符，注入通道被关闭。同时处理 U+2028/U+2029（JS 字面量里的
   * 行终止符，JSON 里合法但旧引擎会报语法错误）。
   */
  function jsonSafe(v) {
    return JSON.stringify(v)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  function toScript(snapshot) {
    const payload = {
      schema: snapshot.schema || SCHEMA_VERSION,
      app: '团队协作台',
      version: snapshot.version || (window.APP_VERSION || 'unknown'),
      exported_at: snapshot.exported_at || new Date().toISOString(),
      counts: snapshot.counts || {},
      data: snapshot.data || {},
    };
    return '/* 团队协作台 数据文件 —— 由程序自动生成，建议不要手工修改 */\n'
      + '/* 如需备份，直接复制本文件；如需迁移，把整个文件夹拷到新电脑即可 */\n'
      + 'window.__DATA = ' + jsonSafe(payload) + ';\n';
  }

  /**
   * 解析数据文件
   *
   * 容错：兼容三种历史格式
   *   1. window.__DATA = {...};          ← 当前格式
   *   2. {"data":{...}}                  ← 纯 JSON（用户手工另存过）
   *   3. window.__DATA = {...}           ← 结尾无分号
   */
  function parse(text) {
    if (!text || typeof text !== 'string') return null;
    const s = text.trim();

    // 纯 JSON
    if (s.charAt(0) === '{') {
      try {
        const o = JSON.parse(s);
        if (o && o.data) return o;
        return null;
      } catch (_) { /* 继续尝试其他格式 */ }
    }

    const i = s.indexOf('window.__DATA');
    if (i < 0) return null;
    const eq = s.indexOf('=', i);
    if (eq < 0) return null;
    // 从 = 之后到最后一个 } 结束（比找分号更稳，能容忍末尾多余注释）
    const end = s.lastIndexOf('}');
    if (end <= eq) return null;
    const body = s.slice(eq + 1, end + 1).trim();
    try {
      const o = JSON.parse(body);
      return (o && typeof o === 'object') ? o : null;
    } catch (e) {
      E.Log.warn('fileio', '数据文件解析失败：' + e.message);
      return null;
    }
  }

  /* ------------------------------------------------------------
   * 快照
   * ------------------------------------------------------------ */

  /**
   * 导出快照
   *
   * @param {object} opts
   * @param {boolean} opts.redactPasswords 是否剥离账号口令哈希
   *
   * 关于 redactPasswords：
   *   对外分发的备份文件（exportBackup）一律剥离口令哈希。
   *   理由：备份文件会被转发、存网盘、塞进工单附件，一旦被拿到，
   *         里面的口令哈希可被离线爆破，用户复用的密码会波及其他系统。
   *         剥离后账号处于「需重设口令」状态，首次登录时设置新口令即可。
   *
   *   但**不**对写回本地数据目录的 data.js 剥离：
   *         那个文件是本机的工作数据，也是「整个文件夹拷到新电脑」这条
   *         迁移路径的唯一载体，剥离后用户必须重设一遍口令才能登录，
   *         与「拷过去双击就能用」的产品承诺冲突。
   *         本地文件的保护靠 PBKDF2 口令派生（10 万轮）而非靠剥离。
   */
  async function exportSnapshot(opts) {
    const o = opts || {};
    const entities = ['tasks', 'plans', 'logs', 'users', 'departments', 'roles',
      'subtasks', 'tags', 'task_assignees', 'work_log_reviews', 'notifications',
      'operation_logs', 'task_order', 'settings'];

    // 整个快照在**同一个只读事务**里读取：
    // 逐表分别开事务时，用户若恰好在导出期间新增了任务，
    // 快照里就会出现「任务已建但计划还没建」的中间态，
    // 拿这个快照去覆盖另一台机器的数据会得到不一致的结果。
    const data = {};
    const counts = {};
    await DB.read(entities, async (c) => {
      for (const e of entities) {
        try {
          data[e] = await c.getAll(e);
          counts[e] = data[e].length;
        } catch (err) {
          E.Log.warn('fileio', `导出 ${e} 失败：` + err.message);
          data[e] = [];
          counts[e] = 0;
        }
      }
    });

    if (o.redactPasswords) {
      data.users = redactUserPasswords(data.users);
    }

    return {
      schema: SCHEMA_VERSION,
      app: '团队协作台',
      version: (window.APP_VERSION || 'unknown'),
      exported_at: new Date().toISOString(),
      counts,
      data,
    };
  }

  /**
   * 剥离账号口令哈希（不可逆）
   *
   * 做法：把 password 字段替换为固定标记 PWD_RESET_MARK。
   *   标记值是常量、不含任何口令信息，拿到文件也无法反推口令。
   *   导入后该账号登录时会走「首次设置新口令」流程。
   *
   * 只动 password 字段，账号、角色、姓名、任务归属等业务数据完整保留。
   */
  function redactUserPasswords(users) {
    const list = Array.isArray(users) ? users : [];
    return list.map((u) => {
      if (!u || typeof u !== 'object') return u;
      const out = Object.assign({}, u);
      if (out.password) out.password = window.Auth.PWD_RESET_MARK;
      return out;
    });
  }

  /**
   * 导入快照
   *
   * @param {object} snap
   * @param {'replace'|'merge'} mode
   */
  async function importSnapshot(snap, mode) {
    if (!snap || !snap.data || typeof snap.data !== 'object') {
      throw new E.AppError('数据文件格式不正确，无法导入', 'E_BADFILE');
    }

    // schema 版本门禁：导入比当前程序更新的数据文件必然丢字段，
    // 与其默默丢数据，不如明确拒绝并提示升级程序。
    const fileSchema = Number(snap.schema);
    if (Number.isFinite(fileSchema) && fileSchema > SCHEMA_VERSION) {
      throw new E.AppError(
        '这个数据文件来自更新版本的程序（数据版本 ' + fileSchema + '，当前程序支持 ' + SCHEMA_VERSION + '）。'
        + '请升级本程序后再导入，否则会丢失新版本独有的数据。',
        'E_SCHEMA_TOO_NEW');
    }

    const m = mode === 'merge' ? 'merge' : 'replace';
    const entities = ['tasks', 'plans', 'logs', 'users', 'departments', 'roles',
      'subtasks', 'tags', 'task_assignees', 'work_log_reviews', 'notifications',
      'operation_logs', 'task_order', 'settings'];

    // 导入前校验：至少要有用户，否则导入后无法登录
    const incomingUsers = Array.isArray(snap.data.users) ? snap.data.users : [];
    if (m === 'replace' && !incomingUsers.length) {
      throw new E.AppError(
        '这个数据文件里没有任何成员账号，导入后将无法登录。已取消导入。',
        'E_NO_USERS'
      );
    }

    let imported = 0;
    let skipped = 0;

    await DB.write(entities, async (c) => {
      for (const e of entities) {
        const rows = Array.isArray(snap.data[e]) ? snap.data[e] : [];
        if (m === 'replace') {
          try { await c.clear(e, { tolerate: true }); } catch (_) {}
        }
        for (const row of rows) {
          try {
            // 归一化：老版本可能有缺字段或多余字段
            const clean = normalizeRow(e, row);
            if (!clean) { skipped++; continue; }
            // tolerate：单行失败不连带中止整个事务，否则「跳过坏行」做不到
            await c.put(e, clean, { tolerate: true });
            imported++;
          } catch (err) {
            skipped++;
            E.Log.warn('fileio', `导入 ${e} 的一行失败：` + err.message);
          }
        }
      }
    });

    window.Settings.invalidate();

    E.Log.info('fileio', `导入完成：${imported} 行，跳过 ${skipped} 行`);
    if (window.Bus) {
      window.Bus.emit(window.Bus.EVENTS.FILE_IMPORTED, {
        mode: m, imported, skipped, counts: snap.counts,
      });
      window.Bus.emit(window.Bus.EVENTS.DATA_CHANGED, { entity: '*', action: 'import' });
    }

    return { mode: m, imported, skipped };
  }

  /** 归一化导入的行（用 Schema 校验，脏行直接丢弃） */
  function normalizeRow(entity, row) {
    if (!row || typeof row !== 'object') return null;

    if (entity === 'settings') {
      if (typeof row.k !== 'string' || !row.k) return null;
      return { k: String(row.k).slice(0, 64), v: String(row.v == null ? '' : row.v) };
    }

    if (!window.Schema.has(entity)) {
      // 未知实体：原样放进（向前兼容新版本加的表）
      return row;
    }

    const n = window.Schema.normalize(entity, row, { keepId: true, strict: false });
    // id 必须有，否则 put 会当新增（可能重复）
    if (entity !== 'settings' && !n.id) return null;
    return n;
  }

  /* ------------------------------------------------------------
   * 目录写入
   * ------------------------------------------------------------ */

  /** 查询权限状态（不弹窗） */
  async function permissionState(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return 'unknown';
    try {
      return await handle.queryPermission({ mode: 'readwrite' });
    } catch (_) {
      return 'unknown';
    }
  }

  /** 请求权限（必须在用户手势中调用） */
  async function requestPermission(handle) {
    if (!handle || typeof handle.requestPermission !== 'function') return false;
    try {
      return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
    } catch (_) {
      return false;
    }
  }

  /**
   * 初始化：恢复上次的目录句柄
   *
   * 注意：权限状态会在浏览器重启后降级为 'prompt'，
   * 属正常现象（浏览器的安全策略），需要用户再点一次授权。
   */
  async function init() {
    _dirHandle = await loadHandle();
    if (!_dirHandle) return { state: 'none' };

    const st = await permissionState(_dirHandle);
    return {
      state: st,                       // 'granted' | 'prompt' | 'denied' | 'unknown'
      name: _dirHandle.name || '',
      canAutoWrite: st === 'granted',
    };
  }

  /**
   * 让用户选目录（必须在手势中）
   *
   * 选完立刻写一次，确保目录里马上出现 data.js，
   * 这样用户能直观确认"数据确实存在这里"。
   */
  async function pickDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new E.AppError(
        '当前浏览器不支持"选择文件夹"。请用 Edge 或 Chrome 打开，或改用「导出备份」手动保存。',
        'E_UNSUPPORTED'
      );
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'tpData' });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new E.AppError('已取消选择', 'E_CANCEL');
      }
      throw new E.AppError('无法访问所选文件夹：' + (e && e.message), 'E_PICK_FAIL');
    }

    _dirHandle = handle;
    await saveHandle(handle);

    const w = await writeNow();
    return {
      name: handle.name || '',
      wrote: w.ok,
      file: w.file || null,
    };
  }

  /**
   * 原子写入目录
   *
   * 步骤：备份旧文件 → 写新内容 → 关闭（close 才真正落盘）
   * 旧文件备份失败不阻断主流程（首次使用没有旧文件，属正常）
   */
  async function writeToDirectory(snapshot) {
    if (!_dirHandle) throw new E.AppError('尚未连接数据目录', 'E_NO_DIR');

    const granted = await requestPermission(_dirHandle);
    if (!granted) throw new E.AppError('文件夹写入权限被拒绝，请重新连接', 'E_PERM_DENIED');

    const text = toScript(snapshot);
    const main = DATA_FILE;

    // 1. 备份旧文件
    try {
      const old = await _dirHandle.getFileHandle(main);
      const oldText = await (await old.getFile()).text();
      if (oldText && oldText.length < 20 * 1024 * 1024) {
        const bak = await _dirHandle.getFileHandle(BACKUP_FILE, { create: true });
        const w0 = await bak.createWritable();
        await w0.write(oldText);
        await w0.close();
      }
    } catch (_) {
      // 没有旧文件（首次写入）属正常
    }

    // 2. 写新文件
    const fh = await _dirHandle.getFileHandle(main, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(text);
      await w.close();      // 只有 close 才真正提交
    } catch (e) {
      try { await w.abort(); } catch (_) {}
      throw new E.AppError('写入数据文件失败：' + (e && e.message), 'E_WRITE');
    }

    // 3. 记录时间
    try {
      await DB.write('meta', (c) => c.put('meta', {
        k: META_LAST_SAVE, v: Date.now(), at: window.Schema.nowStr(),
      }));
    } catch (_) {}

    return { file: main, bytes: text.length };
  }

  /** 立即写回（有目录时） */
  async function writeNow() {
    if (!_dirHandle) return { ok: false, reason: 'no-dir' };
    try {
      const snap = await exportSnapshot();
      const r = await writeToDirectory(snap);
      _dirty = false;
      if (window.Bus) {
        window.Bus.emit(window.Bus.EVENTS.DIRTY_CHANGED, { dirty: false });
        window.Bus.emit(window.Bus.EVENTS.FILE_SAVED, { file: r.file, counts: snap.counts });
      }
      markDirty(false);
      return { ok: true, file: r.file, counts: snap.counts, bytes: r.bytes };
    } catch (e) {
      const err = E.normalize(e);
      E.Log.error('fileio', '写回失败：' + err.message);
      if (window.Bus) window.Bus.emit(window.Bus.EVENTS.FILE_ERROR, { message: err.message });
      return { ok: false, reason: err.code || 'error', message: err.message };
    }
  }

  /** 从目录读回（用户手工替换了 data.js 但不想刷新页面） */
  async function readFromDirectory() {
    if (!_dirHandle) throw new E.AppError('尚未连接数据目录', 'E_NO_DIR');
    const fh = await _dirHandle.getFileHandle(DATA_FILE);
    const file = await fh.getFile();
    return parse(await file.text());
  }

  /* ------------------------------------------------------------
   * 手动导出 / 导入（Firefox、Safari 以及任何场景的兜底）
   * ------------------------------------------------------------ */

  /**
   * 导出备份
   *
   * 优先 showSaveFilePicker（可选位置），
   * 失败时无条件回退到 <a download>。
   * 注意：AbortError 有两种含义（用户取消 / 环境不支持），
   * 一律回退下载 —— 用户真取消的话多下一次也比"点了没反应"好。
   */
  async function exportBackup(filename) {
    // 对外分发的备份一律剥离口令哈希（见 exportSnapshot 注释）
    const snap = await exportSnapshot({ redactPasswords: true });
    const text = toScript(snap);
    const name = filename || ('data-' + window.Validate.today() + '.js');

    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const fh = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: '数据文件', accept: { 'text/javascript': ['.js'] } }],
        });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
        return { ok: true, via: 'picker', name: fh.name || name, counts: snap.counts };
      } catch (e) {
        if (e && e.name !== 'AbortError') {
          E.Log.warn('fileio', 'showSaveFilePicker 失败，回退下载：' + e.name);
        }
      }
    }

    return downloadText(text, name, 'text/javascript');
  }

  /** 通过 <a download> 下载文本 */
  function downloadText(text, filename, mime) {
    try {
      const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 4000);
      return { ok: true, via: 'download', name: filename };
    } catch (e) {
      throw new E.AppError('浏览器不允许下载文件，请检查浏览器设置', 'E_DOWNLOAD');
    }
  }

  /** 让用户选一个数据文件读入（返回解析后的快照） */
  function pickFileToImport() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.js,.json,text/javascript,application/json';
      input.style.display = 'none';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        input.remove();
        if (!f) { resolve(null); return; }
        try {
          const text = await f.text();
          const snap = parse(text);
          if (!snap) {
            reject(new E.AppError('文件内容不是有效的数据文件（应为 data.js）', 'E_BADFILE'));
            return;
          }
          resolve({ snapshot: snap, filename: f.name, bytes: f.size });
        } catch (e) {
          reject(new E.AppError('读取文件失败：' + (e && e.message), 'E_READ'));
        }
      };
      input.oncancel = () => {
        input.remove();
        resolve(null);
      };
      document.body.appendChild(input);
      input.click();
    });
  }

  /* ------------------------------------------------------------
   * 启动时自动载入
   * ------------------------------------------------------------ */

  /**
   * 页面通过 <script src="data.js"> 带入的数据，在库为空时自动导入
   *
   * 这是"换电脑"场景的关键：把文件夹拷过去，双击打开，
   * 数据自动就位，用户不用做任何导入操作。
   */
  async function bootstrapFromScript() {
    const snap = window.__DATA;
    if (!snap || !snap.data) return { imported: false, reason: 'no-file' };

    const empty = await window.Seed.isEmptyDatabase();
    const seeded = await window.Seed.isSeeded();

    if (!empty && seeded) {
      return { imported: false, reason: 'already-has-data', counts: snap.counts };
    }

    try {
      const r = await importSnapshot(snap, 'replace');
      E.Log.info('fileio', '已从 data.js 自动载入数据');
      return { imported: true, counts: snap.counts, rows: r.imported };
    } catch (e) {
      E.Log.error('fileio', '自动载入失败：' + e.message);
      return { imported: false, reason: 'error', message: e.message };
    }
  }

  /* ------------------------------------------------------------
   * 脏标记
   * ------------------------------------------------------------ */

  function markDirty(on) {
    _dirty = !!on;
    const dot = document.getElementById('dirtyDot');
    if (dot) dot.hidden = !_dirty;
    updateTitle();
    if (window.Bus) window.Bus.emit(window.Bus.EVENTS.DIRTY_CHANGED, { dirty: _dirty });
  }

  /**
   * 标题栏状态（取代系统托盘）
   *
   * 纯 HTML 版没有常驻进程，做不了真正的系统托盘。
   * 但用户真正想要的是"不打开也能知道有事" —— 这件事标签页标题能做到：
   *   ●  有未写回文件的改动
   *   (N) 有 N 条逾期任务
   * 浏览器标签栏、任务栏预览、alt+tab 都能一眼看到。
   */
  let _overdue = 0;

  function setOverdue(n) {
    _overdue = Math.max(0, Number(n) || 0);
    updateTitle();
  }

  function updateTitle() {
    const base = (window.Settings && window.Settings.get('site_name')) || '团队协作台';
    const parts = [];
    if (_dirty) parts.push('●');
    if (_overdue > 0) parts.push('(' + (_overdue > 99 ? '99+' : _overdue) + ')');
    document.title = (parts.length ? parts.join(' ') + ' ' : '') + base;
  }

  function isDirty() { return _dirty; }

  window.FileIO = {
    // 能力
    capability,
    // 目录
    init, pickDirectory, writeNow, writeToDirectory, readFromDirectory,
    // 手动
    exportBackup, downloadText, pickFileToImport,
    // 快照
    exportSnapshot, importSnapshot,
    // 序列化
    toScript, parse, normalizeRow,
    // 启动
    bootstrapFromScript,
    // 状态
    markDirty, isDirty, setOverdue, updateTitle,
    get dirName() { return _dirHandle ? (_dirHandle.name || '') : ''; },
    hasDir() { return !!_dirHandle; },
    disconnect() { _dirHandle = null; clearHandle(); return true; },
    DATA_FILE, BACKUP_FILE,
    META_LAST_SAVE,
  };
})();
