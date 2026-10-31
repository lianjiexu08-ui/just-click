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
      return { ok: true, resume: toSave, errors: [] };
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

  return {
    STORAGE_KEY: STORAGE_KEY,
    getResume: getResume,
    saveResume: saveResume,
    clearResume: clearResume,
    onResumeChanged: onResumeChanged
  };
});
