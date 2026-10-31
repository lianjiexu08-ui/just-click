'use strict';

/**
 * 存储层单元测试：用假的 chrome.storage.local 验证持久化链路
 * （对应验收标准 2「options 页保存的数据持久化」）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// resume-schema 先加载，storage.js 会从 globalThis.JC 取纯函数，无需 chrome。
const S = require('../src/lib/resume-schema.js');

const bag = {};
const listeners = [];

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
    },
    onChanged: {
      addListener(fn) {
        listeners.push(fn);
      },
      removeListener(fn) {
        const index = listeners.indexOf(fn);
        if (index !== -1) listeners.splice(index, 1);
      }
    }
  }
};

const Storage = require('../src/lib/storage.js');

test('存储键固定为 jc.resume', () => {
  assert.equal(Storage.STORAGE_KEY, 'jc.resume');
});

test('空存储时返回空 schema，而不是 undefined', async () => {
  delete bag['jc.resume'];
  const resume = await Storage.getResume();
  assert.equal(resume.version, S.RESUME_VERSION);
  assert.equal(resume.basics.email, '');
});

test('保存后能原样读回，并带上 updatedAt', async () => {
  const resume = S.createEmptyResume();
  resume.basics.fullName = '张三';
  resume.basics.email = 'zhangsan@example.com';
  resume.basics.phone = '13800000000';

  const saved = await Storage.saveResume(resume);
  assert.equal(saved.ok, true);
  assert.ok(saved.resume.updatedAt, '保存后应有 updatedAt');
  assert.ok(!Number.isNaN(Date.parse(saved.resume.updatedAt)), 'updatedAt 应是合法时间');

  const loaded = await Storage.getResume();
  assert.equal(loaded.basics.fullName, '张三');
  assert.equal(loaded.basics.email, 'zhangsan@example.com');
  assert.equal(loaded.basics.phone, '13800000000');
});

test('保存时会做类型校验，非法数据不落盘', async () => {
  const before = JSON.stringify(bag['jc.resume']);
  const result = await Storage.saveResume({ basics: { email: { bad: true } } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('basics.email')));
  assert.equal(JSON.stringify(bag['jc.resume']), before, '校验失败时不应覆盖已存数据');
});

test('存储里的脏数据不会让读取崩掉', async () => {
  bag['jc.resume'] = 'this is not a resume';
  const resume = await Storage.getResume();
  assert.equal(resume.version, S.RESUME_VERSION);
  assert.equal(resume.basics.email, '');
});

test('clearResume 会写回空简历', async () => {
  const resume = S.createEmptyResume();
  resume.basics.email = 'a@b.c';
  await Storage.saveResume(resume);
  await Storage.clearResume();
  const loaded = await Storage.getResume();
  assert.equal(loaded.basics.email, '');
});
