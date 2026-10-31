/**
 * JustClick — 字段识别引擎
 *
 * 输入是与 DOM 解耦的「字段描述符」(descriptor)，因此可以在 Node 里用 node:test 直接单测。
 * content script 负责把真实 DOM 节点抽成描述符，本文件只做纯函数打分。
 *
 * 打分模型：
 *   每个字段来源(label / aria-label / placeholder / name / id / ...) 有一个属性权重，
 *   词库里每个 token 有一个语义权重，score = 属性权重 × 语义权重；
 *   同一个 key 取所有来源里的最高分，最终 confidence = score / 3（3 为理论上限）。
 *   ATS 精确选择器命中时直接给满分（1.0），因为那是「已知结构」而不是猜测。
 *
 * UMD 双模导出，禁止 ES module 语法（MV3 content script 不能直接 import）。
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

  var MAX_SCORE = 3;
  var MIN_CONFIDENCE = 0.5;

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

  /** 平局时的优先顺序：越具体的字段越靠前 */
  var KEY_PRIORITY = [
    'firstName',
    'lastName',
    'email',
    'phone',
    'linkedin',
    'github',
    'website',
    'address',
    'city',
    'summary',
    'fullName'
  ];

  /** 字段来源属性权重 */
  var ATTR_WEIGHTS = {
    label: 3.0,
    ariaLabel: 2.6,
    placeholder: 2.4,
    nearby: 2.0,
    title: 1.6,
    name: 1.8,
    id: 1.6,
    dataAutomationId: 2.2,
    className: 1.0
  };

  /**
   * 中英文词库。w: 1.0 强特征 / 0.7 中 / 0.45 弱（避免 "name" 这种泛词抢分）。
   * token 必须是 normalizeText 归一化后的形态（小写、去空格和标点）。
   */
  var DICTIONARY = {
    email: [
      { t: 'email', w: 1.0 },
      { t: 'mail', w: 0.6 },
      { t: '邮箱', w: 1.0 },
      { t: '电子邮件', w: 1.0 },
      { t: '邮件', w: 0.8 },
      { t: '电子信箱', w: 0.9 }
    ],
    phone: [
      { t: 'phone', w: 1.0 },
      { t: 'telephone', w: 0.95 },
      { t: 'mobile', w: 1.0 },
      { t: 'cellphone', w: 0.9 },
      { t: 'tel', w: 0.7 },
      { t: '电话', w: 1.0 },
      { t: '手机', w: 1.0 },
      { t: '联系电话', w: 1.0 },
      { t: '联系方式', w: 0.7 }
    ],
    firstName: [
      { t: 'firstname', w: 1.0 },
      { t: 'givenname', w: 1.0 },
      { t: 'forename', w: 1.0 },
      { t: 'first', w: 0.5 },
      { t: '名', w: 0.8 }
    ],
    lastName: [
      { t: 'lastname', w: 1.0 },
      { t: 'familyname', w: 1.0 },
      { t: 'surname', w: 1.0 },
      { t: '姓氏', w: 1.0 },
      { t: 'last', w: 0.5 },
      { t: '姓', w: 0.8 }
    ],
    fullName: [
      { t: 'fullname', w: 1.0 },
      { t: 'legalname', w: 0.95 },
      { t: 'candidatename', w: 0.95 },
      { t: 'yourname', w: 0.95 },
      { t: '真实姓名', w: 1.0 },
      { t: '姓名', w: 1.0 },
      { t: '名字', w: 0.9 },
      { t: '中文名', w: 0.9 },
      { t: 'name', w: 0.7 },
      { t: '联系人', w: 0.45 }
    ],
    city: [
      { t: 'city', w: 1.0 },
      { t: 'town', w: 0.6 },
      { t: '城市', w: 1.0 },
      { t: '所在城市', w: 1.0 },
      { t: '现居城市', w: 1.0 }
    ],
    address: [
      { t: 'address', w: 1.0 },
      { t: 'addressline1', w: 1.0 },
      { t: 'street', w: 1.0 },
      { t: 'streetaddress', w: 1.0 },
      { t: '地址', w: 1.0 },
      { t: '详细地址', w: 1.0 },
      { t: '通讯地址', w: 1.0 },
      { t: '住址', w: 1.0 },
      { t: '街道', w: 0.9 }
    ],
    linkedin: [
      { t: 'linkedin', w: 1.0 },
      { t: '领英', w: 1.0 }
    ],
    github: [
      { t: 'github', w: 1.0 },
      { t: 'gitee', w: 0.8 },
      { t: '码云', w: 0.7 }
    ],
    website: [
      { t: 'website', w: 1.0 },
      { t: 'personalwebsite', w: 1.0 },
      { t: 'homepage', w: 0.9 },
      { t: 'portfolio', w: 0.9 },
      { t: 'blog', w: 0.7 },
      { t: '个人网站', w: 1.0 },
      { t: '个人主页', w: 1.0 },
      { t: '作品集', w: 1.0 },
      { t: '博客', w: 0.8 }
    ],
    summary: [
      { t: 'summary', w: 0.9 },
      { t: 'bio', w: 0.9 },
      { t: 'aboutyou', w: 0.9 },
      { t: 'aboutme', w: 0.9 },
      { t: 'selfintroduction', w: 1.0 },
      { t: '自我介绍', w: 1.0 },
      { t: '个人简介', w: 1.0 },
      { t: '简介', w: 0.8 },
      { t: '工作经历', w: 1.0 },
      { t: '经历', w: 0.8 }
    ]
  };

  /**
   * 负向词：某个来源文本里出现这些片段时，该来源对对应 key 直接作废。
   * 用来避免 "Company Name" 被判成姓名、"Email Address" 被判成地址这类错误。
   */
  var REJECTS = {
    fullName: ['company', 'school', 'university', 'college', 'username', 'nickname', 'login', '公司', '学校', '大学', '用户名', '昵称', '登录'],
    firstName: ['姓', 'company', 'school', '公司', '学校'],
    lastName: ['姓名', '名字', 'company', 'school', '公司', '学校'],
    email: ['company', '公司', '学校'],
    phone: ['countrycode', '区号', '国家码'],
    address: ['email', '邮箱', 'billing', 'zip', 'zipcode', 'postal', 'postcode', '邮编'],
    city: [],
    linkedin: [],
    github: [],
    website: [],
    summary: ['jobtitle', 'position', '职位']
  };

  /** 整段直接跳过的字段（这些不是我们要填的东西） */
  var GLOBAL_REJECTS = [
    'password',
    'passwd',
    'passcode',
    '密码',
    'captcha',
    '验证码',
    'securitycode',
    'search',
    '搜索',
    'creditcard',
    '信用卡',
    'cvv',
    'coupon',
    '优惠券',
    'referralcode'
  ];

  /**
   * ATS 适配表：已知结构的精确匹配，命中即 confidence = 1。
   * attr 支持 id / name / dataAutomationId。
   */
  var ATS_RULES = [
    // ---- Greenhouse ----
    { ats: 'greenhouse', attr: 'id', pattern: 'first_name', key: 'firstName', exact: true },
    { ats: 'greenhouse', attr: 'id', pattern: 'last_name', key: 'lastName', exact: true },
    { ats: 'greenhouse', attr: 'id', pattern: 'email', key: 'email', exact: true },
    { ats: 'greenhouse', attr: 'id', pattern: 'phone', key: 'phone', exact: true },
    { ats: 'greenhouse', attr: 'name', pattern: 'job_application[first_name]', key: 'firstName' },
    { ats: 'greenhouse', attr: 'name', pattern: 'job_application[last_name]', key: 'lastName' },
    { ats: 'greenhouse', attr: 'name', pattern: 'job_application[email]', key: 'email' },
    { ats: 'greenhouse', attr: 'name', pattern: 'job_application[phone]', key: 'phone' },
    { ats: 'greenhouse', attr: 'name', pattern: 'job_application[location]', key: 'city' },

    // ---- Lever ----
    // Lever 的 name 属性就是这些裸词，必须精确匹配，否则 user_name / company_name 会误判
    { ats: 'lever', attr: 'name', pattern: 'name', key: 'fullName', exact: true },
    { ats: 'lever', attr: 'name', pattern: 'email', key: 'email', exact: true },
    { ats: 'lever', attr: 'name', pattern: 'phone', key: 'phone', exact: true },
    { ats: 'lever', attr: 'name', pattern: 'location', key: 'city', exact: true },
    { ats: 'lever', attr: 'name', pattern: 'urls[linkedin]', key: 'linkedin', exact: true },
    { ats: 'lever', attr: 'name', pattern: 'urls[github]', key: 'github', exact: true },
    { ats: 'lever', attr: 'name', pattern: 'urls[portfolio]', key: 'website', exact: true },

    // ---- Workday ----
    { ats: 'workday', attr: 'dataAutomationId', pattern: 'legalnamesection_firstname', key: 'firstName' },
    { ats: 'workday', attr: 'dataAutomationId', pattern: 'legalnamesection_lastname', key: 'lastName' },
    { ats: 'workday', attr: 'dataAutomationId', pattern: 'email', key: 'email', exact: true },
    { ats: 'workday', attr: 'dataAutomationId', pattern: 'phone-number', key: 'phone', exact: true },
    { ats: 'workday', attr: 'dataAutomationId', pattern: 'addresssection_addressline1', key: 'address' },
    { ats: 'workday', attr: 'dataAutomationId', pattern: 'addresssection_city', key: 'city' },
    { ats: 'workday', attr: 'dataAutomationId', pattern: 'linkedin', key: 'linkedin', exact: true },
    { ats: 'workday', attr: 'dataAutomationId', pattern: 'website', key: 'website', exact: true }
  ];

  /** 归一化：小写、去掉空白与标点、保留中日韩字符与数字 */
  function normalizeText(value) {
    if (typeof value !== 'string') return '';
    return value
      .toLowerCase()
      .replace(/[\s\u00a0]+/g, '')
      .replace(/[^0-9a-z\u4e00-\u9fff\u3040-\u30ff]/g, '');
  }

  // ATS 规则里的 pattern 写的是「人看的形态」（job_application[email]、urls[LinkedIn]），
  // 这里预归一化一份，匹配时与归一化后的属性值比较。normalizeText 是函数声明，已提升。
  for (var ruleIndex = 0; ruleIndex < ATS_RULES.length; ruleIndex++) {
    ATS_RULES[ruleIndex].normPattern = normalizeText(ATS_RULES[ruleIndex].pattern);
  }

  /** 把 descriptor 里所有可用文本来源抽成 [{attr, text, norm}] */
  function collectSources(desc) {
    if (!desc || typeof desc !== 'object') return [];
    var out = [];
    var ATTR_MAP = [
      ['label', desc.labelText],
      ['ariaLabel', desc.ariaLabel],
      ['placeholder', desc.placeholder],
      ['nearby', desc.nearbyText],
      ['title', desc.title],
      ['name', desc.name],
      ['id', desc.id],
      ['dataAutomationId', desc.dataAutomationId],
      ['className', desc.className]
    ];
    for (var i = 0; i < ATTR_MAP.length; i++) {
      var attr = ATTR_MAP[i][0];
      var raw = ATTR_MAP[i][1];
      if (typeof raw !== 'string' || !raw) continue;
      var norm = normalizeText(raw);
      if (!norm) continue;
      out.push({ attr: attr, text: raw, norm: norm });
    }
    return out;
  }

  function containsAny(norm, tokens) {
    for (var i = 0; i < tokens.length; i++) {
      if (norm.indexOf(tokens[i]) !== -1) return true;
    }
    return false;
  }

  /** 该字段是否应该被整体跳过（密码、验证码、搜索框……） */
  function isExcludedDescriptor(desc) {
    if (!desc || typeof desc !== 'object') return true;
    if (desc.fillable === false) return true;
    var haystack = [desc.labelText, desc.ariaLabel, desc.placeholder, desc.name, desc.id, desc.className]
      .filter(function (v) { return typeof v === 'string' && v; })
      .map(normalizeText)
      .join('|');
    if (!haystack) return false;
    return containsAny(haystack, GLOBAL_REJECTS);
  }

  /** 命中 ATS 精确规则时返回 key，否则 null */
  function matchAts(desc) {
    if (!desc) return null;
    var attrValue = {
      id: normalizeText(desc.id || ''),
      name: normalizeText(desc.name || ''),
      dataAutomationId: normalizeText(desc.dataAutomationId || '')
    };
    for (var i = 0; i < ATS_RULES.length; i++) {
      var rule = ATS_RULES[i];
      var value = attrValue[rule.attr];
      if (!value) continue;
      var hit = rule.exact ? value === rule.normPattern : value.indexOf(rule.normPattern) !== -1;
      if (hit) {
        return { key: rule.key, ats: rule.ats, pattern: rule.pattern, attr: rule.attr };
      }
    }
    return null;
  }

  /**
   * 识别单个字段。
   * @returns {{key:string, confidence:number, score:number, attr:string, token:string, ats:string|null}|null}
   */
  function detectFieldType(desc) {
    if (!desc || isExcludedDescriptor(desc)) return null;

    var ats = matchAts(desc);
    if (ats) {
      return {
        key: ats.key,
        confidence: 1,
        score: MAX_SCORE,
        attr: ats.attr,
        token: ats.pattern,
        ats: ats.ats
      };
    }

    var sources = collectSources(desc);
    if (!sources.length) return null;

    var best = null;
    for (var s = 0; s < sources.length; s++) {
      var src = sources[s];
      var attrWeight = ATTR_WEIGHTS[src.attr] || 1;
      for (var k = 0; k < FIELD_KEYS.length; k++) {
        var key = FIELD_KEYS[k];
        var rejects = REJECTS[key] || [];
        if (rejects.length && containsAny(src.norm, rejects)) continue;
        var tokens = DICTIONARY[key] || [];
        for (var t = 0; t < tokens.length; t++) {
          var token = tokens[t];
          if (src.norm.indexOf(token.t) === -1) continue;
          var score = attrWeight * token.w;
          var candidate = {
            key: key,
            score: score,
            confidence: Math.min(1, score / MAX_SCORE),
            attr: src.attr,
            token: token.t,
            tokenLength: token.t.length,
            ats: null
          };
          if (isBetter(candidate, best)) best = candidate;
        }
      }
    }
    if (!best) return null;
    delete best.tokenLength;
    return best;
  }

  function priorityIndex(key) {
    var i = KEY_PRIORITY.indexOf(key);
    return i === -1 ? KEY_PRIORITY.length : i;
  }

  /** 排序规则：分数高 > token 更长（更具体）> key 优先级靠前 */
  function isBetter(a, b) {
    if (!b) return true;
    if (a.score !== b.score) return a.score > b.score;
    if (a.tokenLength !== b.tokenLength) return a.tokenLength > b.tokenLength;
    return priorityIndex(a.key) < priorityIndex(b.key);
  }

  /**
   * 批量识别表单。
   * @param {Array} descriptors
   * @returns {Array<{index:number,key:string,confidence:number,ats:string|null}>} 置信度不足的字段不会出现
   */
  function matchForm(descriptors, options) {
    var opts = options || {};
    var minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : MIN_CONFIDENCE;
    var list = Array.isArray(descriptors) ? descriptors : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var hit = detectFieldType(list[i]);
      if (!hit) continue;
      if (hit.confidence < minConfidence) continue;
      out.push({
        index: i,
        key: hit.key,
        confidence: hit.confidence,
        ats: hit.ats,
        attr: hit.attr
      });
    }
    return out;
  }

  /**
   * 生成填充计划：识别 + 取值 + 缺失统计。
   * @param {Array} descriptors
   * @param {Object} valueMap 形如 {email: 'a@b.c'}，值为空字符串表示简历里没写
   * @returns {{assignments:Array, missing:Array, notFound:Array}}
   */
  function buildFillPlan(descriptors, valueMap, options) {
    var values = valueMap || {};
    var matches = matchForm(descriptors, options);
    var assignments = [];
    var filledKeys = {};
    var missingMap = {};
    var seenIndex = {};

    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      if (seenIndex[m.index]) continue;
      var value = typeof values[m.key] === 'string' ? values[m.key].trim() : '';
      var label = FIELD_LABELS[m.key] || m.key;
      if (!value) {
        // 页面上认出了字段，但简历里没写 -> 记为「缺数据」
        if (!missingMap[m.key]) missingMap[m.key] = { key: m.key, label: label, reason: 'no-value' };
        continue;
      }
      seenIndex[m.index] = true;
      filledKeys[m.key] = true;
      assignments.push({
        index: m.index,
        key: m.key,
        label: label,
        value: value,
        confidence: m.confidence,
        ats: m.ats || null
      });
    }

    var missing = [];
    for (var k in missingMap) {
      if (Object.prototype.hasOwnProperty.call(missingMap, k) && !filledKeys[k]) {
        missing.push(missingMap[k]);
      }
    }

    var notFound = [];
    for (var j = 0; j < FIELD_KEYS.length; j++) {
      var key = FIELD_KEYS[j];
      var v = typeof values[key] === 'string' ? values[key].trim() : '';
      if (v && !filledKeys[key]) {
        notFound.push({ key: key, label: FIELD_LABELS[key] || key });
      }
    }

    return { assignments: assignments, missing: missing, notFound: notFound };
  }

  return {
    MAX_SCORE: MAX_SCORE,
    MIN_CONFIDENCE: MIN_CONFIDENCE,
    FIELD_KEYS: FIELD_KEYS,
    FIELD_LABELS: FIELD_LABELS,
    KEY_PRIORITY: KEY_PRIORITY,
    ATTR_WEIGHTS: ATTR_WEIGHTS,
    DICTIONARY: DICTIONARY,
    REJECTS: REJECTS,
    GLOBAL_REJECTS: GLOBAL_REJECTS,
    ATS_RULES: ATS_RULES,
    normalizeText: normalizeText,
    collectSources: collectSources,
    isExcludedDescriptor: isExcludedDescriptor,
    matchAts: matchAts,
    detectFieldType: detectFieldType,
    matchForm: matchForm,
    buildFillPlan: buildFillPlan
  };
});
