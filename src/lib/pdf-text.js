/**
 * JustClick — PDF 文本提取（迭代 4）
 *
 * pdf.js 已经 vendor 化到仓库（vendor/pdfjs/，Apache-2.0），build 会原样拷到
 * dist/vendor/pdfjs/。MV3 禁止远程代码，所以这里只允许用 chrome.runtime.getURL
 * 指到扩展内资源，**任何 CDN 地址都是 bug**。
 *
 * 纯函数部分（chunkText / 扩展名判断 / 扫描件判断）可在 Node 单测；
 * extractPdfText 依赖 pdf.js 与浏览器 DOM，只能在真实 Chrome 里验（见 docs/MANUAL-TEST.md）。
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

  var PDF_MODULE_PATH = 'vendor/pdfjs/pdf.min.mjs';
  var PDF_WORKER_PATH = 'vendor/pdfjs/pdf.worker.min.mjs';
  var PDFJS_VERSION_HINT = '4.x';
  /** 文本少于该长度就当成「没有文本层」（扫描件） */
  var SCANNED_TEXT_MIN = 20;

  function aiModule() {
    if (typeof globalThis !== 'undefined' && globalThis.JC && globalThis.JC.chunkText) {
      return globalThis.JC;
    }
    if (typeof require === 'function') {
      try {
        return require('./ai.js');
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  /** 文本截断（实现只有一份，在 ai.js；这里做转发方便调用方就近使用） */
  function chunkText(text, limit) {
    var AI = aiModule();
    if (AI && typeof AI.chunkText === 'function') return AI.chunkText(text, limit);
    var max = typeof limit === 'number' && limit > 0 ? limit : 30000;
    var raw = typeof text === 'string' ? text : '';
    if (raw.length <= max) return { text: raw, truncated: false, originalLength: raw.length, limit: max };
    return { text: raw.slice(0, max), truncated: true, originalLength: raw.length, limit: max };
  }

  /** 扩展内资源的绝对 URL；非扩展环境（单测/预览）退化为相对路径 */
  function extensionUrl(relativePath) {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
      return chrome.runtime.getURL(relativePath);
    }
    return relativePath;
  }

  function fileExtension(name) {
    var text = typeof name === 'string' ? name : '';
    var dot = text.lastIndexOf('.');
    if (dot === -1) return '';
    return text.slice(dot + 1).toLowerCase();
  }

  function isPdfFile(name) {
    return fileExtension(name) === 'pdf';
  }

  function isTextFile(name) {
    var ext = fileExtension(name);
    return ext === 'txt' || ext === 'md' || ext === 'markdown' || ext === 'text';
  }

  /** 扫描件判定：去掉空白后字符太少，说明没有文本层 */
  function isProbablyScanned(text) {
    var stripped = typeof text === 'string' ? text.replace(/\s+/g, '') : '';
    return stripped.length < SCANNED_TEXT_MIN;
  }

  /**
   * 加载 pdf.js。优先用调用方注入的实例（便于复用与测试），
   * 否则动态 import 扩展内的本地文件，并把 worker 指到扩展内。
   */
  async function loadPdfJs(options) {
    var opts = options || {};
    if (opts.pdfjs && typeof opts.pdfjs.getDocument === 'function') return opts.pdfjs;
    if (typeof globalThis !== 'undefined' && globalThis.pdfjsLib && globalThis.pdfjsLib.getDocument) {
      return globalThis.pdfjsLib;
    }
    var moduleUrl = opts.moduleUrl || extensionUrl(PDF_MODULE_PATH);
    var mod = null;
    try {
      mod = await import(moduleUrl);
    } catch (error) {
      throw new Error('pdf.js 加载失败（' + String((error && error.message) || error) + '），请重新 npm run build');
    }
    var lib = null;
    if (mod && typeof mod.getDocument === 'function') lib = mod;
    else if (mod && mod.default && typeof mod.default.getDocument === 'function') lib = mod.default;
    else if (mod && mod.pdfjsLib && typeof mod.pdfjsLib.getDocument === 'function') lib = mod.pdfjsLib;
    if (!lib) throw new Error('pdf.js 模块结构异常：找不到 getDocument（期望 ' + PDFJS_VERSION_HINT + '）');

    if (lib.GlobalWorkerOptions) {
      lib.GlobalWorkerOptions.workerSrc = opts.workerUrl || extensionUrl(PDF_WORKER_PATH);
    }
    return lib;
  }

  /**
   * 逐页提取文本，页间用 \n 连接。
   * @param {ArrayBuffer|Uint8Array} arrayBuffer PDF 二进制
   * @param {object} [options] {pdfjs, moduleUrl, workerUrl, onProgress(done,total)}
   * @returns {Promise<string>}
   */
  async function extractPdfText(arrayBuffer, options) {
    var opts = options || {};
    if (!arrayBuffer || typeof arrayBuffer.byteLength !== 'number' || arrayBuffer.byteLength === 0) {
      throw new Error('PDF 文件为空或读取失败');
    }
    if (typeof arrayBuffer.byteLength === 'number' && arrayBuffer.byteLength < 5) {
      throw new Error('这不是一个有效的 PDF 文件');
    }
    var lib = await loadPdfJs(opts);

    var task = lib.getDocument({
      data: arrayBuffer,
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0
    });
    var doc = await task.promise;
    var pages = [];
    try {
      for (var pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        var page = await doc.getPage(pageNumber);
        var content = await page.getTextContent();
        var items = (content && content.items) || [];
        var buffer = [];
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (!item) continue;
          if (typeof item.str === 'string') buffer.push(item.str);
          if (item.hasEOL) buffer.push('\n');
        }
        var text = buffer
          .join('')
          .replace(/[ \t\u00a0]+/g, ' ')
          .replace(/ *\n */g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        pages.push(text);
        if (typeof opts.onProgress === 'function') {
          try {
            opts.onProgress(pageNumber, doc.numPages);
          } catch (e) {
            /* 进度回调不应该影响提取 */
          }
        }
        if (typeof page.cleanup === 'function') page.cleanup();
      }
    } finally {
      if (typeof doc.destroy === 'function') {
        try {
          await doc.destroy();
        } catch (e) {
          /* ignore */
        }
      }
    }
    return pages.join('\n');
  }

  /**
   * 从 File 读文本：PDF 走 pdf.js，TXT/MD 直接读。
   * @returns {Promise<{ok:boolean, text:string, kind:string, error:string, scanned:boolean}>}
   */
  async function extractTextFromFile(file, options) {
    var opts = options || {};
    var name = file && typeof file.name === 'string' ? file.name : '';
    if (!file) return { ok: false, text: '', kind: '', error: '没有选择文件', scanned: false };

    if (isPdfFile(name)) {
      try {
        var buffer = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : null;
        if (!buffer) return { ok: false, text: '', kind: 'pdf', error: '这个文件读不出二进制内容', scanned: false };
        var text = await extractPdfText(buffer, opts);
        if (isProbablyScanned(text)) {
          return {
            ok: false,
            text: text,
            kind: 'pdf',
            scanned: true,
            error: '该 PDF 没有可提取的文本层，可能是扫描件或图片型 PDF；请改用「粘贴文本」方式'
          };
        }
        return { ok: true, text: text, kind: 'pdf', error: '', scanned: false };
      } catch (error) {
        return {
          ok: false,
          text: '',
          kind: 'pdf',
          scanned: false,
          error: 'PDF 解析失败：' + String((error && error.message) || error)
        };
      }
    }

    if (isTextFile(name) || !name) {
      try {
        var raw = typeof file.text === 'function' ? await file.text() : '';
        if (isProbablyScanned(raw)) {
          return { ok: false, text: raw, kind: 'text', error: '文件内容为空或太短，请检查是不是选错了文件', scanned: false };
        }
        return { ok: true, text: raw, kind: 'text', error: '', scanned: false };
      } catch (error) {
        return { ok: false, text: '', kind: 'text', error: '文件读取失败：' + String((error && error.message) || error) };
      }
    }

    return { ok: false, text: '', kind: '', error: '只支持 .pdf 与 .txt 文件', scanned: false };
  }

  return {
    PDF_MODULE_PATH: PDF_MODULE_PATH,
    PDF_WORKER_PATH: PDF_WORKER_PATH,
    SCANNED_TEXT_MIN: SCANNED_TEXT_MIN,
    chunkText: chunkText,
    extensionUrl: extensionUrl,
    fileExtension: fileExtension,
    isPdfFile: isPdfFile,
    isTextFile: isTextFile,
    isProbablyScanned: isProbablyScanned,
    loadPdfJs: loadPdfJs,
    extractPdfText: extractPdfText,
    extractTextFromFile: extractTextFromFile
  };
});
