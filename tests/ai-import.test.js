'use strict';

/**
 * 迭代 4 需求 3 的合并策略：预览行 → 确认写入。
 * 关键底线：AI 空值不覆盖已有值；用户没勾「覆盖」就保留原值；跳过行不写。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const AI = require('../src/lib/ai.js');
const S = require('../src/lib/resume-schema.js');

function resumeWith(values) {
  const resume = S.createEmptyResume();
  Object.assign(resume.basics, values.basics || {});
  resume.customFields = values.customFields || [];
  return resume;
}

test('previewRows：已有值的行标 conflict，默认不覆盖、不跳过', () => {
  const resume = resumeWith({ basics: { email: 'old@x.com' } });
  const fields = [{ key: 'email', label: '邮箱', value: 'new@x.com' }];
  const rows = AI.previewRows(fields, resume, AI.buildFieldSpecs(resume));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'email');
  assert.equal(rows[0].existing, 'old@x.com');
  assert.equal(rows[0].conflict, true);
  assert.equal(rows[0].overwrite, false);
  assert.equal(rows[0].skip, false);
  assert.match(rows[0].note, /已有值/);
});

test('previewRows：没有值的字段标「新增」，空值字段不进预览', () => {
  const resume = S.createEmptyResume();
  const rows = AI.previewRows(
    [
      { key: 'city', label: '城市', value: '上海' },
      { key: 'phone', label: '电话', value: '   ' }
    ],
    resume,
    AI.buildFieldSpecs(resume)
  );
  assert.equal(rows.length, 1, '空值不该出现在预览里');
  assert.equal(rows[0].conflict, false);
  assert.equal(rows[0].note, '新增');
});

test('applyAiRows：已有值且未勾覆盖 → 保留原值，不写入', () => {
  const resume = resumeWith({ basics: { email: 'old@x.com' } });
  const result = AI.applyAiRows(resume, [{ key: 'email', label: '邮箱', value: 'new@x.com', overwrite: false }]);
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 0);
  assert.equal(result.kept.length, 1);
  assert.equal(result.resume.basics.email, 'old@x.com');
});

test('applyAiRows：勾了覆盖 → 替换已有值', () => {
  const resume = resumeWith({ basics: { email: 'old@x.com' } });
  const result = AI.applyAiRows(resume, [{ key: 'email', label: '邮箱', value: 'new@x.com', overwrite: true }]);
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].overwritten, true);
  assert.equal(result.resume.basics.email, 'new@x.com');
});

test('applyAiRows：AI 空值绝不覆盖已有值', () => {
  const resume = resumeWith({ basics: { email: 'old@x.com', phone: '13800000000' } });
  const result = AI.applyAiRows(resume, [
    { key: 'email', value: '', overwrite: true },
    { key: 'phone', value: '   ', overwrite: true }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 0);
  assert.equal(result.resume.basics.email, 'old@x.com');
  assert.equal(result.resume.basics.phone, '13800000000');
  assert.equal(result.skipped.length, 2);
});

test('applyAiRows：勾了跳过就不写', () => {
  const resume = S.createEmptyResume();
  const result = AI.applyAiRows(resume, [{ key: 'city', label: '城市', value: '上海', skip: true }]);
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].reason, '已跳过');
  assert.equal(result.resume.basics.city, '');
});

test('applyAiRows：新 key 作为自定义字段创建，并落到第三组', () => {
  const resume = S.createEmptyResume();
  const result = AI.applyAiRows(resume, [{ key: 'portfolio', label: '作品集链接', value: 'https://x.dev' }]);
  assert.equal(result.ok, true);
  const field = result.resume.customFields.find((f) => f.key === 'portfolio');
  assert.ok(field, '自定义字段应被创建');
  assert.equal(field.label, '作品集链接');
  assert.equal(field.value, 'https://x.dev');
  assert.equal(field.group, 'extra');
  assert.equal(S.resolveValue(result.resume, 'portfolio'), 'https://x.dev');
});

test('applyAiRows：已存在的自定义字段，勾了覆盖才更新值，且分组不变', () => {
  const resume = resumeWith({
    customFields: [{ key: 'expected_salary', label: '期望薪资', value: '20k', group: 'intent' }]
  });
  const result = AI.applyAiRows(resume, [
    { key: 'expected_salary', label: '期望薪资', value: '30k', overwrite: true }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.resume.customFields.length, 1, '不应重复创建同 key 自定义字段');
  assert.equal(result.resume.customFields[0].value, '30k');
  assert.equal(result.resume.customFields[0].group, 'intent', '原有分组不能被改写');
});

test('applyAiRows：已存在的自定义字段，未勾覆盖时保留原值', () => {
  const resume = resumeWith({
    customFields: [{ key: 'expected_salary', label: '期望薪资', value: '20k', group: 'intent' }]
  });
  const result = AI.applyAiRows(resume, [{ key: 'expected_salary', label: '期望薪资', value: '30k' }]);
  assert.equal(result.ok, true);
  assert.equal(result.resume.customFields[0].value, '20k');
  assert.equal(result.kept.length, 1);
});

test('applyAiRows：fullName 写入后标记 manual，不再被自动拼接覆盖', () => {
  const resume = resumeWith({ basics: { firstName: 'San', lastName: 'Zhang' } });
  // 已有「姓+名」会派生出 San Zhang，算已有值 → 必须显式勾覆盖才会写入
  const result = AI.applyAiRows(resume, [
    { key: 'fullName', label: '姓名', value: '张三', overwrite: true }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.resume.basics.fullName, '张三');
  assert.equal(result.resume.fullNameManual, true);
  assert.equal(S.resolveValue(result.resume, 'fullName'), '张三');
});

test('applyAiRows：fullName 已有派生值时，不勾覆盖就保留派生值（不静默改姓名）', () => {
  const resume = resumeWith({ basics: { firstName: 'San', lastName: 'Zhang' } });
  const result = AI.applyAiRows(resume, [{ key: 'fullName', label: '姓名', value: '张三' }]);
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 0);
  assert.equal(result.kept[0].existing, 'San Zhang');
  assert.equal(result.resume.basics.fullName, '');
  assert.equal(S.resolveValue(result.resume, 'fullName'), 'San Zhang');
});

test('applyAiRows：只给姓 + 名时，全名由 schema 自动拼接', () => {
  const resume = S.createEmptyResume();
  const result = AI.applyAiRows(resume, [
    { key: 'lastName', label: '姓', value: '张' },
    { key: 'firstName', label: '名', value: '三' }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.resume.basics.lastName, '张');
  assert.equal(result.resume.basics.firstName, '三');
  assert.equal(S.resolveValue(result.resume, 'fullName'), '张三');
});

test('applyAiRows：非法自定义 key 被拒绝并给出原因', () => {
  const resume = S.createEmptyResume();
  const result = AI.applyAiRows(resume, [{ key: 'BAD KEY', label: '乱写', value: 'x' }]);
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 0);
  assert.ok(result.skipped.some((s) => /不合法/.test(s.reason)));
  assert.equal(result.resume.customFields.length, 0);
});

test('applyAiRows：不修改传入的简历对象（纯函数式拷贝）', () => {
  const resume = resumeWith({ basics: { email: 'old@x.com' } });
  const snapshot = JSON.stringify(resume);
  AI.applyAiRows(resume, [{ key: 'email', value: 'new@x.com', overwrite: true }]);
  assert.equal(JSON.stringify(resume), snapshot);
});

test('applyAiRows：写入后带 updatedAt，且能通过 validateResume', () => {
  const resume = S.createEmptyResume();
  const result = AI.applyAiRows(resume, [{ key: 'summary', label: '经历摘要', value: '5 年前端经验' }]);
  assert.equal(result.ok, true);
  assert.ok(!Number.isNaN(Date.parse(result.resume.updatedAt)));
  const checked = S.validateResume(result.resume);
  assert.equal(checked.ok, true);
  assert.equal(result.resume.summary, '5 年前端经验');
  assert.equal(result.resume.experience, '5 年前端经验');
});
