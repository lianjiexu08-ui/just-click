/**
 * JustClick — AI 简历导入的纯逻辑（迭代 4）
 *
 * 这里只做「不碰 DOM、不发网络」的部分，因此可以在 Node 里直接单测：
 *   chunkText / buildPrompt / parseJsonLoose / parseAiResume
 *   previewRows / applyAiRows / 错误分类文案
 *
 * 网络请求在 ai-client.js，存储与设置校验在 ai-settings.js，PDF 提取在 pdf-text.js。
 * 与其它 lib 一样使用 UMD 双模导出（content script 只能跑经典脚本，禁止 ESM）。
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

  /** 送给模型的简历文本上限：超过就截断（PRD 迭代 4 需求 2） */
  var AI_TEXT_LIMIT = 30000;
  var DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
  var DEFAULT_MODEL = 'deepseek-chat';

  /** 内置字段的抽取说明：让模型知道「姓 / 名分开」「薪资带单位」这类约定 */
  var FIELD_HINTS = {
    fullName: '姓名全名；中文为「姓+名」，英文为「名 姓」',
    firstName: '名（Given name），只填名，不要带姓',
    lastName: '姓（Family name / Surname），只填姓，不要带名',
    email: '邮箱地址，只保留一个',
    phone: '电话号码，尽量保留国家码',
    city: '当前所在城市',
    address: '详细地址（街道门牌），没有就省略',
    linkedin: 'LinkedIn 主页链接',
    github: 'GitHub 主页链接',
    website: '个人网站或作品集链接',
    summary: '经历摘要 / 自我评价，1-3 句，不要整段复制',
    experience: '工作经历摘要'
  };

  var CUSTOM_VALUE_MAX = 2000;

  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** 清理文本：去控制字符、折叠行内空白，保留换行（摘要类字段要用） */
  function cleanValue(value) {
    if (typeof value === 'number' && isFinite(value)) value = String(value);
    if (typeof value !== 'string') return '';
    var text = value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text;
  }

  function schemaModule() {
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
    return null;
  }

  /* ------------------------------------------------------------ 字段说明 */

  /**
   * 归一化字段清单，接受三种写法：
   *   [{key, label, hint}] / ['email', ...] / { email: '邮箱' }
   */
  function normalizeFieldSpecs(fieldSpecs) {
    var out = [];
    var seen = Object.create(null);
    function push(key, label, hint) {
      if (typeof key !== 'string' || !key || seen[key]) return;
      seen[key] = true;
      var spec = { key: key, label: label || key, hint: hint || '' };
      out.push(spec);
    }
    if (Array.isArray(fieldSpecs)) {
      for (var i = 0; i < fieldSpecs.length; i++) {
        var item = fieldSpecs[i];
        if (typeof item === 'string') push(item, item, '');
        else if (isPlainObject(item)) push(item.key, item.label, item.hint);
      }
    } else if (isPlainObject(fieldSpecs)) {
      for (var k in fieldSpecs) {
        if (hasOwn(fieldSpecs, k)) push(k, fieldSpecs[k], '');
      }
    }
    return out;
  }

  /**
   * 用当前简历生成字段清单（内置 ∪ 自定义），带「说明」。
   * options 页发起解析前调用，保证自定义字段也能被 AI 填。
   */
  function buildFieldSpecs(resume) {
    var S = schemaModule();
    if (!S || typeof S.getFieldKeys !== 'function') return [];
    var keys = S.getFieldKeys(resume);
    var specs = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var label = S.labelFor(resume, key);
      var hint = FIELD_HINTS[key] || '用户自定义字段「' + label + '」，按字面含义从简历里取';
      specs.push({ key: key, label: label, hint: hint });
    }
    return specs;
  }

  /* -------------------------------------------------------------- 截断 */

  /**
   * 把文本截到 limit 字符以内。
   * @returns {{text: string, truncated: boolean, originalLength: number, limit: number}}
   */
  function chunkText(text, limit) {
    var max = typeof limit === 'number' && isFinite(limit) && limit > 0 ? Math.floor(limit) : AI_TEXT_LIMIT;
    var raw = typeof text === 'string' ? text : '';
    if (raw.length <= max) {
      return { text: raw, truncated: false, originalLength: raw.length, limit: max };
    }
    return { text: raw.slice(0, max), truncated: true, originalLength: raw.length, limit: max };
  }

  /* -------------------------------------------------------------- 提示词 */

  /**
   * 组装抽取提示词。纯函数：同样的参数永远得到同样的字符串。
   * @param {Array|object} fieldSpecs 当前全部字段（内置 + 自定义）
   * @param {string} text 简历原文
   */
  function buildPrompt(fieldSpecs, text) {
    var specs = normalizeFieldSpecs(fieldSpecs);
    var chunk = chunkText(text, AI_TEXT_LIMIT);

    var lines = [];
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      lines.push('- ' + spec.key + '（' + spec.label + '）' + (spec.hint ? '：' + spec.hint : ''));
    }

    var system = [
      '你是求职简历信息抽取助手。',
      '任务：从用户给出的简历文本中抽取字段值，输出一个 JSON 对象。',
      '硬性要求：',
      '1. 只输出 JSON 对象本身，不要输出解释、前后缀、Markdown 代码围栏。',
      '2. JSON 的 key 必须是下面字段清单里的 key，不要自创 key，不要输出嵌套结构。',
      '3. 每个值都必须是字符串；数组用「、」连接成一段文本，不要输出 null。',
      '4. 不确定的字段直接省略，禁止编造；简历里没有的信息不要猜。',
      '5. 姓和名要分开填到 lastName / firstName，不要互相包含。'
    ].join('\n');

    var user = [
      '字段清单（key（中文名）：说明）：',
      lines.length ? lines.join('\n') : '- （当前没有可填字段）',
      '',
      '简历文本' + (chunk.truncated ? '（原文 ' + chunk.originalLength + ' 字符，已截断到前 ' + chunk.limit + ' 字符）' : '') + '：',
      '"""',
      chunk.text,
      '"""',
      '',
      '请只输出 JSON 对象。'
    ].join('\n');

    return {
      system: system,
      user: user,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      text: chunk.text,
      truncated: chunk.truncated,
      originalLength: chunk.originalLength,
      limit: chunk.limit,
      fieldKeys: specs.map(function (s) {
        return s.key;
      }),
      fieldCount: specs.length
    };
  }

  /* -------------------------------------------------------------- 解析 */

  /** 剥掉 ```json / ``` 围栏（只剥开头结尾，中间内容不动） */
  function stripFences(raw) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) return '';
    text = text.replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/, '');
    text = text.replace(/\r?\n?```[ \t]*$/, '');
    return text.trim();
  }

  /** 从任意位置起始，按括号配平截出第一个完整 JSON 对象（字符串内的括号不计数） */
  function balancedObjectAt(text, start) {
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var i = start; i < text.length; i++) {
      var ch = text.charAt(i);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return '';
  }

  /**
   * 容错解析：直接 parse → 剥围栏 → 提取首个配平 {...} 块。
   * @returns {{ok: boolean, value: object|null, error: string}}
   */
  function parseJsonLoose(raw) {
    if (isPlainObject(raw)) return { ok: true, value: raw, error: '' };
    var text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return { ok: false, value: null, error: 'AI 返回内容为空' };

    var candidates = [];
    candidates.push(text);
    var stripped = stripFences(text);
    if (stripped && stripped !== text) candidates.push(stripped);

    for (var c = 0; c < candidates.length; c++) {
      try {
        var parsed = JSON.parse(candidates[c]);
        if (isPlainObject(parsed)) return { ok: true, value: parsed, error: '' };
      } catch (e) {
        /* 继续尝试下一个候选 */
      }
    }

    // 前后有杂质：从第一个 { 开始按括号配平截取
    var start = stripped.indexOf('{');
    if (start === -1) start = text.indexOf('{');
    if (start !== -1) {
      var block = balancedObjectAt(stripped && stripped.indexOf('{') !== -1 ? stripped : text, start);
      if (block) {
        try {
          var value = JSON.parse(block);
          if (isPlainObject(value)) return { ok: true, value: value, error: '' };
        } catch (e2) {
          return { ok: false, value: null, error: 'AI 返回的 JSON 不合法：' + e2.message };
        }
      }
    }
    return { ok: false, value: null, error: 'AI 返回的内容不是合法 JSON 对象' };
  }

  /** 宽松 key：忽略大小写与分隔符（模型常把 firstName 写成 first_name / First Name） */
  function looseKey(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
  }

  /**
   * 把模型输出解析成字段数组。
   * - 支持 JSON 字符串（含围栏 / 前后杂质）或已解析的对象
   * - 未知 key 忽略（记在 ignored 里，便于 UI 提示）
   * - 数字转字符串、值 trim、空值丢弃、超长截断
   * @returns {{ok: boolean, fields: Array, ignored: Array, errors: Array}}
   */
  function parseAiResume(input, fieldSpecs) {
    var specs = normalizeFieldSpecs(fieldSpecs);
    var byKey = Object.create(null);
    var byLabel = Object.create(null);
    var byLoose = Object.create(null);
    for (var i = 0; i < specs.length; i++) {
      byKey[specs[i].key] = specs[i];
      if (specs[i].label) byLabel[specs[i].label] = specs[i];
      byLoose[looseKey(specs[i].key)] = specs[i];
    }

    var parsed = parseJsonLoose(input);
    if (!parsed.ok) {
      return { ok: false, fields: [], ignored: [], errors: [parsed.error] };
    }

    var obj = parsed.value;
    // 模型偶尔会包一层 {"fields": {...}} / {"data": {...}}：只在这层里认得出的 key 时展开
    if (isPlainObject(obj.fields) && !hasKnownKey(obj, byKey, byLoose)) obj = obj.fields;
    else if (isPlainObject(obj.data) && !hasKnownKey(obj, byKey, byLoose)) obj = obj.data;

    var fields = [];
    var ignored = [];
    var seen = Object.create(null);
    var keys = Object.keys(obj);
    for (var k = 0; k < keys.length; k++) {
      var rawKey = keys[k];
      var spec = byKey[rawKey] || byLabel[rawKey] || byLoose[looseKey(rawKey)] || null;
      if (!spec) {
        ignored.push(rawKey);
        continue;
      }
      if (seen[spec.key]) continue;
      var value = cleanValue(obj[rawKey]);
      if (!value) continue; // 空值丢弃
      if (value.length > CUSTOM_VALUE_MAX) value = value.slice(0, CUSTOM_VALUE_MAX);
      seen[spec.key] = true;
      fields.push({ key: spec.key, label: spec.label, value: value });
    }

    return { ok: true, fields: fields, ignored: ignored, errors: [] };
  }

  function hasKnownKey(obj, byKey, byLoose) {
    for (var k in obj) {
      if (!hasOwn(obj, k)) continue;
      if (byKey[k] || (byLoose && byLoose[looseKey(k)])) return true;
    }
    return false;
  }

  /* -------------------------------------------------------------- 预览 */

  /**
   * 生成预览行：AI 有值、已有值时不默认覆盖（AI 空值不覆盖已有值）。
   * @returns {Array<{key,label,value,existing,conflict,skip,overwrite,note}>}
   */
  function previewRows(aiFields, resume, fieldSpecs) {
    var S = schemaModule();
    var specs = normalizeFieldSpecs(fieldSpecs);
    var labels = Object.create(null);
    for (var i = 0; i < specs.length; i++) labels[specs[i].key] = specs[i].label;

    var rows = [];
    var list = Array.isArray(aiFields) ? aiFields : [];
    for (var j = 0; j < list.length; j++) {
      var field = list[j];
      if (!isPlainObject(field) || typeof field.key !== 'string' || !field.key) continue;
      var value = cleanValue(field.value);
      if (!value) continue;
      var existing = S && typeof S.resolveValue === 'function' ? S.resolveValue(resume, field.key) : '';
      var label = field.label || labels[field.key] || (S && S.labelFor ? S.labelFor(resume, field.key) : field.key);
      rows.push({
        key: field.key,
        label: label,
        value: value,
        existing: existing,
        conflict: !!existing,
        skip: false,
        overwrite: false,
        source: 'ai',
        note: existing ? '已有值，勾选「覆盖」才会替换' : '新增'
      });
    }
    return rows;
  }

  /* -------------------------------------------------------------- 写入 */

  function cloneResume(resume) {
    try {
      return JSON.parse(JSON.stringify(resume));
    } catch (e) {
      return null;
    }
  }

  function setRowValue(target, row) {
    var S = schemaModule();
    var key = row.key;
    var value = cleanValue(row.value);
    if (!value) return { ok: false, reason: '空值' };
    var builtin = S && typeof S.isBuiltinFieldKey === 'function' ? S.isBuiltinFieldKey(key) : false;

    if (key === 'summary' || key === 'experience') {
      target.summary = value;
      target.experience = value;
      return { ok: true };
    }
    if (key === 'fullName') {
      target.basics.fullName = value;
      // AI 写进来的全名视为「用户确认过的全名」，不再被「姓+名」自动拼接覆盖
      target.fullNameManual = true;
      return { ok: true };
    }
    if (builtin) {
      target.basics[key] = value;
      return { ok: true };
    }

    // 自定义字段：有则覆盖，无则创建（分组落到 extra，与模板第三组一致）
    if (!Array.isArray(target.customFields)) target.customFields = [];
    for (var i = 0; i < target.customFields.length; i++) {
      if (target.customFields[i] && target.customFields[i].key === key) {
        target.customFields[i].value = value;
        if (!target.customFields[i].label && row.label) target.customFields[i].label = row.label;
        return { ok: true };
      }
    }
    var keyOk = S && S.CUSTOM_KEY_RE ? S.CUSTOM_KEY_RE.test(key) : /^[a-z][a-z0-9_]{0,39}$/.test(key);
    if (!keyOk) return { ok: false, reason: '自定义 key 不合法：' + key };
    var label = cleanValue(row.label) || key;
    if (label.length > 40) label = label.slice(0, 40);
    var entry = { key: key, label: label, value: value, group: 'extra' };
    // 保持模板顺序：内置在前，自定义按创建顺序追加
    target.customFields.push(entry);
    return { ok: true };
  }

  /**
   * 把预览行写进简历。只有显式调用（用户点「确认写入」）才会走到这里。
   * 规则：skip 跳过；空值不写；已有值且未勾选覆盖 → 保留原值。
   * @returns {{ok: boolean, resume: object, applied: Array, kept: Array, skipped: Array, errors: Array}}
   */
  function applyAiRows(resume, rows, options) {
    var S = schemaModule();
    var opts = isPlainObject(options) ? options : {};
    var result = { ok: false, resume: resume, applied: [], kept: [], skipped: [], errors: [] };

    if (!S || typeof S.validateResume !== 'function') {
      result.errors.push('简历 schema 未加载');
      return result;
    }
    var target = cloneResume(resume);
    if (!isPlainObject(target)) {
      result.errors.push('当前简历数据不可用，请先在模板里保存一次');
      return result;
    }
    if (!Array.isArray(target.customFields)) target.customFields = [];

    var list = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!isPlainObject(row) || typeof row.key !== 'string' || !row.key) continue;
      if (row.skip === true) {
        result.skipped.push({ key: row.key, reason: '已跳过' });
        continue;
      }
      var value = cleanValue(row.value);
      if (!value) {
        result.skipped.push({ key: row.key, reason: '值为空' });
        continue;
      }
      var existing = S.resolveValue(target, row.key);
      if (existing && row.overwrite !== true) {
        result.kept.push({ key: row.key, existing: existing });
        continue;
      }
      var written = setRowValue(target, { key: row.key, label: row.label, value: value });
      if (!written.ok) {
        result.skipped.push({ key: row.key, reason: written.reason || '写入失败' });
        continue;
      }
      result.applied.push({ key: row.key, label: row.label || row.key, value: value, overwritten: !!existing });
    }

    // 姓/名有了但全名为空：不写死 fullName，交给 resume-schema 的 resolveValue 自动拼接
    var checked = S.validateResume(target);
    if (!checked.ok) {
      result.errors = checked.errors;
      result.errors.push('AI 结果未能通过简历校验，未写入任何内容');
      return result;
    }
    result.ok = true;
    result.resume = checked.resume;
    result.warnings = checked.warnings || [];
    if (opts.markUpdated !== false) {
      result.resume.updatedAt = new Date().toISOString();
    }
    return result;
  }

  /* ---------------------------------------------------------- 错误分类 */

  var ERROR_TEXT = {
    config: '还没有配置好 AI 接口',
    network: '网络请求失败：检查网络、代理，或接口地址是否可访问',
    auth: 'API Key 无效或没有权限（401/403）',
    not_found: '接口路径或模型不存在（404），检查 baseURL 是否带 /v1、模型名是否拼对',
    rate_limit: '请求过于频繁（429），稍后再试',
    bad_request: '请求被接口拒绝（400/422），多半是模型不支持当前参数',
    bad_json: '接口返回的不是 JSON，或没有返回内容',
    server: '接口服务端错误（5xx），稍后再试',
    timeout: '请求超时',
    empty: '没有抽取到任何字段'
  };

  function statusToKind(status) {
    var code = typeof status === 'number' ? status : 0;
    if (code === 401 || code === 403) return 'auth';
    if (code === 404) return 'not_found';
    if (code === 429) return 'rate_limit';
    if (code === 400 || code === 422) return 'bad_request';
    if (code >= 500) return 'server';
    if (code === 0) return 'network';
    return 'bad_request';
  }

  /**
   * 统一错误对象：{kind, status, message, retryable}
   * retryable 只描述「换一种请求参数再试一次有没有意义」，不是自动重试策略。
   */
  function classifyError(input) {
    if (typeof input === 'number') input = { status: input };
    var info = isPlainObject(input) ? input : {};
    var kind = info.kind || statusToKind(info.status);
    var base = ERROR_TEXT[kind] || '请求失败';
    var detail = cleanValue(info.message || info.detail || '');
    if (detail) detail = detail.replace(/\s+/g, ' ').slice(0, 160);
    var status = typeof info.status === 'number' ? info.status : 0;
    return {
      kind: kind,
      status: status,
      message: base + (detail ? '：' + detail : ''),
      detail: detail,
      retryable: kind === 'bad_request' || kind === 'server' || kind === 'bad_json'
    };
  }

  /**
   * 是否值得「去掉 response_format 再试一次」。
   * 401/403（key 错）、429（限流）、404（路径错）、网络失败都不重试：
   * 这些换参数也没用，重试只会放大问题。
   */
  function shouldRetryWithoutFormat(error) {
    if (!error) return false;
    var kind = error.kind || statusToKind(error.status);
    return kind === 'bad_request' || kind === 'server' || kind === 'bad_json';
  }

  /** 给 UI 的一行错误提示（不含任何 key / 简历正文） */
  function describeError(error) {
    var info = classifyError(error);
    return info.message;
  }

  return {
    AI_TEXT_LIMIT: AI_TEXT_LIMIT,
    DEFAULT_BASE_URL: DEFAULT_BASE_URL,
    DEFAULT_MODEL: DEFAULT_MODEL,
    FIELD_HINTS: FIELD_HINTS,
    CUSTOM_VALUE_MAX: CUSTOM_VALUE_MAX,
    ERROR_TEXT: ERROR_TEXT,
    isPlainObject: isPlainObject,
    cleanValue: cleanValue,
    normalizeFieldSpecs: normalizeFieldSpecs,
    buildFieldSpecs: buildFieldSpecs,
    chunkText: chunkText,
    buildPrompt: buildPrompt,
    stripFences: stripFences,
    parseJsonLoose: parseJsonLoose,
    parseAiResume: parseAiResume,
    previewRows: previewRows,
    applyAiRows: applyAiRows,
    statusToKind: statusToKind,
    classifyError: classifyError,
    shouldRetryWithoutFormat: shouldRetryWithoutFormat,
    describeError: describeError
  };
});
