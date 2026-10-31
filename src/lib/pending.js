/**
 * JustClick — 待填项持久化（迭代 3）
 *
 * 填充后「表单匹配到了、但简历里没值」的字段会存进 chrome.storage 的 `jc.pending`：
 *   - 按字段 key 去重（同一个 key 只留最新一条，绝不堆积）
 *   - 带来源站点域名与时间，popup 顶部才能说「你有 N 个待填项（上次来自 xxx.com）」
 *   - 补值后立刻移除；跨页面、跨会话都还在
 *
 * 只有读写存储这一段碰 chrome.*，去重/归并逻辑是纯函数（单测用存储 stub 驱动）。
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

  var PENDING_KEY = 'jc.pending';
  var PENDING_SCHEMA_VERSION = 1;

  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function text(value) {
    if (typeof value === 'number' && isFinite(value)) return String(value);
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim();
  }

  function hostOf(url) {
    var raw = text(url);
    if (!raw) return '';
    raw = raw.replace(/^[a-z]+:\/\//i, '');
    var cut = raw.split(/[/?#]/)[0];
    return cut.toLowerCase();
  }

  /**
   * 规整一条待填项。key 缺失就丢弃（没有 key 无从去重也无从补填）。
   * @param {object} raw
   * @param {{host?:string, now?:string, url?:string}} [defaults]
   */
  function normalizePendingItem(raw, defaults) {
    var opts = defaults || {};
    if (!isPlainObject(raw)) return null;
    var key = text(raw.key);
    if (!key) return null;
    var label = text(raw.label) || key;
    var host = text(raw.host) || text(opts.host) || hostOf(raw.url || opts.url);
    var at = text(raw.at) || text(opts.now) || new Date().toISOString();
    var item = { key: key, label: label, host: host, at: at };
    if (raw.source === 'fill-report' || raw.source === 'learn') item.source = raw.source;
    return item;
  }

  /** 归并去重：同 key 保留最新（at 更大者），新的排后面 */
  function mergePendingItems(existing, incoming) {
    var out = [];
    var index = Object.create(null);

    function put(item) {
      if (!item) return;
      if (Object.prototype.hasOwnProperty.call(index, item.key)) {
        var at = index[item.key];
        var current = out[at];
        if (String(item.at) >= String(current.at)) out[at] = item;
        return;
      }
      index[item.key] = out.length;
      out.push(item);
    }

    var listA = Array.isArray(existing) ? existing : [];
    for (var i = 0; i < listA.length; i++) put(normalizePendingItem(listA[i]));

    var listB = Array.isArray(incoming) ? incoming : [];
    for (var j = 0; j < listB.length; j++) {
      var item = normalizePendingItem(listB[j]);
      if (!item) continue;
      if (Object.prototype.hasOwnProperty.call(index, item.key)) {
        // 同 key：接受更新的一条（时间更晚则替换，否则保留原值但刷新 label）
        var at = index[item.key];
        var current = out[at];
        if (String(item.at) >= String(current.at)) out[at] = item;
        else out[at] = { key: current.key, label: item.label, host: current.host, at: current.at };
        continue;
      }
      index[item.key] = out.length;
      out.push(item);
    }
    return out;
  }

  function summary(items) {
    var list = Array.isArray(items) ? items : [];
    var hosts = [];
    for (var i = 0; i < list.length; i++) {
      var host = text(list[i].host);
      if (host && hosts.indexOf(host) === -1) hosts.push(host);
    }
    return {
      count: list.length,
      hosts: hosts,
      host: hosts.length ? hosts[0] : '',
      label: list.length
        ? '你有 ' + list.length + ' 个待填项' + (hosts.length ? '（上次来自 ' + hosts[0] + '）' : '')
        : ''
    };
  }

  function assertChrome() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      throw new Error('chrome.storage.local 不可用');
    }
  }

  function emptyBag() {
    return { schemaVersion: PENDING_SCHEMA_VERSION, items: [] };
  }

  function readBag(raw) {
    if (!isPlainObject(raw) || !Array.isArray(raw.items)) return emptyBag();
    var items = [];
    var seen = Object.create(null);
    for (var i = 0; i < raw.items.length; i++) {
      var item = normalizePendingItem(raw.items[i]);
      if (!item || seen[item.key]) continue;
      seen[item.key] = true;
      items.push(item);
    }
    return { schemaVersion: PENDING_SCHEMA_VERSION, items: items };
  }

  function getPendingItems() {
    assertChrome();
    return chrome.storage.local.get(PENDING_KEY).then(function (bag) {
      return readBag(bag ? bag[PENDING_KEY] : null);
    });
  }

  function saveBag(items) {
    var bag = emptyBag();
    bag.items = Array.isArray(items) ? items : [];
    var payload = {};
    payload[PENDING_KEY] = bag;
    return chrome.storage.local.set(payload).then(function () {
      return bag;
    });
  }

  /**
   * 追加待填项（自动去重、更新来源站点与时间）。
   * @param {Array} items
   * @param {{host?:string, now?:string, url?:string}} [defaults]
   */
  function addPendingItems(items, defaults) {
    var opts = defaults || {};
    var incoming = [];
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i++) {
      var item = normalizePendingItem(list[i], opts);
      if (item) incoming.push(item);
    }
    if (!incoming.length) return Promise.resolve({ ok: true, items: [], added: 0 });

    return getPendingItems().then(function (bag) {
      var merged = mergePendingItems(bag.items, incoming);
      return saveBag(merged).then(function (saved) {
        return { ok: true, items: saved.items, added: merged.length - bag.items.length };
      });
    });
  }

  function removePendingItem(key) {
    var wanted = text(key);
    if (!wanted) return Promise.resolve({ ok: false, items: [], removed: false, errors: ['缺少 key'] });
    return getPendingItems().then(function (bag) {
      var next = [];
      var removed = false;
      for (var i = 0; i < bag.items.length; i++) {
        if (bag.items[i].key === wanted) {
          removed = true;
          continue;
        }
        next.push(bag.items[i]);
      }
      if (!removed) return { ok: true, items: bag.items, removed: false };
      return saveBag(next).then(function (saved) {
        return { ok: true, items: saved.items, removed: true };
      });
    });
  }

  function clearPendingItems() {
    return saveBag([]).then(function (saved) {
      return { ok: true, items: saved.items };
    });
  }

  return {
    PENDING_KEY: PENDING_KEY,
    PENDING_SCHEMA_VERSION: PENDING_SCHEMA_VERSION,
    hostOf: hostOf,
    normalizePendingItem: normalizePendingItem,
    mergePendingItems: mergePendingItems,
    summary: summary,
    getPendingItems: getPendingItems,
    addPendingItems: addPendingItems,
    removePendingItem: removePendingItem,
    clearPendingItems: clearPendingItems
  };
});
