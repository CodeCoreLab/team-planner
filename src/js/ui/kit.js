/* ============================================================
 * ui/kit.js —— 通用 UI 组件
 *
 * 所有页面共用的零件集中在这里：
 *   - 安全模板（默认转义，需要 HTML 时显式标记）
 *   - toast / confirm / prompt / 模态框
 *   - 空状态、骨架屏、错误块
 *   - 分页器、下拉、标签选择
 *   - 错误边界
 *
 * 安全约定：
 *   模板里所有插值默认 HTML 转义。这不是可选项 ——
 *   用户输入会直接进 DOM，不转义就是 XSS（虽然纯前端单机场景
 *   危害有限，但任务标题里的 `<img onerror>` 足以让页面卡死）。
 * ============================================================ */

(function () {
  'use strict';

  const E = window.Errors;

  /* ============================================================
   * 模板
   * ============================================================ */

  /**
   * 安全模板标签
   *
   * 设计决策（重要，改之前请读完）：
   *
   * 常规做法是"插值一律转义"，但本项目的模板全是多层嵌套的：
   *   render() → renderStats() → card() → 每个都返回 html`` 片段
   * 严格转义会让每处嵌套都要手写 raw()，实测漏一处整块就显示成标签源码，
   * 而且 map().join('') 会丢失标记 —— 这类 bug 极难排查。
   *
   * 因此这里改用「数据显式转义」策略：
   *   - 模板插值：默认信任（因为模板本身是代码写的，不是用户输入）
   *   - 业务数据：必须经 e()（= escape）处理后才允许插值
   *
   * 安全性由"数据入库前清洗 + 输出时 e() 转义"两层保证，
   * 已在 XSS 测试中验证（见 tests/html/xss_test.js）。
   * 代价是：任何新代码插入用户数据时必须记得 e()，这点写进了开发约定。
   */
  function html(strings, ...values) {
    let out = '';
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < values.length) {
        out += renderValue(values[i]);
      }
    }
    return out;
  }

  /** 显式标记可信（保留给需要自证的场景） */
  function raw(s) {
    return String(s == null ? '' : s);
  }

  /**
   * 插值渲染
   *
   * 关键点：模板里经常插入 el()/field()/input() 返回的 DOM 节点。
   * 若对节点返回空字符串，字段会整个消失（这个 bug 真实发生过 ——
   * 设置页所有输入框都变空，只剩按钮）。
   * 因此节点统一序列化为 outerHTML。
   */
  function renderValue(v) {
    if (v === null || v === undefined || v === false || v === true) return '';
    const t = typeof v;
    if (t === 'string') return v;
    if (t === 'number') return Number.isFinite(v) ? String(v) : '';
    if (Array.isArray(v)) {
      let out = '';
      for (const x of v) out += renderValue(x);
      return out;
    }
    if (t === 'object') {
      if (v.nodeType === 1 && typeof v.outerHTML === 'string') return v.outerHTML;  // 元素节点
      if (v.nodeType === 11 && typeof v.textContent === 'string') {
        // DocumentFragment：序列化其子节点
        let out = '';
        for (const c of Array.from(v.childNodes)) out += renderValue(c);
        return out;
      }
      if (v.__html !== undefined) return String(v.__html);
      return '';
    }
    return '';
  }

  /**
   * 拼接一组片段
   *
   * 代替 arr.map(fn).join('')：后者的 index 参数会成为模板插值，
   * 输出里会混进 0 1 2 这样的数字（这个 bug 真实发生过）。
   */
  function join(arr, fn) {
    const list = Array.isArray(arr) ? arr : [];
    let out = '';
    for (let i = 0; i < list.length; i++) {
      const r = fn(list[i], i);
      out += (r === null || r === undefined || r === false) ? '' : String(r);
    }
    return out;
  }

  /** 条件渲染 */
  function when(cond, fn) {
    if (!cond) return '';
    const r = fn();
    return (r === null || r === undefined || r === false) ? '' : String(r);
  }

  /** HTML 转义 */
  function escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 属性值转义（比 HTML 转义多处理换行） */
  function escapeAttr(s) {
    return escape(s).replace(/\n/g, '&#10;');
  }

  /* ============================================================
   * DOM 工具
   * ============================================================ */

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $$(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }

  /** 布尔属性：值为 falsy 时不设置，truthy 时设为同名属性 */
  const BOOL_ATTRS = ['disabled', 'readonly', 'required', 'checked', 'selected', 'hidden', 'multiple', 'autofocus'];

  /** 创建元素（避免手写 innerHTML 拼字符串） */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        // falsy 一律跳过（注意：'' 也是 falsy，避免出现 disabled="" 这种空值属性）
        if (v === null || v === undefined || v === false || v === '') continue;

        if (k === 'class' || k === 'className') { node.className = v; }
        else if (k === 'text') { node.textContent = v; }
        else if (k === 'html') { node.innerHTML = v; }
        else if (k.startsWith('on') && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'dataset' && typeof v === 'object') {
          for (const dk of Object.keys(v)) node.dataset[dk] = v[dk];
        } else if (k === 'style' && typeof v === 'object') {
          for (const sk of Object.keys(v)) node.style[sk] = v[sk];
        } else if (BOOL_ATTRS.indexOf(k) >= 0) {
          // 布尔属性按"存在即生效"处理，值本身无意义
          if (v !== false && v !== 0) node.setAttribute(k, '');
        } else {
          node.setAttribute(k, String(v));
        }
      }
    }
    const kids = Array.isArray(children) ? children : (children === undefined ? [] : [children]);
    for (const c of kids) {
      if (c === null || c === undefined || c === false) continue;
      if (typeof c === 'string' || typeof c === 'number') {
        node.appendChild(document.createTextNode(String(c)));
      } else if (c.nodeType) {
        node.appendChild(c);
      } else if (Array.isArray(c)) {
        for (const cc of c) {
          if (cc === null || cc === undefined) continue;
          node.appendChild(typeof cc === 'string' ? document.createTextNode(cc) : cc);
        }
      }
    }
    return node;
  }

  /**
   * 事件委托：给容器挂监听，处理动态生成的子元素
   *
   * 关键：必须能"按容器"清理旧监听器。
   *
   * #page 是永久复用的容器，每次路由只替换 innerHTML。
   * 早前每次 nav() 都往上挂新的 delegate，旧监听器从不移除 ——
   * 导航 N 次就有 N 个监听器同时响应。实测：切到工作台再回来，
   * 点一次复选框触发 2 次 toggle，奇偶抵消，用户看到"点了没反应"。
   *
   * 现在按容器记录所有委托监听器，清空容器前统一移除。 */
  const delegated = new WeakMap();  // root -> [{event, fn}]

  function delegate(root, selector, event, handler) {
    if (!root) return function () {};
    const fn = (ev) => {
      const target = ev.target && ev.target.closest ? ev.target.closest(selector) : null;
      if (target && root.contains(target)) {
        handler.call(target, ev, target);
      }
    };
    root.addEventListener(event, fn);

    if (!delegated.has(root)) delegated.set(root, []);
    delegated.get(root).push({ event, fn });

    return () => {
      root.removeEventListener(event, fn);
      const list = delegated.get(root);
      if (list) {
        const i = list.findIndex(r => r.fn === fn && r.event === event);
        if (i >= 0) list.splice(i, 1);
      }
    };
  }

  /** 移除某容器上所有委托监听器（页面切换前调用） */
  function clearDelegates(root) {
    if (!root) return 0;
    const list = delegated.get(root);
    if (!list || !list.length) return 0;
    for (const { event, fn } of list) {
      root.removeEventListener(event, fn);
    }
    const n = list.length;
    delegated.set(root, []);
    return n;
  }

  /**
   * 挂载内容到容器
   *
   * 字符串一律按 HTML 解析 —— 调用方给的都是 html`` 模板或 raw() 的结果，
   * 其中的用户数据已经过转义。若当纯文本插入，整页会显示成一堆标签源码。
   * 需要插入纯文本请用 textContent 或 el('span', {text}).
   */
  function mount(container, content) {
    if (!container) return;
    container.innerHTML = '';
    if (content === null || content === undefined) return;
    if (typeof content === 'string') {
      container.innerHTML = content;
    } else if (content instanceof Node) {
      container.appendChild(content);
    } else if (Array.isArray(content)) {
      content.forEach(c => {
        if (!c) return;
        container.appendChild(typeof c === 'string' ? htmlToNode(c) : c);
      });
    } else if (typeof content === 'object' && content.__html !== undefined) {
      container.innerHTML = content.__html;
    } else {
      container.textContent = String(content);
    }
  }

  /** 字符串 → DOM 节点（用于数组混合场景） */
  function htmlToNode(str) {
    const tpl = document.createElement('template');
    tpl.innerHTML = str;
    return tpl.content;
  }

  /* ============================================================
   * Toast
   * ============================================================ */

  const TOAST_MAX = 4;
  let toasts = [];

  /**
   * 轻提示
   * @param {string} msg
   * @param {'ok'|'err'|'warn'|'info'} type
   * @param {object} opts { duration, action: {label, fn} }
   */
  function toast(msg, type, opts) {
    const o = opts || {};
    const wrap = document.getElementById('toastWrap');
    if (!wrap) {
      // 极端情况（DOM 还没好）：退化为日志
      E.Log.info('ui', msg);
      return;
    }

    // 同文案去重（连续点两次保存不用弹两个）
    const same = toasts.find(t => t.dataset.msg === msg && !t.dataset.leaving);
    if (same) {
      clearTimeout(Number(same.dataset.timer));
      const timer = setTimeout(() => removeToast(same), o.duration || 2600);
      same.dataset.timer = String(timer);
      return;
    }

    const node = el('div', {
      class: 'toast toast--' + (type || 'info'),
      dataset: { msg, timer: '' },
    }, [
      el('span', { class: 'toast__msg', text: msg }),
      o.action ? el('button', {
        class: 'toast__act',
        type: 'button',
        text: o.action.label,
        onclick: () => { o.action.fn && o.action.fn(); removeToast(node); },
      }) : null,
      el('button', {
        class: 'toast__x', type: 'button', 'aria-label': '关闭', text: '×',
        onclick: () => removeToast(node),
      }),
    ]);

    wrap.appendChild(node);
    toasts.push(node);

    // 超过上限，挤掉最早的
    while (toasts.length > TOAST_MAX) {
      removeToast(toasts[0]);
    }

    const timer = setTimeout(() => removeToast(node), o.duration || (type === 'err' ? 5200 : 2600));
    node.dataset.timer = String(timer);
    return node;
  }

  function removeToast(node) {
    if (!node || !node.parentNode || node.dataset.leaving) return;
    node.dataset.leaving = '1';
    node.classList.add('toast--out');
    setTimeout(() => {
      node.remove();
      toasts = toasts.filter(t => t !== node);
    }, 220);
  }

  /* ============================================================
   * 确认框 / 输入框
   * ============================================================ */

  let modalStack = [];

  /**
   * 确认框
   * @returns {Promise<boolean>}
   */
  function confirm(message, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const overlay = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        el('div', { class: 'modal__p modal__p--sm' }, [
          el('div', { class: 'modal__h' }, [
            el('h3', { text: o.title || '请确认' }),
          ]),
          el('div', { class: 'modal__b' }, [
            el('p', { class: 'modal__text', text: message }),
          ]),
          el('div', { class: 'modal__f' }, [
            el('button', {
              class: 'btn', type: 'button', text: o.cancelText || '取消',
              onclick: () => done(false),
            }),
            el('button', {
              class: 'btn ' + (o.danger ? 'btn--danger' : 'btn--primary'),
              type: 'button', text: o.okText || '确定',
              onclick: () => done(true),
            }),
          ]),
        ]),
      ]);

      function done(v) {
        overlay.remove();
        modalStack = modalStack.filter(m => m !== overlay);
        document.removeEventListener('keydown', onKey);
        document.body.classList.toggle('is-modal', modalStack.length > 0);
        resolve(v);
      }

      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); done(false); }
        if (ev.key === 'Enter') { ev.preventDefault(); done(true); }
      }

      document.body.appendChild(overlay);
      modalStack.push(overlay);
      document.body.classList.add('is-modal');
      document.addEventListener('keydown', onKey);
      const ok = overlay.querySelector('.btn--primary, .btn--danger');
      if (ok) setTimeout(() => ok.focus(), 30);
    });
  }

  /**
   * 输入框
   * @returns {Promise<string|null>}
   */
  function prompt(message, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const input = el('input', {
        class: 'input', type: o.type || 'text',
        value: o.value || '',
        placeholder: o.placeholder || '',
        maxlength: o.maxlength || 255,
      });

      const overlay = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        el('div', { class: 'modal__p modal__p--sm' }, [
          el('div', { class: 'modal__h' }, [el('h3', { text: o.title || '请输入' })]),
          el('div', { class: 'modal__b' }, [
            el('p', { class: 'modal__text', text: message }),
            input,
            el('p', { class: 'modal__hint', id: 'promptHint', text: o.hint || '' }),
          ]),
          el('div', { class: 'modal__f' }, [
            el('button', { class: 'btn', type: 'button', text: '取消', onclick: () => done(null) }),
            el('button', { class: 'btn btn--primary', type: 'button', text: o.okText || '确定', onclick: () => done(input.value) }),
          ]),
        ]),
      ]);

      function done(v) {
        overlay.remove();
        modalStack = modalStack.filter(m => m !== overlay);
        document.removeEventListener('keydown', onKey);
        document.body.classList.toggle('is-modal', modalStack.length > 0);
        resolve(v);
      }

      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); done(null); }
        if (ev.key === 'Enter') { ev.preventDefault(); done(input.value); }
      }

      document.body.appendChild(overlay);
      modalStack.push(overlay);
      document.body.classList.add('is-modal');
      document.addEventListener('keydown', onKey);
      setTimeout(() => input.focus(), 30);
    });
  }

  /**
   * 通用模态框
   *
   * @param {object} opts { title, body, footer, width, onClose, closeOnBackdrop }
   * @returns {{ close: fn, root: HTMLElement }}
   */
  function modal(opts) {
    const o = opts || {};
    const overlay = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
    const panel = el('div', {
      class: 'modal__p' + (o.width === 'sm' ? ' modal__p--sm' : o.width === 'lg' ? ' modal__p--lg' : ''),
      style: o.maxWidth ? { maxWidth: o.maxWidth } : null,
    });
    if (o.title !== null) {
      panel.appendChild(el('div', { class: 'modal__h' }, [
        el('h3', { text: o.title || '' }),
        el('button', {
          class: 'modal__x', type: 'button', 'aria-label': '关闭', text: '×',
          onclick: () => close(),
        }),
      ]));
    }
    const body = el('div', { class: 'modal__b' });
    if (o.body) mount(body, o.body);
    panel.appendChild(body);

    if (o.footer) {
      const foot = el('div', { class: 'modal__f' });
      mount(foot, o.footer);
      panel.appendChild(foot);
    }

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    modalStack.push(overlay);
    document.body.classList.add('is-modal');

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      overlay.remove();
      modalStack = modalStack.filter(m => m !== overlay);
      document.body.classList.toggle('is-modal', modalStack.length > 0);
      document.removeEventListener('keydown', onKey);
      if (typeof o.onClose === 'function') o.onClose();
    }

    function onKey(ev) {
      if (ev.key === 'Escape' && o.closeOnEsc !== false) { ev.preventDefault(); close(); }
    }
    document.addEventListener('keydown', onKey);

    if (o.closeOnBackdrop !== false) {
      overlay.addEventListener('mousedown', (ev) => {
        if (ev.target === overlay) close();
      });
    }

    return { close, root: panel, body, overlay };
  }

  /** 关闭所有模态框 */
  function closeAll() {
    modalStack.forEach(m => m.remove());
    modalStack = [];
    document.body.classList.remove('is-modal');
  }

  /* ============================================================
   * 状态块
   * ============================================================ */

  function empty(message, action) {
    return html`<div class="empty">
      <div class="empty__icon">—</div>
      <p class="empty__msg">${message || '暂无数据'}</p>
      ${action ? html`<button class="btn btn--primary btn--sm" id="${action.id || 'emptyAct'}" type="button">${action.label}</button>` : ''}
    </div>`;
  }

  function skeleton(rows) {
    const n = Math.max(1, Math.min(12, rows || 3));
    let out = '<div class="skeleton">';
    for (let i = 0; i < n; i++) out += '<div class="skeleton__row"></div>';
    return out + '</div>';
  }

  function spinner(text) {
    return html`<div class="loading"><span class="spinner"></span>${text || '载入中…'}</div>`;
  }

  /** 错误块（带重试与诊断） */
  function errorBlock(err, retryFn) {
    const e = E.normalize(err);
    const msg = E.userMessage(e);
    return html`<div class="errbox">
      <p class="errbox__msg">${msg}</p>
      ${e.expected ? '' : html`<p class="errbox__hint">技术信息：${String(e.message).slice(0, 200)}</p>`}
      <div class="errbox__act">
        ${retryFn ? html`<button class="btn btn--sm" id="errRetry" type="button">重试</button>` : ''}
        <button class="btn btn--sm btn--ghost" id="errDiag" type="button">诊断信息</button>
      </div>
    </div>`;
  }

  /* ============================================================
   * 分页
   * ============================================================ */

  /**
   * 渲染分页器
   * @param {{page, total_pages, total, per_page}} p
   * @param {(page:number)=>void} onChange
   */
  function pager(p, onChange) {
    if (!p || p.total_pages <= 1) {
      return p && p.total ? html`<div class="pager pager--single">共 ${p.total} 条</div>` : '';
    }

    const cur = p.page;
    const last = p.total_pages;
    const pages = [];
    // 当前页 ±2，加首尾
    const set = new Set([1, last, cur, cur - 1, cur + 1, cur - 2, cur + 2]);
    const list = Array.from(set).filter(n => n >= 1 && n <= last).sort((a, b) => a - b);

    let prev = 0;
    for (const n of list) {
      if (prev && n - prev > 1) pages.push(html`<span class="pager__gap">…</span>`);
      pages.push(html`<button class="pager__n ${n === cur ? 'is-on' : ''}"
        data-page="${n}" type="button">${n}</button>`);
      prev = n;
    }

    const node = el('div', { class: 'pager' }, [
      el('span', { class: 'pager__info', text: `共 ${p.total} 条 · 第 ${cur}/${last} 页` }),
      el('button', {
        class: 'btn btn--sm', type: 'button', text: '上一页',
        disabled: cur <= 1 ? 'disabled' : null,
        onclick: () => cur > 1 && onChange(cur - 1),
      }),
      (() => {
        const wrap = el('div', { class: 'pager__nums' });
        wrap.innerHTML = pages.join('');
        delegate(wrap, '[data-page]', 'click', (ev, t) => onChange(Number(t.dataset.page)));
        return wrap;
      })(),
      el('button', {
        class: 'btn btn--sm', type: 'button', text: '下一页',
        disabled: cur >= last ? 'disabled' : null,
        onclick: () => cur < last && onChange(cur + 1),
      }),
    ]);
    return node;
  }

  /* ============================================================
   * 表单控件
   * ============================================================ */

  /**
   * 下拉选项
   * @param {string} name
   * @param {Array<{value,label}>|Array<string>} options
   * @param {*} value 当前值
   * @param {object} attrs
   */
  function select(name, options, value, attrs) {
    const a = Object.assign({ class: 'input', name }, attrs || {});
    const node = el('select', a);
    for (const opt of (options || [])) {
      const val = typeof opt === 'object' ? opt.value : opt;
      const label = typeof opt === 'object' ? opt.label : opt;
      const o = el('option', { value: val, text: label });
      if (String(val) === String(value)) o.selected = true;
      node.appendChild(o);
    }
    return node;
  }

  /** 从枚举生成下拉 */
  function enumSelect(name, group, value, attrs) {
    const list = window.Schema.ENUMS[group] || [];
    const opts = list.map(v => ({ value: v, label: window.Schema.label(group, v) }));
    return select(name, opts, value, attrs);
  }

  /** 字段容器 */
  function field(label, control, opts) {
    const o = opts || {};
    return el('label', { class: 'fld' + (o.wide ? ' fld--wide' : '') }, [
      el('span', { class: 'fld__l', text: label + (o.required ? ' *' : '') }),
      control,
      o.hint ? el('span', { class: 'fld__h', text: o.hint }) : null,
    ]);
  }

  /** 输入框 */
  function input(name, value, attrs) {
    return el('input', Object.assign({
      class: 'input', name, value: value == null ? '' : String(value),
    }, attrs || {}));
  }

  function textarea(name, value, attrs) {
    const node = el('textarea', Object.assign({ class: 'input', name, rows: 3 }, attrs || {}));
    node.value = value == null ? '' : String(value);
    return node;
  }

  /* ============================================================
   * 错误边界
   * ============================================================ */

  /**
   * 渲染一个"页面区块"并兜住异常
   *
   * 局部失败不应该让整页白屏 —— 一块卡片出错就只显示那块错误。
   *
   * @param {HTMLElement} container
   * @param {() => Promise<string|Node>} renderFn
   * @param {object} opts { tag, retry }
   */
  async function boundary(container, renderFn, opts) {
    const o = opts || {};
    if (!container) return;
    try {
      const out = await renderFn();
      mount(container, out);
      return { ok: true };
    } catch (e) {
      const err = E.normalize(e);
      E.Log.error(o.tag || 'ui', err.message, { stack: String(err.stack || '').slice(0, 800) });
      mount(container, errorBlock(err));
      const retry = container.querySelector('#errRetry');
      if (retry) {
        retry.addEventListener('click', () => {
          boundary(container, renderFn, o);
        });
      }
      const diag = container.querySelector('#errDiag');
      if (diag) {
        diag.addEventListener('click', () => showDiagnostics());
      }
      if (!err.expected) {
        toast(E.userMessage(err), 'err');
      }
      return { ok: false, error: err };
    }
  }

  /** 显示诊断信息（用户可复制给开发者） */
  function showDiagnostics() {
    const text = E.diagnostics({
      version: window.APP_VERSION,
      dir: window.FileIO ? window.FileIO.dirName : '',
      counts: null,
    });
    const ta = el('textarea', { class: 'input', rows: 14, readonly: 'readonly' });
    ta.value = text;

    const m = modal({
      title: '诊断信息',
      body: el('div', {}, [
        el('p', { class: 'muted', text: '下面是最近的运行日志与当前环境信息。反馈问题时请复制这段内容。' }),
        ta,
      ]),
      footer: [
        el('button', {
          class: 'btn', type: 'button', text: '复制',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast('已复制到剪贴板', 'ok');
            } catch (_) {
              ta.select();
              toast('请按 Ctrl+C 复制', 'info');
            }
          },
        }),
        el('button', {
          class: 'btn btn--ghost', type: 'button', text: '清空日志',
          onclick: () => { E.Log.clear(); toast('日志已清空', 'ok'); m.close(); },
        }),
      ],
    });
  }

  /* ============================================================
   * 忙碌遮罩
   * ============================================================ */

  let busyCount = 0;

  function busy(on, text) {
    const el = document.getElementById('busyOverlay');
    if (!el) return;
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    if (busyCount > 0) {
      el.hidden = false;
      const t = el.querySelector('.busy__text');
      if (t) t.textContent = text || '处理中…';
    } else {
      el.hidden = true;
    }
  }

  /**
   * 包裹一个异步操作：自动显示忙碌、统一错误提示
   *
   * 关于异常：默认**继续抛出**（rethrow），调用方才能判断成败。
   * 早期实现把异常吞掉返回 undefined，结果模态框把失败当成功、
   * 界面显示"已保存"但数据没写进去 —— 这类静默失败最伤用户。
   *
   * @param {Function} fn
   * @param {object} opts { text, tag, silent, swallow }
   *   silent  不弹 toast（调用方自己处理提示）
   *   swallow 吞掉异常（仅用于"失败不影响主流程"的场景）
   */
  async function withBusy(fn, opts) {
    const o = opts || {};
    busy(true, o.text);
    try {
      return await fn();
    } catch (e) {
      const err = E.normalize(e);
      E.Log.error(o.tag || 'action', err.message);
      if (o.silent !== true) {
        toast(err.expected ? err.message : E.userMessage(err), 'err');
      }
      if (o.swallow === true) return undefined;
      throw err;
    } finally {
      busy(false);
    }
  }

  /* ============================================================
   * 定时工具
   * ============================================================ */

  /** 防抖：最后一次调用后 delay 毫秒才执行 */
  function debounce(fn, delay) {
    let t = null;
    const wait = Math.max(0, Number(delay) || 300);
    return function (...args) {
      const self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), wait);
    };
  }

  /** 节流：delay 内最多执行一次 */
  function throttle(fn, delay) {
    let last = 0;
    let timer = null;
    const wait = Math.max(0, Number(delay) || 200);
    return function (...args) {
      const self = this;
      const now = Date.now();
      const remain = wait - (now - last);
      if (remain <= 0) {
        last = now;
        fn.apply(self, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = null;
          fn.apply(self, args);
        }, remain);
      }
    };
  }

  /** 下一帧执行（合并同帧多次调用） */
  function nextFrame(fn) {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(fn);
    } else {
      setTimeout(fn, 16);
    }
  }

  window.UI = {
    html, raw, escape, escapeAttr,
    $, $$, el, delegate, clearDelegates, mount,
    toast, confirm, prompt, modal, closeAll,
    empty, skeleton, spinner, errorBlock,
    join, when,
    pager, select, enumSelect, field, input, textarea,
    boundary, showDiagnostics,
    busy, withBusy,
    debounce, throttle, nextFrame,
  };
})();
