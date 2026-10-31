'use strict';

/**
 * 用户映射规则引擎单元测试
 * 对应 PRD 验收：规则 CRUD、优先级、regex 防护、sitePattern、禁用回退。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../src/lib/rules.js');

/* ------------------------------------------------------------ 纯函数部分 */

test('createRule 生成完整默认结构，id 唯一', () => {
  const rule = R.createRule({
    match: { attrs: ['name', 'id', 'name', 'dataAutomationId'], pattern: 'expected_salary', matchType: 'contains' },
    target: ' expected_salary ',
    scope: { sitePattern: 'jobs.example.com' }
  });

  assert.deepEqual(rule.match.attrs, ['name', 'id'], '非法/重复 attr 应被剔除');
  assert.equal(rule.match.pattern, 'expected_salary');
  assert.equal(rule.match.matchType, 'contains');
  assert.equal(rule.target, 'expected_salary');
  assert.equal(rule.scope.sitePattern, 'jobs.example.com');
  assert.equal(rule.enabled, true);
  assert.equal(rule.source, 'manual');
  assert.equal(rule.hitCount, 0);
  assert.ok(!Number.isNaN(Date.parse(rule.createdAt)), 'createdAt 应是合法 ISO 时间');
  assert.ok(rule.id && rule.id.length > 0);

  const another = R.createRule({ match: { attrs: ['name'], pattern: 'x' }, target: 'email' });
  assert.notEqual(another.id, rule.id);
});

test('validateRule 拦住非法 matchType / pattern / regex / attrs / target / scope', () => {
  const base = {
    match: { attrs: ['name'], pattern: 'salary', matchType: 'contains' },
    target: 'expected_salary',
    scope: { sitePattern: '' }
  };

  const cases = [
    [{ ...base, match: { ...base.match, matchType: 'fuzzy' } }, 'matchType'],
    [{ ...base, match: { ...base.match, pattern: '   ' } }, 'pattern 不能为空'],
    [{ ...base, match: { ...base.match, pattern: 'a'.repeat(R.MAX_PATTERN_LENGTH + 1) } }, '不能超过'],
    [{ ...base, match: { ...base.match, pattern: '[', matchType: 'regex' } }, 'regex 无法编译'],
    [{ ...base, match: { ...base.match, attrs: [] } }, 'attrs'],
    [{ ...base, match: { ...base.match, attrs: ['dataAutomationId'] } }, 'attrs 只能取'],
    [{ ...base, target: '  ' }, 'target'],
    [{ ...base, scope: { sitePattern: 123 } }, 'sitePattern'],
    [{ ...base, scope: { sitePattern: null } }, 'sitePattern']
  ];

  for (const [rule, hint] of cases) {
    const checked = R.validateRule(rule);
    assert.equal(checked.ok, false, `应判非法：${hint}`);
    assert.ok(
      checked.errors.some((e) => e.includes(hint)),
      `错误信息应包含「${hint}」，实际：${checked.errors.join(' | ')}`
    );
  }
});

test('validateRule 接受合法 regex，并规整 attrs / target / sitePattern', () => {
  const checked = R.validateRule({
    match: { attrs: ['name', 'label', 'name'], pattern: ' expected.*salary ', matchType: 'regex' },
    target: ' expected_salary ',
    scope: { sitePattern: ' jobs.example.com ' }
  });
  assert.equal(checked.ok, true, checked.errors.join('；'));
  assert.deepEqual(checked.rule.match.attrs, ['name', 'label']);
  assert.equal(checked.rule.match.pattern, 'expected.*salary');
  assert.equal(checked.rule.target, 'expected_salary');
  assert.equal(checked.rule.scope.sitePattern, 'jobs.example.com');
});

test('matchRule：exact / prefix / contains / regex 都先归一化再比较', () => {
  const desc = {
    labelText: 'Expected Salary（税前）',
    ariaLabel: '期望薪资',
    name: 'expected_salary',
    id: 'field-expected-salary'
  };
  const make = (attrs, pattern, matchType) => ({
    match: { attrs, pattern, matchType },
    target: 'expected_salary',
    scope: { sitePattern: '' }
  });

  assert.ok(R.matchRule(desc, make(['name'], 'expected_salary', 'exact')));
  assert.equal(R.matchRule(desc, make(['name'], 'salary', 'exact')), null);
  assert.ok(R.matchRule(desc, make(['name'], 'EXPECTED', 'prefix')));
  assert.ok(R.matchRule(desc, make(['name'], 'salary', 'contains')));
  assert.ok(R.matchRule(desc, make(['name'], 'expected.*salary', 'regex')));
  assert.equal(R.matchRule(desc, make(['name'], '^salary$', 'regex')), null);

  // label → labelText、ariaLabel → ariaLabel 的映射
  assert.ok(R.matchRule(desc, make(['label'], 'Expected Salary', 'contains')));
  assert.ok(R.matchRule(desc, make(['ariaLabel'], '期望薪资', 'exact')));
  assert.equal(R.matchRule(desc, make(['placeholder'], '期望薪资', 'contains')), null);
});

test('sitePattern 命中才生效，空 pattern 表示全站', () => {
  const desc = { name: 'expected_salary' };
  const rule = R.createRule({
    match: { attrs: ['name'], pattern: 'salary', matchType: 'contains' },
    target: 'expected_salary',
    scope: { sitePattern: 'jobs.example.com' }
  });

  assert.ok(R.matchRule(desc, rule, { url: 'https://jobs.example.com/apply/1' }));
  assert.equal(R.matchRule(desc, rule, { url: 'https://other.example.com/apply/1' }), null);
  assert.equal(R.matchRule(desc, rule, { url: '' }), null);

  rule.scope.sitePattern = '';
  assert.ok(R.matchRule(desc, rule, { url: '' }), '空 sitePattern 不应要求 url');
});

test('matchUserRules 优先级：manual > learned、hitCount > pattern 长度 > createdAt', () => {
  const desc = { name: 'expected_salary' };

  const learned = R.createRule({
    match: { attrs: ['name'], pattern: 'salary', matchType: 'contains' },
    target: 'learned_target',
    source: 'learned',
    hitCount: 50,
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  const manual = R.createRule({
    match: { attrs: ['name'], pattern: 'salary', matchType: 'contains' },
    target: 'manual_target',
    source: 'manual',
    hitCount: 0,
    createdAt: '2025-01-01T00:00:00.000Z'
  });
  assert.equal(R.matchUserRules(desc, [learned, manual]).key, 'manual_target');

  const lowHits = R.createRule({
    match: { attrs: ['name'], pattern: 'expected', matchType: 'contains' },
    target: 'low_hits',
    hitCount: 1,
    createdAt: '2026-02-01T00:00:00.000Z'
  });
  const highHits = R.createRule({
    match: { attrs: ['name'], pattern: 'salary', matchType: 'contains' },
    target: 'high_hits',
    hitCount: 9,
    createdAt: '2025-02-01T00:00:00.000Z'
  });
  assert.equal(R.matchUserRules(desc, [lowHits, highHits]).key, 'high_hits');

  const short = R.createRule({
    match: { attrs: ['name'], pattern: 'salary', matchType: 'contains' },
    target: 'short',
    hitCount: 0,
    createdAt: '2026-03-01T00:00:00.000Z'
  });
  const long = R.createRule({
    match: { attrs: ['name'], pattern: 'expected_salary', matchType: 'contains' },
    target: 'long',
    hitCount: 0,
    createdAt: '2025-03-01T00:00:00.000Z'
  });
  assert.equal(R.matchUserRules(desc, [short, long]).key, 'long');

  const older = R.createRule({
    match: { attrs: ['name'], pattern: 'salary', matchType: 'contains' },
    target: 'older',
    hitCount: 0,
    createdAt: '2025-01-01T00:00:00.000Z'
  });
  const newer = R.createRule({
    match: { attrs: ['name'], pattern: 'salary', matchType: 'contains' },
    target: 'newer',
    hitCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(R.matchUserRules(desc, [older, newer]).key, 'newer');
});

test('matchUserRules 跳过禁用规则，非法 regex 只跳过自己', () => {
  const desc = { name: 'expected_salary' };
  const disabled = R.createRule({
    match: { attrs: ['name'], pattern: 'salary', matchType: 'contains' },
    target: 'disabled_target',
    enabled: false
  });
  assert.equal(R.matchUserRules(desc, [disabled]), null);

  const brokenRegex = R.createRule({
    match: { attrs: ['name'], pattern: '[', matchType: 'regex' },
    target: 'broken'
  });
  const valid = R.createRule({
    match: { attrs: ['name'], pattern: 'salary', matchType: 'contains' },
    target: 'valid'
  });
  // 坏 regex 不能让整个匹配抛异常，也不能挡住后面的合法规则
  const hit = R.matchUserRules(desc, [brokenRegex, valid]);
  assert.equal(hit.key, 'valid');
  assert.equal(hit.confidence, 1);
});

test('matchUserRules 在完全相同条件下也保持确定性', () => {
  const desc = { name: 'expected_salary' };
  const a = R.createRule({
    id: 'rule-b',
    match: { attrs: ['name'], pattern: 'salary', matchType: 'contains' },
    target: 'b',
    hitCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  const b = R.createRule({
    id: 'rule-a',
    match: { attrs: ['name'], pattern: 'salary', matchType: 'contains' },
    target: 'a',
    hitCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(R.matchUserRules(desc, [a, b]).key, R.matchUserRules(desc, [b, a]).key);
  assert.equal(R.matchUserRules(desc, [a, b]).key, 'a', '最后按 id 升序兜底');
});

test('regex 编译结果被缓存：同一 pattern 只 new RegExp 一次', () => {
  const RealRegExp = global.RegExp;
  let constructions = 0;
  function SpyRegExp(pattern) {
    constructions++;
    return new RealRegExp(pattern);
  }
  SpyRegExp.prototype = RealRegExp.prototype;
  global.RegExp = SpyRegExp;

  try {
    const rule = R.createRule({
      match: { attrs: ['name'], pattern: 'cachetest[0-9]+', matchType: 'regex' },
      target: 'custom_target'
    });
    assert.ok(R.matchRule({ name: 'cache_test_42' }, rule, {}));
    assert.ok(R.matchRule({ name: 'cache_test_43' }, rule, {}));
    assert.equal(constructions, 1, '第二次匹配应命中缓存');
  } finally {
    global.RegExp = RealRegExp;
  }
});

/* -------------------------------------------------------------- 存储部分 */

const bag = {};

global.chrome = {
  storage: {
    local: {
      get(key) {
        if (typeof key === 'string') return Promise.resolve({ [key]: bag[key] });
        return Promise.resolve({ ...bag });
      },
      set(next) {
        Object.assign(bag, next);
        return Promise.resolve();
      }
    }
  }
};

const Storage = require('../src/lib/storage.js');

function validRule(pattern, target) {
  return R.createRule({
    match: { attrs: ['name'], pattern: pattern, matchType: 'contains' },
    target: target
  });
}

test('规则存储使用 jc.rules 与 schemaVersion 2', async () => {
  delete bag['jc.rules'];
  assert.equal(Storage.RULES_KEY, 'jc.rules');
  assert.equal(Storage.RULES_SCHEMA_VERSION, 2);

  const empty = await Storage.getRules();
  assert.deepEqual(empty, { schemaVersion: 2, fieldRules: [] });
});

test('addRule / getRules / updateRule / setRuleEnabled / deleteRule 全链路', async () => {
  delete bag['jc.rules'];
  const added = await Storage.addRule(validRule('salary', 'expected_salary'));
  assert.equal(added.ok, true, (added.errors || []).join('；'));
  assert.ok(added.rule.id);

  let loaded = await Storage.getRules();
  assert.equal(loaded.fieldRules.length, 1);
  assert.equal(loaded.fieldRules[0].target, 'expected_salary');
  assert.equal(bag['jc.rules'].schemaVersion, 2);

  const updated = await Storage.updateRule(added.rule.id, { match: { pattern: 'expected_salary', matchType: 'exact' } });
  assert.equal(updated.ok, true, (updated.errors || []).join('；'));
  loaded = await Storage.getRules();
  assert.equal(loaded.fieldRules[0].match.pattern, 'expected_salary');
  assert.equal(loaded.fieldRules[0].match.matchType, 'exact');

  await Storage.setRuleEnabled(added.rule.id, false);
  loaded = await Storage.getRules();
  assert.equal(loaded.fieldRules[0].enabled, false);

  await Storage.bumpRuleHits([added.rule.id, added.rule.id, 'missing']);
  loaded = await Storage.getRules();
  assert.equal(loaded.fieldRules[0].hitCount, 1, '重复 id 只累加一次');

  const deleted = await Storage.deleteRule(added.rule.id);
  assert.equal(deleted.ok, true);
  loaded = await Storage.getRules();
  assert.equal(loaded.fieldRules.length, 0);
});

test('非法规则不落盘，并返回可读 errors', async () => {
  delete bag['jc.rules'];
  await Storage.addRule(validRule('salary', 'expected_salary'));
  const before = JSON.stringify(bag['jc.rules']);

  const bad = await Storage.addRule({
    match: { attrs: ['name'], pattern: '[', matchType: 'regex' },
    target: 'expected_salary'
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('regex 无法编译')));
  assert.equal(JSON.stringify(bag['jc.rules']), before, '校验失败不应覆盖已有规则');

  const badBatch = await Storage.saveRules([
    validRule('salary', 'expected_salary'),
    { match: { attrs: [], pattern: '', matchType: 'fuzzy' }, target: '' }
  ]);
  assert.equal(badBatch.ok, false);
  assert.ok(badBatch.errors.length > 0);
  assert.equal(JSON.stringify(bag['jc.rules']), before, '批量保存有一条非法就整体不落盘');
});

test('读取时跳过存储里的坏规则，不影响好规则', async () => {
  delete bag['jc.rules'];
  const good = validRule('salary', 'expected_salary');
  bag['jc.rules'] = {
    schemaVersion: 2,
    fieldRules: [good, { match: { attrs: ['name'], pattern: '[', matchType: 'regex' }, target: 'x' }]
  };
  const loaded = await Storage.getRules();
  assert.equal(loaded.fieldRules.length, 1);
  assert.equal(loaded.fieldRules[0].id, good.id);
});
