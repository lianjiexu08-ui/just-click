'use strict';

/**
 * 迭代 4 验收 5：测试连接按钮的三分支（200 / 401 / 网络错误）、
 * response_format 降级重试、错误分类，以及「key 只进 Authorization 头」。
 *
 * 全部用注入的 fetchImpl 驱动，不访问真实网络。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const Client = require('../src/lib/ai-client.js');
const AI = require('../src/lib/ai.js');
const S = require('../src/lib/resume-schema.js');

const SECRET = 'sk-test-secret-0123456789';
const BASE = 'https://api.deepseek.com/v1';

function makeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

function okBody(content, model = 'deepseek-chat') {
  return { model, choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 12 } };
}

test('chatUrl：/v1 与 /v1/ 都拼成 /v1/chat/completions，已带路径的原样保留', () => {
  assert.equal(Client.chatUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(Client.chatUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(Client.chatUrl('https://x.com/v1/chat/completions'), 'https://x.com/v1/chat/completions');
  assert.equal(Client.chatUrl(''), '');
});

test('测试连接 200：返回 ✓ 模型名', async () => {
  const calls = [];
  const result = await Client.testConnection({
    baseURL: BASE,
    apiKey: SECRET,
    model: 'deepseek-chat',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeResponse(200, okBody('pong'));
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'deepseek-chat');
  assert.match(result.message, /连接成功/);
  assert.ok(typeof result.ms === 'number');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BASE + '/chat/completions');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.max_tokens, 8, '测试连接必须是 max_tokens=8 的小请求');
  assert.equal(body.response_format, undefined, '测试连接不带 response_format');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + SECRET);
});

test('测试连接 401：分类为 auth，文案提示 key 无效', async () => {
  const result = await Client.testConnection({
    baseURL: BASE,
    apiKey: SECRET,
    model: 'deepseek-chat',
    fetchImpl: async () => makeResponse(401, { error: { message: 'Invalid API key provided' } })
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'auth');
  assert.match(result.message, /API Key/);
  assert.match(result.message, /401/);
});

test('测试连接网络失败：分类为 network，不抛异常', async () => {
  const result = await Client.testConnection({
    baseURL: BASE,
    apiKey: SECRET,
    model: 'deepseek-chat',
    fetchImpl: async () => {
      const error = new Error('Failed to fetch');
      error.name = 'TypeError';
      throw error;
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'network');
  assert.match(result.message, /网络/);
});

test('测试连接 404：分类为 not_found，提示检查 baseURL / 模型名，且不重试', async () => {
  let calls = 0;
  const result = await Client.testConnection({
    baseURL: BASE,
    apiKey: SECRET,
    model: 'not-exist-model',
    fetchImpl: async () => {
      calls += 1;
      return makeResponse(404, { error: { message: 'model not found' } });
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'not_found');
  assert.match(result.message, /404/);
  assert.equal(calls, 1, '404 不该降级重试');
});

test('response_format 被拒：自动去掉参数重试一次，并标记 degraded', async () => {
  const bodies = [];
  let attempt = 0;
  const result = await Client.callChat({
    baseURL: BASE,
    apiKey: SECRET,
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      attempt += 1;
      if (attempt === 1) {
        return makeResponse(400, { error: { message: 'response_format is not supported by this model' } });
      }
      return makeResponse(200, okBody('{"email":"a@b.c"}'));
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  assert.equal(bodies[1].response_format, undefined, '第二次请求必须去掉 response_format');
  assert.equal(JSON.parse(result.content).email, 'a@b.c');
});

test('429 限流：不降级重试（重试只会更糟）', async () => {
  let calls = 0;
  const result = await Client.callChat({
    baseURL: BASE,
    apiKey: SECRET,
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async () => {
      calls += 1;
      return makeResponse(429, { error: { message: 'rate limit exceeded' } });
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'rate_limit');
  assert.equal(calls, 1);
  assert.equal(result.attempts.length, 1);
});

test('未配置时直接给引导，不发请求', async () => {
  let calls = 0;
  const result = await Client.testConnection({
    baseURL: '',
    apiKey: '',
    model: '',
    fetchImpl: async () => {
      calls += 1;
      return makeResponse(200, okBody('pong'));
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'config');
  assert.match(result.message, /baseURL/);
  assert.equal(calls, 0);
});

test('200 但 content 为空：分类为 bad_json', async () => {
  const result = await Client.callChat({
    baseURL: BASE,
    apiKey: SECRET,
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async () => makeResponse(200, { choices: [{ message: { content: '   ' } }] })
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'bad_json');
});

test('extractResume：围栏 JSON → 结构化字段，未知 key 进 ignored', async () => {
  const resume = S.createEmptyResume();
  const specs = AI.buildFieldSpecs(resume);
  let promptText = '';
  const result = await Client.extractResume({
    baseURL: BASE,
    apiKey: SECRET,
    model: 'deepseek-chat',
    fieldSpecs: specs,
    text: '张三，邮箱 san@example.com，电话 13800000000',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      promptText = body.messages[1].content;
      return makeResponse(
        200,
        okBody('```json\n{"fullName":"张三","email":"san@example.com","phone":13800000000,"unknown_key":"x"}\n```')
      );
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.fields.length, 3);
  assert.deepEqual(result.fields.map((f) => f.key).sort(), ['email', 'fullName', 'phone']);
  assert.deepEqual(result.ignored, ['unknown_key']);
  assert.equal(result.fields.find((f) => f.key === 'phone').value, '13800000000');
  assert.match(promptText, /只输出 JSON 对象/);
  assert.equal(result.truncated, false);
});

test('extractResume：空文本不发请求，返回 empty 分类', async () => {
  let calls = 0;
  const result = await Client.extractResume({
    baseURL: BASE,
    apiKey: SECRET,
    model: 'deepseek-chat',
    fieldSpecs: ['email'],
    text: '   ',
    fetchImpl: async () => {
      calls += 1;
      return makeResponse(200, okBody('{}'));
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'empty');
  assert.equal(calls, 0);
});

test('extractResume：AI 返回空对象 → empty（不写入任何字段）', async () => {
  const result = await Client.extractResume({
    baseURL: BASE,
    apiKey: SECRET,
    model: 'deepseek-chat',
    fieldSpecs: ['email'],
    text: '一段不像简历的文字',
    fetchImpl: async () => makeResponse(200, okBody('{}'))
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'empty');
  assert.deepEqual(result.fields, []);
});

test('apiKey 永远不出现在请求体、错误文案与 console 里', async () => {
  const captured = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = {};
  for (const method of methods) {
    originals[method] = console[method];
    console[method] = (...args) => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }
  let seenBody = '';
  let seenMessage = '';
  try {
    const failure = await Client.testConnection({
      baseURL: BASE,
      apiKey: SECRET,
      model: 'deepseek-chat',
      fetchImpl: async (url, init) => {
        seenBody = init.body;
        // 模拟端点把 Authorization 回显在错误里
        return makeResponse(401, { error: { message: 'Invalid key: Bearer ' + SECRET } });
      }
    });
    seenMessage = failure.message;
  } finally {
    for (const method of methods) console[method] = originals[method];
  }
  assert.equal(captured.length, 0, 'ai-client 不应该有任何 console 输出');
  assert.ok(!seenBody.includes(SECRET), '请求体里不该出现 key');
  assert.ok(!seenMessage.includes(SECRET), '错误文案必须抹掉 key');
  assert.match(seenMessage, /\*\*\*/);
});
