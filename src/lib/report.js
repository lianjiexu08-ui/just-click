/**
 * JustClick — 填充报告（迭代 3）
 *
 * 把 field-matcher 的填充计划（assignments / missing / notFound）转成 popup 直接渲染的
 * 三个区块：已填 filled / 待填 missing / 未匹配 unmatched。
 *
 * 纯函数，无 DOM、无 chrome.*：popup 与单测走同一段代码，报告结构不会「UI 里对、测试里错」。
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

  /** PRD：报告中「值」超过 20 字截断，点击展开看全文 */
  var MAX_VALUE_LEN = 20;

  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function text(value) {
    if (typeof value === 'number' && isFinite(value)) return String(value);
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim();
  }

  /**
   * 截断展示值：保留前 max 个字符 + 省略号，并标记是否被截断（UI 据此决定能否展开）。
   * @returns {{display:string, truncated:boolean}}
   */
  function truncateValue(value, max) {
    var full = text(value);
    var limit = typeof max === 'number' && max > 0 ? max : MAX_VALUE_LEN;
    if (full.length <= limit) return { display: full, truncated: false };
    return { display: full.slice(0, limit) + '…', truncated: true };
  }

  function valueItem(key, label, value, max) {
    var full = text(value);
    var cut = truncateValue(full, max);
    return {
      key: key,
      label: label || key,
      value: full,
      display: cut.display,
      truncated: cut.truncated
    };
  }

  function emptyReport(at) {
    return {
      filled: [],
      missing: [],
      unmatched: [],
      counts: { filled: 0, missing: 0, unmatched: 0 },
      total: 0,
      at: at || new Date().toISOString()
    };
  }

  /**
   * 由填充计划生成报告对象。
   * @param {{assignments?:Array, missing?:Array, notFound?:Array}} plan
   * @param {Object} [valueMap] 键 → 值（用于 unmatched 区块显示「简历里有、页面没有」的值）
   * @param {{maxValueLen?:number, now?:string|Date, scanned?:number}} [options]
   */
  function buildReportFromPlan(plan, valueMap, options) {
    var opts = options || {};
    var values = isPlainObject(valueMap) ? valueMap : {};
    var max = typeof opts.maxValueLen === 'number' ? opts.maxValueLen : MAX_VALUE_LEN;
    var at =
      opts.now instanceof Date
        ? opts.now.toISOString()
        : typeof opts.now === 'string' && opts.now
          ? opts.now
          : new Date().toISOString();

    var source = isPlainObject(plan) ? plan : {};
    var assignments = Array.isArray(source.assignments) ? source.assignments : [];
    var missingRaw = Array.isArray(source.missing) ? source.missing : [];
    var notFoundRaw = Array.isArray(source.notFound) ? source.notFound : [];

    var report = emptyReport(at);
    var filledKeys = Object.create(null);
    var seenMissing = Object.create(null);

    for (var i = 0; i < assignments.length; i++) {
      var a = assignments[i];
      if (!a || typeof a.key !== 'string') continue;
      filledKeys[a.key] = true;
      var filledItem = valueItem(a.key, a.label, a.value, max);
      // 迭代 5：多 frame 合并 / Shadow DOM 命中的附加信息，有则原样带给 UI
      if (a.shadow === true) filledItem.shadow = true;
      if (Array.isArray(a.frames) && a.frames.length) filledItem.frames = a.frames.slice();
      report.filled.push(filledItem);
    }

    for (var m = 0; m < missingRaw.length; m++) {
      var miss = missingRaw[m];
      if (!miss || typeof miss.key !== 'string') continue;
      if (filledKeys[miss.key] || seenMissing[miss.key]) continue;
      seenMissing[miss.key] = true;
      var missingItem = { key: miss.key, label: miss.label || miss.key };
      if (Array.isArray(miss.frames) && miss.frames.length) missingItem.frames = miss.frames.slice();
      report.missing.push(missingItem);
    }

    for (var n = 0; n < notFoundRaw.length; n++) {
      var unf = notFoundRaw[n];
      if (!unf || typeof unf.key !== 'string') continue;
      if (filledKeys[unf.key]) continue;
      var unmatchedItem = valueItem(unf.key, unf.label, values[unf.key], max);
      if (Array.isArray(unf.frames) && unf.frames.length) unmatchedItem.frames = unf.frames.slice();
      report.unmatched.push(unmatchedItem);
    }

    report.counts = {
      filled: report.filled.length,
      missing: report.missing.length,
      unmatched: report.unmatched.length
    };
    report.total = report.counts.filled + report.counts.missing + report.counts.unmatched;
    if (typeof opts.scanned === 'number') report.scanned = opts.scanned;
    return report;
  }

  /** 兼容旧版 content script 只回 label 数组的情况，避免 popup 拿不到 key 就崩 */
  function reportFromFillResult(result, options) {
    var opts = options || {};
    var source = isPlainObject(result) ? result : {};
    var plan = {
      assignments: Array.isArray(source.filledItems) ? source.filledItems : [],
      missing: Array.isArray(source.missingItems) ? source.missingItems : [],
      notFound: Array.isArray(source.unmatchedItems) ? source.unmatchedItems : []
    };
    if (!plan.assignments.length && Array.isArray(source.filledLabels)) {
      for (var i = 0; i < source.filledLabels.length; i++) {
        plan.assignments.push({ key: 'filled_' + i, label: source.filledLabels[i], value: '' });
      }
    }
    if (!plan.missing.length && Array.isArray(source.missing)) {
      for (var j = 0; j < source.missing.length; j++) {
        plan.missing.push({ key: 'missing_' + j, label: source.missing[j] });
      }
    }
    if (!plan.notFound.length && Array.isArray(source.notFound)) {
      for (var k = 0; k < source.notFound.length; k++) {
        plan.notFound.push({ key: 'unmatched_' + k, label: source.notFound[k] });
      }
    }
    return buildReportFromPlan(plan, opts.valueMap, opts);
  }

  /** 报告转纯文本（「复制报告」按钮用，也便于贴给团队/存档） */
  function reportToText(report, options) {
    var opts = options || {};
    var data = isPlainObject(report) ? report : emptyReport();
    var lines = [];
    var when = '';
    if (typeof data.at === 'string' && data.at) {
      var d = new Date(data.at);
      when = isNaN(d.getTime()) ? data.at : d.toLocaleString('zh-CN');
    }
    lines.push('JustClick 填充报告' + (when ? ' · ' + when : ''));
    if (opts.url) lines.push('页面：' + opts.url);
    lines.push('');

    lines.push('【已填 ' + (data.filled || []).length + ' 项】');
    if (!(data.filled || []).length) lines.push('- （无）');
    for (var i = 0; i < (data.filled || []).length; i++) {
      var f = data.filled[i];
      lines.push('- ' + f.label + ' = ' + (f.value || '（空）'));
    }
    lines.push('');

    lines.push('【待填 ' + (data.missing || []).length + ' 项】');
    if (!(data.missing || []).length) lines.push('- （无）');
    for (var m = 0; m < (data.missing || []).length; m++) {
      lines.push('- ' + data.missing[m].label);
    }
    lines.push('');

    lines.push('【未匹配 ' + (data.unmatched || []).length + ' 项】');
    if (!(data.unmatched || []).length) lines.push('- （无）');
    for (var n = 0; n < (data.unmatched || []).length; n++) {
      var u = data.unmatched[n];
      lines.push('- ' + u.label + (u.value ? ' = ' + u.value : ''));
    }
    return lines.join('\n');
  }

  return {
    MAX_VALUE_LEN: MAX_VALUE_LEN,
    truncateValue: truncateValue,
    emptyReport: emptyReport,
    buildReportFromPlan: buildReportFromPlan,
    reportFromFillResult: reportFromFillResult,
    reportToText: reportToText
  };
});
