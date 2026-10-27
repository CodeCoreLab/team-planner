/* ============================================================
 * boot.js —— 启动器
 *
 * 职责：
 *   1. 按依赖顺序加载模块（file:// 下 ES Module 被 CORS 拦，只能用经典 script）
 *   2. 加载失败时给出明确提示（缺哪个文件说哪个）
 *   3. 渲染致命错误的兜底界面
 *
 * 为什么手写加载器而不直接写一堆 <script> 标签：
 *   - 可以精确报出"哪个模块没加载上"
 *   - 可以在加载失败时显示可读的错误页，而不是白屏
 *   - 顺序在代码里一目了然，不依赖 HTML 里标签的先后
 * ============================================================ */

const APP_VERSION = '1.0.0';
// 暴露到 window：导出快照时要用版本号打标，而其它模块是经典 script（非 ES Module），
// 无法 import 常量，只能从 window 上取。
window.APP_VERSION = APP_VERSION;

/**
 * 模块清单（顺序即依赖顺序）
 *
 * 分层约定：
 *   core  → 不依赖任何东西
 *   data  → 依赖 core
 *   io    → 依赖 core + data
 *   ui    → 依赖 core + data（kit 不依赖 io）
 *   pages → 依赖以上全部
 */
const MODULES = [
  // ---- core ----
  ['js/core/errors.js', 'Errors'],
  ['js/core/bus.js', 'Bus'],
  ['js/core/validate.js', 'Validate'],
  ['js/core/schema.js', 'Schema'],

  // ---- data ----
  ['js/data/db.js', 'DB'],
  ['js/data/auth.js', 'Auth'],
  ['js/data/repo.js', 'Repo'],
  ['js/data/taskRepo.js', 'TaskRepo'],
  ['js/data/planRepo.js', 'PlanRepo'],
  ['js/data/logRepo.js', 'LogRepo'],
  ['js/data/orgRepo.js', 'OrgRepo'],
  ['js/data/miscRepo.js', 'Settings'],   // 同时导出 NoticeRepo / OpLog / SearchRepo / ExportRepo
  ['js/data/seed.js', 'Seed'],

  // ---- io ----
  ['js/io/fileio.js', 'FileIO'],

  // ---- ui ----
  ['js/ui/kit.js', 'UI'],
  ['js/ui/shell.js', 'AppShell'],

  // ---- pages ----
  ['js/pages/dashboard.js', null],
  ['js/pages/plans.js', null],
  ['js/pages/plan_manage.js', null],
  ['js/pages/board.js', null],
  ['js/pages/logs.js', null],
  ['js/pages/reports.js', null],
  ['js/pages/org.js', null],
  ['js/pages/settings.js', null],
  ['js/pages/profile.js', null],
  ['js/pages/oplogs.js', null],
];

/* ============================================================
 * 错误页
 * ============================================================ */

function fatalPage(title, detail) {
  const root = document.getElementById('root') || document.body;
  root.innerHTML =
    '<div class="fatal">'
    + '<h1>' + escapeHtml(title) + '</h1>'
    + '<p>' + escapeHtml(detail) + '</p>'
    + '<div class="fatal__help">'
    + '<p>请确认解压后以下内容都在同一文件夹内：</p>'
    + '<pre>index.html\ndata.js（首次使用后生成）\ncss/app.css\njs/core/…\njs/data/…\njs/io/…\njs/ui/…\njs/pages/…</pre>'
    + '<p>常见原因：解压不完整、把 index.html 单独拷了出来、或 js 目录被改名。</p>'
    + '</div>'
    + '<button class="btn btn--primary" onclick="location.reload()">重新载入</button>'
    + '</div>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ============================================================
 * 加载器
 * ============================================================ */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;      // 保证按创建顺序执行
    s.onload = () => resolve(src);
    s.onerror = () => reject(new Error('无法加载 ' + src));
    document.head.appendChild(s);
  });
}

function loadCSS(href) {
  return new Promise((resolve) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = () => resolve(true);
    l.onerror = () => {
      console.warn('样式文件缺失：' + href);
      resolve(false);
    };
    document.head.appendChild(l);
  });
}

/**
 * 加载 data.js
 *
 * 打包时始终放一个占位文件（只有注释，不含 window.__DATA），
 * 因此这里直接插入 <script> 不会产生任何控制台报错：
 *   - 占位文件：解析出 undefined，走到"首次使用"分支
 *   - 真实数据：挂上 window.__DATA，自动导入
 *
 * 早期用 fetch 探测存在性，但那会在文件缺失时打印 404 / CORS 报错，
 * 用户打开开发者工具会误以为程序坏了 —— 用占位文件从根上避免。
 */
async function loadDataFile() {
  try {
    await loadScript('data.js');
  } catch (e) {
    // 脚本标签的 error 事件只在「文件真的不存在 / 无法加载」时触发。
    // 这里不阻断启动，走首次使用流程。
    return false;
  }
  // 脚本加载成功但内容不是合法数据文件：说明 data.js 存在却已损坏
  // （例如被手工编辑坏、写入过程中断电）。这种情况必须显式提示，
  // 否则用户会以为「数据没了」，而真实原因是文件解析失败。
  if (window.__DATA === undefined) {
    return false;
  }
  if (!window.__DATA || typeof window.__DATA !== 'object' || !window.__DATA.data) {
    window.__DATA_FILE_ERROR__ = 'data.js 的内容不是有效的数据文件（缺少 data 字段）。';
    return false;
  }
  return true;
}

/** 可选加载（保留给其他可选资源） */
function loadOptional(src) {
  return loadScript(src).then(() => true).catch(() => false);
}

/* ============================================================
 * 启动
 * ============================================================ */

(async function boot() {
  const t0 = performance.now();

  // 1. 先挂全局兜底（在任何业务代码之前，才能捕获它们的问题）
  try {
    await loadScript('js/core/errors.js');
  } catch (e) {
    fatalPage('程序文件不完整', '核心模块 js/core/errors.js 加载失败。');
    return;
  }

  const E = window.Errors;
  E.Log.info('boot', '开始加载，版本 ' + APP_VERSION);

  // 致命错误交给 UI 层展示
  E.setFatalHandler((err) => {
    if (err && !err.expected) {
      // UI 可能还没加载完，延迟一点
      setTimeout(() => {
        if (window.UI) window.UI.toast('出现未预期的错误，可点右上角「诊断」查看', 'err');
      }, 200);
    }
  });

  // 2. 可选：同目录的数据文件（换电脑场景的关键）
  const hasData = await loadDataFile();
  if (hasData && window.__DATA) {
    E.Log.info('boot', '检测到 data.js（' + JSON.stringify(window.__DATA.counts || {}) + '）');
  } else if (window.__DATA_FILE_ERROR__) {
    E.Log.error('boot', window.__DATA_FILE_ERROR__);
    // 不阻断启动，但必须让用户知道「文件在、只是读不出来」，
    // 否则用户会误判为数据丢失，从而做出错误决策。
    setTimeout(() => {
      if (window.UI) {
        window.UI.toast(window.__DATA_FILE_ERROR__ + ' 请用「备份」导出的文件替换 data.js。', 'err', { duration: 12000 });
      }
    }, 800);
  } else {
    E.Log.info('boot', '未检测到 data.js（首次使用或尚未保存）');
  }

  // 3. 样式
  await loadCSS('css/app.css');

  // 4. 按序加载其余模块
  for (let i = 1; i < MODULES.length; i++) {
    const [src, globalName] = MODULES[i];
    try {
      await loadScript(src);
    } catch (e) {
      E.Log.error('boot', '模块加载失败：' + src);
      fatalPage('程序文件不完整', '模块加载失败：' + src + '。请确认 js 目录完整。');
      return;
    }

    if (globalName && !window[globalName]) {
      E.Log.error('boot', src + ' 已加载但没有导出 ' + globalName);
      fatalPage('程序内部错误', src + ' 已加载但没有导出 ' + globalName + '，可能是文件版本不匹配。');
      return;
    }
  }

  // 5. 版本戳
  const stamp = document.getElementById('ver');
  if (stamp) stamp.textContent = 'v' + APP_VERSION;

  const loadMs = Math.round(performance.now() - t0);
  E.Log.info('boot', `全部模块就绪，耗时 ${loadMs}ms`);

  // 6. 显示界面骨架，然后交给 shell
  const tip = document.getElementById('bootTip');
  if (tip) tip.hidden = true;

  try {
    await window.AppShell.start();
  } catch (e) {
    const err = E.normalize(e);
    E.Log.error('boot', '启动失败：' + err.message, { stack: String(err.stack || '').slice(0, 1000) });
    fatalPage('启动失败', err.message || '未知错误');
  }
})();
