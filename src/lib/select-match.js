/**
 * JustClick — 下拉框取值匹配（迭代 5）
 *
 * 国内站点的 <select> 选项文案五花八门：「本科及以上」「硕士研究生」「随时到岗」
 * 「一周以内」。用户简历里写的却是「本科」「硕士」「随时」「一周内」。
 * 这里把匹配规则抽成纯函数，content script 只负责把 el.options 映射成
 * [{text, value}] 再调本模块，DOM 侧只做 selectedIndex 赋值 + 派发事件。
 *
 * 规则顺序：归一化精确 → 包含式（两侧长度 ≥ 2）→ 同义词组 → -1。
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

  /** 包含式匹配的最小长度：避免「本」命中「本科」这类单字误伤 */
  var MIN_CONTAINS_LEN = 2;

  /** 同义词组：组内任一词命中即可回填对应选项 */
  var SYNONYM_GROUPS = [
    ['本科', '学士'],
    ['硕士', '研究生'],
    ['大专', '专科'],
    ['博士', '博士研究生'],
    ['随时', '立即', '随时到岗'],
    ['一周内', '一周以内'],
    ['一个月内', '一个月以内', '一月内']
  ];

  /** 小写、去空白（含全角空格）、去标点，只留字母数字与中日韩字符 */
  function normalizeOption(value) {
    if (typeof value !== 'string') return '';
    return value
      .toLowerCase()
      .replace(/[\s\u00a0\u3000]+/g, '')
      .replace(/[^0-9a-z\u4e00-\u9fff\u3040-\u30ff]/g, '');
  }

  function textsOf(option) {
    if (!option || typeof option !== 'object') return [];
    var out = [];
    var text = normalizeOption(option.text);
    var value = normalizeOption(option.value);
    if (text) out.push(text);
    if (value && value !== text) out.push(value);
    return out;
  }

  /** 精确匹配：text 或 value 归一化后完全相等 */
  function exactIndex(list, target) {
    for (var i = 0; i < list.length; i++) {
      var texts = textsOf(list[i]);
      for (var t = 0; t < texts.length; t++) {
        if (texts[t] === target) return i;
      }
    }
    return -1;
  }

  /**
   * 包含式匹配：优先「选项文本包含目标」（选项更具体，如「本科及以上」），
   * 其次「目标包含选项文本」（如目标「随时到岗」、选项「随时」）。
   */
  function containsIndex(list, target) {
    if (target.length < MIN_CONTAINS_LEN) return -1;
    var bestIndex = -1;
    var bestScore = Infinity;
    for (var i = 0; i < list.length; i++) {
      var texts = textsOf(list[i]);
      for (var t = 0; t < texts.length; t++) {
        var text = texts[t];
        if (!text || text.length < MIN_CONTAINS_LEN) continue;
        var forward = text.indexOf(target) !== -1;
        var backward = target.indexOf(text) !== -1;
        if (!forward && !backward) continue;
        var score = (forward ? 0 : 1000) + Math.abs(text.length - target.length);
        if (score < bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }
    }
    return bestIndex;
  }

  /** 同义词组：目标属于某组 → 选项文本/值也属于该组即命中 */
  function synonymIndex(list, target) {
    var group = null;
    for (var g = 0; g < SYNONYM_GROUPS.length; g++) {
      if (SYNONYM_GROUPS[g].indexOf(target) !== -1) {
        group = SYNONYM_GROUPS[g];
        break;
      }
    }
    if (!group) return -1;
    for (var i = 0; i < list.length; i++) {
      var texts = textsOf(list[i]);
      for (var t = 0; t < texts.length; t++) {
        if (group.indexOf(texts[t]) !== -1) return i;
      }
    }
    return -1;
  }

  /**
   * @param {Array<{text:string, value:string}>} options
   * @param {string} value 简历里的值
   * @returns {number} 命中的下标（≥0），否则 -1
   */
  function matchSelectOption(options, value) {
    var list = Array.isArray(options) ? options : [];
    var target = normalizeOption(typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
    if (!target || !list.length) return -1;

    var index = exactIndex(list, target);
    if (index !== -1) return index;

    index = containsIndex(list, target);
    if (index !== -1) return index;

    return synonymIndex(list, target);
  }

  return {
    MIN_CONTAINS_LEN: MIN_CONTAINS_LEN,
    SYNONYM_GROUPS: SYNONYM_GROUPS,
    normalizeOption: normalizeOption,
    matchSelectOption: matchSelectOption
  };
});
