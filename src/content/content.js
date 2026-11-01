/**
 * JustClick — content script
 *
 * 职责：把页面上的可填字段抽成描述符 → 交给 JC.buildFillPlan 打分 → 赋值 → 高亮 2 秒 → 回报结果。
 * 识别逻辑本身在 lib/field-matcher.js（纯函数，可单测），这里只处理 DOM。
 */
(function () {
  'use strict';

  if (window.__justclickLoaded) return;
  window.__justclickLoaded = true;

  var HIGHLIGHT_CLASS = 'jc-filled-highlight';
  var HIGHLIGHT_MS = 2000;
  var MAX_NEARBY_TEXT = 160;

  var FILLABLE_TYPES = {
    text: 1, email: 1, tel: 1, url: 1, number: 1, search: 1, '': 1
  };
  var SKIP_TYPES = {
    hidden: 1, password: 1, submit: 1, button: 1, reset: 1, checkbox: 1,
    radio: 1, file: 1, image: 1, color: 1, range: 1, date: 1, time: 1,
    'datetime-local': 1, month: 1, week: 1
  };

  /* ------------------------------------------------------------------ 样式 */

  function ensureStyle() {
    if (document.getElementById('jc-style')) return;
    var style = document.createElement('style');
    style.id = 'jc-style';
    style.textContent =
      '.' + HIGHLIGHT_CLASS + '{' +
      'outline:2px solid #2563eb !important;' +
      'outline-offset:1px !important;' +
      'background-color:#dbeafe !important;' +
      'box-shadow:0 0 0 3px rgba(37,99,235,.25) !important;' +
      'transition:background-color .15s ease !important;' +
      '}' +
      '#jc-toast{position:fixed;right:20px;bottom:20px;z-index:2147483647;' +
      'background:#111827;color:#f9fafb;font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;' +
      'padding:12px 16px;border-radius:10px;max-width:320px;box-shadow:0 8px 24px rgba(0,0,0,.28);' +
      'opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease;}' +
      '#jc-toast.jc-show{opacity:1;transform:translateY(0);}' +
      '#jc-toast b{color:#93c5fd;font-weight:600;}' +
      '#jc-toast .jc-sub{color:#9ca3af;margin-top:4px;font-size:12px;}';
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------ 字段抽取 */

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.disabled || el.readOnly) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return false;
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view) return false;
    var computed = view.getComputedStyle(el);
    if (!computed) return false;
    if (computed.display === 'none' || computed.visibility === 'hidden' || computed.opacity === '0') return false;
    return true;
  }

  function textOf(node) {
    if (!node) return '';
    var text = typeof node.innerText === 'string' ? node.innerText : node.textContent || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_NEARBY_TEXT);
  }

  function labelTextFor(el) {
    var parts = [];
    if (el.id) {
      try {
        var escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id;
        var explicit = el.ownerDocument.querySelector('label[for="' + escaped + '"]');
        if (explicit) parts.push(textOf(explicit));
      } catch (e) {
        /* 非法选择器忽略 */
      }
    }
    var wrapping = el.closest ? el.closest('label') : null;
    if (wrapping) parts.push(textOf(wrapping));
    var labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach(function (id) {
        var node = el.ownerDocument.getElementById(id);
        if (node) parts.push(textOf(node));
      });
    }
    return parts.filter(Boolean).join(' ');
  }

  /** 取字段附近的说明文字（上一级兄弟节点 / 父容器的一段文本） */
  function nearbyTextFor(el) {
    var node = el.previousElementSibling;
    var hops = 0;
    while (node && hops < 3) {
      var t = textOf(node);
      if (t && t.length <= MAX_NEARBY_TEXT) return t;
      node = node.previousElementSibling;
      hops++;
    }
    var parent = el.parentElement;
    if (parent) {
      var clone = parent.cloneNode(true);
      var junk = clone.querySelectorAll('input,textarea,select,button,script,style,svg');
      for (var i = 0; i < junk.length; i++) junk[i].remove();
      var pt = textOf(clone);
      if (pt && pt.length <= MAX_NEARBY_TEXT) return pt;
    }
    return '';
  }

  /**
   * 向上最多 4 层祖先的 className 拼接（小写、截 120 字）。
   * 国内站点常用容器类名表达语义（如 Boss 直聘快速投递弹窗的 .dialog），
   * 站点规则里的 containerClass 约束靠它命中。
   */
  function containerClassFor(el) {
    var parts = [];
    var node = el;
    for (var i = 0; i < 4 && node; i++) {
      var cls = '';
      try {
        if (typeof node.className === 'string') cls = node.className;
        else if (node.getAttribute) cls = node.getAttribute('class') || '';
      } catch (e) {
        cls = '';
      }
      if (cls) parts.push(String(cls).toLowerCase());
      // 跨越 shadow 边界继续往上找宿主
      node = node.parentElement || (node.parentNode && node.parentNode.host) || null;
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function descriptorFor(el, meta) {
    var tag = (el.tagName || '').toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    var info = meta || {};
    var desc = {
      tag: tag,
      type: type,
      id: el.id || '',
      name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      className: typeof el.className === 'string' ? el.className : '',
      containerClass: containerClassFor(el),
      dataAutomationId: el.getAttribute('data-automation-id') || el.getAttribute('data-automationid') || '',
      labelText: labelTextFor(el),
      nearbyText: '',
      fillable: true,
      // 迭代 5：shadow 元素的宿主选择器链（普通 DOM 为空串）
      shadowPath: info.inShadow && info.path ? info.path : ''
    };

    if (tag === 'textarea') {
      desc.type = 'textarea';
    } else if (tag === 'select') {
      desc.type = 'select';
    } else if (tag !== 'input') {
      desc.fillable = false;
      return desc;
    } else if (SKIP_TYPES[type]) {
      desc.fillable = false;
      return desc;
    } else if (!FILLABLE_TYPES[type] && type !== 'textarea') {
      // 未知 type 仍尝试，但标记低优先
      desc.fillable = true;
    }

    if (!isVisible(el)) {
      desc.fillable = false;
      return desc;
    }
    if (!desc.labelText) desc.nearbyText = nearbyTextFor(el);
    return desc;
  }

  /**
   * 收集可填字段（含 Shadow DOM）。
   * 每个可填元素保留 path：填充时按 path 重新定位，不跨消息缓存元素引用。
   */
  function collectFillables() {
    var fillables = [];
    var descriptors = [];
    var entries = [];

    if (window.JC && typeof window.JC.collectDeep === 'function') {
      entries = window.JC.collectDeep(document, { isVisible: isVisible });
    } else {
      // 老注入（lib/shadow.js 未加载）时的降级路径，保证填充不会整体失效
      var nodes = document.querySelectorAll('input, textarea, select');
      for (var n = 0; n < nodes.length; n++) {
        entries.push({ el: nodes[n], path: '', inShadow: false, type: '' });
      }
    }

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry || !entry.el) continue;
      var desc = descriptorFor(entry.el, entry);
      if (!desc.fillable) continue;
      var tag = (entry.el.tagName || '').toLowerCase();
      fillables.push({
        el: entry.el,
        path: entry.path || '',
        inShadow: entry.inShadow === true,
        tag: tag,
        type: desc.type
      });
      descriptors.push(desc);
    }
    return { fillables: fillables, descriptors: descriptors };
  }

  /**
   * 按 path 重新定位；定位失败（DOM 变了 / 选择器非法）返回 null。
   * 普通 DOM 的 path 就是单段选择器，shadow 的 path 用 HOST_SEP 串起来。
   */
  function resolveFillable(fillable) {
    if (!fillable) return null;
    if (!fillable.path) return fillable.el;
    if (!window.JC || typeof window.JC.resolvePath !== 'function') return fillable.el;
    var el = window.JC.resolvePath(document, fillable.path);
    if (!el) return null;
    if (el === fillable.el) return el;
    // 普通 DOM 的 path 是单段选择器（如 input:nth-of-type(1)），文档里可能先命中
    // 另一个同结构字段。原节点还在树上时优先用它，只有它被替换/移除时才用 path 新节点。
    try {
      if (fillable.el && typeof document.contains === 'function' && document.contains(fillable.el)) {
        return fillable.el;
      }
    } catch (e) {
      /* ignore */
    }
    // 选择器可能命中同名但不同类型的元素，tag 不一致就当作定位失败
    var tag = (el.tagName || '').toLowerCase();
    if (fillable.tag && tag !== fillable.tag) return null;
    return el;
  }

  /* -------------------------------------------------------------- 写值 */

  /** 走原生 setter + 事件，保证 React / Vue 受控组件也能收到变更 */
  function setNativeValue(el, value) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) {
      setter.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /**
   * 下拉框赋值：匹配逻辑在 lib/select-match.js（精确 → 包含 → 同义词组），
   * 这里只负责 selectedIndex + 事件。匹配不到返回 false，由调用方记 failures。
   */
  function setSelectValue(el, value) {
    var options = el.options || [];
    var mapped = [];
    for (var i = 0; i < options.length; i++) {
      mapped.push({
        text: options[i].textContent || options[i].text || '',
        value: options[i].value || ''
      });
    }

    var index = -1;
    if (window.JC && typeof window.JC.matchSelectOption === 'function') {
      index = window.JC.matchSelectOption(mapped, value);
    } else {
      // 降级：select-match.js 未注入时只做归一化精确匹配
      var target = String(value).toLowerCase().replace(/\s+/g, '');
      for (var j = 0; j < mapped.length; j++) {
        var text = String(mapped[j].text).toLowerCase().replace(/\s+/g, '');
        var val = String(mapped[j].value).toLowerCase().replace(/\s+/g, '');
        if (text === target || val === target) {
          index = j;
          break;
        }
      }
    }

    if (index < 0) return false;
    el.selectedIndex = index;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function highlight(el) {
    ensureStyle();
    el.classList.add(HIGHLIGHT_CLASS);
    setTimeout(function () {
      el.classList.remove(HIGHLIGHT_CLASS);
    }, HIGHLIGHT_MS);
  }

  function showToast(title, sub) {
    ensureStyle();
    var toast = document.getElementById('jc-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'jc-toast';
      document.documentElement.appendChild(toast);
    }
    toast.innerHTML = '';
    var main = document.createElement('div');
    main.textContent = title;
    toast.appendChild(main);
    if (sub) {
      var extra = document.createElement('div');
      extra.className = 'jc-sub';
      extra.textContent = sub;
      toast.appendChild(extra);
    }
    // 强制重排后再加 class，保证过渡动画生效
    void toast.offsetWidth;
    toast.classList.add('jc-show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () {
      toast.classList.remove('jc-show');
    }, 3200);
  }

  /* -------------------------------------------------------------- 填充 */

  function buildValueMap(resume) {
    var map = {};
    if (!resume || !window.JC || !window.JC.resolveValue) return map;
    var keys =
      typeof window.JC.getFieldKeys === 'function' ? window.JC.getFieldKeys(resume) : window.JC.FIELD_KEYS || [];
    for (var i = 0; i < keys.length; i++) {
      map[keys[i]] = window.JC.resolveValue(resume, keys[i]);
    }
    return map;
  }

  function buildFieldLabels(resume) {
    var labels = {};
    if (!resume || !window.JC) return labels;
    var keys =
      typeof window.JC.getFieldKeys === 'function' ? window.JC.getFieldKeys(resume) : window.JC.FIELD_KEYS || [];
    for (var i = 0; i < keys.length; i++) {
      labels[keys[i]] =
        typeof window.JC.labelFor === 'function'
          ? window.JC.labelFor(resume, keys[i])
          : (window.JC.FIELD_LABELS && window.JC.FIELD_LABELS[keys[i]]) || keys[i];
    }
    return labels;
  }

  function runFill(resume, rules, url) {
    if (!window.JC || typeof window.JC.buildFillPlan !== 'function') {
      return { ok: false, error: '识别引擎未加载，请重新加载插件', filled: 0, filledLabels: [], missing: [], notFound: [] };
    }

    var collected = collectFillables();
    var valueMap = buildValueMap(resume);
    var fieldKeys =
      typeof window.JC.getFieldKeys === 'function' ? window.JC.getFieldKeys(resume) : window.JC.FIELD_KEYS || [];
    var plan = window.JC.buildFillPlan(collected.descriptors, valueMap, {
      minConfidence: 0.5,
      fieldKeys: fieldKeys,
      fieldLabels: buildFieldLabels(resume),
      rules: Array.isArray(rules) ? rules : [],
      url: typeof url === 'string' && url ? url : location.href
    });

    var filledLabels = [];
    var filledKeys = [];
    var filledItems = [];
    var ruleHits = [];
    var failures = [];
    var shadowFields = 0;
    var shadowScanned = 0;

    for (var s = 0; s < collected.fillables.length; s++) {
      if (collected.fillables[s] && collected.fillables[s].inShadow) shadowScanned++;
    }

    for (var i = 0; i < plan.assignments.length; i++) {
      var a = plan.assignments[i];
      var fillable = collected.fillables[a.index];
      if (!fillable) continue;
      // 收集 → 写入之间页面可能重渲染，按 path 重新定位而不是用旧引用
      var el = resolveFillable(fillable);
      if (!el) {
        failures.push(a.label);
        continue;
      }
      try {
        if ((el.tagName || '').toUpperCase() === 'SELECT') {
          if (!setSelectValue(el, a.value)) {
            failures.push(a.label);
            continue;
          }
        } else {
          setNativeValue(el, a.value);
        }
        highlight(el);
        filledLabels.push(a.label);
        var item = { key: a.key, label: a.label, value: a.value };
        if (fillable.inShadow) {
          item.shadow = true;
          shadowFields++;
        }
        filledItems.push(item);
        if (filledKeys.indexOf(a.key) === -1) filledKeys.push(a.key);
        if (a.ruleId && ruleHits.indexOf(a.ruleId) === -1) ruleHits.push(a.ruleId);
      } catch (e) {
        failures.push(a.label);
      }
    }

    var missing = plan.missing.map(function (m) { return m.label; });
    var notFound = plan.notFound.map(function (m) { return m.label; });

    // 迭代 3：报告三区块直接用这三个带 key 的结构，popup 不再靠 label 反查
    var missingItems = plan.missing.map(function (m) { return { key: m.key, label: m.label }; });
    var unmatchedItems = plan.notFound.map(function (m) {
      return { key: m.key, label: m.label, value: valueMap[m.key] || '' };
    });

    var summary = filledLabels.length
      ? '已填 ' + filledLabels.length + ' 项：' + filledLabels.join('、')
      : '没有在该页面找到可填字段';
    var detailParts = [];
    if (missing.length) detailParts.push('简历缺少：' + missing.join('、'));
    if (notFound.length) detailParts.push('页面没有：' + notFound.join('、'));
    if (failures.length) detailParts.push('填充失败：' + failures.join('、'));

    // 多 frame 下每个 iframe 都弹一条会糊满页面，只在本 frame 真的填了东西时提示
    if (filledLabels.length) showToast(summary, detailParts.join('；'));

    return {
      ok: true,
      filled: filledLabels.length,
      filledLabels: filledLabels,
      filledKeys: filledKeys,
      filledItems: filledItems,
      missing: missing,
      missingItems: missingItems,
      notFound: notFound,
      unmatchedItems: unmatchedItems,
      failures: failures,
      scanned: collected.descriptors.length,
      matched: plan.assignments.length + plan.missing.length,
      ruleHits: ruleHits,
      // 迭代 5：多 frame / shadow 的元信息
      frameUrl: location.href,
      shadowFields: shadowFields,
      shadowScanned: shadowScanned,
      viaShadow: shadowFields > 0
    };
  }

  /* ---------------------------------------------------------- 增量补填（迭代 3） */

  /**
   * 只填一个输入框：报告里「待填」那行点了「补填」走这里。
   * 刻意只调 setNativeValue / setSelectValue —— 不点按钮、不调用表单的提交方法，
   * 页面上有没有「提交」按钮都与本函数无关。
   */
  function runFillOne(message) {
    var key = message && typeof message.key === 'string' ? message.key : '';
    var value = message && typeof message.value === 'string' ? message.value : '';
    if (!key) return { ok: false, error: '缺少字段 key', filled: 0, submitted: false };
    if (!value) return { ok: false, error: '补填的值是空的', filled: 0, submitted: false };

    var el = null;
    if (message.selector) {
      try {
        if (window.JC && typeof window.JC.isShadowPath === 'function' && window.JC.isShadowPath(message.selector)) {
          el = window.JC.resolvePath(document, message.selector);
        } else {
          el = document.querySelector(message.selector);
        }
      } catch (e) {
        el = null;
      }
    }

    if (!el) {
      if (!window.JC || typeof window.JC.buildFillPlan !== 'function') {
        return { ok: false, error: '识别引擎未加载，请刷新页面后重试', filled: 0, submitted: false };
      }
      var collected = collectFillables();
      var valueMap = {};
      valueMap[key] = value;
      var labels = {};
      if (message.label) labels[key] = message.label;
      var plan = window.JC.buildFillPlan(collected.descriptors, valueMap, {
        minConfidence: 0.5,
        fieldKeys: [key],
        fieldLabels: labels,
        rules: Array.isArray(message.rules) ? message.rules : [],
        url: location.href
      });
      if (plan.assignments.length) {
        el = resolveFillable(collected.fillables[plan.assignments[0].index]);
      }
    }

    if (!el) return { ok: false, error: '页面上找不到这个字段', filled: 0, submitted: false };

    try {
      if ((el.tagName || '').toUpperCase() === 'SELECT') {
        if (!setSelectValue(el, value)) {
          return { ok: false, error: '下拉框里没有这个选项', filled: 0, submitted: false };
        }
      } else {
        setNativeValue(el, value);
      }
      highlight(el);
      showToast('已补填 1 项：' + (message.label || key), '只填了值，没有提交表单。');
      return { ok: true, filled: 1, key: key, value: value, submitted: false };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), filled: 0, submitted: false };
    }
  }

  /**
   * 学习流扫描：走 collectDeep，因此 iframe 里的 content script 也能把 Shadow DOM
   * 内的字段列出来。selector 直接用 path（可能含 HOST_SEP），保证后续 JC_FILL_ONE
   * 能按 shadow 路径回定位。
   */
  function scanEntries() {
    var out = [];
    if (!window.JC) return out;

    if (typeof window.JC.collectDeep !== 'function') {
      // 降级：没有 shadow 模块时退回迭代 2 的普通扫描
      return typeof window.JC.collectFields === 'function'
        ? window.JC.collectFields(document, { isVisible: isVisible })
        : out;
    }

    var deep = window.JC.collectDeep(document, { isVisible: isVisible });
    for (var i = 0; i < deep.length; i++) {
      var found = deep[i];
      if (!found || !found.el) continue;
      var entry = null;
      if (typeof window.JC.entryForElement === 'function') {
        entry = window.JC.entryForElement(found.el, i);
      }
      if (!entry) {
        var tag = (found.el.tagName || '').toLowerCase();
        entry = {
          index: i,
          tag: tag,
          type: found.type || tag,
          label: '',
          attrs: {},
          selector: found.path || '',
          suggestedKey: '',
          suggestedBy: ''
        };
      }
      entry.selector = found.path || entry.selector || '';
      entry.path = entry.selector;
      entry.inShadow = found.inShadow === true;
      entry.frameUrl = location.href;
      out.push(entry);
    }
    return out;
  }

  /* -------------------------------------------------------------- 消息 */

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return undefined;

    if (message.type === 'JC_PING') {
      var probe = collectFillables();
      sendResponse({ ok: true, ready: true, scanned: probe.descriptors.length });
      return undefined;
    }

    if (message.type === 'JC_SCAN_FIELDS') {
      try {
        if (!window.JC) {
          sendResponse({
            ok: false,
            error: '学习模块未加载，请刷新页面后重试',
            url: location.href,
            frameUrl: location.href,
            entries: []
          });
          return undefined;
        }
        sendResponse({
          ok: true,
          url: location.href,
          frameUrl: location.href,
          entries: scanEntries()
        });
      } catch (e) {
        sendResponse({
          ok: false,
          error: String((e && e.message) || e),
          url: location.href,
          frameUrl: location.href,
          entries: []
        });
      }
      return undefined;
    }

    if (message.type === 'JC_FILL_ONE') {
      try {
        sendResponse(runFillOne(message));
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), filled: 0, submitted: false });
      }
      return undefined;
    }

    if (message.type === 'JC_FILL') {
      try {
        sendResponse(runFill(message.resume, message.rules, message.url));
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e), filled: 0, filledLabels: [], missing: [], notFound: [] });
      }
      return undefined;
    }

    return undefined;
  });
})();
