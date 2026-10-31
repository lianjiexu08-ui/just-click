/**
 * JustClick — options（迭代 3：简历模板重构）
 *
 * 页面结构：工具条（导出/导入/清空）→ 完整度 → 三组模板 → 待填清单 → 映射规则。
 * 交互原则：每一项失焦即保存（防抖 400ms，可注入计时器，逻辑在 lib/template.js），
 * 没有「保存」按钮；内置字段不可删只能清空，自定义项可删。
 */
(function () {
  'use strict';

  var els = {
    template: document.getElementById('template'),
    completenessTotal: document.getElementById('completeness-total'),
    completenessBar: document.getElementById('completeness-bar'),
    exportBtn: document.getElementById('export-btn'),
    importBtn: document.getElementById('import-btn'),
    importInput: document.getElementById('import-input'),
    clearBtn: document.getElementById('clear-btn'),
    saveHint: document.getElementById('save-hint'),
    status: document.getElementById('status'),
    errors: document.getElementById('errors'),
    pendingList: document.getElementById('pending-list'),
    pendingRefresh: document.getElementById('pending-refresh'),
    pendingStatus: document.getElementById('pending-status'),
    rulesList: document.getElementById('rules-list'),
    addRuleBtn: document.getElementById('add-rule-btn'),
    reloadRulesBtn: document.getElementById('reload-rules-btn'),
    rulesStatus: document.getElementById('rules-status')
  };

  var model = null;
  var groups = [];
  var rulesState = [];

  var saver = window.JC.createDebouncedSaver({
    delay: window.JC.SAVE_DELAY,
    save: function () {
      return persist();
    }
  });

  /* ---------------------------------------------------------------- 提示 */

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setPendingStatus(text, kind) {
    els.pendingStatus.textContent = text;
    els.pendingStatus.className = 'status' + (kind ? ' ' + kind : '');
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

  /* -------------------------------------------------------------- 数据层 */

  /** 把一行输入写回 model（不做 trim，避免打字过程中光标乱跳） */
  function setValue(target, key, raw) {
    if (key === 'summary' || key === 'experience') {
      target.summary = raw;
      target.experience = raw;
      return;
    }
    if (key === 'fullName') {
      // 全名特殊：等于「姓 + 名」自动拼接结果时不留值（保持自动），
      // 只有用户真的写了别的内容（或手动清空）才记成手动并冻结自动拼接
      var trimmed = typeof raw === 'string' ? raw.trim() : '';
      var composed = window.JC.composeFullName(target.basics.firstName, target.basics.lastName);
      if (trimmed && trimmed !== composed) {
        target.basics.fullName = raw;
        target.fullNameManual = true;
      } else if (!trimmed && composed) {
        target.basics.fullName = '';
        target.fullNameManual = true;
      } else {
        target.basics.fullName = '';
        target.fullNameManual = false;
      }
      return;
    }
    if (window.JC.isBuiltinFieldKey(key)) {
      target.basics[key] = raw;
      return;
    }
    for (var i = 0; i < target.customFields.length; i++) {
      if (target.customFields[i].key === key) {
        target.customFields[i].value = raw;
        return;
      }
    }
  }

  function currentValue(key) {
    if (key === 'summary' || key === 'experience') return model.summary || '';
    if (window.JC.isBuiltinFieldKey(key)) return model.basics[key] || '';
    for (var i = 0; i < model.customFields.length; i++) {
      if (model.customFields[i].key === key) return model.customFields[i].value || '';
    }
    return '';
  }

  function persist() {
    return window.JC.saveResume(model).then(function (result) {
      if (!result.ok) {
        showErrors(result.errors);
        setStatus('保存失败，请检查提示项', 'warn');
        return result;
      }
      model = result.resume;
      showErrors(result.warnings && result.warnings.length ? result.warnings : null, 'warn');
      var d = new Date(result.resume.updatedAt);
      els.saveHint.textContent = '已保存 ✓ ' + (isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN'));
      setStatus('本地已保存（' + model.customFields.length + ' 个自定义项）');
      updateCompleteness();
      return result;
    }).catch(function (error) {
      setStatus('保存失败：' + ((error && error.message) || error), 'warn');
      return { ok: false };
    });
  }

  /* ---------------------------------------------------------- 完整度 */

  function updateCompleteness() {
    groups = window.JC.templatesFor(model, { seed: false });
    var stats = window.JC.computeCompleteness(groups, model);
    els.completenessTotal.textContent = stats.filled + ' / ' + stats.total;
    els.completenessBar.style.width = stats.percent + '%';

    for (var i = 0; i < stats.groups.length; i++) {
      var detail = stats.groups[i];
      var count = document.querySelector('[data-group-count="' + detail.id + '"]');
      if (count) count.textContent = '已填 ' + detail.filled + ' / ' + detail.total;
      var bar = document.querySelector('[data-group-bar="' + detail.id + '"] i');
      if (bar) bar.style.width = detail.percent + '%';
    }
    return stats;
  }

  /* ------------------------------------------------------------ 模板渲染 */

  function composedNamePreview() {
    var composed = window.JC.composeFullName(model.basics.firstName, model.basics.lastName);
    if (!composed) return '';
    if (model.fullNameManual === true) return '';
    return '留空自动拼接：' + composed;
  }

  function fieldInput(row) {
    var input = document.createElement(row.multiline ? 'textarea' : 'input');
    input.id = 'f-' + row.key;
    input.setAttribute('data-field-key', row.key);
    input.setAttribute('data-group', row.group);
    input.autocomplete = 'off';
    if (row.multiline) {
      input.rows = 4;
      input.placeholder = row.placeholder || '';
    } else {
      input.type = row.type || 'text';
      input.placeholder = row.placeholder || '';
    }
    input.value = row.value || '';
    if (row.autoCompose) {
      var preview = composedNamePreview();
      if (preview) input.placeholder = preview;
    }

    input.addEventListener('input', function () {
      setValue(model, row.key, input.value);
      saver.push(model);
      updateCompleteness();
    });
    input.addEventListener('blur', function () {
      setValue(model, row.key, input.value);
      saver.push(model);
      saver.flush();
    });
    return input;
  }

  function createRow(row) {
    var wrap = document.createElement('div');
    wrap.className = 'tpl-row' + (row.multiline ? ' wide' : '') + (row.kind === 'custom' ? ' custom' : '');
    wrap.setAttribute('data-tpl-row', '');
    wrap.setAttribute('data-key', row.key);

    var label = document.createElement('label');
    label.className = 'tpl-label';
    label.setAttribute('for', 'f-' + row.key);
    label.textContent = row.label;
    wrap.appendChild(label);

    var body = document.createElement('div');
    body.className = 'tpl-body';
    body.appendChild(fieldInput(row));
    wrap.appendChild(body);

    if (row.kind === 'custom') {
      var key = document.createElement('code');
      key.className = 'tpl-key';
      key.textContent = row.key;
      key.title = '存储用 key（自定义项）';
      wrap.appendChild(key);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger small';
      remove.textContent = '删除';
      remove.addEventListener('click', function () {
        var result = window.JC.removeCustomField(model, row.key);
        if (!result.ok) {
          showErrors([result.error], 'warn');
          return;
        }
        model = result.resume;
        persist().then(function () {
          renderGroups();
          renderPending();
        });
      });
      wrap.appendChild(remove);
    }

    return wrap;
  }

  function startDraft(groupId) {
    var rowsHost = document.querySelector('[data-group-rows="' + groupId + '"]');
    if (!rowsHost || rowsHost.querySelector('[data-draft]')) return;

    var draft = document.createElement('div');
    draft.className = 'tpl-row draft';
    draft.setAttribute('data-draft', '');

    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = '新字段名，如 期望薪资 / portfolio';
    labelInput.autocomplete = 'off';
    labelInput.className = 'draft-label';

    var hint = document.createElement('span');
    hint.className = 'draft-hint';
    hint.textContent = '写名字后回车或点「添加」，key 会自动生成（同一个名字不会重复创建）';

    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'primary small';
    add.textContent = '添加';

    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost small';
    cancel.textContent = '取消';

    function commit() {
      var result = window.JC.addCustomField(model, labelInput.value, groupId);
      if (!result.ok) {
        hint.textContent = result.error || '添加失败';
        hint.className = 'draft-hint warn';
        return;
      }
      model = result.resume;
      persist().then(function () {
        renderGroups();
        var input = document.querySelector('[data-field-key="' + result.field.key + '"]');
        if (input) input.focus();
      });
    }

    add.addEventListener('click', commit);
    cancel.addEventListener('click', function () {
      draft.remove();
    });
    labelInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });

    draft.appendChild(labelInput);
    draft.appendChild(hint);
    draft.appendChild(add);
    draft.appendChild(cancel);
    rowsHost.appendChild(draft);
    labelInput.focus();
  }

  function renderGroups() {
    els.template.innerHTML = '';
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];

      var section = document.createElement('section');
      section.className = 'card group';
      section.setAttribute('data-group', group.id);

      var head = document.createElement('div');
      head.className = 'group-head';
      var title = document.createElement('h2');
      title.textContent = group.title;
      head.appendChild(title);
      var count = document.createElement('span');
      count.className = 'group-count';
      count.setAttribute('data-group-count', group.id);
      count.textContent = '已填 0 / 0';
      head.appendChild(count);
      section.appendChild(head);

      var bar = document.createElement('div');
      bar.className = 'bar';
      bar.setAttribute('data-group-bar', group.id);
      bar.appendChild(document.createElement('i'));
      section.appendChild(bar);

      if (group.hint) {
        var hint = document.createElement('p');
        hint.className = 'section-hint';
        hint.textContent = group.hint;
        section.appendChild(hint);
      }

      var rowsHost = document.createElement('div');
      rowsHost.className = 'tpl-rows';
      rowsHost.setAttribute('data-group-rows', group.id);
      for (var r = 0; r < group.rows.length; r++) rowsHost.appendChild(createRow(group.rows[r]));
      section.appendChild(rowsHost);

      var actions = document.createElement('div');
      actions.className = 'actions';
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'ghost small';
      addBtn.textContent = '+ 添加自定义项';
      addBtn.addEventListener('click', function (groupId) {
        return function () {
          startDraft(groupId);
        };
      }(group.id));
      actions.appendChild(addBtn);
      section.appendChild(actions);

      els.template.appendChild(section);
    }
    updateCompleteness();
  }

  /* ------------------------------------------------------------ 待填清单 */

  function focusField(key, label) {
    var input = document.querySelector('[data-field-key="' + key + '"]');
    if (input) {
      input.focus();
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    }
    // 模板里还没有这个字段：作为自定义项补进第三组
    var added = window.JC.addCustomField(model, label || key, 'extra');
    if (!added.ok) return false;
    model = added.resume;
    return persist().then(function () {
      renderGroups();
      var next = document.querySelector('[data-field-key="' + added.field.key + '"]');
      if (next) {
        next.focus();
        next.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
  }

  async function renderPending() {
    try {
      var bag = await window.JC.getPendingItems();
      var items = bag.items || [];
      els.pendingList.innerHTML = '';

      if (!items.length) {
        var empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = '没有待填项。填充时表单认出来但简历没值的字段会出现在这里。';
        els.pendingList.appendChild(empty);
        setPendingStatus('');
        return;
      }

      items.forEach(function (item) {
        var row = document.createElement('div');
        row.className = 'pending-row';
        row.setAttribute('data-pending-key', item.key);

        var label = document.createElement('span');
        label.className = 'pending-label';
        label.textContent = item.label;
        row.appendChild(label);

        var meta = document.createElement('span');
        meta.className = 'pending-meta';
        var when = item.at ? new Date(item.at) : null;
        meta.textContent =
          (item.host || '未知站点') +
          (when && !isNaN(when.getTime()) ? ' · ' + when.toLocaleString('zh-CN') : '');
        row.appendChild(meta);

        var go = document.createElement('button');
        go.type = 'button';
        go.className = 'ghost small';
        go.textContent = '去填写';
        go.addEventListener('click', function () {
          focusField(item.key, item.label);
        });
        row.appendChild(go);

        var ignore = document.createElement('button');
        ignore.type = 'button';
        ignore.className = 'link small';
        ignore.textContent = '忽略';
        ignore.addEventListener('click', function () {
          window.JC.removePendingItem(item.key).then(function () {
            renderPending();
          });
        });
        row.appendChild(ignore);

        els.pendingList.appendChild(row);
      });

      setPendingStatus('共 ' + items.length + ' 个待填项', 'ok');
    } catch (error) {
      setPendingStatus('读取待填清单失败：' + ((error && error.message) || error), 'warn');
    }
  }

  /* -------------------------------------------------------------- 规则表 */

  function currentFields() {
    var keys = window.JC.getFieldKeys(model);
    return keys.map(function (key) {
      return { key: key, label: window.JC.labelFor(model, key) };
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

  /* -------------------------------------------------------------- 数据管理 */

  function exportJson() {
    var text = window.JC.exportJSON(model);
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
    setStatus('已导出 justclick-resume.json（含自定义字段与分组）', 'ok');
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
      var ok = window.confirm('导入会覆盖当前模板内容（含自定义字段），确定继续？');
      if (!ok) {
        setStatus('已取消导入');
        return;
      }
      var saved = await window.JC.saveResume(parsed.resume);
      if (!saved.ok) {
        showErrors(saved.errors);
        setStatus('导入内容校验通过，但保存失败', 'warn');
        return;
      }
      model = saved.resume;
      renderGroups();
      renderPending();
      await loadRules();
      var notices = (parsed.warnings || []).concat(saved.warnings || []);
      showErrors(notices, notices.length ? 'warn' : null);
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
    var loaded = await window.JC.getResume();
    var seeded = window.JC.seedTemplateResume(loaded, { force: true });
    model = seeded.resume;
    await persist();
    renderGroups();
    showErrors(null);
    setStatus('已清空', 'ok');
  }

  /* ---------------------------------------------------------------- 启动 */

  async function load() {
    try {
      var loaded = await window.JC.getResume();
      var seeded = window.JC.seedTemplateResume(loaded);
      model = seeded.resume;
      if (seeded.changed) {
        // 预置项只在第一次播种；播种后立刻落盘，避免每次刷新都重算
        var saved = await window.JC.saveResume(model);
        if (saved.ok) model = saved.resume;
      }
      renderGroups();
      applyLoadedStatus();
      showErrors(null);
    } catch (e) {
      setStatus('读取失败：' + ((e && e.message) || e), 'warn');
    }
    await loadRules();
    await renderPending();
  }

  function applyLoadedStatus() {
    if (model.updatedAt) {
      var d = new Date(model.updatedAt);
      setStatus('已载入本地简历（更新于 ' + (isNaN(d.getTime()) ? model.updatedAt : d.toLocaleString('zh-CN')) + '）');
    } else {
      setStatus('模板已就绪，开始填写即可（自动保存）');
    }
  }

  els.exportBtn.addEventListener('click', exportJson);
  els.importBtn.addEventListener('click', function () {
    els.importInput.click();
  });
  els.importInput.addEventListener('change', function () {
    importJson(els.importInput.files && els.importInput.files[0]);
    els.importInput.value = '';
  });
  els.clearBtn.addEventListener('click', clearAll);
  els.pendingRefresh.addEventListener('click', renderPending);
  els.addRuleBtn.addEventListener('click', addRule);
  els.reloadRulesBtn.addEventListener('click', loadRules);

  window.addEventListener('beforeunload', function () {
    if (saver.isPending()) saver.flush();
  });

  load();
})();
