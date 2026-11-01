'use strict';

/**
 * 迭代 4 验收 2：parseAiResume 的容错解析 ≥6 类场景。
 * 覆盖：正常 JSON / ```json 围栏 / 前后杂质 / 未知 key 忽略 / 数字转字符串 / 空值丢弃。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const AI = require('../src/lib/ai.js');
const S = require('../src/lib/resume-schema.js');

function specs() {
  const resume = S.createEmptyResume();
  resume.customFields = [{ key: 'expected_salary', label: '期望薪资', value: '' }];
  return AI.buildFieldSpecs(resume);
}

test('parseAiResume：正常 JSON 直接映射到 key', () => {
  const result = AI.parseAiResume('{"firstName":"三","lastName":"张","email":"san@example.com"}', specs());
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.fields.map((f) => f.key).sort(),
    ['email', 'firstName', 'lastName']
  );
  const email = result.fields.find((f) => f.key === 'email');
  assert.equal(email.value, 'san@example.com');
  assert.equal(email.label, '邮箱');
});

test('parseAiResume：剥掉 ```json 围栏', () => {
  const raw = '```json\n{"email":"a@b.c","city":"上海"}\n```';
  const result = AI.parseAiResume(raw, specs());
  assert.equal(result.ok, true);
  assert.equal(result.fields.length, 2);
  assert.equal(result.fields.find((f) => f.key === 'city').value, '上海');
});

test('parseAiResume：前后有杂质文本也能提取 JSON 对象', () => {
  const raw = '好的，这是解析结果：{"email":"a@b.c","phone":"13800000000"} 希望对你有帮助！';
  const result = AI.parseAiResume(raw, specs());
  assert.equal(result.ok, true);
  assert.deepEqual(result.fields.map((f) => f.key).sort(), ['email', 'phone']);
});

test('parseAiResume：未知 key 忽略并记录', () => {
  const raw = '{"email":"a@b.c","nickname":"小三","favorite_color":"blue"}';
  const result = AI.parseAiResume(raw, specs());
  assert.equal(result.ok, true);
  assert.equal(result.fields.length, 1);
  assert.deepEqual(result.ignored.sort(), ['favorite_color', 'nickname']);
});

test('parseAiResume：数字值转成字符串', () => {
  const raw = '{"phone":13800138000,"expected_salary":30000}';
  const result = AI.parseAiResume(raw, specs());
  assert.equal(result.ok, true);
  assert.equal(result.fields.find((f) => f.key === 'phone').value, '13800138000');
  assert.equal(result.fields.find((f) => f.key === 'expected_salary').value, '30000');
});

test('parseAiResume：空值 / null / 纯空白丢弃', () => {
  const raw = '{"email":"","city":null,"address":"   ","phone":"13800000000"}';
  const result = AI.parseAiResume(raw, specs());
  assert.equal(result.ok, true);
  assert.deepEqual(result.fields.map((f) => f.key), ['phone']);
});

test('parseAiResume：非法 JSON 返回 ok=false 且不抛错', () => {
  const result = AI.parseAiResume('抱歉，我无法处理这份简历。', specs());
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.deepEqual(result.fields, []);
});

test('parseAiResume：大小写 / 下划线差异也能对上 key', () => {
  const result = AI.parseAiResume('{"first_name":"三","EMAIL":"a@b.c"}', specs());
  assert.equal(result.ok, true);
  assert.deepEqual(result.fields.map((f) => f.key).sort(), ['email', 'firstName']);
});

test('parseAiResume：容忍 {"fields": {...}} 包裹，中文 label 也能对上', () => {
  const wrapped = AI.parseAiResume('{"fields":{"邮箱":"a@b.c"}}', specs());
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.fields[0].key, 'email');
});

test('parseAiResume：值超长按 2000 字符截断', () => {
  const long = 'x'.repeat(2500);
  const result = AI.parseAiResume(JSON.stringify({ summary: long }), specs());
  assert.equal(result.ok, true);
  assert.equal(result.fields[0].value.length, 2000);
});

test('parseJsonLoose：数组 / 纯文本不算合法简历 JSON', () => {
  assert.equal(AI.parseJsonLoose('[1,2,3]').ok, false);
  assert.equal(AI.parseJsonLoose('').ok, false);
  assert.equal(AI.parseJsonLoose('{"a":1}').ok, true);
});
