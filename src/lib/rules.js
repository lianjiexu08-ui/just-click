/**
 * JustClick — 用户映射规则引擎
 *
 * 迭代 1 的字典与 ATS 规则是「猜」，本文件是用户显式教的「确定」：
 * 一条规则 = 在哪些属性上、用什么方式、匹配什么文本、填哪个字段。
 *
 * 这里只做纯函数，不碰 DOM / chrome.*，因此可以用 node:test 直接覆盖
 * 「用户规则压过字典误判」「正则写坏不能拖垮整次填充」这类关键行为。
 *
 * UMD 双模导出，禁止 ES module 语法。
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

  /** 规则只允许在这些描述符属性上匹配，避免用户写出无法执行的规则 */
  var ALLOWED_ATTRS = ['id', 'name', 'label', 'placeholder', 'ariaLabel'];
  var MATCH_TYPES = ['exact', 'prefix', 'contains', 'regex'];
  var MAX_PATTERN_LENGTH = 200;

  var DEFAULT_ATTRS = ['name'];

  /**
   * normalizeText 必须与 field-matcher 的完全一致，否则同一条规则在
   * 「匹配」与「打分」两条路径上会得到不同结论。这里保留一份独立实现，
   * 让 rules.js 可以单独 require（不依赖加载顺序）。
   */
  function normalizeText(value) {
    if (typeof value !== 'string') return '';
    return value
      .toLowerCase()
      .replace(/[\s\u00a0]+/g, '')
      .replace(/[^0-9a-z\u4e00-\u9fff\u3040-\u30ff]/g, '');
  }

  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function generateId() {
    try {
      if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch (e) {
      /* 某些环境禁用 crypto，走时间戳兜底 */
    }
    return 'rule_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  /** 去重、去非法、保持用户选择顺序 */
  function normalizeAttrs(attrs) {
    var out = [];
    if (!Array.isArray(attrs)) return out;
    for (var i = 0; i < attrs.length; i++) {
      var attr = attrs[i];
      if (typeof attr !== 'string') continue;
      if (ALLOWED_ATTRS.indexOf(attr) === -1) continue;
      if (out.indexOf(attr) === -1) out.push(attr);
    }
    return out;
  }

  /**
   * 正则编译缓存。键是原始 pattern，值是 RegExp 或 null（编译失败也缓存，
   * 避免用户每次填表都重复抛异常）。非法正则只跳过该条规则，不影响其它规则。
   */
  var regexCache = Object.create(null);

  function compileRegex(pattern) {
    if (typeof pattern !== 'string' || !pattern) return null;
    if (hasOwn(regexCache, pattern)) return regexCache[pattern];
    var compiled = null;
    try {
      compiled = new RegExp(pattern);
    } catch (e) {
      compiled = null;
    }
    regexCache[pattern] = compiled;
    // 规则 pattern 最长 200，正常不会撑爆；这里只防御异常调用
    if (Object.keys(regexCache).length > 500) {
      var keys = Object.keys(regexCache);
      for (var i = 0; i < 100; i++) delete regexCache[keys[i]];
    }
    return compiled;
  }

  /**
   * 生成一条完整规则。非法输入不在这里报错（交给 validateRule），
   * 这样 UI 可以先渲染再提示用户修正。
   */
  function createRule(input) {
    var src = isPlainObject(input) ? input : {};
    var matchSrc = isPlainObject(src.match) ? src.match : src;
    var scopeSrc = isPlainObject(src.scope) ? src.scope : {};

    var attrs = normalizeAttrs(matchSrc.attrs);
    var matchType = MATCH_TYPES.indexOf(matchSrc.matchType) !== -1 ? matchSrc.matchType : 'contains';

    return {
      id: typeof src.id === 'string' && src.id ? src.id : generateId(),
      match: {
        attrs: attrs.length ? attrs : DEFAULT_ATTRS.slice(),
        pattern: typeof matchSrc.pattern === 'string' ? matchSrc.pattern : '',
        matchType: matchType
      },
      target: typeof src.target === 'string' ? src.target.trim() : '',
      scope: {
        sitePattern: typeof scopeSrc.sitePattern === 'string' ? scopeSrc.sitePattern.trim() : ''
      },
      enabled: src.enabled !== false,
      source: src.source === 'learned' ? 'learned' : 'manual',
      createdAt: typeof src.createdAt === 'string' && src.createdAt ? src.createdAt : new Date().toISOString(),
      hitCount:
        typeof src.hitCount === 'number' && isFinite(src.hitCount) && src.hitCount > 0
          ? Math.floor(src.hitCount)
          : 0
    };
  }

  /**
   * 校验并规整规则。
   * @returns {{ok:boolean, errors:string[], rule:object|null}}
   */
  function validateRule(rule) {
    if (!isPlainObject(rule)) {
      return { ok: false, errors: ['规则必须是对象'], rule: null };
    }
    var errors = [];
    var match = isPlainObject(rule.match) ? rule.match : {};
    var matchType = match.matchType;
    var pattern = typeof match.pattern === 'string' ? match.pattern.trim() : '';
    var attrs = normalizeAttrs(match.attrs);

    if (MATCH_TYPES.indexOf(matchType) === -1) {
      errors.push('matchType 必须是 ' + MATCH_TYPES.join(' / '));
    }
    if (!pattern) {
      errors.push('pattern 不能为空');
    } else if (pattern.length > MAX_PATTERN_LENGTH) {
      errors.push('pattern 不能超过 ' + MAX_PATTERN_LENGTH + ' 字符');
    } else if (matchType === 'regex' && !compileRegex(pattern)) {
      // 非法正则是「校验失败」，不是抛异常
      errors.push('regex 无法编译：' + pattern);
    }

    if (!Array.isArray(match.attrs) || !match.attrs.length) {
      errors.push('attrs 至少选择一个');
    } else {
      for (var i = 0; i < match.attrs.length; i++) {
        if (ALLOWED_ATTRS.indexOf(match.attrs[i]) === -1) {
          errors.push('attrs 只能取 ' + ALLOWED_ATTRS.join(' / '));
          break;
        }
      }
    }
    if (!attrs.length && Array.isArray(match.attrs) && match.attrs.length) {
      errors.push('attrs 没有可用项');
    }

    var target = typeof rule.target === 'string' ? rule.target.trim() : '';
    if (!target) errors.push('target 不能为空');

    var scopeSrc = isPlainObject(rule.scope) ? rule.scope : {};
    if (rule.scope !== undefined && rule.scope !== null && !isPlainObject(rule.scope)) {
      errors.push('scope 必须是对象');
    }
    var sitePattern = scopeSrc.sitePattern;
    if (sitePattern === undefined) sitePattern = '';
    if (typeof sitePattern !== 'string') {
      errors.push('scope.sitePattern 必须是字符串');
      sitePattern = '';
    }

    var normalized = createRule({
      id: rule.id,
      match: { attrs: attrs, pattern: pattern, matchType: matchType },
      target: target,
      scope: { sitePattern: sitePattern.trim() },
      enabled: rule.enabled,
      source: rule.source,
      createdAt: rule.createdAt,
      hitCount: rule.hitCount
    });

    if (errors.length) return { ok: false, errors: errors, rule: normalized };
    return { ok: true, errors: [], rule: normalized };
  }

  /** desc 的某个属性取可匹配文本：label 对应 labelText，其余同名 */
  function textOfAttr(desc, attr) {
    if (!desc || typeof desc !== 'object') return '';
    switch (attr) {
      case 'label':
        return typeof desc.labelText === 'string' ? desc.labelText : '';
      case 'ariaLabel':
        return typeof desc.ariaLabel === 'string' ? desc.ariaLabel : '';
      case 'id':
        return typeof desc.id === 'string' ? desc.id : '';
      case 'name':
        return typeof desc.name === 'string' ? desc.name : '';
      case 'placeholder':
        return typeof desc.placeholder === 'string' ? desc.placeholder : '';
      default:
        return '';
    }
  }

  function siteAllows(rule, ctx) {
    var sitePattern =
      rule && rule.scope && typeof rule.scope.sitePattern === 'string' ? rule.scope.sitePattern.trim() : '';
    if (!sitePattern) return true;
    var url = ctx && typeof ctx.url === 'string' ? ctx.url : '';
    if (!url) return false;
    return url.toLowerCase().indexOf(sitePattern.toLowerCase()) !== -1;
  }

  /**
   * 单条规则匹配。返回命中的 {attr, pattern, matchType}，未命中 null。
   * 先 normalizeText 再比较（regex 除外：regex 对归一化后的文本做 test）。
   */
  function matchRule(desc, rule, ctx) {
    if (!desc || !rule || !isPlainObject(rule.match)) return null;
    if (!siteAllows(rule, ctx)) return null;

    var match = rule.match;
    var matchType = match.matchType;
    if (MATCH_TYPES.indexOf(matchType) === -1) return null;

    var pattern = typeof match.pattern === 'string' ? match.pattern.trim() : '';
    if (!pattern) return null;

    var normPattern = normalizeText(pattern);
    var regex = null;
    if (matchType === 'regex') {
      regex = compileRegex(pattern);
      if (!regex) return null;
    } else if (!normPattern) {
      // 纯标点 pattern 归一化后为空，任何文本都不应命中
      return null;
    }

    var attrs = normalizeAttrs(match.attrs);
    for (var i = 0; i < attrs.length; i++) {
      var attr = attrs[i];
      var norm = normalizeText(textOfAttr(desc, attr));
      if (!norm) continue;
      var hit = false;
      if (matchType === 'regex') hit = regex.test(norm);
      else if (matchType === 'exact') hit = norm === normPattern;
      else if (matchType === 'prefix') hit = norm.indexOf(normPattern) === 0;
      else hit = norm.indexOf(normPattern) !== -1;
      if (hit) return { attr: attr, pattern: pattern, matchType: matchType };
    }
    return null;
  }

  function sourceRank(rule) {
    return rule && rule.source === 'learned' ? 1 : 0;
  }

  function hitCountOf(rule) {
    return rule && typeof rule.hitCount === 'number' && isFinite(rule.hitCount) ? rule.hitCount : 0;
  }

  function patternOf(rule) {
    return rule && rule.match && typeof rule.match.pattern === 'string' ? rule.match.pattern : '';
  }

  function createdAtOf(rule) {
    var time = rule && typeof rule.createdAt === 'string' ? Date.parse(rule.createdAt) : NaN;
    return isNaN(time) ? 0 : time;
  }

  /**
   * 比较两条命中规则：负数表示 a 优先。
   * 顺序写死，保证同样输入永远得到同样结果（不能依赖数组顺序）。
   */
  function compareRules(a, b) {
    var rankDiff = sourceRank(a) - sourceRank(b);
    if (rankDiff !== 0) return rankDiff;

    var hitDiff = hitCountOf(b) - hitCountOf(a);
    if (hitDiff !== 0) return hitDiff;

    var patternDiff = patternOf(b).length - patternOf(a).length;
    if (patternDiff !== 0) return patternDiff;

    var timeDiff = createdAtOf(b) - createdAtOf(a);
    if (timeDiff !== 0) return timeDiff;

    var idA = a && typeof a.id === 'string' ? a.id : '';
    var idB = b && typeof b.id === 'string' ? b.id : '';
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  }

  /**
   * 在规则集合里挑出唯一命中项。
   * @returns {{rule:object, key:string, confidence:number, attr:string, pattern:string}|null}
   */
  function matchUserRules(desc, rules, ctx) {
    var list = Array.isArray(rules) ? rules : [];
    var best = null;
    var bestHit = null;

    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      if (!rule || rule.enabled === false) continue;
      if (typeof rule.target !== 'string' || !rule.target.trim()) continue;
      var hit = matchRule(desc, rule, ctx);
      if (!hit) continue;
      if (!best || compareRules(rule, best) < 0) {
        best = rule;
        bestHit = hit;
      }
    }

    if (!best || !bestHit) return null;
    return {
      rule: best,
      key: best.target.trim(),
      confidence: 1,
      attr: bestHit.attr,
      pattern: bestHit.pattern
    };
  }

  return {
    ALLOWED_ATTRS: ALLOWED_ATTRS,
    MATCH_TYPES: MATCH_TYPES,
    MAX_PATTERN_LENGTH: MAX_PATTERN_LENGTH,
    normalizeText: normalizeText,
    generateId: generateId,
    normalizeAttrs: normalizeAttrs,
    createRule: createRule,
    validateRule: validateRule,
    matchRule: matchRule,
    matchUserRules: matchUserRules,
    compareRules: compareRules
  };
});
