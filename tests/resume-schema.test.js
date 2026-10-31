'use strict';

/**
 * 简历数据模型单元测试：schema 完整性、容错迁移、校验、导入导出往返。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../src/lib/resume-schema.js');

test('createEmptyResume 覆盖全部字段', () => {
  const resume = S.createEmptyResume();
  assert.equal(resume.version, S.RESUME_VERSION);
  assert.equal(resume.updatedAt, null);
  assert.equal(resume.summary, '');
  assert.equal(resume.experience, '');
  for (const key of S.BASICS_KEYS) {
    assert.equal(resume.basics[key], '', `basics.${key} 应为空串`);
  }
});

test('validateResume 拒绝非对象输入', () => {
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    const result = S.validateResume(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} 应校验失败`);
    assert.ok(result.errors.length > 0);
    assert.equal(result.resume.version, S.RESUME_VERSION);
  }
});

test('validateResume 把数字转字符串，对对象类型报错', () => {
  const numeric = S.validateResume({ basics: { email: 12345 } });
  assert.equal(numeric.ok, true);
  assert.equal(numeric.resume.basics.email, '12345');

  const wrongType = S.validateResume({ basics: { email: { nested: true } } });
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.errors.some((e) => e.includes('basics.email')));
});

test('v1 扁平结构可以迁移到 v2', () => {
  const legacy = { name: '张三', email: 'zhangsan@example.com', phone: '13800000000', city: '上海' };
  const result = S.validateResume(legacy);
  assert.equal(result.ok, true);
  assert.equal(result.resume.basics.fullName, '张三');
  assert.equal(result.resume.basics.email, 'zhangsan@example.com');
  assert.equal(result.resume.basics.phone, '13800000000');
  assert.equal(result.resume.basics.city, '上海');
});

test('sanitizeText 折叠空白并去控制字符', () => {
  assert.equal(S.sanitizeText('  a \n\n b  '), 'a b');
  assert.equal(S.sanitizeText(null), '');
  assert.equal(S.sanitizeText(42), '42');
  assert.equal(S.sanitizeText('a\u0007b'), 'a b');
});

test('resolveValue：fullName 可由姓 + 名组合，summary 可回退 experience', () => {
  const resume = S.createEmptyResume();
  resume.basics.firstName = 'San';
  resume.basics.lastName = 'Zhang';
  assert.equal(S.resolveValue(resume, 'fullName'), 'San Zhang');

  resume.basics.fullName = '张三';
  assert.equal(S.resolveValue(resume, 'fullName'), '张三');

  assert.equal(S.resolveValue(resume, 'summary'), '');
  resume.experience = '5 年前端经验';
  assert.equal(S.resolveValue(resume, 'summary'), '5 年前端经验');
  assert.equal(S.resolveValue(resume, 'unknownKey'), '');
});

test('hasAnyData 判断是否至少有可填数据', () => {
  assert.equal(S.hasAnyData(S.createEmptyResume()), false);
  const resume = S.createEmptyResume();
  resume.basics.email = 'a@b.c';
  assert.equal(S.hasAnyData(resume), true);
});

test('exportJSON / importJSON 往返不丢字段', () => {
  const resume = S.createEmptyResume();
  resume.basics.fullName = '张三';
  resume.basics.email = 'zhangsan@example.com';
  resume.summary = '5 年前端';

  const text = S.exportJSON(resume);
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, S.RESUME_VERSION);
  assert.ok(parsed.updatedAt, 'exportJSON 应写入 updatedAt');

  const back = S.importJSON(text);
  assert.equal(back.ok, true);
  assert.equal(back.resume.basics.fullName, '张三');
  assert.equal(back.resume.basics.email, 'zhangsan@example.com');
  assert.equal(back.resume.summary, '5 年前端');
});

test('importJSON 给出可读的错误信息', () => {
  assert.equal(S.importJSON('').ok, false);
  assert.equal(S.importJSON('   ').ok, false);

  const broken = S.importJSON('{ not json');
  assert.equal(broken.ok, false);
  assert.ok(broken.errors[0].includes('JSON 解析失败'));

  const wrongShape = S.importJSON('[]');
  assert.equal(wrongShape.ok, false);
  assert.ok(wrongShape.errors[0].includes('JSON 对象'));
});

test('FORM_FIELDS 覆盖全部可识别字段且路径合法', () => {
  assert.deepEqual(
    S.FORM_FIELDS.map((f) => f.key),
    S.FIELD_KEYS,
    'options 表单漏了字段，或顺序与识别引擎不一致'
  );

  const seen = new Set();
  for (const field of S.FORM_FIELDS) {
    assert.ok(!seen.has(field.path), `表单路径重复：${field.path}`);
    seen.add(field.path);

    const [head, tail] = field.path.split('.');
    if (tail) {
      assert.equal(head, 'basics');
      assert.ok(S.BASICS_KEYS.includes(tail), `未知的基本信息字段：${tail}`);
    } else {
      assert.ok(S.TOP_KEYS.includes(head), `未知的顶层字段：${head}`);
    }
  }
});
