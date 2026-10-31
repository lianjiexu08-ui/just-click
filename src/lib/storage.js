/**
 * JustClick — chrome.storage.local 封装
 *
 * 只在这里碰 chrome.* API，业务逻辑全部走 resume-schema / field-matcher 的纯函数，
 * 这样单测不需要模拟浏览器环境。
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

  var STORAGE_KEY = 'jc.resume';
  var RULES_KEY = 'jc.rules';
  var RULES_SCHEMA_VERSION = 2;

  function schema() {
    if (typeof globalThis !== 'undefined' && globalThis.JC && globalThis.JC.validateResume) {
      return globalThis.JC;
    }
    if (typeof require === 'function') {
      try {
        return require('./resume-schema.js');
      } catch (e) {
        /* ignore */
      }
    }
    throw new Error('resume-schema 未加载');
  }

  function rulesModule() {
    if (typeof globalThis !== 'undefined' && globalThis.JC && globalThis.JC.validateRule) {
      return globalThis.JC;
    }
    if (typeof require === 'function') {
      try {
        return require('./rules.js');
      } catch (e) {
        /* ignore */
      }
    }
    throw new Error('rules 未加载');
  }

  function assertChrome() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      throw new Error('chrome.storage.local 不可用');
    }
  }

  /** 读取简历，缺失或损坏时回退到空 schema */
  function getResume() {
    var S = schema();
    assertChrome();
    return chrome.storage.local.get(STORAGE_KEY).then(function (bag) {
      var raw = bag ? bag[STORAGE_KEY] : null;
      if (!raw) return S.createEmptyResume();
      var checked = S.validateResume(raw);
      return checked.resume;
    });
  }

  /** 保存简历，写入前统一校验 + 打时间戳 */
  function saveResume(resume) {
    var S = schema();
    assertChrome();
    var checked = S.validateResume(resume);
    if (!checked.ok) {
      return Promise.resolve({ ok: false, resume: checked.resume, errors: checked.errors });
    }
    var toSave = checked.resume;
    toSave.version = S.RESUME_VERSION;
    toSave.updatedAt = new Date().toISOString();
    var bag = {};
    bag[STORAGE_KEY] = toSave;
    return chrome.storage.local.set(bag).then(function () {
      return { ok: true, resume: toSave, errors: [], warnings: checked.warnings };
    });
  }

  function clearResume() {
    var S = schema();
    assertChrome();
    var empty = S.createEmptyResume();
    return saveResume(empty);
  }

  /** 订阅跨页面变更（options 页保存后 popup 自动刷新） */
  function onResumeChanged(callback) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return function () {};
    var listener = function (changes, area) {
      if (area !== 'local' || !changes[STORAGE_KEY]) return;
      var raw = changes[STORAGE_KEY].newValue;
      if (!raw) return;
      callback(schema().validateResume(raw).resume);
    };
    chrome.storage.onChanged.addListener(listener);
    return function () {
      chrome.storage.onChanged.removeListener(listener);
    };
  }

  /* --------------------------------------------------------------- 规则存储 */

  function emptyRules() {
    return { schemaVersion: RULES_SCHEMA_VERSION, fieldRules: [] };
  }

  /**
   * 读取规则。存储里的脏规则（手改 JSON / 旧版本残留）直接跳过，
   * 不让一条坏 regex 把整个规则表读崩。
   */
  function getRules() {
    var R = rulesModule();
    assertChrome();
    return chrome.storage.local.get(RULES_KEY).then(function (bag) {
      var raw = bag ? bag[RULES_KEY] : null;
      if (!raw || !Array.isArray(raw.fieldRules)) return emptyRules();
      var out = [];
      for (var i = 0; i < raw.fieldRules.length; i++) {
        var checked = R.validateRule(raw.fieldRules[i]);
        if (checked.ok) out.push(checked.rule);
      }
      return { schemaVersion: RULES_SCHEMA_VERSION, fieldRules: out };
    });
  }

  /**
   * 全量保存。任何一条规则不合法就整体不落盘，
   * 避免「存进去一半、读出来更乱」。
   * @param {Array|{fieldRules:Array}} input
   */
  function saveRules(input) {
    var R = rulesModule();
    assertChrome();
    var list = Array.isArray(input) ? input : input && Array.isArray(input.fieldRules) ? input.fieldRules : null;
    if (!list) {
      return Promise.resolve({ ok: false, errors: ['规则必须是数组或 {fieldRules: []}'], rules: [] });
    }

    var errors = [];
    var normalized = [];
    for (var i = 0; i < list.length; i++) {
      var checked = R.validateRule(list[i]);
      if (!checked.ok) {
        errors.push('规则 #' + (i + 1) + '：' + checked.errors.join('；'));
        continue;
      }
      normalized.push(checked.rule);
    }
    if (errors.length) {
      return Promise.resolve({ ok: false, errors: errors, rules: normalized });
    }

    var payload = { schemaVersion: RULES_SCHEMA_VERSION, fieldRules: normalized };
    var bag = {};
    bag[RULES_KEY] = payload;
    return chrome.storage.local.set(bag).then(function () {
      return { ok: true, rules: normalized, errors: [] };
    });
  }

  /** 新增一条规则；没带 id 时自动生成（createRule 负责 uuid 兜底） */
  function addRule(rule) {
    var R = rulesModule();
    var candidate = rule && rule.id ? rule : R.createRule(rule || {});
    var checked = R.validateRule(candidate);
    if (!checked.ok) {
      return Promise.resolve({ ok: false, errors: checked.errors, rule: null });
    }
    return getRules().then(function (bag) {
      for (var i = 0; i < bag.fieldRules.length; i++) {
        if (bag.fieldRules[i].id === checked.rule.id) {
          return { ok: false, errors: ['规则 id 已存在：' + checked.rule.id], rule: checked.rule };
        }
      }
      var next = bag.fieldRules.concat([checked.rule]);
      return saveRules(next).then(function (saved) {
        if (!saved.ok) return { ok: false, errors: saved.errors, rule: checked.rule };
        return { ok: true, rule: checked.rule, errors: [] };
      });
    });
  }

  /** 局部更新：match / scope 做浅合并，id / createdAt / hitCount 默认保留 */
  function updateRule(id, patch) {
    var R = rulesModule();
    if (typeof id !== 'string' || !id) {
      return Promise.resolve({ ok: false, errors: ['缺少规则 id'], rule: null });
    }
    var changes = patch && typeof patch === 'object' ? patch : {};
    return getRules().then(function (bag) {
      var index = -1;
      for (var i = 0; i < bag.fieldRules.length; i++) {
        if (bag.fieldRules[i].id === id) {
          index = i;
          break;
        }
      }
      if (index === -1) {
        return { ok: false, errors: ['规则不存在：' + id], rule: null };
      }

      var base = bag.fieldRules[index];
      var next = {};
      for (var k in base) {
        if (Object.prototype.hasOwnProperty.call(base, k)) next[k] = base[k];
      }
      for (var p in changes) {
        if (Object.prototype.hasOwnProperty.call(changes, p)) next[p] = changes[p];
      }
      next.id = id;
      next.match = {};
      for (var m in base.match) {
        if (Object.prototype.hasOwnProperty.call(base.match, m)) next.match[m] = base.match[m];
      }
      if (changes.match && typeof changes.match === 'object') {
        for (var cm in changes.match) {
          if (Object.prototype.hasOwnProperty.call(changes.match, cm)) next.match[cm] = changes.match[cm];
        }
      }
      // 允许 UI 直接 patch pattern / attrs / matchType，少写一层嵌套
      if (changes.pattern !== undefined) next.match.pattern = changes.pattern;
      if (changes.attrs !== undefined) next.match.attrs = changes.attrs;
      if (changes.matchType !== undefined) next.match.matchType = changes.matchType;
      next.scope = {};
      for (var s in base.scope) {
        if (Object.prototype.hasOwnProperty.call(base.scope, s)) next.scope[s] = base.scope[s];
      }
      if (changes.scope && typeof changes.scope === 'object') {
        for (var cs in changes.scope) {
          if (Object.prototype.hasOwnProperty.call(changes.scope, cs)) next.scope[cs] = changes.scope[cs];
        }
      }
      if (changes.sitePattern !== undefined) next.scope.sitePattern = changes.sitePattern;

      var checked = R.validateRule(next);
      if (!checked.ok) {
        return { ok: false, errors: checked.errors, rule: next };
      }
      var list = bag.fieldRules.slice();
      list[index] = checked.rule;
      return saveRules(list).then(function (saved) {
        if (!saved.ok) return { ok: false, errors: saved.errors, rule: checked.rule };
        return { ok: true, rule: checked.rule, errors: [] };
      });
    });
  }

  function deleteRule(id) {
    return getRules().then(function (bag) {
      var next = [];
      var removed = false;
      for (var i = 0; i < bag.fieldRules.length; i++) {
        if (bag.fieldRules[i].id === id) {
          removed = true;
          continue;
        }
        next.push(bag.fieldRules[i]);
      }
      if (!removed) return { ok: true, removed: false, errors: [] };
      return saveRules(next).then(function (saved) {
        return { ok: saved.ok, removed: true, errors: saved.errors };
      });
    });
  }

  function setRuleEnabled(id, enabled) {
    return updateRule(id, { enabled: enabled !== false });
  }

  /** 填充后累加命中次数，用于「同分取 hitCount 高者」的优先级 */
  function bumpRuleHits(ids) {
    if (!Array.isArray(ids) || !ids.length) return Promise.resolve({ ok: true, updated: 0, rules: [] });
    var wanted = Object.create(null);
    for (var i = 0; i < ids.length; i++) {
      if (typeof ids[i] === 'string' && ids[i]) wanted[ids[i]] = true;
    }
    return getRules().then(function (bag) {
      var updated = 0;
      var next = [];
      for (var j = 0; j < bag.fieldRules.length; j++) {
        var rule = bag.fieldRules[j];
        if (wanted[rule.id]) {
          updated++;
          var copy = {};
          for (var k in rule) {
            if (Object.prototype.hasOwnProperty.call(rule, k)) copy[k] = rule[k];
          }
          copy.hitCount = (typeof rule.hitCount === 'number' ? rule.hitCount : 0) + 1;
          next.push(copy);
        } else {
          next.push(rule);
        }
      }
      if (!updated) return { ok: true, updated: 0, rules: bag.fieldRules };
      return saveRules(next).then(function (saved) {
        return { ok: saved.ok, updated: updated, rules: saved.rules, errors: saved.errors };
      });
    });
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    RULES_KEY: RULES_KEY,
    RULES_SCHEMA_VERSION: RULES_SCHEMA_VERSION,
    getResume: getResume,
    saveResume: saveResume,
    clearResume: clearResume,
    onResumeChanged: onResumeChanged,
    getRules: getRules,
    saveRules: saveRules,
    addRule: addRule,
    updateRule: updateRule,
    deleteRule: deleteRule,
    setRuleEnabled: setRuleEnabled,
    bumpRuleHits: bumpRuleHits
  };
});
