/**
 * JustClick — 从当前页学习
 *
 * 只做「把 DOM 抽成可展示的字段清单 + 生成用户规则」这两件事，
 * 不直接写存储、不改页面。为了能在 node:test 里用手写 DOM stub 覆盖，
 * 元素只要求 tagName / id / getAttribute，root 只要求 querySelectorAll。
 *
 * UMD 双模导出，禁止 ES module 语法。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.JC = root.JC || {};
    for (var k in api) {
      if (Object.prototype.hasOwnProperty.call(api, k)) root.JC[k] = api[k];
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 这些 input type 不是「可填文本」，学习流不应把它们列出来（与 content 的 SKIP_TYPES 对齐） */
  var SKIP_TYPES = {
    hidden: 1,
    password: 1,
    submit: 1,
    button: 1,
    reset: 1,
    checkbox: 1,
    radio: 1,
    file: 1,
    image: 1,
    color: 1,
    range: 1,
    date: 1,
    time: 1,
    'datetime-local': 1,
    month: 1,
    week: 1
  };

  /**
   * id / name 是机器属性，最稳定；ariaLabel / placeholder 能直接映射到描述符；
   * label 在 stub 里是「可见文案」的兜底值，不一定等于真实 <label>，所以同长度时排最后。
   */
  var ATTR_SPECIFICITY = {
    id: 5,
    name: 5,
    ariaLabel: 4,
    placeholder: 3,
    label: 2
  };
  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function rulesApi() {
    if (typeof globalThis !== 'undefined' && globalThis.JC && typeof globalThis.JC.createRule === 'function') {
      return globalThis.JC;
    }
    if (typeof require === 'function') {
      try {
        return require('./rules.js');
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  function matcherApi() {
    if (typeof globalThis !== 'undefined' && globalThis.JC && typeof globalThis.JC.detectFieldType === 'function') {
      return globalThis.JC;
    }
    if (typeof require === 'function') {
      try {
        return require('./field-matcher.js');
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  /** 元素可能来自 stub，任何 getAttribute 异常都按「没有该属性」处理 */
  function getAttr(el, name) {
    if (!el) return '';
    try {
      if (typeof el.getAttribute === 'function') {
        var value = el.getAttribute(name);
        return value === undefined || value === null ? '' : String(value);
      }
    } catch (e) {
      return '';
    }
    try {
      if (name === 'id' && el.id) return String(el.id);
    } catch (e) {
      /* ignore */
    }
    return '';
  }

  function tagOf(el) {
    try {
      return el && el.tagName ? String(el.tagName).toLowerCase() : '';
    } catch (e) {
      return '';
    }
  }

  /** CSS.escape 不可用时退到「非字母数字下划线连字符都加反斜杠」，再不行才 URL 转义 */
  function escapeIdent(value) {
    var text = String(value);
    try {
      if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
        return CSS.escape(text);
      }
    } catch (e) {
      /* ignore */
    }
    try {
      return text.replace(/([^A-Za-z0-9_-])/g, '\\$1');
    } catch (e) {
      return encodeURIComponent(text);
    }
  }

  function escapeAttrValue(value) {
    try {
      return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    } catch (e) {
      return encodeURIComponent(String(value));
    }
  }

  /**
   * 生成尽量稳定、尽量短的选择器：优先 #id，其次 [name="x"]，
   * 最后 tag:nth-of-type(n)。任何异常都退回 tag 名，绝不抛出。
   */
  function selectorFor(el) {
    var tag = tagOf(el) || 'input';
    try {
      if (!el) return tag;
      var id = el.id ? String(el.id) : getAttr(el, 'id');
      if (id) return '#' + escapeIdent(id);

      var name = getAttr(el, 'name');
      if (name) return '[name="' + escapeAttrValue(name) + '"]';

      var parent = el.parentNode;
      if (parent && parent.children && parent.children.length) {
        var index = 0;
        var count = 0;
        for (var i = 0; i < parent.children.length; i++) {
          var sibling = parent.children[i];
          if (tagOf(sibling) !== tag) continue;
          count++;
          if (sibling === el) index = count;
        }
        if (index) return tag + ':nth-of-type(' + index + ')';
      }
    } catch (e) {
      return tag;
    }
    return tag;
  }

  /** 用内置引擎给一个「建议字段」，只用于 UI 预选，不参与规则生成 */
  function suggestKey(attrs) {
    var M = matcherApi();
    if (!M || typeof M.detectFieldType !== 'function') return { key: '', by: '' };
    // 不把兜底 label 当作 labelText：它不是真实 <label>，否则建议来源会永远显示 label
    var hit = M.detectFieldType({
      fillable: true,
      ariaLabel: attrs.ariaLabel,
      placeholder: attrs.placeholder,
      name: attrs.name,
      id: attrs.id
    });
    return hit ? { key: hit.key, by: hit.attr } : { key: '', by: '' };
  }

  function entryFor(el, index) {
    var tag = tagOf(el);
    var type = tag === 'input' ? getAttr(el, 'type').toLowerCase() || 'text' : tag;
    var attrs = {
      id: getAttr(el, 'id') || (el && el.id ? String(el.id) : ''),
      name: getAttr(el, 'name'),
      label: '',
      placeholder: getAttr(el, 'placeholder'),
      ariaLabel: getAttr(el, 'aria-label')
    };
    // 没有 <label for> 可查（stub 里也不该依赖 document），用最接近用户可见文案的属性顶上
    attrs.label = attrs.ariaLabel || attrs.placeholder || getAttr(el, 'title') || attrs.name || attrs.id || '';

    var suggestion = suggestKey(attrs);
    return {
      index: index,
      tag: tag,
      type: type,
      label: attrs.label,
      attrs: attrs,
      selector: selectorFor(el),
      suggestedKey: suggestion.key,
      suggestedBy: suggestion.by
    };
  }

  /**
   * 扫描可填控件。
   * @param {Document|object} root 至少有 querySelectorAll
   * @param {{isVisible?:Function}} [options]
   * @returns {Array<{index,tag,type,label,attrs,selector,suggestedKey,suggestedBy}>}
   */
  function collectFields(root, options) {
    var opts = options || {};
    var out = [];
    if (!root || typeof root.querySelectorAll !== 'function') return out;

    var nodes;
    try {
      nodes = root.querySelectorAll('input,textarea,select');
    } catch (e) {
      return out;
    }
    if (!nodes) return out;

    var list = Array.prototype.slice.call(nodes);
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!el) continue;
      var tag = tagOf(el);
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue;

      if (tag === 'input') {
        var type = getAttr(el, 'type').toLowerCase();
        if (hasOwn(SKIP_TYPES, type)) continue;
      }

      if (typeof opts.isVisible === 'function') {
        var visible = true;
        try {
          visible = opts.isVisible(el) !== false;
        } catch (e) {
          // 判断不了可见性时不猜测，直接跳过，避免把隐藏字段教进规则
          visible = false;
        }
        if (!visible) continue;
      }

      out.push(entryFor(el, out.length));
    }
    return out;
  }

  /**
   * 从字段清单里挑「最长、且同样长时最稳定」的属性作为规则 pattern。
   * 长文本更能避免误匹配；同长度再优先 id / name 这类机器属性。
   */
  function bestAttr(attrs) {
    var best = null;
    if (!attrs) return null;
    for (var attr in attrs) {
      if (!hasOwn(attrs, attr)) continue;
      if (!hasOwn(ATTR_SPECIFICITY, attr)) continue;
      var raw = attrs[attr];
      if (typeof raw !== 'string') continue;
      var value = raw.trim();
      if (!value) continue;
      var score = Math.min(value.length, 9999) * 100 + ATTR_SPECIFICITY[attr];
      if (!best || score > best.score) best = { attr: attr, value: value, score: score };
    }
    return best;
  }

  /**
   * 为单个字段生成建议规则（source=manual，默认 contains）。
   * 找不到任何可用属性时返回 null，由调用方提示用户手填。
   */
  function suggestRuleFor(entry, targetKey, options) {
    var opts = options || {};
    if (!entry || !targetKey) return null;
    var best = bestAttr(entry.attrs);
    if (!best) return null;

    var pattern = best.value;
    if (pattern.length > 200) pattern = pattern.slice(0, 200);
    var matchType = opts.matchType || 'contains';
    var sitePattern = typeof opts.sitePattern === 'string' ? opts.sitePattern : '';

    var R = rulesApi();
    if (!R || typeof R.createRule !== 'function') return null;
    return R.createRule({
      match: { attrs: [best.attr], pattern: pattern, matchType: matchType },
      target: targetKey,
      scope: { sitePattern: sitePattern },
      source: 'manual'
    });
  }

  /**
   * 批量生成规则。
   * @param {Array} entries collectFields 的结果
   * @param {Object} selection 形如 {0:'expected_salary', 2:'__ignore__'}
   * @param {{sitePattern?:string}} [options]
   */
  function buildRulesFromSelection(entries, selection, options) {
    var opts = options || {};
    var map = selection || {};
    var list = Array.isArray(entries) ? entries : [];
    var rules = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry) continue;
      var target = map[entry.index];
      if (!target || target === '__ignore__') continue;
      var rule = suggestRuleFor(entry, target, { sitePattern: opts.sitePattern, matchType: opts.matchType });
      if (rule) rules.push(rule);
    }
    return rules;
  }

  return {
    SKIP_TYPES: SKIP_TYPES,
    getAttr: getAttr,
    selectorFor: selectorFor,
    collectFields: collectFields,
    suggestRuleFor: suggestRuleFor,
    buildRulesFromSelection: buildRulesFromSelection
  };
});
