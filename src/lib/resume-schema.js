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

  function createEmptyResume() {
    var basics = {};
    for (var i = 0; i < BASICS_KEYS.length; i++) basics[BASICS_KEYS[i]] = '';
    var resume = { version: RESUME_VERSION, basics: basics, updatedAt: null };
    for (var j = 0; j < TOP_KEYS.length; j++) resume[TOP_KEYS[j]] = '';
    return resume;
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

    var resume = migrateResume(raw);

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
    for (var i = 0; i < FIELD_KEYS.length; i++) {
      if (resolveValue(resume, FIELD_KEYS[i])) return true;
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
        v = basics[fieldKey];
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
    BASICS_KEYS: BASICS_KEYS,
    TOP_KEYS: TOP_KEYS,
    FIELD_KEYS: FIELD_KEYS,
    FIELD_LABELS: FIELD_LABELS,
    FORM_FIELDS: FORM_FIELDS,
    isPlainObject: isPlainObject,
    sanitizeText: sanitizeText,
    createEmptyResume: createEmptyResume,
    migrateResume: migrateResume,
    validateResume: validateResume,
    hasAnyData: hasAnyData,
    resolveValue: resolveValue,
    exportJSON: exportJSON,
    importJSON: importJSON
  };
});
