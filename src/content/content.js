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

  function descriptorFor(el) {
    var tag = (el.tagName || '').toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    var desc = {
      tag: tag,
      type: type,
      id: el.id || '',
      name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      className: typeof el.className === 'string' ? el.className : '',
      dataAutomationId: el.getAttribute('data-automation-id') || el.getAttribute('data-automationid') || '',
      labelText: labelTextFor(el),
      nearbyText: '',
      fillable: true
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

  function collectFillables() {
    var nodes = document.querySelectorAll('input, textarea, select');
    var fillables = [];
    var descriptors = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var desc = descriptorFor(el);
      if (!desc.fillable) continue;
      fillables.push(el);
      descriptors.push(desc);
    }
    return { fillables: fillables, descriptors: descriptors };
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

  function setSelectValue(el, value) {
    var target = String(value).toLowerCase();
    var options = el.options || [];
    for (var i = 0; i < options.length; i++) {
      var text = (options[i].textContent || '').trim().toLowerCase();
      var val = (options[i].value || '').trim().toLowerCase();
      if (text === target || val === target) {
        el.selectedIndex = i;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
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
    var ruleHits = [];
    var failures = [];

    for (var i = 0; i < plan.assignments.length; i++) {
      var a = plan.assignments[i];
      var el = collected.fillables[a.index];
      if (!el) continue;
      try {
        if (el.tagName === 'SELECT') {
          if (!setSelectValue(el, a.value)) {
            failures.push(a.label);
            continue;
          }
        } else {
          setNativeValue(el, a.value);
        }
        highlight(el);
        filledLabels.push(a.label);
        if (filledKeys.indexOf(a.key) === -1) filledKeys.push(a.key);
        if (a.ruleId && ruleHits.indexOf(a.ruleId) === -1) ruleHits.push(a.ruleId);
      } catch (e) {
        failures.push(a.label);
      }
    }

    var missing = plan.missing.map(function (m) { return m.label; });
    var notFound = plan.notFound.map(function (m) { return m.label; });

    var summary = filledLabels.length
      ? '已填 ' + filledLabels.length + ' 项：' + filledLabels.join('、')
      : '没有在该页面找到可填字段';
    var detailParts = [];
    if (missing.length) detailParts.push('简历缺少：' + missing.join('、'));
    if (notFound.length) detailParts.push('页面没有：' + notFound.join('、'));
    if (failures.length) detailParts.push('填充失败：' + failures.join('、'));

    showToast(summary, detailParts.join('；'));

    return {
      ok: true,
      filled: filledLabels.length,
      filledLabels: filledLabels,
      filledKeys: filledKeys,
      missing: missing,
      notFound: notFound,
      failures: failures,
      scanned: collected.descriptors.length,
      matched: plan.assignments.length + plan.missing.length,
      ruleHits: ruleHits
    };
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
        if (!window.JC || typeof window.JC.collectFields !== 'function') {
          sendResponse({ ok: false, error: '学习模块未加载，请刷新页面后重试', url: location.href, entries: [] });
          return undefined;
        }
        sendResponse({
          ok: true,
          url: location.href,
          entries: window.JC.collectFields(document, { isVisible: isVisible })
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), url: location.href, entries: [] });
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
