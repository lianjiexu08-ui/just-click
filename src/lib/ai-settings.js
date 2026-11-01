/**
 * JustClick — AI 供应商设置（迭代 4，BYOK）
 *
 * 存储键独立于简历数据（jc.aiSettings），这样「导出/导入简历 JSON」永远不会
 * 把 API Key 导出给别人。唯一碰 chrome.storage 的地方仍是本文件 + storage.js。
 *
 * 安全约定：本模块不调用 console，错误文案里也不拼 apiKey。
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

  var AI_SETTINGS_KEY = 'jc.aiSettings';
  var AI_SETTINGS_VERSION = 1;
  var DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
  var DEFAULT_MODEL = 'deepseek-chat';
  var MASK = '●●●●●●';

  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function hasChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function trimString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * 归一化：缺字段才补默认值；显式给空串就保持空串（这样「清空模型名」会被校验拦下，
   * 而不是悄悄退回默认模型，让用户以为配置生效了）。baseURL 去尾部斜杠。
   */
  function normalizeSettings(raw) {
    var out = { baseURL: DEFAULT_BASE_URL, model: DEFAULT_MODEL, apiKey: '' };
    if (isPlainObject(raw)) {
      if (raw.baseURL !== undefined && raw.baseURL !== null) {
        out.baseURL = trimString(raw.baseURL).replace(/\/+$/, '');
      }
      if (raw.model !== undefined && raw.model !== null) {
        out.model = trimString(raw.model);
      }
      if (typeof raw.apiKey === 'string') out.apiKey = raw.apiKey.trim();
    }
    return out;
  }

  /** 校验：baseURL 必须是 http(s)、model 必填、key 不含空白 */
  function validateSettings(settings) {
    var normalized = normalizeSettings(settings);
    var errors = [];
    if (!/^https?:\/\/[^\s/]+/i.test(normalized.baseURL)) {
      errors.push('baseURL 必须以 http:// 或 https:// 开头，例如 https://api.deepseek.com/v1');
    }
    if (!normalized.model) errors.push('模型名不能为空，例如 deepseek-chat');
    if (normalized.apiKey && /\s/.test(normalized.apiKey)) errors.push('API Key 不能包含空格或换行');
    return { ok: errors.length === 0, settings: normalized, errors: errors };
  }

  /** 是否已经可以发请求（三个都填了） */
  function isConfigured(settings) {
    var s = normalizeSettings(settings);
    return !!(s.baseURL && s.model && s.apiKey);
  }

  /** UI 展示用：永远不把明文 key 塞进提示文本 */
  function maskKey(apiKey) {
    var key = typeof apiKey === 'string' ? apiKey : '';
    if (!key) return '';
    return MASK;
  }

  /** 不含密钥的安全视图（用于日志/状态栏/报告） */
  function describeSettings(settings) {
    var s = normalizeSettings(settings);
    return {
      baseURL: s.baseURL,
      model: s.model,
      hasKey: !!s.apiKey,
      keyPreview: maskKey(s.apiKey)
    };
  }

  function readStored() {
    if (!hasChromeStorage()) return Promise.resolve(null);
    return chrome.storage.local.get(AI_SETTINGS_KEY).then(function (bag) {
      return bag ? bag[AI_SETTINGS_KEY] : null;
    });
  }

  /**
   * 读取设置。存储缺失/损坏时回退默认值，不抛错。
   * @returns {Promise<{ok:boolean, settings:object, configured:boolean}>}
   */
  function loadAiSettings() {
    return readStored()
      .then(function (raw) {
        var settings = normalizeSettings(raw);
        return { ok: true, settings: settings, configured: isConfigured(settings) };
      })
      .catch(function () {
        var settings = normalizeSettings(null);
        return { ok: true, settings: settings, configured: false };
      });
  }

  /**
   * 保存设置（覆盖写）。校验失败不落盘，避免把半截配置存进去。
   * @returns {Promise<{ok:boolean, settings:object, errors:string[]}>}
   */
  function saveAiSettings(settings) {
    var checked = validateSettings(settings);
    if (!checked.ok) {
      return Promise.resolve({ ok: false, settings: checked.settings, errors: checked.errors });
    }
    if (!hasChromeStorage()) {
      return Promise.resolve({ ok: false, settings: checked.settings, errors: ['chrome.storage.local 不可用'] });
    }
    var payload = {
      schemaVersion: AI_SETTINGS_VERSION,
      baseURL: checked.settings.baseURL,
      model: checked.settings.model,
      apiKey: checked.settings.apiKey,
      updatedAt: new Date().toISOString()
    };
    var bag = {};
    bag[AI_SETTINGS_KEY] = payload;
    return chrome.storage.local.set(bag).then(function () {
      return { ok: true, settings: checked.settings, errors: [] };
    });
  }

  /** 清除 key，保留 baseURL / model（换 key 不用重填地址） */
  function clearApiKey() {
    return loadAiSettings().then(function (bag) {
      var next = {
        baseURL: bag.settings.baseURL,
        model: bag.settings.model,
        apiKey: ''
      };
      return saveAiSettings(next).then(function (saved) {
        return { ok: saved.ok, settings: saved.settings, errors: saved.errors };
      });
    });
  }

  return {
    AI_SETTINGS_KEY: AI_SETTINGS_KEY,
    AI_SETTINGS_VERSION: AI_SETTINGS_VERSION,
    DEFAULT_BASE_URL: DEFAULT_BASE_URL,
    DEFAULT_MODEL: DEFAULT_MODEL,
    MASK: MASK,
    normalizeSettings: normalizeSettings,
    validateSettings: validateSettings,
    isConfigured: isConfigured,
    maskKey: maskKey,
    describeSettings: describeSettings,
    loadAiSettings: loadAiSettings,
    saveAiSettings: saveAiSettings,
    clearApiKey: clearApiKey
  };
});
