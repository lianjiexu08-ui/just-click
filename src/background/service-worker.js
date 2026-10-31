/**
 * JustClick — MV3 service worker
 * 职责：首次安装时初始化存储、给 popup/options 提供后台兜底路由。
 * 保持无依赖、无 import（MV3 service worker 生命周期短，越薄越稳）。
 */
'use strict';

var STORAGE_KEY = 'jc.resume';

function emptyResume() {
  return {
    version: 2,
    basics: {
      firstName: '',
      lastName: '',
      fullName: '',
      email: '',
      phone: '',
      city: '',
      address: '',
      linkedin: '',
      github: '',
      website: ''
    },
    summary: '',
    experience: '',
    updatedAt: null
  };
}

chrome.runtime.onInstalled.addListener(function (details) {
  chrome.storage.local.get(STORAGE_KEY).then(function (bag) {
    if (bag && bag[STORAGE_KEY]) return;
    var seed = {};
    seed[STORAGE_KEY] = emptyResume();
    return chrome.storage.local.set(seed);
  }).catch(function (error) {
    console.error('[JustClick] 初始化存储失败', error);
  });

  if (details && details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(function () {
      /* 用户可手动从扩展菜单打开 */
    });
  }
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return undefined;

  if (message.type === 'JC_GET_RESUME') {
    chrome.storage.local.get(STORAGE_KEY).then(function (bag) {
      sendResponse({ ok: true, resume: (bag && bag[STORAGE_KEY]) || emptyResume() });
    }).catch(function (error) {
      sendResponse({ ok: false, error: String(error && error.message || error) });
    });
    return true; // 异步响应
  }

  if (message.type === 'JC_SAVE_RESUME' && message.resume) {
    var bag = {};
    bag[STORAGE_KEY] = message.resume;
    chrome.storage.local.set(bag).then(function () {
      sendResponse({ ok: true });
    }).catch(function (error) {
      sendResponse({ ok: false, error: String(error && error.message || error) });
    });
    return true;
  }

  return undefined;
});
