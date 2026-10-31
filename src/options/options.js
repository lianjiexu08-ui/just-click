/**
 * JustClick — options（简历编辑 + JSON 导入导出）
 * 表单结构由 resume-schema 的 FORM_FIELDS 驱动，新增字段只需改 schema。
 */
(function () {
  'use strict';

  var els = {
    form: document.getElementById('resume-form'),
    saveBtn: document.getElementById('save-btn'),
    exportBtn: document.getElementById('export-btn'),
    importBtn: document.getElementById('import-btn'),
    importInput: document.getElementById('import-input'),
    clearBtn: document.getElementById('clear-btn'),
    status: document.getElementById('status'),
    errors: document.getElementById('errors')
  };

  var dirty = false;

  function getPath(obj, path) {
    return path.split('.').reduce(function (acc, part) {
      return acc && typeof acc === 'object' ? acc[part] : '';
    }, obj);
  }

  function setPath(obj, path, value) {
    var parts = path.split('.');
    var node = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
    return obj;
  }

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showErrors(list) {
    if (!list || !list.length) {
      els.errors.hidden = true;
      els.errors.textContent = '';
      return;
    }
    els.errors.hidden = false;
    els.errors.textContent = list.join('\n');
  }

  function buildForm() {
    els.form.innerHTML = '';
    window.JC.FORM_FIELDS.forEach(function (field) {
      var wrap = document.createElement('div');
      wrap.className = 'field' + (field.multiline ? ' wide' : '');

      var label = document.createElement('label');
      label.setAttribute('for', 'f-' + field.path);
      label.textContent = field.label;
      wrap.appendChild(label);

      var input = document.createElement(field.multiline ? 'textarea' : 'input');
      input.id = 'f-' + field.path;
      input.dataset.path = field.path;
      if (field.multiline) {
        input.rows = 5;
        input.placeholder = field.placeholder || '';
      } else {
        input.type = field.type || 'text';
        input.placeholder = field.placeholder || '';
        input.autocomplete = 'off';
      }
      input.addEventListener('input', function () {
        dirty = true;
        setStatus('有未保存的修改', 'warn');
      });
      wrap.appendChild(input);
      els.form.appendChild(wrap);
    });
  }

  function fillForm(resume) {
    var inputs = els.form.querySelectorAll('[data-path]');
    for (var i = 0; i < inputs.length; i++) {
      var path = inputs[i].dataset.path;
      var value = path === 'summary' ? window.JC.resolveValue(resume, 'summary') : getPath(resume, path);
      inputs[i].value = typeof value === 'string' ? value : '';
    }
    dirty = false;
  }

  function readForm() {
    var resume = window.JC.createEmptyResume();
    var inputs = els.form.querySelectorAll('[data-path]');
    for (var i = 0; i < inputs.length; i++) {
      var path = inputs[i].dataset.path;
      var raw = inputs[i].value;
      if (path === 'summary') {
        // 经历摘要同时写进 summary 与 experience，保证导入导出与识别都拿得到
        resume.summary = raw;
        resume.experience = raw;
      } else {
        setPath(resume, path, raw);
      }
    }
    return resume;
  }

  async function load() {
    try {
      var resume = await window.JC.getResume();
      fillForm(resume);
      if (resume.updatedAt) {
        var d = new Date(resume.updatedAt);
        setStatus('已载入本地简历（更新于 ' + (isNaN(d.getTime()) ? resume.updatedAt : d.toLocaleString('zh-CN')) + '）');
      } else {
        setStatus('还没有保存过简历，填写后点「保存」');
      }
      showErrors(null);
    } catch (e) {
      setStatus('读取失败：' + ((e && e.message) || e), 'warn');
    }
  }

  async function save() {
    var resume = readForm();
    els.saveBtn.disabled = true;
    try {
      var result = await window.JC.saveResume(resume);
      if (!result.ok) {
        showErrors(result.errors);
        setStatus('保存失败，请检查标红项', 'warn');
        return;
      }
      showErrors(null);
      dirty = false;
      var d = new Date(result.resume.updatedAt);
      setStatus('已保存 · ' + d.toLocaleTimeString('zh-CN'), 'ok');
    } catch (e) {
      setStatus('保存失败：' + ((e && e.message) || e), 'warn');
    } finally {
      els.saveBtn.disabled = false;
    }
  }

  function exportJson() {
    var text = window.JC.exportJSON(readForm());
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'justclick-resume.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    setStatus('已导出 justclick-resume.json', 'ok');
  }

  function importJson(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      var parsed = window.JC.importJSON(String(reader.result || ''));
      if (!parsed.ok) {
        showErrors(parsed.errors);
        setStatus('导入失败：JSON 结构不合法', 'warn');
        return;
      }
      fillForm(parsed.resume);
      var saved = await window.JC.saveResume(parsed.resume);
      if (!saved.ok) {
        showErrors(saved.errors);
        setStatus('导入内容已填入表单，但保存失败', 'warn');
        return;
      }
      showErrors(parsed.warnings && parsed.warnings.length ? parsed.warnings : null);
      setStatus('已导入并保存', 'ok');
    };
    reader.onerror = function () {
      setStatus('文件读取失败', 'warn');
    };
    reader.readAsText(file);
  }

  async function clearAll() {
    if (!window.confirm('确定清空本机保存的简历数据？此操作不可撤销。')) return;
    await window.JC.clearResume();
    fillForm(window.JC.createEmptyResume());
    showErrors(null);
    setStatus('已清空', 'ok');
  }

  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    save();
  });
  els.exportBtn.addEventListener('click', exportJson);
  els.importBtn.addEventListener('click', function () {
    els.importInput.click();
  });
  els.importInput.addEventListener('change', function () {
    importJson(els.importInput.files && els.importInput.files[0]);
    els.importInput.value = '';
  });
  els.clearBtn.addEventListener('click', clearAll);

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });

  window.addEventListener('beforeunload', function (e) {
    if (!dirty) return undefined;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  buildForm();
  load();
})();
