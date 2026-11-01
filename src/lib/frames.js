/**
 * JustClick — 多 frame 结果合并（迭代 5）
 *
 * `all_frames: true` 之后，一个页面里的主 frame + 若干 iframe 会各自跑一遍
 * content script，popup 逐 frame 发消息后会拿到若干份 `JC_FILL` 响应。
 * 本模块把它们合并成与 `buildReportFromPlan` 的 plan 同形的结构：
 *
 *   { assignments, missing, notFound, frames, scanned, empty }
 *
 * 去重规则：同一个 key 在多个 frame 里出现时只保留一条，并用 frames 列出
 * 所有命中的 frame 标签（「跨 frame 的同 key missing 只显示一次」是 PRD 硬要求）。
 * 某个 frame 失败（未注入 / 页面已卸载）只标 failed，不影响其它 frame 的结果。
 *
 * 纯函数，不碰 chrome.*，可在 Node 直测。
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

  /** label 里 path 的最大长度，超出截断（避免 popup 里一行被长 URL 撑爆） */
  var MAX_PATH_LEN = 40;

  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  /**
   * frame 的人类可读标签：host + path（去掉 query / hash），path 超 40 字截断。
   * 非 http(s) 或空 → '该页面'（about:blank / data: 这类 frame 不该出现在报告里）。
   *
   * @param {string} url
   * @returns {string}
   */
  function frameLabel(url) {
    if (!isHttpUrl(url)) return '该页面';
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return '该页面';
    }
    if (!/^https?:$/i.test(parsed.protocol)) return '该页面';
    var host = parsed.host || parsed.hostname || '';
    if (!host) return '该页面';
    var pathname = parsed.pathname || '';
    if (!pathname) pathname = '/';
    if (pathname.length > MAX_PATH_LEN) pathname = pathname.slice(0, MAX_PATH_LEN) + '…';
    return host + pathname;
  }

  /**
   * 学习流用：给每个 entry 打上 frameLabel，并重排全局唯一 index（0..n-1），
   * 保留原 selector（shadow 路径可能就在 selector 里）。
   *
   * @param {Array} entries
   * @param {string} label
   * @returns {Array}
   */
  function tagEntriesWithFrame(entries, label) {
    var list = Array.isArray(entries) ? entries : [];
    var frameLabelText = typeof label === 'string' && label ? label : '该页面';
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry || typeof entry !== 'object') continue;
      var copy = {};
      for (var key in entry) {
        if (Object.prototype.hasOwnProperty.call(entry, key)) copy[key] = entry[key];
      }
      copy.frameLabel = frameLabelText;
      copy.index = out.length;
      if (typeof copy.selector !== 'string' || !copy.selector) copy.selector = '';
      out.push(copy);
    }
    return out;
  }

  function pushFrameLabel(item, label) {
    if (!item.frames) item.frames = [];
    if (item.frames.indexOf(label) === -1) item.frames.push(label);
  }

  /**
   * 合并多个 frame 的 `JC_FILL` 响应。
   *
   * @param {Array<{frameId:number, url:string, result:object}>} frames
   * @param {{labelFor?:Function}} [options]
   * @returns {{assignments:Array, missing:Array, notFound:Array, frames:Array, scanned:number, empty:boolean}}
   */
  function mergeFrameResults(frames, options) {
    var opts = options || {};
    var list = Array.isArray(frames) ? frames : [];
    var labelFor = typeof opts.labelFor === 'function' ? opts.labelFor : frameLabel;

    var outFrames = [];
    var assignments = [];
    var missing = [];
    var notFound = [];
    var assignmentIndex = Object.create(null);
    var missingIndex = Object.create(null);
    var notFoundIndex = Object.create(null);
    var scanned = 0;

    for (var i = 0; i < list.length; i++) {
      var item = isPlainObject(list[i]) ? list[i] : {};
      var result = isPlainObject(item.result) ? item.result : null;
      var label = '';
      try {
        label = labelFor(item.url || (result && result.frameUrl) || '');
      } catch (e) {
        label = '该页面';
      }
      if (!label) label = '该页面';

      var ok = true;
      var error = '';
      if (!result) {
        ok = false;
        error = '没有收到该 frame 的响应';
      } else if (result.ok === false) {
        ok = false;
        error = typeof result.error === 'string' && result.error ? result.error : '填充失败';
      } else if (typeof result.error === 'string' && result.error && result.ok !== true) {
        ok = false;
        error = result.error;
      }

      var filledItems = ok && Array.isArray(result.filledItems) ? result.filledItems : [];
      var missingItems = ok && Array.isArray(result.missingItems) ? result.missingItems : [];
      var unmatchedItems = ok && Array.isArray(result.unmatchedItems) ? result.unmatchedItems : [];
      var frameScanned = ok && typeof result.scanned === 'number' && isFinite(result.scanned) ? result.scanned : 0;
      scanned += frameScanned;

      var filledCount = filledItems.length;
      if (!ok) filledCount = 0;
      else if (!filledItems.length && typeof result.filled === 'number' && isFinite(result.filled)) {
        filledCount = result.filled;
      }

      outFrames.push({
        frameId: typeof item.frameId === 'number' ? item.frameId : i,
        label: label,
        ok: ok,
        failed: !ok,
        error: error,
        scanned: frameScanned,
        filled: filledCount,
        missing: missingItems.length,
        unmatched: unmatchedItems.length
      });

      for (var a = 0; a < filledItems.length; a++) {
        var filled = filledItems[a];
        if (!isPlainObject(filled) || typeof filled.key !== 'string' || !filled.key) continue;
        if (!assignmentIndex[filled.key]) {
          var assignment = {
            key: filled.key,
            label: typeof filled.label === 'string' && filled.label ? filled.label : filled.key,
            value: typeof filled.value === 'string' ? filled.value : '',
            frames: []
          };
          if (filled.shadow === true || filled.viaShadow === true) assignment.shadow = true;
          assignmentIndex[filled.key] = assignment;
          assignments.push(assignment);
        } else if (filled.shadow === true || filled.viaShadow === true) {
          assignmentIndex[filled.key].shadow = true;
        }
        pushFrameLabel(assignmentIndex[filled.key], label);
      }

      for (var m = 0; m < missingItems.length; m++) {
        var miss = missingItems[m];
        if (!isPlainObject(miss) || typeof miss.key !== 'string' || !miss.key) continue;
        if (!missingIndex[miss.key]) {
          missingIndex[miss.key] = {
            key: miss.key,
            label: typeof miss.label === 'string' && miss.label ? miss.label : miss.key,
            frames: []
          };
          missing.push(missingIndex[miss.key]);
        }
        pushFrameLabel(missingIndex[miss.key], label);
      }

      for (var n = 0; n < unmatchedItems.length; n++) {
        var unmatched = unmatchedItems[n];
        if (!isPlainObject(unmatched) || typeof unmatched.key !== 'string' || !unmatched.key) continue;
        if (!notFoundIndex[unmatched.key]) {
          var un = {
            key: unmatched.key,
            label: typeof unmatched.label === 'string' && unmatched.label ? unmatched.label : unmatched.key,
            frames: []
          };
          if (typeof unmatched.value === 'string' && unmatched.value) un.value = unmatched.value;
          notFoundIndex[unmatched.key] = un;
          notFound.push(un);
        } else if (typeof unmatched.value === 'string' && unmatched.value && !notFoundIndex[unmatched.key].value) {
          notFoundIndex[unmatched.key].value = unmatched.value;
        }
        pushFrameLabel(notFoundIndex[unmatched.key], label);
      }
    }

    return {
      assignments: assignments,
      missing: missing,
      notFound: notFound,
      frames: outFrames,
      scanned: scanned,
      empty: assignments.length === 0 && missing.length === 0 && notFound.length === 0
    };
  }

  return {
    MAX_PATH_LEN: MAX_PATH_LEN,
    frameLabel: frameLabel,
    tagEntriesWithFrame: tagEntriesWithFrame,
    mergeFrameResults: mergeFrameResults
  };
});
