/**
 * JustClick — 内联补填（迭代 3）
 *
 * 报告里的「待填 M 项」允许当场补值：补的值先写回简历模型（内置字段覆盖、未知字段自动
 * 作为自定义字段创建），再生成一条**只填值、绝不提交表单**的增量指令交给 content script。
 *
 * 纯函数：不碰 chrome.*、不碰 DOM（存储由调用方用 storage.saveResume 落盘）。
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

  var S = null;

  function schema() {
    if (S) return S;
    if (typeof globalThis !== 'undefined' && globalThis.JC && globalThis.JC.validateResume) {
      S = globalThis.JC;
      return S;
    }
    if (typeof require === 'function') {
      try {
        S = require('./resume-schema.js');
        return S;
      } catch (e) {
        /* ignore */
      }
    }
    throw new Error('resume-schema 未加载');
  }

  /** 增量填充指令的类型，content script 与 popup 共用这一个常量，避免字符串抄错 */
  var FILL_ONE = 'JC_FILL_ONE';

  /**
   * 明确禁止出现在增量指令里的字段：只要有一个，就说明谁想提交表单。
   * 注意：不能把 'submit' 放进这个列表 —— 指令必须显式带 `submit: false` 作为「不提交」的承诺，
   * 该字段由 isNonSubmittingInstruction 单独按「必须严格等于 false」校验。
   */
  var FORBIDDEN_KEYS = ['formSubmit', 'requestSubmit', 'clickSubmit', 'pressEnter'];

  function stableHash(text) {
    var str = typeof text === 'string' ? text : '';
    var hash = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash >>> 0;
  }

  /** key → 存储位置；内置字段落 basics / 顶层，其它一律当成自定义字段 */
  function resolveTarget(resume, key) {
    var S2 = schema();
    if (typeof key !== 'string' || !key) return { kind: 'invalid', key: '' };

    if (S2.isBuiltinFieldKey(key)) {
      if (key === 'summary' || key === 'experience') {
        return { kind: 'top', key: key, path: key };
      }
      return { kind: 'basics', key: key, path: 'basics.' + key };
    }

    if (S2.isPlainObject(resume) && Array.isArray(resume.customFields)) {
      for (var i = 0; i < resume.customFields.length; i++) {
        var field = resume.customFields[i];
        if (field && field.key === key) {
          return { kind: 'custom', key: key, index: i, path: 'customFields.' + i + '.value' };
        }
      }
    }
    return { kind: 'new-custom', key: key, path: 'customFields.+' };
  }

  /** 未知 key 建自定义字段时用的 key：英文 slug 优先，纯中文退到确定性哈希（与模板一致） */
  function customKeyFor(label, resume) {
    var S2 = schema();
    var text = S2.sanitizeText(label);
    if (!text) return '';
    var slug = S2.slugifyKey(text).slice(0, 40).replace(/_+$/g, '');
    if (slug && S2.CUSTOM_KEY_RE.test(slug) && !S2.isBuiltinFieldKey(slug)) {
      var taken = S2.getFieldKeys(resume);
      if (taken.indexOf(slug) === -1) return slug;
    }
    return 'cf_' + stableHash(text).toString(36);
  }

  /**
   * 把补填的值写回简历模型。
   * @param {object} resume
   * @param {string} key 字段 key（内置或自定义）
   * @param {string} value 用户刚补的值
   * @param {{label?:string, group?:string}} [meta] 未知 key 建自定义字段时用到的展示名与分组
   * @returns {{ok:boolean, resume:object, created:boolean, key:string, label:string, errors:string[]}}
   */
  function applySupplement(resume, key, value, meta) {
    var S2 = schema();
    var options = meta || {};
    var errors = [];
    var text = S2.sanitizeText(value);

    if (!text) errors.push('补填的值不能为空');
    if (text.length > S2.CUSTOM_VALUE_MAX) text = text.slice(0, S2.CUSTOM_VALUE_MAX);

    var base = S2.migrateResume(resume);
    if (!key || typeof key !== 'string') {
      return { ok: false, resume: base, created: false, key: '', label: '', errors: errors.concat('缺少字段 key') };
    }
    if (errors.length) {
      return { ok: false, resume: base, created: false, key: key, label: options.label || key, errors: errors };
    }

    var target = resolveTarget(base, key);

    if (target.kind === 'basics') {
      base.basics[key] = text;
      // 手动写过全名（哪怕写空）就不再被「姓 + 名」自动覆盖
      if (key === 'fullName') base.fullNameManual = true;
      return {
        ok: true,
        resume: base,
        created: false,
        key: key,
        label: S2.labelFor(base, key),
        errors: []
      };
    }

    if (target.kind === 'top') {
      base[key] = text;
      // 经历摘要与 experience 双向同步，保证识别与导出都拿得到
      if (key === 'summary') base.experience = text;
      if (key === 'experience') base.summary = text;
      return {
        ok: true,
        resume: base,
        created: false,
        key: key,
        label: S2.labelFor(base, key),
        errors: []
      };
    }

    if (target.kind === 'custom') {
      base.customFields[target.index].value = text;
      return {
        ok: true,
        resume: base,
        created: false,
        key: key,
        label: S2.labelFor(base, key),
        errors: []
      };
    }

    // 简历里没有这个 key：作为自定义字段创建（补填过的东西以后还能被规则复用）
    var label = S2.sanitizeText(options.label || key) || key;
    // key 本身合法就直接沿用（例如 expected_salary），否则按 label 生成
    var newKey = S2.CUSTOM_KEY_RE.test(key) && !S2.isBuiltinFieldKey(key) ? key : customKeyFor(label, base);
    if (!newKey) {
      return { ok: false, resume: base, created: false, key: key, label: label, errors: ['无法为这个字段生成 key'] };
    }
    var group = S2.normalizeCustomGroup(options.group) || S2.DEFAULT_CUSTOM_GROUP;
    base.customFields = base.customFields.concat([{ key: newKey, label: label, value: text, group: group }]);
    return { ok: true, resume: base, created: true, key: newKey, label: label, errors: [] };
  }

  /**
   * 生成增量填充指令（只填这一个输入框）。
   * submit 恒为 false，并且不存在任何提交相关字段 —— content script 只认这一种指令。
   */
  function buildFillOneInstruction(input) {
    var data = input || {};
    var instruction = {
      type: FILL_ONE,
      key: typeof data.key === 'string' ? data.key : '',
      value: typeof data.value === 'string' ? data.value : String(data.value == null ? '' : data.value),
      label: typeof data.label === 'string' ? data.label : '',
      selector: typeof data.selector === 'string' ? data.selector : '',
      url: typeof data.url === 'string' ? data.url : '',
      submit: false
    };
    return instruction;
  }

  /** 自检：指令里不能出现任何提交意图（popup 发送前调用，测试也直接断言） */
  function isNonSubmittingInstruction(instruction) {
    if (!instruction || typeof instruction !== 'object') return false;
    if (instruction.submit !== false) return false;
    for (var i = 0; i < FORBIDDEN_KEYS.length; i++) {
      var key = FORBIDDEN_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(instruction, key)) return false;
    }
    return true;
  }

  return {
    FILL_ONE: FILL_ONE,
    FORBIDDEN_KEYS: FORBIDDEN_KEYS,
    stableHash: stableHash,
    resolveTarget: resolveTarget,
    customKeyFor: customKeyFor,
    applySupplement: applySupplement,
    buildFillOneInstruction: buildFillOneInstruction,
    isNonSubmittingInstruction: isNonSubmittingInstruction
  };
});
