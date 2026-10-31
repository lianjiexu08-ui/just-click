'use strict';

/**
 * 迭代 3 验收 4：内联补填 —— 补值写入存储 + 生成「只填不提交」的增量填充指令。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../src/lib/resume-schema.js');
const SUP = require('../src/lib/supplement.js');

/** 最小 chrome.storage.local stub：进程内一个对象即存储 */
const bag = {};
global.chrome = {
  storage: {
    local: {
      get(key) {
        if (typeof key === 'string') {
          const out = {};
          if (Object.prototype.hasOwnProperty.call(bag, key)) out[key] = bag[key];
          return Promise.resolve(out);
        }
        return Promise.resolve(Object.assign({}, bag));
      },
      set(obj) {
        Object.assign(bag, JSON.parse(JSON.stringify(obj)));
        return Promise.resolve();
      }
    }
  }
};

const Storage = require('../src/lib/storage.js');

test('验收 4：内置字段补值 → 写入存储 → 重新读出', async () => {
  const resume = S.createEmptyResume();
  const applied = SUP.applySupplement(resume, 'email', 'san@example.com');
  assert.equal(applied.ok, true);
  assert.equal(applied.created, false);
  assert.equal(applied.resume.basics.email, 'san@example.com');

  const saved = await Storage.saveResume(applied.resume);
  assert.equal(saved.ok, true);

  const loaded = await Storage.getResume();
  assert.equal(loaded.basics.email, 'san@example.com');
});

test('验收 4：自定义字段补值覆盖原值，不会重复创建', async () => {
  const base = S.createEmptyResume();
  base.customFields = [{ key: 'expected_salary', label: '期望薪资', value: '20k' }];

  const applied = SUP.applySupplement(base, 'expected_salary', '30k');
  assert.equal(applied.ok, true);
  assert.equal(applied.created, false);
  assert.equal(applied.resume.customFields.length, 1);
  assert.equal(applied.resume.customFields[0].value, '30k');
  assert.equal(S.resolveValue(applied.resume, 'expected_salary'), '30k');
});

test('验收 4：简历里没有的字段，补值后自动成为自定义字段', async () => {
  const applied = SUP.applySupplement(S.createEmptyResume(), 'expected_salary', '30k', {
    label: '期望薪资'
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.created, true);
  assert.equal(applied.key, 'expected_salary');
  assert.equal(applied.label, '期望薪资');
  assert.equal(applied.resume.customFields.length, 1);
  assert.deepEqual(applied.resume.customFields[0], {
    key: 'expected_salary',
    label: '期望薪资',
    value: '30k',
    group: 'extra'
  });

  const saved = await Storage.saveResume(applied.resume);
  assert.equal(saved.ok, true);
  const loaded = await Storage.getResume();
  assert.equal(S.resolveValue(loaded, 'expected_salary'), '30k');
});

test('验收 4：空值不写盘，给可读错误', () => {
  const applied = SUP.applySupplement(S.createEmptyResume(), 'email', '   ');
  assert.equal(applied.ok, false);
  assert.ok(applied.errors.some((e) => e.includes('不能为空')));
  assert.equal(applied.resume.basics.email, '');
});

test('验收 4：增量填充指令 submit 恒为 false，且没有任何提交字段', () => {
  const instruction = SUP.buildFillOneInstruction({
    key: 'email',
    value: 'a@b.c',
    label: '邮箱',
    url: 'https://jobs.example.com/apply'
  });

  assert.equal(instruction.type, 'JC_FILL_ONE');
  assert.equal(instruction.submit, false);
  assert.equal(instruction.key, 'email');
  assert.equal(instruction.value, 'a@b.c');
  assert.equal(SUP.isNonSubmittingInstruction(instruction), true);

  // 任何带提交意图的变体都必须被拦下
  assert.equal(SUP.isNonSubmittingInstruction(Object.assign({}, instruction, { submit: true })), false);
  assert.equal(SUP.isNonSubmittingInstruction(Object.assign({}, instruction, { formSubmit: true })), false);
  assert.equal(SUP.isNonSubmittingInstruction(Object.assign({}, instruction, { submit: undefined })), false);
  assert.equal(SUP.isNonSubmittingInstruction(null), false);
  for (const key of SUP.FORBIDDEN_KEYS) {
    assert.ok(!Object.prototype.hasOwnProperty.call(instruction, key), `指令里不该出现 ${key}`);
  }
});

test('验收 4：content script 只填值，源码里不存在任何提交调用', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'content.js'), 'utf8');
  // 注释里允许提「不要提交」，真正要检查的是可执行代码
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  assert.ok(source.includes('JC_FILL_ONE'), 'content script 必须处理增量填充指令');
  assert.ok(!/\.submit\s*\(/.test(source), '不得调用 form.submit()');
  assert.ok(!/requestSubmit\s*\(/.test(source), '不得调用 form.requestSubmit()');
  assert.ok(!/\.click\s*\(/.test(source), '不得模拟点击（可能命中提交按钮）');
  assert.ok(!/(submitButton|btnSubmit)/.test(source), '不得查找提交按钮');
});
