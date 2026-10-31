/**
 * JustClick — options（简历编辑 + 自定义字段 + 映射规则 + JSON 导入导出）
 *
 * 内置字段由 resume-schema 的 FORM_FIELDS 驱动；自定义字段与映射规则是
 * 迭代 2 的用户数据，独立于内置字典，避免把一次性配置写死进代码。
 */
(function () {
  'use strict';

  var els = {
    form: document.getElementById('resume-form'),
    customList: document.getElementById('custom-fields'),
    addCustomBtn: document.getElementById('add-custom-btn'),
    rulesList: document.getElementById('rules-list'),
    addRuleBtn: document.getElementById('add-rule-btn'),
    reloadRulesBtn: document.getElementById('reload-rules-btn'),
    rulesStatus: document.getElementById('rules-status'),
    saveBtn: document.getElementById('save-btn'),
    exportBtn: document.getElementById('export-btn'),
    importBtn: document.getElementById('import-btn'),
    importInput: document.getElementById('import-input'),
    clearBtn: document.getElementById('clear-btn'),
    status: document.getElementById('status'),
    errors: document.getElementById('errors')
  };

  var dirty = false;
  var rulesState = [];

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

  function markDirty() {
    dirty = true;
    setStatus('有未保存的修改', 'warn');
  }

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setRulesStatus(text, kind) {
    els.rulesStatus.textContent = text;
    els.rulesStatus.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showErrors(list, kind) {
    els.errors.className = 'errors' + (kind ? ' ' + kind : '');
    if (!list || !list.length) {
      els.errors.hidden = true;
      els.errors.textContent = '';
      return;
    }
    els.errors.hidden = false;
    els.errors.textContent = list.join('\n');
  }

  /* ------------------------------------------------------------ 内置表单 */

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
      input.addEventListener('input', markDirty);
      wrap.appendChild(input);
      els.form.appendChild(wrap);
    });
  }

  /* ---------------------------------------------------------- 自定义字段 */

  function customKeyPool() {
    var keys = window.JC.FIELD_KEYS.slice();
    var inputs = els.customList.querySelectorAll('[data-custom-key]');
    for (var i = 0; i < inputs.length; i++) {
      var value = inputs[i].value.trim();
      if (value && keys.indexOf(value) === -1) keys.push(value);
    }
    return keys;
  }

  /** label 能 slug 就用 slug，纯中文/纯符号/数字开头则退到 custom_field_N */
  function suggestKeyForLabel(label) {
    var slug = window.JC.slugifyKey(label);
    if (slug) {
      slug = slug.slice(0, 40).replace(/_+$/g, '');
      if (window.JC.CUSTOM_KEY_RE.test(slug)) return slug;
    }
    return window.JC.nextCustomKey(customKeyPool());
  }

  function customInput(placeholder, attrName) {
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.setAttribute(attrName, '');
    return input;
  }

  function createCustomRow(field) {
    var data = field || {};
    var row = document.createElement('div');
    row.className = 'custom-row';
    row.setAttribute('data-custom-row', '');

    var labelInput = customInput('标签，如 期望薪资', 'data-custom-label');
    var keyInput = customInput('expected_salary', 'data-custom-key');
    var valueInput = customInput('值，如 30k / 2026-03', 'data-custom-value');
    keyInput.className = 'key-input';

    labelInput.value = data.label || '';
    keyInput.value = data.key || '';
    valueInput.value = data.value || '';
    // 已有 key 视为用户手动确定过，后续改 label 不再覆盖
    keyInput.dataset.auto = data.key ? '0' : '1';

    labelInput.addEventListener('input', function () {
      if (keyInput.dataset.auto !== '0') keyInput.value = suggestKeyForLabel(labelInput.value);
      markDirty();
    });
    keyInput.addEventListener('input', function () {
      keyInput.dataset.auto = '0';
      markDirty();
    });
    valueInput.addEventListener('input', markDirty);

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger small';
    remove.textContent = '删除';
    remove.addEventListener('click', function () {
      row.remove();
      markDirty();
    });

    row.appendChild(labelInput);
    row.appendChild(keyInput);
    row.appendChild(valueInput);
    row.appendChild(remove);
    return row;
  }

  function renderCustomFields(fields) {
    els.customList.innerHTML = '';
    var list = Array.isArray(fields) ? fields : [];
    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '还没有自定义字段。添加后会出现在 popup 的学习下拉与规则目标里。';
      els.customList.appendChild(empty);
      return;
    }
    for (var i = 0; i < list.length; i++) els.customList.appendChild(createCustomRow(list[i]));
  }

  function readCustomFields() {
    var rows = els.customList.querySelectorAll('[data-custom-row]');
    var out = [];
    var used = window.JC.FIELD_KEYS.slice();
    for (var i = 0; i < rows.length; i++) {
      var labelInput = rows[i].querySelector('[data-custom-label]');
      var keyInput = rows[i].querySelector('[data-custom-key]');
      var valueInput = rows[i].querySelector('[data-custom-value]');
      if (!labelInput || !keyInput || !valueInput) continue;

      var label = labelInput.value.trim();
      var key = keyInput.value.trim();
      var value = valueInput.value;
      if (!label && !key && !value) continue;
      if (!key && label) key = suggestKeyForLabel(label);
      if (key && used.indexOf(key) === -1) used.push(key);
      out.push({ key: key, label: label, value: value });
    }
    return out;
  }

  /* -------------------------------------------------------------- 规则表 */

  function currentFields() {
    var draft = readForm();
    var keys = window.JC.getFieldKeys(draft);
    return keys.map(function (key) {
      return { key: key, label: window.JC.labelFor(draft, key) };
    });
  }

  function fieldSelect(selected) {
    var select = document.createElement('select');
    var fields = currentFields();
    var found = false;
    fields.forEach(function (field) {
      var option = document.createElement('option');
      option.value = field.key;
      option.textContent = field.label + ' · ' + field.key;
      if (field.key === selected) {
        option.selected = true;
        found = true;
      }
      select.appendChild(option);
    });
    if (!found && selected) {
      var option = document.createElement('option');
      option.value = selected;
      option.textContent = selected;
      option.selected = true;
      select.appendChild(option);
    }
    return select;
  }

  function labeledField(text, control) {
    var wrap = document.createElement('div');
    wrap.className = 'field';
    var label = document.createElement('label');
    label.textContent = text;
    wrap.appendChild(label);
    wrap.appendChild(control);
    return wrap;
  }

  function rulePatch(rule, patch) {
    window.JC.updateRule(rule.id, patch).then(function (result) {
      if (!result.ok) {
        showErrors(result.errors);
        setRulesStatus('规则未保存：' + result.errors.join('；'), 'warn');
        return;
      }
      showErrors(null);
      setRulesStatus('已保存规则 ' + result.rule.match.pattern, 'ok');
      for (var i = 0; i < rulesState.length; i++) {
        if (rulesState[i].id === result.rule.id) rulesState[i] = result.rule;
      }
    }).catch(function (error) {
      setRulesStatus('规则保存失败：' + ((error && error.message) || error), 'warn');
    });
  }

  function createRuleCard(rule, index) {
    var card = document.createElement('div');
    card.className = 'rule';
    card.setAttribute('data-rule-id', rule.id);

    var head = document.createElement('div');
    head.className = 'rule-head';
    var title = document.createElement('div');
    title.className = 'rule-title';

    var enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = rule.enabled !== false;
    enabled.addEventListener('change', function () {
      rulePatch(rule, { enabled: enabled.checked });
    });
    title.appendChild(enabled);

    var titleText = document.createElement('span');
    titleText.textContent = '规则 ' + (index + 1) + (rule.enabled === false ? '（已禁用）' : '');
    title.appendChild(titleText);
    head.appendChild(title);

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger small';
    remove.textContent = '删除';
    remove.addEventListener('click', function () {
      window.JC.deleteRule(rule.id).then(function (result) {
        if (!result.ok) {
          setRulesStatus('删除失败：' + (result.errors || []).join('；'), 'warn');
          return;
        }
        setRulesStatus('已删除规则', 'ok');
        loadRules();
      });
    });
    head.appendChild(remove);
    card.appendChild(head);

    var grid = document.createElement('div');
    grid.className = 'rule-grid';

    var target = fieldSelect(rule.target);
    target.addEventListener('change', function () {
      rulePatch(rule, { target: target.value });
    });
    grid.appendChild(labeledField('目标字段', target));

    var matchType = document.createElement('select');
    window.JC.MATCH_TYPES.forEach(function (type) {
      var option = document.createElement('option');
      option.value = type;
      option.textContent = type;
      if (type === rule.match.matchType) option.selected = true;
      matchType.appendChild(option);
    });
    matchType.addEventListener('change', function () {
      rulePatch(rule, { match: { matchType: matchType.value } });
    });
    grid.appendChild(labeledField('匹配方式', matchType));

    var pattern = document.createElement('input');
    pattern.type = 'text';
    pattern.value = rule.match.pattern;
    pattern.placeholder = 'expected_salary';
    pattern.addEventListener('change', function () {
      rulePatch(rule, { match: { pattern: pattern.value } });
    });
    grid.appendChild(labeledField('匹配文本', pattern));

    var site = document.createElement('input');
    site.type = 'text';
    site.value = rule.scope && rule.scope.sitePattern ? rule.scope.sitePattern : '';
    site.placeholder = '空 = 全站，如 jobs.example.com';
    site.addEventListener('change', function () {
      rulePatch(rule, { scope: { sitePattern: site.value } });
    });
    grid.appendChild(labeledField('站点限制', site));

    card.appendChild(grid);

    var attrsRow = document.createElement('div');
    attrsRow.className = 'rule-attrs';
    window.JC.ALLOWED_ATTRS.forEach(function (attr) {
      var label = document.createElement('label');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.value = attr;
      box.checked = rule.match.attrs.indexOf(attr) !== -1;
      box.addEventListener('change', function () {
        var attrs = [];
        var boxes = attrsRow.querySelectorAll('input[type="checkbox"]');
        for (var i = 0; i < boxes.length; i++) {
          if (boxes[i].checked) attrs.push(boxes[i].value);
        }
        rulePatch(rule, { match: { attrs: attrs } });
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(attr));
      attrsRow.appendChild(label);
    });
    card.appendChild(attrsRow);

    var foot = document.createElement('div');
    foot.className = 'rule-foot';
    var meta = document.createElement('span');
    meta.className = 'rule-meta';
    meta.textContent =
      '来源 ' + (rule.source || 'manual') + ' · 命中 ' + (rule.hitCount || 0) + ' 次 · ' + (rule.createdAt || '');
    foot.appendChild(meta);
    card.appendChild(foot);

    return card;
  }

  function renderRules(rules) {
    els.rulesList.innerHTML = '';
    if (!rules.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '还没有映射规则。可以在 popup 里点「从当前页学习」，或点下方「新增规则」手写一条。';
      els.rulesList.appendChild(empty);
      return;
    }
    for (var i = 0; i < rules.length; i++) els.rulesList.appendChild(createRuleCard(rules[i], i));
  }

  async function loadRules() {
    try {
      var bag = await window.JC.getRules();
      rulesState = bag.fieldRules || [];
      renderRules(rulesState);
      setRulesStatus('共 ' + rulesState.length + ' 条规则，修改后自动保存', 'ok');
    } catch (error) {
      setRulesStatus('读取规则失败：' + ((error && error.message) || error), 'warn');
    }
  }

  async function addRule() {
    var fields = currentFields();
    var target = fields.length ? fields[0].key : 'fullName';
    var rule = window.JC.createRule({
      match: { attrs: ['name'], pattern: target, matchType: 'contains' },
      target: target,
      scope: { sitePattern: '' },
      source: 'manual'
    });
    var result = await window.JC.addRule(rule);
    if (!result.ok) {
      showErrors(result.errors);
      setRulesStatus('新增规则失败：' + result.errors.join('；'), 'warn');
      return;
    }
    showErrors(null);
    await loadRules();
    setRulesStatus('已新增规则：name 包含 ' + target + ' → ' + target, 'ok');
  }

  /* -------------------------------------------------------------- 表单读写 */

  function fillForm(resume) {
    var inputs = els.form.querySelectorAll('[data-path]');
    for (var i = 0; i < inputs.length; i++) {
      var path = inputs[i].dataset.path;
      var value = path === 'summary' ? window.JC.resolveValue(resume, 'summary') : getPath(resume, path);
      inputs[i].value = typeof value === 'string' ? value : '';
    }
    renderCustomFields(resume.customFields || []);
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
    resume.customFields = readCustomFields();
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
    await loadRules();
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
      fillForm(result.resume);
      if (result.warnings && result.warnings.length) {
        showErrors(result.warnings, 'warn');
        setStatus('已保存，但有 ' + result.warnings.length + ' 项提示', 'warn');
      } else {
        showErrors(null);
        var d = new Date(result.resume.updatedAt);
        setStatus('已保存 · ' + d.toLocaleTimeString('zh-CN'), 'ok');
      }
      // 新 key 可能刚加进来，规则目标下拉需要刷新
      await loadRules();
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
    setStatus('已导出 justclick-resume.json（含自定义字段）', 'ok');
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
      var notices = (parsed.warnings || []).concat(saved.warnings || []);
      showErrors(notices, notices.length ? 'warn' : null);
      setStatus('已导入并保存', 'ok');
      await loadRules();
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
  els.addCustomBtn.addEventListener('click', function () {
    var empty = els.customList.querySelector('.empty');
    if (empty) empty.remove();
    els.customList.appendChild(createCustomRow({}));
    markDirty();
  });
  els.addRuleBtn.addEventListener('click', addRule);
  els.reloadRulesBtn.addEventListener('click', loadRules);
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
