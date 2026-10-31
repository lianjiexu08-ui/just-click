/**
 * JustClick — popup
 * 读本地简历 → 向当前标签页的 content script 发填充指令 → 展示结果与缺口；
 * 迭代 2 增加「从当前页学习」：扫描字段 → 用户选目标 → 生成并保存规则。
 */
(function () {
  'use strict';

  var els = {
    fillBtn: document.getElementById('fill-btn'),
    learnBtn: document.getElementById('learn-btn'),
    learnPanel: document.getElementById('learn-panel'),
    learnList: document.getElementById('learn-list'),
    learnScope: document.getElementById('learn-scope'),
    learnScopeLabel: document.getElementById('learn-scope-label'),
    learnSave: document.getElementById('learn-save'),
    learnStatus: document.getElementById('learn-status'),
    learnClose: document.getElementById('learn-close'),
    result: document.getElementById('result'),
    completeness: document.getElementById('completeness'),
    completenessBar: document.getElementById('completeness-bar'),
    profileName: document.getElementById('profile-name'),
    missingChips: document.getElementById('missing-chips'),
    updatedAt: document.getElementById('updated-at'),
    optionsBtn: document.getElementById('options-btn'),
    refreshBtn: document.getElementById('refresh-btn')
  };

  var resume = null;
  var busy = false;
  var learnEntries = [];
  var learnHost = '';

  function fieldKeys() {
    if (window.JC && typeof window.JC.getFieldKeys === 'function') return window.JC.getFieldKeys(resume);
    return (window.JC && window.JC.FIELD_KEYS) || [];
  }

  function fieldLabel(key) {
    if (window.JC && typeof window.JC.labelFor === 'function') return window.JC.labelFor(resume, key);
    return (window.JC && window.JC.FIELD_LABELS && window.JC.FIELD_LABELS[key]) || key;
  }

  function filledFieldKeys() {
    var keys = fieldKeys();
    var ready = [];
    for (var i = 0; i < keys.length; i++) {
      if (window.JC.resolveValue(resume, keys[i])) ready.push(keys[i]);
    }
    return ready;
  }

  function renderProfile() {
    var keys = fieldKeys();
    var ready = filledFieldKeys();
    els.completeness.textContent = ready.length + ' / ' + keys.length;
    els.completenessBar.style.width = keys.length ? Math.round((ready.length / keys.length) * 100) + '%' : '0%';

    var name = window.JC.resolveValue(resume, 'fullName');
    els.profileName.textContent = name ? name : '尚未填写简历';

    els.missingChips.innerHTML = '';
    keys.forEach(function (key) {
      if (ready.indexOf(key) !== -1) return;
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = fieldLabel(key);
      els.missingChips.appendChild(chip);
    });

    if (resume && resume.updatedAt) {
      var d = new Date(resume.updatedAt);
      els.updatedAt.textContent = '更新于 ' + (isNaN(d.getTime()) ? resume.updatedAt : d.toLocaleString('zh-CN'));
    } else {
      els.updatedAt.textContent = '还没有保存过简历';
    }

    els.fillBtn.disabled = ready.length === 0;
    if (ready.length === 0) {
      els.fillBtn.textContent = '先填写简历';
    } else {
      els.fillBtn.textContent = '一键填充当前页面';
    }
  }

  function showResult(kind, title, sub) {
    els.result.hidden = false;
    els.result.className = 'result' + (kind === 'error' ? ' error' : '');
    els.result.innerHTML = '';
    var t = document.createElement('div');
    t.className = 'result-title';
    t.textContent = title;
    els.result.appendChild(t);
    if (sub) {
      var s = document.createElement('div');
      s.className = 'result-sub';
      s.textContent = sub;
      els.result.appendChild(s);
    }
  }

  function showLearnStatus(text, kind) {
    els.learnStatus.textContent = text;
    els.learnStatus.className = 'learn-status' + (kind ? ' ' + kind : '');
  }

  /** content script 可能因安装前已打开的页面而缺失，这里按需补注入 */
  async function ensureContentScript(tabId) {
    try {
      var pong = await chrome.tabs.sendMessage(tabId, { type: 'JC_PING' });
      if (pong && pong.ok) return true;
    } catch (e) {
      /* 未注入，继续尝试注入 */
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: [
          'lib/resume-schema.js',
          'lib/rules.js',
          'lib/field-matcher.js',
          'lib/learner.js',
          'content/content.js'
        ]
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function currentTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  function isInjectableUrl(url) {
    return typeof url === 'string' && /^https?:/i.test(url);
  }

  async function prepareTab() {
    var tab = await currentTab();
    if (!tab || !tab.id) {
      showResult('error', '拿不到当前标签页', '请在一个普通网页上重试。');
      return null;
    }
    if (!isInjectableUrl(tab.url)) {
      showResult('error', '这个页面不能操作', 'Chrome 内部页面和扩展商店页面无法注入脚本。');
      return null;
    }
    var ready = await ensureContentScript(tab.id);
    if (!ready) {
      showResult('error', '注入失败', '请刷新目标页面后重试，或检查是否被浏览器策略拦截。');
      return null;
    }
    return tab;
  }

  /* -------------------------------------------------------------- 一键填充 */

  async function handleFill() {
    if (busy) return;
    if (!window.JC.hasAnyData(resume)) {
      showResult('error', '简历还是空的', '点下面的「编辑简历」填几个字段再来。');
      return;
    }

    busy = true;
    els.fillBtn.disabled = true;
    els.fillBtn.textContent = '填充中…';

    try {
      var tab = await prepareTab();
      if (!tab) return;

      var rulesBag = await window.JC.getRules();
      var res = await chrome.tabs.sendMessage(tab.id, {
        type: 'JC_FILL',
        resume: resume,
        rules: rulesBag.fieldRules || [],
        url: tab.url
      });
      if (!res || !res.ok) {
        showResult('error', '填充失败', (res && res.error) || '未知错误');
        return;
      }

      // popup 负责落盘命中计数，content script 不直接碰存储
      if (res.ruleHits && res.ruleHits.length) {
        try {
          await window.JC.bumpRuleHits(res.ruleHits);
        } catch (e) {
          /* 计数失败不影响本次填充结果 */
        }
      }

      if (res.filled > 0) {
        var subs = [];
        if (res.missing && res.missing.length) subs.push('简历缺少：' + res.missing.join('、'));
        if (res.notFound && res.notFound.length) subs.push('页面没找到：' + res.notFound.join('、'));
        if (res.failures && res.failures.length) subs.push('写入失败：' + res.failures.join('、'));
        showResult('ok', '已填 ' + res.filled + ' 项：' + res.filledLabels.join('、'), subs.join('\n'));
      } else if (res.scanned === 0) {
        showResult('error', '没发现表单', '这个页面似乎没有可填的输入框。');
      } else {
        var why = [];
        if (res.missing && res.missing.length) why.push('简历缺少：' + res.missing.join('、'));
        if (res.notFound && res.notFound.length) why.push('页面没找到：' + res.notFound.join('、'));
        showResult('error', '没找到可填字段', why.join('\n') || '识别到的 ' + res.scanned + ' 个输入框都不匹配简历字段。');
      }
    } catch (e) {
      showResult('error', '出错了', String((e && e.message) || e));
    } finally {
      busy = false;
      renderProfile();
    }
  }

  /* -------------------------------------------------------------- 学习流 */

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (e) {
      return '';
    }
  }

  function attrSample(entry) {
    var attrs = entry.attrs || {};
    var parts = [];
    ['id', 'name', 'placeholder', 'ariaLabel'].forEach(function (key) {
      if (attrs[key]) parts.push(key + '=' + String(attrs[key]).slice(0, 60));
    });
    return parts.join(' · ') || '（无可匹配属性）';
  }

  function fieldChoices() {
    var keys = fieldKeys();
    var out = [];
    for (var i = 0; i < keys.length; i++) out.push({ key: keys[i], label: fieldLabel(keys[i]) });
    return out;
  }

  function renderLearnList() {
    els.learnList.innerHTML = '';
    var choices = fieldChoices();
    var keys = choices.map(function (c) { return c.key; });

    learnEntries.forEach(function (entry) {
      var item = document.createElement('div');
      item.className = 'learn-item';

      var label = document.createElement('div');
      label.className = 'li-label';
      label.textContent = entry.label || entry.selector || '（无标签字段）';
      item.appendChild(label);

      var meta = document.createElement('div');
      meta.className = 'li-meta';
      meta.appendChild(document.createTextNode(attrSample(entry) + ' → '));
      var selector = document.createElement('span');
      selector.className = 'li-selector';
      selector.textContent = entry.selector;
      meta.appendChild(selector);
      item.appendChild(meta);

      var select = document.createElement('select');
      select.setAttribute('data-learn-index', String(entry.index));

      var ignore = document.createElement('option');
      ignore.value = '__ignore__';
      ignore.textContent = '忽略（不生成规则）';
      select.appendChild(ignore);

      choices.forEach(function (choice) {
        var option = document.createElement('option');
        option.value = choice.key;
        option.textContent = choice.label + ' · ' + choice.key;
        select.appendChild(option);
      });

      select.value = entry.suggestedKey && keys.indexOf(entry.suggestedKey) !== -1 ? entry.suggestedKey : '__ignore__';
      item.appendChild(select);
      els.learnList.appendChild(item);
    });
  }

  async function handleLearn() {
    if (busy) return;
    busy = true;
    els.learnBtn.disabled = true;
    showResult('ok', '正在扫描当前页…', '只列出可见、可填的 input / textarea / select。');

    try {
      var tab = await prepareTab();
      if (!tab) return;

      var res = await chrome.tabs.sendMessage(tab.id, { type: 'JC_SCAN_FIELDS' });
      if (!res || !res.ok) {
        showResult('error', '扫描失败', (res && res.error) || 'content script 没有返回结果。');
        return;
      }
      learnEntries = Array.isArray(res.entries) ? res.entries : [];
      learnHost = hostOf(res.url || tab.url);

      if (!learnEntries.length) {
        els.learnPanel.hidden = true;
        showResult('error', '没有可学习的字段', '这个页面没有可见的 input / textarea / select。');
        return;
      }

      els.learnScopeLabel.textContent = learnHost ? '只在此站点生效（' + learnHost + '）' : '只在此站点生效';
      els.learnScope.checked = Boolean(learnHost);
      renderLearnList();
      els.learnPanel.hidden = false;
      showLearnStatus('扫描到 ' + learnEntries.length + ' 个字段，选好后点「保存规则」。');
      showResult('ok', '扫描到 ' + learnEntries.length + ' 个字段', '在下方给每个字段选目标，或保持「忽略」。');
    } catch (e) {
      showResult('error', '扫描出错', String((e && e.message) || e));
    } finally {
      busy = false;
      els.learnBtn.disabled = false;
    }
  }

  async function saveLearnedRules() {
    var selects = els.learnList.querySelectorAll('select[data-learn-index]');
    var selection = {};
    for (var i = 0; i < selects.length; i++) {
      selection[selects[i].getAttribute('data-learn-index')] = selects[i].value;
    }

    var sitePattern = els.learnScope.checked ? learnHost : '';
    var rules = window.JC.buildRulesFromSelection(learnEntries, selection, { sitePattern: sitePattern });
    if (!rules.length) {
      showLearnStatus('没有选中任何字段，先给至少一个字段选目标。', 'warn');
      return;
    }

    els.learnSave.disabled = true;
    var saved = 0;
    var errors = [];
    try {
      for (var r = 0; r < rules.length; r++) {
        var result = await window.JC.addRule(rules[r]);
        if (result.ok) saved++;
        else errors.push((result.errors || []).join('；'));
      }
      if (saved) {
        showLearnStatus('已保存 ' + saved + ' 条规则' + (errors.length ? '，' + errors.length + ' 条失败' : '') + '。', errors.length ? 'warn' : '');
        showResult('ok', '已学习 ' + saved + ' 条规则', sitePattern ? '仅对 ' + sitePattern + ' 生效。' : '对所有站点生效。');
      } else {
        showLearnStatus('规则没有保存成功：' + errors.join('；'), 'warn');
      }
    } finally {
      els.learnSave.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- 启动 */

  async function boot() {
    resume = await window.JC.getResume();
    renderProfile();
    window.JC.onResumeChanged(function (next) {
      resume = next;
      renderProfile();
    });
  }

  els.fillBtn.addEventListener('click', handleFill);
  els.learnBtn.addEventListener('click', handleLearn);
  els.learnSave.addEventListener('click', saveLearnedRules);
  els.learnClose.addEventListener('click', function () {
    els.learnPanel.hidden = true;
  });
  els.refreshBtn.addEventListener('click', boot);
  els.optionsBtn.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  boot().catch(function (e) {
    showResult('error', '读取简历失败', String((e && e.message) || e));
  });
})();
