/**
 * JustClick — 简历数据模型（schema / 校验 / 导入导出）
 *
 * 该文件同时用于三种运行环境：
 *   1. content script（浏览器，挂到 globalThis.JC）
 *   2. popup / options 页（普通 <script>）
 *   3. Node 单元测试（require）
 * 因此使用 UMD 双模导出，禁止使用 ES module 语法。
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

  var RESUME_VERSION = 2;

  var CUSTOM_KEY_MAX = 40;
  var CUSTOM_LABEL_MAX = 40;
  var CUSTOM_VALUE_MAX = 2000;
  var CUSTOM_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

  /** basics 下的可填文本字段 */
  var BASICS_KEYS = [
    'firstName',
    'lastName',
    'fullName',
    'email',
    'phone',
    'city',
    'address',
    'linkedin',
    'github',
    'website'
  ];

  /** 顶层可填文本字段 */
  var TOP_KEYS = ['summary', 'experience'];

  /** 字段识别引擎与 UI 共用的字段顺序 */
  var FIELD_KEYS = [
    'fullName',
    'firstName',
    'lastName',
    'email',
    'phone',
    'city',
    'address',
    'linkedin',
    'github',
    'website',
    'summary'
  ];

  var FIELD_LABELS = {
    fullName: '姓名',
    firstName: '名',
    lastName: '姓',
    email: '邮箱',
    phone: '电话',
    city: '城市',
    address: '地址',
    linkedin: 'LinkedIn',
    github: 'GitHub',
    website: '个人网站',
    summary: '经历摘要'
  };

  /** options 页的表单配置（顺序即渲染顺序） */
  var FORM_FIELDS = [
    { path: 'basics.fullName', key: 'fullName', label: '姓名', placeholder: '张三 / San Zhang' },
    { path: 'basics.firstName', key: 'firstName', label: '名（First name）', placeholder: 'San' },
    { path: 'basics.lastName', key: 'lastName', label: '姓（Last name）', placeholder: 'Zhang' },
    { path: 'basics.email', key: 'email', label: '邮箱', placeholder: 'san.zhang@example.com', type: 'email' },
    { path: 'basics.phone', key: 'phone', label: '电话', placeholder: '+86 138 0000 0000', type: 'tel' },
    { path: 'basics.city', key: 'city', label: '城市', placeholder: '上海' },
    { path: 'basics.address', key: 'address', label: '地址', placeholder: '上海市徐汇区某路 100 号' },
    { path: 'basics.linkedin', key: 'linkedin', label: 'LinkedIn', placeholder: 'https://www.linkedin.com/in/xxx' },
    { path: 'basics.github', key: 'github', label: 'GitHub', placeholder: 'https://github.com/xxx' },
    { path: 'basics.website', key: 'website', label: '个人网站 / 作品集', placeholder: 'https://xxx.dev' },
    { path: 'summary', key: 'summary', label: '经历摘要', placeholder: '5 年前端经验，负责……', multiline: true }
  ];

  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  /** 清理用户输入：去控制字符、折叠空白、trim */
  function sanitizeText(value) {
    if (typeof value === 'number' && isFinite(value)) value = String(value);
    if (typeof value !== 'string') return '';
    return value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * label → key：小写、非 [a-z0-9] 折叠成下划线、去首尾下划线。
   * 纯中文会得到空串，此时由调用方补 key 或走 nextCustomKey 的兜底编号。
   */
  function slugifyKey(label) {
    if (typeof label !== 'string') return '';
    return label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  /** 生成 custom_field_1/2… 形式的兜底 key，existing 可以是 key 数组或字段数组 */
  function nextCustomKey(existing) {
    var used = Object.create(null);
    var list = Array.isArray(existing) ? existing : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var key = typeof item === 'string' ? item : item && typeof item.key === 'string' ? item.key : '';
      if (key) used[key] = true;
    }
    var n = 1;
    while (used['custom_field_' + n]) n++;
    return 'custom_field_' + n;
  }

  function isBuiltinFieldKey(key) {
    return FIELD_KEYS.indexOf(key) !== -1;
  }

  /** 只返回结构上有 key 的自定义字段；合法性由 validateResume 负责 */
  function customFieldKeys(resume) {
    if (!isPlainObject(resume) || !Array.isArray(resume.customFields)) return [];
    var out = [];
    for (var i = 0; i < resume.customFields.length; i++) {
      var field = resume.customFields[i];
      if (isPlainObject(field) && typeof field.key === 'string' && field.key) out.push(field.key);
    }
    return out;
  }

  /** 内置 ∪ 自定义，内置在前（UI 下拉与 notFound 统计都依赖这个顺序） */
  function getFieldKeys(resume) {
    var out = FIELD_KEYS.slice();
    var customs = customFieldKeys(resume);
    for (var i = 0; i < customs.length; i++) {
      if (out.indexOf(customs[i]) === -1) out.push(customs[i]);
    }
    return out;
  }

  /** key → 展示名；未知 key 原样返回，便于排查规则写错目标 */
  function labelFor(resume, key) {
    if (typeof key !== 'string' || !key) return '';
    if (Object.prototype.hasOwnProperty.call(FIELD_LABELS, key)) return FIELD_LABELS[key];
    if (isPlainObject(resume) && Array.isArray(resume.customFields)) {
      for (var i = 0; i < resume.customFields.length; i++) {
        var field = resume.customFields[i];
        if (isPlainObject(field) && field.key === key && typeof field.label === 'string') return field.label;
      }
    }
    return key;
  }

  function createEmptyResume() {
    var basics = {};
    for (var i = 0; i < BASICS_KEYS.length; i++) basics[BASICS_KEYS[i]] = '';
    var resume = { version: RESUME_VERSION, basics: basics, customFields: [], updatedAt: null };
    for (var j = 0; j < TOP_KEYS.length; j++) resume[TOP_KEYS[j]] = '';
    return resume;
  }

  /**
   * 迁移阶段只做「形状归一」，不剔除非法项：validateResume 还要靠原始条目
   * 报出具体哪一条为什么不合法。
   */
  function migrateCustomFields(rawList) {
    if (!Array.isArray(rawList)) return [];
    var out = [];
    for (var i = 0; i < rawList.length; i++) {
      var item = rawList[i];
      if (!isPlainObject(item)) continue;
      var key = typeof item.key === 'string' ? item.key.trim() : '';
      var label =
        typeof item.label === 'string'
          ? sanitizeText(item.label)
          : typeof item.label === 'number' && isFinite(item.label)
            ? String(item.label)
            : '';
      var value =
        typeof item.value === 'string'
          ? item.value
          : typeof item.value === 'number' && isFinite(item.value)
            ? String(item.value)
            : '';
      out.push({ key: key, label: label, value: value });
    }
    return out;
  }

  /** 严格校验自定义字段：非法项剔除并给 warning，重复 key 只保留第一条 */
  function validateCustomFields(rawList) {
    var fields = [];
    var warnings = [];
    var seen = Object.create(null);
    if (!Array.isArray(rawList)) return { fields: fields, warnings: warnings };

    for (var i = 0; i < rawList.length; i++) {
      var item = rawList[i];
      if (!isPlainObject(item)) {
        warnings.push('自定义字段 #' + (i + 1) + ' 不是对象，已忽略');
        continue;
      }
      var key = typeof item.key === 'string' ? item.key.trim() : '';
      var label =
        typeof item.label === 'string'
          ? sanitizeText(item.label)
          : typeof item.label === 'number' && isFinite(item.label)
            ? String(item.label)
            : '';
      var problems = [];

      if (!key) problems.push('key 不能为空');
      else if (!CUSTOM_KEY_RE.test(key)) problems.push('key 需匹配 ' + CUSTOM_KEY_RE.source);
      else if (isBuiltinFieldKey(key)) problems.push('不能与内置字段重名');
      if (!label) problems.push('label 必填');
      else if (label.length > CUSTOM_LABEL_MAX) problems.push('label 不能超过 ' + CUSTOM_LABEL_MAX + ' 字');

      var rawValue = item.value;
      if (
        rawValue !== undefined &&
        rawValue !== null &&
        typeof rawValue !== 'string' &&
        typeof rawValue !== 'number'
      ) {
        problems.push('value 必须是字符串');
      }
      if (key && seen[key]) problems.push('key 重复');

      if (problems.length) {
        warnings.push('自定义字段「' + (label || key || '#' + (i + 1)) + '」已忽略：' + problems.join('；'));
        continue;
      }

      var value = typeof rawValue === 'number' ? String(rawValue) : typeof rawValue === 'string' ? rawValue : '';
      if (value.length > CUSTOM_VALUE_MAX) {
        value = value.slice(0, CUSTOM_VALUE_MAX);
        warnings.push('自定义字段「' + label + '」的 value 超过 ' + CUSTOM_VALUE_MAX + ' 字符，已截断');
      }
      seen[key] = true;
      fields.push({ key: key, label: label, value: value });
    }
    return { fields: fields, warnings: warnings };
  }

  /**
   * 容错迁移：把 v1 扁平结构（{name, email, ...}）或残缺结构补成当前 schema。
   * 不做类型校验，校验由 validateResume 负责。
   */
  function migrateResume(raw) {
    var out = createEmptyResume();
    if (!isPlainObject(raw)) return out;

    var basicsSrc = isPlainObject(raw.basics) ? raw.basics : {};
    // v1 兼容：顶层直接放 name/email/phone/...
    var flatAliases = {
      firstName: ['firstName', 'first_name', 'firstname'],
      lastName: ['lastName', 'last_name', 'lastname'],
      fullName: ['fullName', 'full_name', 'name'],
      email: ['email', 'mail'],
      phone: ['phone', 'mobile', 'tel'],
      city: ['city'],
      address: ['address'],
      linkedin: ['linkedin'],
      github: ['github'],
      website: ['website', 'homepage', 'portfolio']
    };

    for (var i = 0; i < BASICS_KEYS.length; i++) {
      var key = BASICS_KEYS[i];
      var aliases = flatAliases[key] || [key];
      var picked = '';
      for (var a = 0; a < aliases.length; a++) {
        var alias = aliases[a];
        if (basicsSrc[alias] !== undefined && basicsSrc[alias] !== null && basicsSrc[alias] !== '') {
          picked = basicsSrc[alias];
          break;
        }
        if (raw[alias] !== undefined && raw[alias] !== null && raw[alias] !== '') {
          picked = raw[alias];
          break;
        }
      }
      // sanitizeText 对 number 会转字符串，对其它类型返回 ''，类型错误由 validateResume 另行报错
      out.basics[key] = sanitizeText(picked);
    }

    for (var t = 0; t < TOP_KEYS.length; t++) {
      var tk = TOP_KEYS[t];
      var tv = raw[tk];
      if (typeof tv === 'string') out[tk] = sanitizeText(tv);
      else if (tv === undefined || tv === null) out[tk] = '';
      else out[tk] = tv; // 保留原始值，交给 validateResume 报错
    }

    out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
    out.customFields = migrateCustomFields(raw.customFields);
    return out;
  }

  /**
   * 校验并规整简历数据。
   * @returns {{ok: boolean, resume: object, errors: string[], warnings: string[]}}
   */
  function validateResume(raw) {
    var errors = [];
    var warnings = [];

    if (!isPlainObject(raw)) {
      return {
        ok: false,
        resume: createEmptyResume(),
        errors: ['简历数据必须是一个 JSON 对象'],
        warnings: warnings
      };
    }

    if (raw.version !== undefined && raw.version !== null) {
      if (typeof raw.version !== 'number' || !isFinite(raw.version)) {
        errors.push('version 必须是数字');
      } else if (raw.version > RESUME_VERSION) {
        warnings.push('数据版本 ' + raw.version + ' 高于当前支持的 ' + RESUME_VERSION + '，仅导入已知字段');
      }
    }

    if (raw.basics !== undefined && !isPlainObject(raw.basics)) {
      errors.push('basics 必须是对象');
    }
    if (raw.customFields !== undefined && raw.customFields !== null && !Array.isArray(raw.customFields)) {
      errors.push('customFields 必须是数组');
    }

    var resume = migrateResume(raw);
    var customs = validateCustomFields(raw.customFields);
    resume.customFields = customs.fields;
    warnings = warnings.concat(customs.warnings);

    // 类型复核：迁移过程会把非字符串压平，这里对明显错误的值补报错
    if (isPlainObject(raw.basics)) {
      for (var i = 0; i < BASICS_KEYS.length; i++) {
        var k = BASICS_KEYS[i];
        var v = raw.basics[k];
        if (v !== undefined && v !== null && typeof v !== 'string' && typeof v !== 'number') {
          errors.push('basics.' + k + ' 必须是字符串');
        }
        if (typeof v === 'string' && v.length > 2000) {
          warnings.push('basics.' + k + ' 过长（' + v.length + ' 字符）已被截断');
          resume.basics[k] = resume.basics[k].slice(0, 2000);
        }
      }
    }
    for (var t = 0; t < TOP_KEYS.length; t++) {
      var tk = TOP_KEYS[t];
      if (raw[tk] !== undefined && raw[tk] !== null && typeof raw[tk] !== 'string') {
        errors.push(tk + ' 必须是字符串');
        resume[tk] = '';
      }
    }

    return { ok: errors.length === 0, resume: resume, errors: errors, warnings: warnings };
  }

  /** 是否存在至少一个可填字段 */
  function hasAnyData(resume) {
    if (!isPlainObject(resume)) return false;
    var keys = getFieldKeys(resume);
    for (var i = 0; i < keys.length; i++) {
      if (resolveValue(resume, keys[i])) return true;
    }
    return false;
  }

  /** 取某个字段最终要填入的值（含组合/回退规则） */
  function resolveValue(resume, fieldKey) {
    if (!isPlainObject(resume)) return '';
    var basics = isPlainObject(resume.basics) ? resume.basics : {};
    var v = '';
    switch (fieldKey) {
      case 'fullName':
        v = basics.fullName;
        if (!v) {
          var joined = [sanitizeText(basics.firstName), sanitizeText(basics.lastName)]
            .filter(Boolean)
            .join(' ');
          v = joined;
        }
        break;
      case 'summary':
        v = resume.summary || resume.experience || '';
        break;
      case 'experience':
        v = resume.experience || resume.summary || '';
        break;
      default:
        // 自定义 key 只从 customFields 取值，绝不回落到 basics 的同名字段
        if (isBuiltinFieldKey(fieldKey)) {
          v = basics[fieldKey];
        } else if (Array.isArray(resume.customFields)) {
          for (var i = 0; i < resume.customFields.length; i++) {
            var field = resume.customFields[i];
            if (isPlainObject(field) && field.key === fieldKey) {
              v = field.value;
              break;
            }
          }
        }
    }
    return sanitizeText(v);
  }

  /** 序列化为可导出的 JSON 文本 */
  function exportJSON(resume) {
    var checked = validateResume(resume);
    var out = checked.resume;
    out.version = RESUME_VERSION;
    out.updatedAt = new Date().toISOString();
    return JSON.stringify(out, null, 2);
  }

  /**
   * 从 JSON 文本导入。
   * @returns {{ok: boolean, resume: object|null, errors: string[], warnings: string[]}}
   */
  function importJSON(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, resume: null, errors: ['内容为空'], warnings: [] };
    }
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, resume: null, errors: ['JSON 解析失败：' + e.message], warnings: [] };
    }
    var checked = validateResume(parsed);
    if (!checked.ok) {
      return { ok: false, resume: checked.resume, errors: checked.errors, warnings: checked.warnings };
    }
    return { ok: true, resume: checked.resume, errors: [], warnings: checked.warnings };
  }

  return {
    RESUME_VERSION: RESUME_VERSION,
    CUSTOM_KEY_MAX: CUSTOM_KEY_MAX,
    CUSTOM_LABEL_MAX: CUSTOM_LABEL_MAX,
    CUSTOM_VALUE_MAX: CUSTOM_VALUE_MAX,
    CUSTOM_KEY_RE: CUSTOM_KEY_RE,
    BASICS_KEYS: BASICS_KEYS,
    TOP_KEYS: TOP_KEYS,
    FIELD_KEYS: FIELD_KEYS,
    FIELD_LABELS: FIELD_LABELS,
    FORM_FIELDS: FORM_FIELDS,
    isPlainObject: isPlainObject,
    sanitizeText: sanitizeText,
    slugifyKey: slugifyKey,
    nextCustomKey: nextCustomKey,
    isBuiltinFieldKey: isBuiltinFieldKey,
    customFieldKeys: customFieldKeys,
    getFieldKeys: getFieldKeys,
    labelFor: labelFor,
    createEmptyResume: createEmptyResume,
    migrateResume: migrateResume,
    validateCustomFields: validateCustomFields,
    validateResume: validateResume,
    hasAnyData: hasAnyData,
    resolveValue: resolveValue,
    exportJSON: exportJSON,
    importJSON: importJSON
  };
});
