// 扩展共享配置：默认值 + 语言表
// 被 popup.js / options.js（<script> 引入）和 background.js（importScripts）共用
'use strict';

const AITR = {
  // 本地存储 key 命名空间
  STORE_KEY: 'aitrConfig',

  DEFAULTS: {
    baseUrl: 'https://api.deepseek.com', // OpenAI 兼容端点根
    apiKey: '',                          // 用户自己填，只存 chrome.storage.local
    model: 'deepseek-v4-flash',          // 2026-08-06 实测：v4-flash 直调默认思考模式（卡批/慢/烧token），background 用 thinking:{type:'disabled'} 关掉后与 deepseek-chat 别名一致且更快更稳。规范名无弃用风险。
    // 兜底：若 v4-flash 后续失效，可改回别名 deepseek-chat（实测仍可用但官方已标记弃用），或 v4-pro
    targetLang: 'zh-CN',                 // 默认目标语言
    autoTranslate: false                 // 打开外文页面是否自动翻译
  },

  // 语言选项：{ value, label }
  LANGUAGES: [
    { value: 'zh-CN', label: '简体中文' },
    { value: 'zh-TW', label: '繁體中文' },
    { value: 'en',    label: 'English' },
    { value: 'ja',    label: '日本語' },
    { value: 'ko',    label: '한국어' },
    { value: 'fr',    label: 'Français' },
    { value: 'de',    label: 'Deutsch' },
    { value: 'es',    label: 'Español' },
    { value: 'ru',    label: 'Русский' },
    { value: 'pt',    label: 'Português' },
    { value: 'it',    label: 'Italiano' }
  ],

  // 语言 -> 人类可读名（供 banner / popup 显示"翻译为X"）
  langLabel: function (code) {
    const hit = this.LANGUAGES.find(function (l) { return l.value === code; });
    return hit ? hit.label : code;
  },

  // 读取配置（合并默认值）。返回 Promise<config>
  loadConfig: function () {
    return new Promise(function (resolve) {
      chrome.storage.local.get(AITR.STORE_KEY, function (obj) {
        const saved = obj[AITR.STORE_KEY] || {};
        resolve(Object.assign({}, AITR.DEFAULTS, saved));
      });
    });
  },

  saveConfig: function (cfg) {
    const obj = {};
    obj[AITR.STORE_KEY] = cfg;
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, resolve);
    });
  },

  // ===== 用量统计（真实 token，独立 key，不进 aitrConfig） =====
  USAGE_KEY: 'aitrUsage',
  // { byDay: { 'YYYY-MM-DD': { in: tokens, out: tokens } } }，仅留最近 62 天

  // 费用估算常量（单价参考 DeepSeek 定价，可后续调整）
  USAGE_EST: {
    priceInPerM: 0.14,   // USD / 1M 输入 token
    priceOutPerM: 0.28,  // USD / 1M 输出 token
    symbol: '¥',
    usdToCny: 7.1
  },

  // token 数 → 费用估算（返回人民币）
  estimateCost: function (inTokens, outTokens) {
    const e = this.USAGE_EST;
    const usd = ((inTokens || 0) / 1e6) * e.priceInPerM + ((outTokens || 0) / 1e6) * e.priceOutPerM;
    return usd * e.usdToCny;
  },

  // 数字格式化：≥1万 显示 x.x万
  formatCount: function (n) {
    if (n == null) return '-';
    return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(Math.round(n));
  },

  loadUsage: function () {
    return new Promise(function (resolve) {
      chrome.storage.local.get(AITR.USAGE_KEY, function (obj) {
        resolve(obj[AITR.USAGE_KEY] || { byDay: {} });
      });
    });
  },

  saveUsage: function (u) {
    const obj = {};
    obj[AITR.USAGE_KEY] = u;
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, resolve);
    });
  },

  // ===== 站点设置（独立 key） =====
  SITES_KEY: 'aitrSites',
  // { hostname: { auto: bool, never: bool } }，缺省站点跟随全局 autoTranslate

  loadSites: function () {
    return new Promise(function (resolve) {
      chrome.storage.local.get(AITR.SITES_KEY, function (obj) {
        resolve(obj[AITR.SITES_KEY] || {});
      });
    });
  },

  saveSites: function (sites) {
    const obj = {};
    obj[AITR.SITES_KEY] = sites;
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, resolve);
    });
  },

  // 逐级剥子域匹配：sub.example.com → example.com（返回该域设置或 null）
  // 注意：单段 hostname（如 localhost）直接匹配自身，否则 i < length-1 永不执行
  matchSite: function (sites, hostname) {
    if (!hostname || !sites) return null;
    const parts = String(hostname).toLowerCase().split('.');
    if (parts.length === 1) {
      return Object.prototype.hasOwnProperty.call(sites, parts[0]) ? sites[parts[0]] : null;
    }
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(i).join('.');
      if (Object.prototype.hasOwnProperty.call(sites, key)) return sites[key];
    }
    return null;
  }
};

if (typeof module !== 'undefined' && module.exports) { module.exports = AITR; }
