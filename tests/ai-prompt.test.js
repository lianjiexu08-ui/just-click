'use strict';

/**
 * 迭代 4 验收 1/3：buildPrompt 覆盖全部字段与「只输出 JSON」约束、文本截断 30000；
 * chunkText 的边界（空串 / 恰好等于上限 / 超限）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const AI = require('../src/lib/ai.js');
const S = require('../src/lib/resume-schema.js');

function sampleResume() {
  const resume = S.createEmptyResume();
  resume.basics.firstName = '三';
  resume.basics.lastName = '张';
  resume.basics.email = 'san.zhang@example.com';
  resume.customFields = [
    { key: 'expected_salary', label: '期望薪资', value: '30k', group: 'intent' },
    { key: 'portfolio', label: '作品集链接', value: 'https://x.dev', group: 'extra' }
  ];
  return resume;
}

test('buildFieldSpecs：内置 ∪ 自定义，姓/名带分隔说明', () => {
  const specs = AI.buildFieldSpecs(sampleResume());
  const keys = specs.map((s) => s.key);
  assert.ok(keys.includes('firstName') && keys.includes('lastName') && keys.includes('fullName'));
  assert.ok(keys.includes('expected_salary') && keys.includes('portfolio'), '自定义字段必须进清单');
  const last = specs.find((s) => s.key === 'lastName');
  const first = specs.find((s) => s.key === 'firstName');
  assert.match(last.hint, /姓/);
  assert.match(first.hint, /名/);
  assert.ok(last.hint !== first.hint, '姓与名的说明不能一样');
});

test('buildPrompt：包含全部字段 label 与 key', () => {
  const specs = AI.buildFieldSpecs(sampleResume());
  const prompt = AI.buildPrompt(specs, '张三，13800000000，期望薪资 30k');
  for (const spec of specs) {
    assert.ok(prompt.user.includes(spec.label), `提示词缺少 label：${spec.label}`);
    assert.ok(prompt.user.includes(spec.key), `提示词缺少 key：${spec.key}`);
  }
  assert.ok(prompt.user.includes('期望薪资'));
  assert.equal(prompt.fieldCount, specs.length);
  assert.deepEqual(prompt.fieldKeys, specs.map((s) => s.key));
});

test('buildPrompt：明确「只输出 JSON」、禁止编造、key 必须来自清单', () => {
  const prompt = AI.buildPrompt(AI.buildFieldSpecs(sampleResume()), '一段简历');
  assert.match(prompt.system, /只输出 JSON 对象/);
  assert.match(prompt.system, /禁止编造/);
  assert.match(prompt.system, /不确定的字段直接省略/);
  assert.match(prompt.system, /不要输出解释/);
  assert.match(prompt.user, /请只输出 JSON 对象/);
  assert.equal(prompt.messages.length, 2);
  assert.equal(prompt.messages[0].role, 'system');
  assert.equal(prompt.messages[1].role, 'user');
});

test('buildPrompt：35000 字文本被截到 30000 并标记', () => {
  const long = 'a'.repeat(35000);
  const prompt = AI.buildPrompt(AI.buildFieldSpecs(sampleResume()), long);
  assert.equal(prompt.text.length, 30000);
  assert.equal(prompt.truncated, true);
  assert.equal(prompt.originalLength, 35000);
  assert.equal(prompt.limit, 30000);
  assert.match(prompt.user, /已截断到前 30000 字符/);
});

test('buildPrompt：正常长度文本不截断，也不出现截断提示', () => {
  const prompt = AI.buildPrompt(['email'], '短简历');
  assert.equal(prompt.truncated, false);
  assert.ok(!prompt.user.includes('已截断'));
  assert.equal(prompt.text, '短简历');
});

test('chunkText 边界：空串 / 恰好等于上限 / 超限 / 非字符串', () => {
  assert.deepEqual(AI.chunkText('', 10), { text: '', truncated: false, originalLength: 0, limit: 10 });

  const exact = 'b'.repeat(10);
  const same = AI.chunkText(exact, 10);
  assert.equal(same.truncated, false);
  assert.equal(same.text.length, 10);

  const over = AI.chunkText('c'.repeat(11), 10);
  assert.equal(over.truncated, true);
  assert.equal(over.text.length, 10);
  assert.equal(over.originalLength, 11);

  assert.equal(AI.chunkText(null, 5).text, '');
  assert.equal(AI.chunkText(undefined, 5).originalLength, 0);

  assert.equal(AI.AI_TEXT_LIMIT, 30000);
  const defaultLimit = AI.chunkText('x'.repeat(30001));
  assert.equal(defaultLimit.limit, 30000);
  assert.equal(defaultLimit.truncated, true);
});

test('chunkText：非法 limit 退回默认 30000', () => {
  const result = AI.chunkText('短', 0);
  assert.equal(result.limit, 30000);
  assert.equal(result.truncated, false);
});
