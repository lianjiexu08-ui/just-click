/**
 * JustClick — AI 接口客户端（迭代 4，BYOK）
 *
 * 只做「发请求 / 读响应 / 分类错误」，不碰 DOM、不读写存储。
 * 三条硬约束：
 *   1. 只往用户配置的 baseURL 发请求，不接受任何中转或远程脚本；
 *   2. apiKey 只出现在 Authorization 头里，绝不进错误文案 / console；
 *   3. response_format 不被兼容端点支持时，自动去掉该参数重试一次（仅一次）。
 *
 * 测试通过注入 fetchImpl 驱动，因此单测不需要真实网络。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.JC = root.JC || {};
    for (var k in api) {
      if (Object.prototype.hasOwnProperty.call(api, k)) root.JC[k] = api[k];
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONNECT_TIMEOUT = 2000;
  var EXTRACT_TIMEOUT = 60000;

  function aiModule() {
    if (typeof globalThis !== 'undefined' && globalThis.JC && globalThis.JC.buildPrompt) {
      return globalThis.JC;
    }
    if (typeof require === 'function') {
      try {
        return require('./ai.js');
      } catch (e) {
        /* ignore */
      }
    }
    throw new Error('ai 模块未加载');
  }

  function now() {
    return typeof Date !== 'undefined' && Date.now ? Date.now() : 0;
  }

  /** 去掉尾部斜杠；已经是 /chat/completions 的地址原样返回 */
  function chatUrl(baseURL) {
    var base = typeof baseURL === 'string' ? baseURL.trim() : '';
    if (!base) return '';
    base = base.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(base)) return base;
    return base + '/chat/completions';
  }

  /** 把密钥从任意文本里抹掉，避免端点回显 Authorization 时被带进 UI/日志 */
  function scrub(text, secret) {
    var out = typeof text === 'string' ? text : '';
    if (secret && secret.length >= 4) out = out.split(secret).join('***');
    return out.replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  function missingConfig(settings) {
    if (!settings.baseURL) return '请先填写接口地址 baseURL（如 https://api.deepseek.com/v1）';
    if (!/^https?:\/\/[^\s]+$/i.test(settings.baseURL)) return 'baseURL 必须以 http:// 或 https:// 开头';
    if (!settings.model) return '请先填写模型名（如 deepseek-chat）';
    if (!settings.apiKey) return '请先填写 API Key';
    return '';
  }

  function fromServerBody(data, text) {
    if (data && typeof data === 'object') {
      var err = data.error;
      if (typeof err === 'string' && err) return err;
      if (err && typeof err.message === 'string' && err.message) return err.message;
      if (typeof data.message === 'string' && data.message) return data.message;
    }
    return typeof text === 'string' ? text : '';
  }

  async function readResponse(response) {
    var text = '';
    try {
      text = await response.text();
    } catch (e) {
      text = '';
    }
    var data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e2) {
        data = null;
      }
    }
    return { text: text, data: data };
  }

  /**
   * 发一次 chat/completions，必要时降级重试。
   * @param {object} options {fetchImpl, baseURL, apiKey, model, messages, maxTokens, timeoutMs, responseFormat}
   * @returns {{ok:boolean, content?:string, kind?:string, status?:number, message?:string, attempts:Array, degraded?:boolean, model?:string}}
   */
  async function callChat(options) {
    var opts = options || {};
    var AI = aiModule();
    var settings = {
      baseURL: typeof opts.baseURL === 'string' ? opts.baseURL.trim() : '',
      apiKey: typeof opts.apiKey === 'string' ? opts.apiKey : '',
      model: typeof opts.model === 'string' ? opts.model.trim() : ''
    };
    var configError = missingConfig(settings);
    if (configError) {
      return { ok: false, kind: 'config', status: 0, message: configError, attempts: [] };
    }
    var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (typeof fetchImpl !== 'function') {
      return { ok: false, kind: 'network', status: 0, message: '当前环境没有可用的 fetch', attempts: [] };
    }
    var url = chatUrl(settings.baseURL);
    var messages = Array.isArray(opts.messages) ? opts.messages : [];
    var wantFormat = opts.responseFormat !== false;
    var attempts = [];

    var first = await attempt(wantFormat);
    attempts.push(summarize(first));
    if (!first.ok && wantFormat && AI.shouldRetryWithoutFormat(first)) {
      var second = await attempt(false);
      attempts.push(summarize(second));
      second.attempts = attempts;
      second.degraded = true;
      return second;
    }
    first.attempts = attempts;
    return first;

    async function attempt(withFormat) {
      var body = {
        model: settings.model,
        messages: messages,
        temperature: 0,
        stream: false
      };
      if (typeof opts.maxTokens === 'number' && opts.maxTokens > 0) body.max_tokens = opts.maxTokens;
      if (withFormat) body.response_format = { type: 'json_object' };

      var controller = null;
      var timer = null;
      if (typeof AbortController === 'function') {
        controller = new AbortController();
        var timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : EXTRACT_TIMEOUT;
        timer = setTimeout(function () {
          try {
            controller.abort();
          } catch (e) {
            /* ignore */
          }
        }, timeoutMs);
      }

      var response = null;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + settings.apiKey
          },
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined
        });
      } catch (error) {
        if (timer) clearTimeout(timer);
        var aborted = error && (error.name === 'AbortError' || error.code === 20);
        var info = AI.classifyError({
          kind: aborted ? 'timeout' : 'network',
          message: scrub((error && error.message) || String(error || ''), settings.apiKey)
        });
        return {
          ok: false,
          kind: info.kind,
          status: 0,
          message: info.message,
          detail: info.detail,
          withFormat: withFormat
        };
      }
      if (timer) clearTimeout(timer);

      var read = await readResponse(response);
      if (!response.ok) {
        var failure = AI.classifyError({
          status: response.status,
          message: scrub(fromServerBody(read.data, read.text), settings.apiKey)
        });
        return {
          ok: false,
          kind: failure.kind,
          status: response.status,
          message: failure.message,
          detail: failure.detail,
          withFormat: withFormat
        };
      }
      if (!read.data || typeof read.data !== 'object') {
        return {
          ok: false,
          kind: 'bad_json',
          status: response.status,
          message: AI.ERROR_TEXT.bad_json + '：响应不是 JSON 对象',
          withFormat: withFormat
        };
      }

      var content = '';
      if (Array.isArray(read.data.choices) && read.data.choices.length) {
        var choice = read.data.choices[0];
        if (choice && choice.message && typeof choice.message.content === 'string') content = choice.message.content;
      }
      if (!content.trim()) {
        return {
          ok: false,
          kind: 'bad_json',
          status: response.status,
          message: AI.ERROR_TEXT.bad_json + '：choices[0].message.content 为空',
          withFormat: withFormat
        };
      }
      return {
        ok: true,
        status: response.status,
        content: content,
        model: typeof read.data.model === 'string' ? read.data.model : '',
        usage: read.data.usage || null,
        withFormat: withFormat
      };
    }

    function summarize(result) {
      return {
        ok: !!result.ok,
        status: result.status || 0,
        kind: result.kind || (result.ok ? 'ok' : 'network'),
        withResponseFormat: result.withFormat !== false
      };
    }
  }

  /**
   * 「测试连接」：max_tokens=8 的最小请求，2 秒内给结论。
   * @returns {{ok:boolean, kind:string, status:number, model?:string, ms:number, message:string}}
   */
  async function testConnection(options) {
    var opts = options || {};
    var started = now();
    var timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : CONNECT_TIMEOUT;
    var result = await callChat({
      fetchImpl: opts.fetchImpl,
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
      model: opts.model,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
      timeoutMs: timeoutMs,
      responseFormat: false
    });
    var ms = Math.max(0, Math.round(now() - started));
    if (!result.ok) {
      return { ok: false, kind: result.kind || 'network', status: result.status || 0, message: result.message, ms: ms };
    }
    var model = result.model || opts.model || '';
    return {
      ok: true,
      kind: 'ok',
      status: result.status || 200,
      model: model,
      ms: ms,
      message: '连接成功：' + model + '（' + ms + 'ms）'
    };
  }

  /**
   * 编排一次完整的「文本 → 结构化字段」：buildPrompt → callChat → parseAiResume。
   * 不写存储、不碰 DOM；失败时返回可展示的分类文案。
   */
  async function extractResume(options) {
    var opts = options || {};
    var AI = aiModule();
    var prompt = AI.buildPrompt(opts.fieldSpecs, opts.text);
    if (!prompt.text || !prompt.text.trim()) {
      return { ok: false, kind: 'empty', message: '简历文本为空，先上传 PDF/TXT 或粘贴一段文字', fields: [], attempts: [] };
    }
    var result = await callChat({
      fetchImpl: opts.fetchImpl,
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
      model: opts.model,
      messages: prompt.messages,
      timeoutMs: typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : EXTRACT_TIMEOUT,
      responseFormat: true,
      maxTokens: opts.maxTokens
    });
    if (!result.ok) {
      return {
        ok: false,
        kind: result.kind,
        status: result.status || 0,
        message: result.message,
        fields: [],
        attempts: result.attempts || [],
        degraded: !!result.degraded,
        truncated: prompt.truncated
      };
    }
    var parsed = AI.parseAiResume(result.content, opts.fieldSpecs);
    if (!parsed.ok) {
      return {
        ok: false,
        kind: 'bad_json',
        status: result.status || 0,
        message: parsed.errors.join('；'),
        fields: [],
        attempts: result.attempts || [],
        degraded: !!result.degraded,
        truncated: prompt.truncated
      };
    }
    if (!parsed.fields.length) {
      return {
        ok: false,
        kind: 'empty',
        status: result.status || 0,
        message: AI.ERROR_TEXT.empty + '（可能不是简历，或字段名与模板差异太大）',
        fields: [],
        ignored: parsed.ignored,
        attempts: result.attempts || [],
        degraded: !!result.degraded,
        truncated: prompt.truncated
      };
    }
    return {
      ok: true,
      kind: 'ok',
      status: result.status || 200,
      model: result.model || '',
      fields: parsed.fields,
      ignored: parsed.ignored,
      attempts: result.attempts || [],
      degraded: !!result.degraded,
      truncated: prompt.truncated,
      originalLength: prompt.originalLength
    };
  }

  return {
    CONNECT_TIMEOUT: CONNECT_TIMEOUT,
    EXTRACT_TIMEOUT: EXTRACT_TIMEOUT,
    chatUrl: chatUrl,
    scrub: scrub,
    missingConfig: missingConfig,
    callChat: callChat,
    testConnection: testConnection,
    extractResume: extractResume
  };
});
