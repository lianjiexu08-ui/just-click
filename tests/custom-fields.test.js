'use strict';

/**
 * 自定义简历字段 + PRD 验收 1/2/3
 * 核心约束：自定义 key 只能靠用户规则命中，绝不能被硬编码进字典。
 *
 * 0.6.1 返修说明：需求 B 把六组中文预置词条（含 expected_salary）直接放进了
 * DICTIONARY，并取消了 options.fieldKeys 门禁，所以原先用 expected_salary
 * 举证「自定义 key 不被字典猜」的断言不再成立。这里把举证对象换成真正自建的
 * key `wechat`（不在 DICTIONARY 里），并保留「expected_salary 不进 FIELD_KEYS /
 * S.FIELD_KEYS / ATS_RULES」的断言；反硬编码红线的语义没有放松。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../src/lib/resume-schema.js');
const R = require('../src/lib/rules.js');
const M = require('../src/lib/field-matcher.js');

function desc(extra) {
  return Object.assign({ fillable: true }, extra);
}

function customResume(fields) {
  const resume = S.createEmptyResume();
  resume.customFields = fields || [{ key: 'expected_salary', label: '期望薪资', value: '30k / 月' }];
  return resume;
}

function planFor(resume, descriptors, rules) {
  const keys = S.getFieldKeys(resume);
  const values = {};
  const labels = {};
  for (const key of keys) {
    values[key] = S.resolveValue(resume, key);
    labels[key] = S.labelFor(resume, key);
  }
  return M.buildFillPlan(descriptors, values, {
    fieldKeys: keys,
    fieldLabels: labels,
    rules: rules || [],
    url: 'https://jobs.example.com/apply'
  });
}

test('slugifyKey：英文 slug 化，纯中文返回空串', () => {
  assert.equal(S.slugifyKey('Expected Salary'), 'expected_salary');
  assert.equal(S.slugifyKey('  E-mail Address! '), 'e_mail_address');
  assert.equal(S.slugifyKey('custom_field_1'), 'custom_field_1');
  assert.equal(S.slugifyKey('期望薪资'), '', '纯中文交给调用方补 key');
  assert.equal(S.slugifyKey('期望薪资 salary'), 'salary');
  assert.equal(S.slugifyKey(null), '');
});

test('nextCustomKey 生成不冲突的 custom_field_N', () => {
  assert.equal(S.nextCustomKey([]), 'custom_field_1');
  assert.equal(S.nextCustomKey(['custom_field_1']), 'custom_field_2');
  assert.equal(S.nextCustomKey([{ key: 'custom_field_2' }]), 'custom_field_1');
  assert.equal(S.nextCustomKey(['custom_field_1', 'custom_field_2']), 'custom_field_3');
});

test('createEmptyResume 带空 customFields，getFieldKeys 内置在前', () => {
  const empty = S.createEmptyResume();
  assert.deepEqual(empty.customFields, []);
  assert.deepEqual(S.getFieldKeys(empty), S.FIELD_KEYS);

  const resume = customResume([
    { key: 'portfolio', label: '作品集', value: 'https://x.dev' },
    { key: 'expected_salary', label: '期望薪资', value: '30k' }
  ]);
  const keys = S.getFieldKeys(resume);
  assert.deepEqual(keys.slice(0, S.FIELD_KEYS.length), S.FIELD_KEYS, '内置 key 必须在前');
  assert.deepEqual(keys.slice(S.FIELD_KEYS.length), ['portfolio', 'expected_salary']);
  assert.deepEqual(S.customFieldKeys(resume), ['portfolio', 'expected_salary']);
  assert.equal(S.labelFor(resume, 'expected_salary'), '期望薪资');
  assert.equal(S.labelFor(resume, 'email'), '邮箱');
  assert.equal(S.labelFor(resume, 'unknown_key'), 'unknown_key');
});

test('resolveValue 能取自定义 key，内置 key 行为不变', () => {
  const resume = customResume();
  resume.basics.email = 'a@b.c';
  assert.equal(S.resolveValue(resume, 'expected_salary'), '30k / 月');
  assert.equal(S.resolveValue(resume, 'email'), 'a@b.c');
  assert.equal(S.resolveValue(resume, 'unknown_key'), '');
  assert.equal(S.hasAnyData(resume), true, '只有自定义字段也算有数据');
});

test('validateResume 剔除非法自定义字段并给 warning（不静默、不硬报错）', () => {
  const checked = S.validateResume({
    basics: { email: 'a@b.c' },
    customFields: [
      { key: 'expected_salary', label: '期望薪资', value: '30k' },
      { key: 'email', label: '邮箱', value: 'x' },
      { key: 'Bad-Key', label: '坏 key', value: '' },
      { key: '', label: '缺 key', value: '' },
      { key: 'no_label', label: '', value: '' },
      { key: 'long_label', label: 'x'.repeat(S.CUSTOM_LABEL_MAX + 1), value: '' },
      { key: 'bad_value', label: '坏值', value: { nested: true } },
      { key: 'expected_salary', label: '重复', value: 'x' }
    ]
  });

  assert.equal(checked.ok, true, '非法自定义字段应剔除并给 warning，而不是让整份简历不可保存');
  assert.deepEqual(checked.resume.customFields, [
    { key: 'expected_salary', label: '期望薪资', value: '30k' }
  ]);
  assert.ok(checked.warnings.length >= 7, `应逐条报告，实际 ${checked.warnings.length} 条`);
  assert.ok(checked.warnings.some((w) => w.includes('不能与内置字段重名')));
  assert.ok(checked.warnings.some((w) => w.includes('key 重复')));
  assert.ok(checked.warnings.some((w) => w.includes('label 不能超过')));
});

test('value 超过 2000 字会截断并提示', () => {
  const checked = S.validateResume({
    customFields: [{ key: 'long_value', label: '长文本', value: 'x'.repeat(S.CUSTOM_VALUE_MAX + 5) }]
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.resume.customFields[0].value.length, S.CUSTOM_VALUE_MAX);
  assert.ok(checked.warnings.some((w) => w.includes('已截断')));
});

test('migrateResume / exportJSON / importJSON 都保留 customFields', () => {
  const migrated = S.migrateResume({
    name: '张三',
    customFields: [{ key: 'available_date', label: '到岗时间', value: '2026-03' }]
  });
  assert.deepEqual(migrated.customFields, [{ key: 'available_date', label: '到岗时间', value: '2026-03' }]);

  const resume = customResume();
  const text = S.exportJSON(resume);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.customFields, resume.customFields);

  const imported = S.importJSON(text);
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.resume.customFields, resume.customFields);
});

test('验收 1：添加「期望薪资」后，name=expected_salary 的模拟表单能填上该值', () => {
  const resume = customResume();
  const descriptors = [desc({ name: 'expected_salary', labelText: '期望薪资' })];

  // 迭代 5：期望薪资已是 DICTIONARY 的预置字段，不传 fieldKeys 也能被字典命中
  assert.equal(M.detectFieldType(descriptors[0]).key, 'expected_salary');

  // 反硬编码红线：真正自建的 key（wechat）仍然只能靠用户规则命中
  assert.equal(M.detectFieldType({ labelText: '微信', name: 'wechat' }), null, '自建 key 不得被硬编码进字典');

  const rule = R.createRule({
    match: { attrs: ['name'], pattern: 'expected_salary', matchType: 'contains' },
    target: 'expected_salary',
    scope: { sitePattern: '' }
  });
  const plan = planFor(resume, descriptors, [rule]);

  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].key, 'expected_salary');
  assert.equal(plan.assignments[0].label, '期望薪资');
  assert.equal(plan.assignments[0].value, '30k / 月');
  assert.equal(plan.assignments[0].confidence, 1);
  assert.equal(plan.assignments[0].source, 'user-rule');
  assert.equal(plan.assignments[0].ruleId, rule.id);

  // 动态 key 集合也用于 notFound：页面没有该字段时要能报出来
  const emptyPlan = planFor(resume, [desc({ labelText: 'Email' })], []);
  assert.ok(emptyPlan.notFound.some((item) => item.key === 'expected_salary'));
  assert.equal(emptyPlan.notFound.find((item) => item.key === 'expected_salary').label, '期望薪资');
});

test('验收 2：用户规则覆盖内置字典（自建 key wechat 只能靠规则命中）', () => {
  const tricky = desc({
    name: 'wechat',
    labelText: '微信（可接受电话沟通）'
  });

  // 先证明这是「字典确实会判错」的用例：wechat 没有词库，label 里的「电话」会被判成 phone
  const wrong = M.detectFieldType(tricky);
  assert.ok(wrong, '基线应有字典猜测');
  assert.equal(wrong.key, 'phone');
  assert.equal(wrong.ats, null, '基线来自字典而不是 ATS');

  const rule = R.createRule({
    match: { attrs: ['name'], pattern: 'wechat', matchType: 'contains' },
    target: 'wechat',
    scope: { sitePattern: '' }
  });
  const hit = M.detectFieldType(tricky, { rules: [rule], url: 'https://jobs.example.com/apply' });
  assert.equal(hit.key, 'wechat');
  assert.equal(hit.confidence, 1);
  assert.equal(hit.score, M.MAX_SCORE);
  assert.equal(hit.source, 'user-rule');
  assert.equal(hit.ruleId, rule.id);
  assert.equal(hit.ats, null);

  // 核心验收：自建 key 不能出现在词典 / 内置 key 列表 / ATS 规则里
  assert.equal(Object.prototype.hasOwnProperty.call(M.DICTIONARY, 'wechat'), false);
  assert.equal(M.FIELD_KEYS.includes('wechat'), false);
  assert.equal(S.FIELD_KEYS.includes('wechat'), false);
  assert.equal(M.ATS_RULES.some((r) => r.key === 'wechat'), false);

  // 迭代 5：expected_salary 允许出现在 DICTIONARY，但它仍然不是内置字段
  assert.equal(Object.prototype.hasOwnProperty.call(M.DICTIONARY, 'expected_salary'), true);
  assert.equal(M.FIELD_KEYS.includes('expected_salary'), false);
  assert.equal(S.FIELD_KEYS.includes('expected_salary'), false);
  assert.equal(M.ATS_RULES.some((r) => r.key === 'expected_salary'), false);
});

test('验收 3：禁用规则后回退内置行为', () => {
  const tricky = desc({
    name: 'wechat',
    labelText: '微信（可接受电话沟通）'
  });
  const rule = R.createRule({
    match: { attrs: ['name'], pattern: 'wechat', matchType: 'contains' },
    target: 'wechat',
    scope: { sitePattern: '' },
    enabled: false
  });
  const hit = M.detectFieldType(tricky, { rules: [rule], url: 'https://jobs.example.com/apply' });
  assert.equal(hit.key, 'phone');
  assert.notEqual(hit.source, 'user-rule');
});

test('sitePattern 不匹配时不应用用户规则', () => {
  const tricky = desc({ name: 'wechat', labelText: '微信（可接受电话沟通）' });
  const rule = R.createRule({
    match: { attrs: ['name'], pattern: 'wechat', matchType: 'contains' },
    target: 'wechat',
    scope: { sitePattern: 'jobs.example.com' }
  });

  assert.equal(
    M.detectFieldType(tricky, { rules: [rule], url: 'https://other.example.com/apply' }).key,
    'phone'
  );
  assert.equal(
    M.detectFieldType(tricky, { rules: [rule], url: 'https://jobs.example.com/apply' }).key,
    'wechat'
  );
});

test('resolveFieldKeys 去重合并且内置在前', () => {
  assert.deepEqual(M.resolveFieldKeys(), M.FIELD_KEYS);
  assert.deepEqual(
    M.resolveFieldKeys(['expected_salary', 'email', 'expected_salary', '', null]),
    M.FIELD_KEYS.concat(['expected_salary'])
  );
});

test('未传新参数时行为与迭代 1 一致（向后兼容）', () => {
  const descriptors = [desc({ id: 'first_name' }), desc({ labelText: 'Email' })];
  const values = { firstName: 'San', email: 'a@b.c', expected_salary: '30k' };
  const plan = M.buildFillPlan(descriptors, values);
  assert.deepEqual(plan.assignments.map((a) => a.key), ['firstName', 'email']);
  assert.deepEqual(plan.notFound, [], '默认 key 集合不包含自定义 key');
});
