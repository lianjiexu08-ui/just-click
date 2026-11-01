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

  /**
   * 合并内置 key 与用户自定义 key：内置 11 个固定在前，自定义按用户顺序，
   * 重复项去掉。UI 下拉、notFound 统计都以此为准。
   */
  function resolveFieldKeys(customKeys) {
    var out = FIELD_KEYS.slice();
    if (!Array.isArray(customKeys)) return out;
    for (var i = 0; i < customKeys.length; i++) {
      var key = customKeys[i];
      if (typeof key !== 'string') continue;
      var trimmed = key.trim();
      if (!trimmed) continue;
      if (out.indexOf(trimmed) === -1) out.push(trimmed);
    }
    return out;
  }

  /** 规则引擎按需取：浏览器里走 globalThis.JC，Node 里回落到 require */
  function rulesApi() {
    if (typeof globalThis !== 'undefined' && globalThis.JC && typeof globalThis.JC.matchUserRules === 'function') {
      return globalThis.JC;
    }
    if (typeof require === 'function') {
      try {
        return require('./rules.js');
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

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
    ],

    // ---- 迭代 5：中国求职站点的六组预置字段 ----
    // 直接进 DICTIONARY，不再受 options.fieldKeys 门禁限制：中文 label 只要出现
    // 这些词就能命中。反硬编码红线靠「表里只有这六个 key」守住 —— 用户自建的
    // 任意 key（如 wechat）不在表里，任何情况下都不会被字典命中，只能靠用户规则。
    expected_salary: [
      { t: '期望薪资', w: 2.6 },
      { t: '期望月薪', w: 2.6 },
      { t: '薪资', w: 2.4 },
      { t: '薪酬', w: 2.4 },
      { t: '月薪', w: 2.4 },
      { t: '年薪', w: 2.2 },
      { t: '待遇', w: 1.8 },
      { t: 'expectedsalary', w: 2.2 }
    ],
    available_date: [
      { t: '到岗时间', w: 2.6 },
      { t: '入职时间', w: 2.6 },
      { t: '上岗时间', w: 2.6 },
      { t: '到岗', w: 2.4 },
      { t: '可到岗', w: 2.4 },
      { t: '上岗', w: 2.2 },
      { t: 'availabledate', w: 2.2 },
      { t: 'noticeperiod', w: 1.8 }
    ],
    education: [
      { t: '最高学历', w: 2.6 },
      { t: '学历', w: 2.4 },
      { t: '教育程度', w: 2.4 },
      { t: '学位', w: 2.2 },
      { t: 'education', w: 2.2 },
      { t: 'degree', w: 2.2 }
    ],
    school: [
      { t: '毕业院校', w: 2.6 },
      { t: '毕业学校', w: 2.6 },
      { t: '学校', w: 2.2 },
      { t: '院校', w: 2.2 },
      { t: 'school', w: 2.2 }
    ],
    major: [
      { t: '所学专业', w: 2.6 },
      { t: '专业方向', w: 2.4 },
      { t: '专业', w: 2.2 },
      { t: '方向', w: 1.6 },
      { t: 'major', w: 2.2 }
    ],
    experience_years: [
      { t: '工作年限', w: 2.6 },
      { t: '工作经验', w: 2.4 },
      { t: '从业年限', w: 2.4 },
      { t: '年经验', w: 2.2 },
      { t: '工龄', w: 2.2 },
      { t: 'experienceyears', w: 2.2 },
      { t: 'workyears', w: 2.2 }
    ]
  };

  /**
   * 兼容导出：迭代 5 早期版本把六组中文词条放在独立的 PRESET_DICTIONARY，
   * 外部代码可能还在引用。现在它们已经是 DICTIONARY 的一部分，这里保留同名
   * 视图并指向**同一数组引用**，避免两份词库漂移。
   */
  var PRESET_KEYS = ['expected_salary', 'available_date', 'education', 'school', 'major', 'experience_years'];
  var PRESET_DICTIONARY = {};
  for (var presetIndex = 0; presetIndex < PRESET_KEYS.length; presetIndex++) {
    PRESET_DICTIONARY[PRESET_KEYS[presetIndex]] = DICTIONARY[PRESET_KEYS[presetIndex]];
  }

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
    summary: ['jobtitle', 'position', '职位'],
    // 迭代 5：预置字段的负向词，避免「当前薪资」被当成期望薪资、「技能」被当成专业
    expected_salary: ['现有', '当前', 'current', 'present'],
    available_date: [],
    education: ['学校', '院校', '专业'],
    school: ['学历', '专业'],
    major: ['技能', '项目', '公司'],
    experience_years: []
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
   * attr 支持 id / name / dataAutomationId / placeholder / ariaLabel / containerClass。
   *
   * 迭代 5：中国五站规则与通用 ATS 规则**在同一个数组里**，中国站点排在前部，
   * 保证优先于 Greenhouse / Lever / Workday。站点规则带 sites 字段做 host 隔离，
   * 只有当前 url 命中对应域名才可生效；没有 sites 的规则不受 host 限制。
   *
   * 注意：以下中国站点规则来自公开 DOM 结构的推断，**未在真实登录态回归**，
   * 真实站点改版后需要按实际 DOM 校正 pattern。
   */
  var ATS_RULES = [
    // ---- Boss 直聘（快速投递弹窗 .dialog-wrap）----
    { ats: 'zhipin', sites: ['zhipin.com'], attr: 'name', pattern: 'geekName', key: 'fullName', exact: true },
    { ats: 'zhipin', sites: ['zhipin.com'], attr: 'name', pattern: 'geekMobile', key: 'phone', exact: true },
    { ats: 'zhipin', sites: ['zhipin.com'], attr: 'name', pattern: 'mobile', key: 'phone', exact: true },
    { ats: 'zhipin', sites: ['zhipin.com'], attr: 'name', pattern: 'phone', key: 'phone', exact: true },
    { ats: 'zhipin', sites: ['zhipin.com'], attr: 'name', pattern: 'name', key: 'fullName', exact: true },
    { ats: 'zhipin', sites: ['zhipin.com'], attr: 'name', pattern: 'email', key: 'email', exact: true },
    { ats: 'zhipin', sites: ['zhipin.com'], attr: 'placeholder', pattern: '请输入姓名', key: 'fullName', exact: true },
    { ats: 'zhipin', sites: ['zhipin.com'], attr: 'placeholder', pattern: '请输入手机号', key: 'phone', exact: true },

    // ---- 智联招聘 ----
    { ats: 'zhaopin', sites: ['zhaopin.com'], attr: 'name', pattern: 'userName', key: 'fullName', exact: true },
    { ats: 'zhaopin', sites: ['zhaopin.com'], attr: 'id', pattern: 'resumeName', key: 'fullName', exact: true },
    { ats: 'zhaopin', sites: ['zhaopin.com'], attr: 'name', pattern: 'realName', key: 'fullName', exact: true },
    { ats: 'zhaopin', sites: ['zhaopin.com'], attr: 'name', pattern: 'mobile', key: 'phone', exact: true },
    { ats: 'zhaopin', sites: ['zhaopin.com'], attr: 'name', pattern: 'phone', key: 'phone', exact: true },
    { ats: 'zhaopin', sites: ['zhaopin.com'], attr: 'name', pattern: 'email', key: 'email', exact: true },
    { ats: 'zhaopin', sites: ['zhaopin.com'], attr: 'id', pattern: 'email', key: 'email', exact: true },

    // ---- 前程无忧 51job ----
    { ats: '51job', sites: ['51job.com'], attr: 'id', pattern: 'inputRealName', key: 'fullName', exact: true },
    { ats: '51job', sites: ['51job.com'], attr: 'name', pattern: 'userName', key: 'fullName', exact: true },
    { ats: '51job', sites: ['51job.com'], attr: 'name', pattern: 'mobilePhone', key: 'phone', exact: true },
    { ats: '51job', sites: ['51job.com'], attr: 'id', pattern: 'mobile', key: 'phone', exact: true },
    { ats: '51job', sites: ['51job.com'], attr: 'name', pattern: 'mobile', key: 'phone', exact: true },
    { ats: '51job', sites: ['51job.com'], attr: 'name', pattern: 'email', key: 'email', exact: true },

    // ---- 拉勾 ----
    { ats: 'lagou', sites: ['lagou.com'], attr: 'name', pattern: 'userName', key: 'fullName', exact: true },
    { ats: 'lagou', sites: ['lagou.com'], attr: 'name', pattern: 'phone', key: 'phone', exact: true },
    { ats: 'lagou', sites: ['lagou.com'], attr: 'name', pattern: 'mobile', key: 'phone', exact: true },
    {
      ats: 'lagou',
      sites: ['lagou.com'],
      attr: 'placeholder',
      pattern: '请输入手机号',
      key: 'phone',
      exact: true
    },
    { ats: 'lagou', sites: ['lagou.com'], attr: 'name', pattern: 'email', key: 'email', exact: true },

    // ---- 猎聘 ----
    // 注意：猎聘用 id=name 表示真实姓名，Lever 用裸 name 表示姓名，两者靠 sites 隔离 + 通用规则在后
    { ats: 'liepin', sites: ['liepin.com'], attr: 'name', pattern: 'realName', key: 'fullName', exact: true },
    { ats: 'liepin', sites: ['liepin.com'], attr: 'id', pattern: 'name', key: 'fullName', exact: true },
    { ats: 'liepin', sites: ['liepin.com'], attr: 'name', pattern: 'mobile', key: 'phone', exact: true },
    { ats: 'liepin', sites: ['liepin.com'], attr: 'name', pattern: 'phone', key: 'phone', exact: true },
    { ats: 'liepin', sites: ['liepin.com'], attr: 'name', pattern: 'email', key: 'email', exact: true },

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

  /**
   * 兼容导出：迭代 5 早期版本把中国五站规则单独放在 SITE_RULES。
   * 现在它们已并入 ATS_RULES，这里保留为派生视图（同一批对象引用），导出名不变。
   */
  var SITE_RULES = ATS_RULES.filter(function (rule) {
    return Array.isArray(rule.sites) && rule.sites.length > 0;
  });

  /**
   * 域名后缀匹配：www.zhipin.com 命中 zhipin.com；zhipin.com.evil.com 不命中。
   * 非 http(s) / 空 url / 空 sites 一律 false（宁可不匹配，也不跨站误用规则）。
   */
  function hostMatches(url, sites) {
    if (typeof url !== 'string' || !url) return false;
    if (!Array.isArray(sites) || !sites.length) return false;
    var host = '';
    try {
      host = String(new URL(url).hostname || '').toLowerCase();
    } catch (e) {
      var m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url);
      if (!m) return false;
      host = m[1].toLowerCase();
    }
    if (!host) return false;
    for (var i = 0; i < sites.length; i++) {
      var site = typeof sites[i] === 'string' ? sites[i].trim().toLowerCase().replace(/^\.+/, '') : '';
      if (!site) continue;
      if (host === site) return true;
      if (host.length > site.length && host.slice(-(site.length + 1)) === '.' + site) return true;
    }
    return false;
  }

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
  // SITE_RULES 是 ATS_RULES 的派生视图，引用同一批对象，不需要再跑一遍。
  for (var ruleIndex = 0; ruleIndex < ATS_RULES.length; ruleIndex++) {
    var atsRule = ATS_RULES[ruleIndex];
    atsRule.normPattern = normalizeText(atsRule.pattern);
    if (atsRule.containerClass) atsRule.normContainer = normalizeText(atsRule.containerClass);
  }

  /** 把 descriptor 里所有可用文本来源抽成 [{attr, text, norm}] */
  function collectSources(desc) {
    if (!desc || typeof desc !== 'object') return [];
    var out = [];
    var ATTR_MAP = [
      ['label', desc.labelText],
      // 迭代 5：调用方直接给出 label 时同样按 label 权重参与匹配
      ['label', desc.label],
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

  /** 单条 ATS / 站点规则是否命中某个 descriptor */
  function ruleHits(rule, attrValue, desc) {
    if (rule.normContainer) {
      var container = normalizeText(desc.containerClass || '');
      if (!container || container.indexOf(rule.normContainer) === -1) return false;
    }
    var value = attrValue[rule.attr];
    if (!value) return false;
    return rule.exact ? value === rule.normPattern : value.indexOf(rule.normPattern) !== -1;
  }

  /**
   * 命中 ATS / 站点精确规则时返回 key，否则 null。
   *
   * 迭代 5：只遍历 ATS_RULES 一张表（中国五站规则排在前部）。规则带 sites 时
   * 必须 hostMatches(opts.url, rule.sites) 才可命中；没有 sites 的通用规则不受
   * host 限制。不传 url 时站点规则一律跳过 —— 保证 matchAts(desc) 向后兼容。
   */
  function matchAts(desc, options) {
    if (!desc) return null;
    var opts = options || {};
    var attrValue = {
      id: normalizeText(desc.id || ''),
      name: normalizeText(desc.name || ''),
      dataAutomationId: normalizeText(desc.dataAutomationId || ''),
      placeholder: normalizeText(desc.placeholder || ''),
      ariaLabel: normalizeText(desc.ariaLabel || ''),
      containerClass: normalizeText(desc.containerClass || '')
    };
    var hasUrl = typeof opts.url === 'string' && opts.url;

    for (var i = 0; i < ATS_RULES.length; i++) {
      var rule = ATS_RULES[i];
      // 站点规则：host 不命中就跳过；没有 sites 的规则不受 host 限制
      if (Array.isArray(rule.sites) && rule.sites.length) {
        if (!hasUrl || !hostMatches(opts.url, rule.sites)) continue;
      }
      if (!ruleHits(rule, attrValue, desc)) continue;
      var hit = { key: rule.key, ats: rule.ats, pattern: rule.pattern, attr: rule.attr };
      // 只有站点规则命中才附带 site，通用规则保持既有响应结构
      if (Array.isArray(rule.sites) && rule.sites.length) hit.site = rule.sites[0];
      return hit;
    }
    return null;
  }

  /**
   * 识别单个字段。
   * 优先级严格为：用户规则 → ATS 精确规则 → 内置字典。
   * 用户规则命中即短路，保证「用户显式教的」永远压过任何猜测。
   *
   * @param {object} desc 字段描述符
   * @param {{fieldKeys?:string[], fieldLabels?:object, rules?:Array, url?:string}} [options]
   * @returns {{key:string, confidence:number, score:number, attr:string, token:string, ats:string|null, source?:string, ruleId?:string}|null}
   */
  function detectFieldType(desc, options) {
    if (!desc || isExcludedDescriptor(desc)) return null;

    var opts = options || {};
    var R = rulesApi();
    if (R && Array.isArray(opts.rules) && opts.rules.length) {
      var ruleHit = R.matchUserRules(desc, opts.rules, { url: opts.url });
      if (ruleHit) {
        return {
          key: ruleHit.key,
          confidence: 1,
          score: MAX_SCORE,
          attr: ruleHit.attr,
          token: ruleHit.pattern,
          ats: null,
          source: 'user-rule',
          ruleId: ruleHit.rule && ruleHit.rule.id ? ruleHit.rule.id : ''
        };
      }
    }

    var ats = matchAts(desc, opts);
    if (ats) {
      var atsHit = {
        key: ats.key,
        confidence: 1,
        score: MAX_SCORE,
        attr: ats.attr,
        token: ats.pattern,
        ats: ats.ats
      };
      // 只有站点规则命中才附带 site，保证既有 ATS 响应结构不变
      if (ats.site) atsHit.site = ats.site;
      return atsHit;
    }

    var sources = collectSources(desc);
    if (!sources.length) return null;

    // 迭代 5：取消 fieldKeys 门禁 —— 内置 key + DICTIONARY 里全部 key 都参与匹配。
    // 反硬编码红线不放松：DICTIONARY 只有上面固定的那些 key，任意用户自建 key
    // （如 wechat）不在这里，也就永远不可能被字典命中，只能靠用户规则。
    var candidateKeys = FIELD_KEYS.slice();
    var dictionaryKeys = Object.keys(DICTIONARY);
    for (var d = 0; d < dictionaryKeys.length; d++) {
      if (candidateKeys.indexOf(dictionaryKeys[d]) === -1) candidateKeys.push(dictionaryKeys[d]);
    }

    var best = null;
    for (var s = 0; s < sources.length; s++) {
      var src = sources[s];
      var attrWeight = ATTR_WEIGHTS[src.attr] || 1;
      for (var k = 0; k < candidateKeys.length; k++) {
        var key = candidateKeys[k];
        // 字典只覆盖固定 key：任意自建 key 没有词库，只能靠用户规则命中。
        // 这条 if 是「禁止把自定义 key 硬编码进字典」的运行时保险。
        var dictionary = null;
        if (Object.prototype.hasOwnProperty.call(DICTIONARY, key)) dictionary = DICTIONARY[key];
        if (!dictionary) continue;
        var rejects = REJECTS[key] || [];
        if (rejects.length && containsAny(src.norm, rejects)) continue;
        var tokens = dictionary;
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
   * @param {object} [options] 透传给 detectFieldType（rules / url / fieldKeys / fieldLabels）
   * @returns {Array<{index:number,key:string,confidence:number,ats:string|null}>} 置信度不足的字段不会出现
   */
  function matchForm(descriptors, options) {
    var opts = options || {};
    var minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : MIN_CONFIDENCE;
    var list = Array.isArray(descriptors) ? descriptors : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var hit = detectFieldType(list[i], opts);
      if (!hit) continue;
      if (hit.confidence < minConfidence) continue;
      var item = {
        index: i,
        key: hit.key,
        confidence: hit.confidence,
        ats: hit.ats,
        attr: hit.attr
      };
      // 只有用户规则命中才附带来源信息，保证无规则时的返回结构与迭代 1 完全一致
      if (hit.source === 'user-rule') {
        item.source = 'user-rule';
        item.ruleId = hit.ruleId || null;
      }
      out.push(item);
    }
    return out;
  }

  /**
   * 迭代 5 别名：模板里的预置 key 是 degree / work_years，canonical 是
   * education / experience_years。优先复用 resume-schema 导出的 FIELD_KEY_ALIASES
   * （浏览器里 resume-schema 先加载并挂到 JC 上），拿不到时退回同一张内置表。
   */
  var FALLBACK_KEY_ALIASES = {
    education: ['degree'],
    degree: ['education'],
    experience_years: ['work_years'],
    work_years: ['experience_years']
  };

  function keyAliasTable() {
    if (typeof globalThis !== 'undefined' && globalThis.JC && globalThis.JC.FIELD_KEY_ALIASES) {
      return globalThis.JC.FIELD_KEY_ALIASES;
    }
    if (typeof require === 'function') {
      try {
        var schema = require('./resume-schema.js');
        if (schema && schema.FIELD_KEY_ALIASES) return schema.FIELD_KEY_ALIASES;
      } catch (e) {
        /* ignore */
      }
    }
    return FALLBACK_KEY_ALIASES;
  }

  function aliasesFor(key) {
    var table = keyAliasTable();
    var list = table && table[key];
    return Array.isArray(list) ? list : [];
  }

  /** 取值：先取 key 本身，为空再按别名顺序回落 */
  function valueForKey(values, key) {
    var v = typeof values[key] === 'string' ? values[key].trim() : '';
    if (v) return v;
    var aliases = aliasesFor(key);
    for (var i = 0; i < aliases.length; i++) {
      var aliasValue = typeof values[aliases[i]] === 'string' ? values[aliases[i]].trim() : '';
      if (aliasValue) return aliasValue;
    }
    return '';
  }

  function labelForOption(key, options) {
    var labels = options && options.fieldLabels ? options.fieldLabels : null;
    if (labels && typeof labels[key] === 'string' && labels[key]) return labels[key];
    if (Object.prototype.hasOwnProperty.call(FIELD_LABELS, key)) return FIELD_LABELS[key];
    // 页面用 canonical key（education / experience_years），简历里只有别名 key
    // （degree / work_years）时，展示名回落到别名，避免 missing 里显示裸 key。
    var aliases = aliasesFor(key);
    for (var i = 0; i < aliases.length; i++) {
      var alias = aliases[i];
      if (labels && typeof labels[alias] === 'string' && labels[alias]) return labels[alias];
      if (Object.prototype.hasOwnProperty.call(FIELD_LABELS, alias)) return FIELD_LABELS[alias];
    }
    return key;
  }

  /**
   * 生成填充计划：识别 + 取值 + 缺失统计。
   * @param {Array} descriptors
   * @param {Object} valueMap 形如 {email: 'a@b.c'}，值为空字符串表示简历里没写
   * @param {object} [options] {fieldKeys, fieldLabels, rules, url, minConfidence}
   * @returns {{assignments:Array, missing:Array, notFound:Array}}
   */
  function buildFillPlan(descriptors, valueMap, options) {
    var opts = options || {};
    var values = valueMap || {};
    var matches = matchForm(descriptors, opts);
    var dynamicKeys = resolveFieldKeys(opts.fieldKeys);
    var assignments = [];
    var filledKeys = Object.create(null);
    var missingMap = Object.create(null);
    var seenIndex = {};

    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      if (seenIndex[m.index]) continue;
      // 迭代 5：key 取不到值时用别名 key（education ↔ degree / experience_years ↔ work_years）
      var value = valueForKey(values, m.key);
      var label = labelForOption(m.key, opts);
      if (!value) {
        // 页面上认出了字段，但简历里没写 -> 记为「缺数据」
        if (!missingMap[m.key]) missingMap[m.key] = { key: m.key, label: label, reason: 'no-value' };
        continue;
      }
      seenIndex[m.index] = true;
      filledKeys[m.key] = true;
      var mAliases = aliasesFor(m.key);
      for (var ma = 0; ma < mAliases.length; ma++) filledKeys[mAliases[ma]] = true;
      var assignment = {
        index: m.index,
        key: m.key,
        label: label,
        value: value,
        confidence: m.confidence,
        ats: m.ats || null
      };
      if (m.source === 'user-rule') {
        assignment.source = 'user-rule';
        assignment.ruleId = m.ruleId || null;
      }
      assignments.push(assignment);
    }

    var missing = [];
    for (var k in missingMap) {
      if (Object.prototype.hasOwnProperty.call(missingMap, k) && !filledKeys[k]) {
        missing.push(missingMap[k]);
      }
    }

    var notFound = [];
    for (var j = 0; j < dynamicKeys.length; j++) {
      var key = dynamicKeys[j];
      // key 或别名任一已填（filledKeys 同时标记了两边）都不再报 notFound
      var v = valueForKey(values, key);
      if (v && !filledKeys[key]) {
        notFound.push({ key: key, label: labelForOption(key, opts) });
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
    PRESET_DICTIONARY: PRESET_DICTIONARY,
    REJECTS: REJECTS,
    GLOBAL_REJECTS: GLOBAL_REJECTS,
    ATS_RULES: ATS_RULES,
    SITE_RULES: SITE_RULES,
    hostMatches: hostMatches,
    normalizeText: normalizeText,
    resolveFieldKeys: resolveFieldKeys,
    collectSources: collectSources,
    isExcludedDescriptor: isExcludedDescriptor,
    matchAts: matchAts,
    detectFieldType: detectFieldType,
    matchForm: matchForm,
    buildFillPlan: buildFillPlan
  };
});
