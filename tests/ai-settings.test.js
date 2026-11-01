'use strict';

/**
 * 迭代 4 验收 4：AI 设置持久化（save/load round-trip，storage stub），
 * 以及「apiKey 不出现在 console / 导出 JSON / 错误文案里」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

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

const Settings = require('../src/lib/ai-settings.js');
const S = require('../src/lib/resume-schema.js');

const SECRET = 'sk-test-secret-0123456789';

test('设置存储键独立于简历（jc.aiSettings）', () => {
  assert.equal(Settings.AI_SETTINGS_KEY, 'jc.aiSettings');
});

test('save → load round-trip（baseURL / apiKey / model 全保留）', async () => {
  const saved = await Settings.saveAiSettings({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: SECRET,
    model: 'deepseek-chat'
  });
  assert.equal(saved.ok, true);

  const loaded = await Settings.loadAiSettings();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.settings.baseURL, 'https://api.deepseek.com/v1');
  assert.equal(loaded.settings.apiKey, SECRET);
  assert.equal(loaded.settings.model, 'deepseek-chat');
  assert.equal(loaded.configured, true);
});

test('baseURL 尾部斜杠被归一化，不会拼出 //chat/completions', async () => {
  await Settings.saveAiSettings({ baseURL: 'https://api.example.com/v1/', apiKey: SECRET, model: 'm' });
  const loaded = await Settings.loadAiSettings();
  assert.equal(loaded.settings.baseURL, 'https://api.example.com/v1');
});

test('非法 baseURL / 空模型不落盘', async () => {
  const before = JSON.stringify(bag['jc.aiSettings']);
  const bad = await Settings.saveAiSettings({ baseURL: 'api.deepseek.com', apiKey: SECRET, model: 'm' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('baseURL')));
  assert.equal(JSON.stringify(bag['jc.aiSettings']), before, '校验失败不应覆盖已存设置');

  const noModel = await Settings.saveAiSettings({ baseURL: 'https://a.com/v1', apiKey: SECRET, model: '  ' });
  assert.equal(noModel.ok, false);
  assert.ok(noModel.errors.some((e) => e.includes('模型')));
});

test('未配置时 isConfigured=false，配置齐了才 true', () => {
  assert.equal(Settings.isConfigured({ baseURL: 'https://a.com/v1', model: 'm', apiKey: '' }), false);
  assert.equal(Settings.isConfigured({ baseURL: '', model: 'm', apiKey: 'k' }), false);
  assert.equal(Settings.isConfigured({ baseURL: 'https://a.com/v1', model: 'm', apiKey: 'k' }), true);
});

test('maskKey 不返回明文；describeSettings 只给 hasKey', () => {
  assert.equal(Settings.maskKey(''), '');
  assert.equal(Settings.maskKey(SECRET), '●●●●●●');
  assert.ok(!Settings.maskKey(SECRET).includes('sk-'));
  const view = Settings.describeSettings({ baseURL: 'https://a.com/v1', model: 'm', apiKey: SECRET });
  assert.equal(view.hasKey, true);
  assert.equal(view.keyPreview, '●●●●●●');
  assert.ok(!JSON.stringify(view).includes(SECRET));
});

test('清除 key 保留 baseURL 与模型', async () => {
  await Settings.saveAiSettings({ baseURL: 'https://api.deepseek.com/v1', apiKey: SECRET, model: 'deepseek-chat' });
  const cleared = await Settings.clearApiKey();
  assert.equal(cleared.ok, true);
  const loaded = await Settings.loadAiSettings();
  assert.equal(loaded.settings.apiKey, '');
  assert.equal(loaded.settings.baseURL, 'https://api.deepseek.com/v1');
  assert.equal(loaded.settings.model, 'deepseek-chat');
  assert.equal(loaded.configured, false);
});

test('apiKey 不进入任何 console 输出', async () => {
  const captured = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const originals = {};
  for (const method of methods) {
    originals[method] = console[method];
    console[method] = (...args) => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }
  try {
    await Settings.saveAiSettings({ baseURL: 'https://api.deepseek.com/v1', apiKey: SECRET, model: 'deepseek-chat' });
    await Settings.loadAiSettings();
    await Settings.clearApiKey();
    await Settings.saveAiSettings({ baseURL: 'https://api.deepseek.com/v1', apiKey: SECRET, model: 'deepseek-chat' });
    // 带空格的 key 会触发错误文案，这条最容易把 key 拼进 message
    await Settings.saveAiSettings({ baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-test secret-0123', model: 'm' });
    Settings.describeSettings({ baseURL: 'https://a.com/v1', model: 'm', apiKey: SECRET });
  } finally {
    for (const method of methods) console[method] = originals[method];
  }
  assert.deepEqual(captured, [], '设置模块不应该有任何 console 输出');
});

test('简历导出 JSON 里不含 API Key', async () => {
  await Settings.saveAiSettings({ baseURL: 'https://api.deepseek.com/v1', apiKey: SECRET, model: 'deepseek-chat' });
  const resume = S.createEmptyResume();
  resume.basics.email = 'a@b.c';
  const json = S.exportJSON(resume);
  assert.ok(!json.includes(SECRET));
  assert.ok(!json.includes('apiKey'));
});
