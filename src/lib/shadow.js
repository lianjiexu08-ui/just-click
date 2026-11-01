/**
 * JustClick — Shadow DOM 穿透（迭代 5）
 *
 * Workday 等站点把表单放进 Shadow DOM，`document.querySelectorAll` 看不到里面。
 * 本模块递归遍历 `element.shadowRoot`（支持多层嵌套），并为每个可填控件生成一条
 * 「宿主选择器链 + 叶子选择器」的路径，用 HOST_SEP 连接：
 *
 *   #host-a >>> div:nth-of-type(1) >>> input:nth-of-type(2)
 *
 * 填充时用 resolvePath 按路径重新定位（popup 两条消息之间 DOM 可能变化，不能缓存元素引用）。
 *
 * 只依赖最小 DOM 接口（children / querySelector / getAttribute / tagName / id /
 * shadowRoot / parentNode），因此可以在 Node 里用手写 stub 树直接单测。
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

  /** 宿主选择器与 shadow 内选择器的分隔符（带空格，方便人读，也方便 split） */
  var HOST_SEP = ' >>> ';

  /** 这些 input type 不是「可填文本」，shadow 内外一视同仁地排除 */
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

  var FILLABLE_TAGS = { input: 1, textarea: 1, select: 1 };

  /** 防止异常嵌套把遍历拖死 */
  var MAX_DEPTH = 200;

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function tagOf(el) {
    try {
      return el && el.tagName ? String(el.tagName).toLowerCase() : '';
    } catch (e) {
      return '';
    }
  }

  /** stub 元素可能没有 getAttribute，或缺属性时返回 null / undefined */
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
    return '';
  }

  /** 与 learner.js 同一套转义策略：CSS.escape 优先，再退回手工转义，最后 URL 编码 */
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
   * 生成尽量稳定的选择器：#id → [name="x"] → tag:nth-of-type(n) → tag。
   * 任何异常都退回 tag 名，绝不抛出。
   */
  function cssSelector(el) {
    var tag = tagOf(el) || 'input';
    try {
      if (!el) return tag;
      if (el.id) return '#' + escapeIdent(el.id);

      var name = getAttr(el, 'name');
      if (name) return '[name="' + escapeAttrValue(name) + '"]';

      var parent = el.parentNode;
      if (parent && parent.children && parent.children.length) {
        var index = 0;
        var count = 0;
        for (var i = 0; i < parent.children.length; i++) {
          var sibling = parent.children[i];
          if (!sibling || tagOf(sibling) !== tag) continue;
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

  /**
   * 默认排除逻辑（不传 isVisible 也生效）：
   * password / hidden / 按钮类 input、el.hidden、aria-hidden=true、style.display=none、
   * disabled、readOnly。shadow 内外走同一个函数，避免「shadow 里把密码框填了」。
   */
  function excludedForShadow(el) {
    if (!el) return true;
    try {
      var tag = tagOf(el);
      if (tag === 'input') {
        var type = getAttr(el, 'type').toLowerCase();
        if (type && hasOwn(SKIP_TYPES, type)) return true;
      }
      if (el.hidden === true) return true;
      if (el.disabled === true) return true;
      if (el.readOnly === true) return true;
      if (getAttr(el, 'aria-hidden').toLowerCase() === 'true') return true;
      var style = el.style;
      if (style && typeof style.display === 'string') {
        if (style.display.trim().toLowerCase() === 'none') return true;
      }
    } catch (e) {
      // 读属性就抛错的节点无法判断，按「不可填」处理，避免误填
      return true;
    }
    return false;
  }

  /** 取元素的子元素：优先 children，其次 childNodes（文本节点跳过） */
  function childrenOf(node) {
    if (!node) return [];
    try {
      if (node.children && typeof node.children.length === 'number') {
        return Array.prototype.slice.call(node.children);
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (node.childNodes && typeof node.childNodes.length === 'number') {
        var out = [];
        for (var i = 0; i < node.childNodes.length; i++) {
          var child = node.childNodes[i];
          if (!child) continue;
          if (child.nodeType === 1 || child.nodeType === undefined) out.push(child);
        }
        return out;
      }
    } catch (e) {
      /* ignore */
    }
    return [];
  }

  /**
   * 递归收集 root 及其所有 shadowRoot 里的可填控件。
   *
   * @param {object} root 至少有 children（document / ShadowRoot / stub）
   * @param {{isVisible?:Function, tagFilter?:Function}} [options]
   * @returns {Array<{el:object, path:string, inShadow:boolean, type:string}>}
   */
  function collectDeep(root, options) {
    var opts = options || {};
    var isVisible = typeof opts.isVisible === 'function' ? opts.isVisible : null;
    var out = [];
    if (!root) return out;

    var seen = [];
    var seenSet = typeof Set === 'function' ? new Set() : null;

    function firstVisit(el) {
      if (!el) return false;
      if (seenSet) {
        if (seenSet.has(el)) return false;
        seenSet.add(el);
        return true;
      }
      if (seen.indexOf(el) !== -1) return false;
      seen.push(el);
      return true;
    }

    // 队列里每一项是「一个容器 + 该容器所处的宿主选择器链」。
    // 用游标而不是 shift()：大页面（上万节点）下 shift 是 O(n²)。
    var queue = [{ node: root, chain: [], depth: 0 }];
    for (var qi = 0; qi < queue.length; qi++) {
      var task = queue[qi];
      var kids = childrenOf(task.node);
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (!firstVisit(el)) continue;

        var selector = cssSelector(el);
        var chain = task.chain.concat([selector]);
        var tag = tagOf(el);

        if (hasOwn(FILLABLE_TAGS, tag) && !excludedForShadow(el)) {
          var visible = true;
          if (isVisible) {
            try {
              visible = isVisible(el) !== false;
            } catch (e) {
              // 可见性判断抛错时不猜测，直接跳过
              visible = false;
            }
          }
          if (visible) {
            var type = tag === 'input' ? getAttr(el, 'type').toLowerCase() || 'text' : tag;
            out.push({
              el: el,
              path: chain.join(HOST_SEP),
              inShadow: chain.length > 1,
              type: type
            });
          }
        }

        if (task.depth >= MAX_DEPTH) continue;

        // 1) 普通子节点沿用当前宿主链（普通 DOM 元素的 path 就是它自己的选择器）
        if (kids.length) {
          queue.push({ node: el, chain: task.chain, depth: task.depth + 1 });
        }

        // 2) 有 shadowRoot 就把宿主选择器压进链，进入 shadow 树继续找
        var shadow = null;
        try {
          shadow = el.shadowRoot || null;
        } catch (e) {
          shadow = null;
        }
        if (shadow) {
          queue.push({ node: shadow, chain: chain, depth: task.depth + 1 });
        }
      }
    }
    return out;
  }

  /**
   * 按 collectDeep 生成的路径重新定位元素。
   * 首段在 root 上 querySelector；其后每一段必须从上一段的 shadowRoot 里查。
   * 任一步失败返回 null，绝不抛异常（DOM 变了是很正常的事）。
   */
  function resolvePath(root, path) {
    try {
      if (!root || typeof root.querySelector !== 'function') return null;
      if (typeof path !== 'string' || !path) return null;
      var parts = path.split(HOST_SEP);
      var el = null;
      for (var i = 0; i < parts.length; i++) {
        var segment = parts[i].trim();
        if (!segment) return null;
        if (i === 0) {
          el = root.querySelector(segment);
        } else {
          if (!el || !el.shadowRoot || typeof el.shadowRoot.querySelector !== 'function') return null;
          el = el.shadowRoot.querySelector(segment);
        }
        if (!el) return null;
      }
      return el;
    } catch (e) {
      return null;
    }
  }

  /** 路径里是否含 shadow 分隔符 */
  function isShadowPath(path) {
    return typeof path === 'string' && path.indexOf('>>>') !== -1;
  }

  /** 统计「来自 Shadow DOM」的字段数：popup 用它显示 N 项 */
  function countShadowFields(entries) {
    var list = Array.isArray(entries) ? entries : [];
    var count = 0;
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry) continue;
      if (entry.inShadow === true || isShadowPath(entry.path || entry.selector)) count++;
    }
    return count;
  }

  return {
    HOST_SEP: HOST_SEP,
    SKIP_TYPES: SKIP_TYPES,
    cssSelector: cssSelector,
    excludedForShadow: excludedForShadow,
    collectDeep: collectDeep,
    resolvePath: resolvePath,
    isShadowPath: isShadowPath,
    countShadowFields: countShadowFields
  };
});
