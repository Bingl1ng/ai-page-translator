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
    targetLang: 'zh-CN',                 // 默认目标语言（网页译成什么）
    autoTranslate: false,                // 打开外文页面是否自动翻译
    displayLang: 'zh-CN'                 // 插件界面显示语言（UI 文字语言，区别于 targetLang）
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

  // token 数 → 费用估算（返回人民币）—— 历史美元粗估(升价前),已被下方 computeCost(真实单价) 替代
  estimateCost: function (inTokens, outTokens) {
    const e = this.USAGE_EST;
    const usd = ((inTokens || 0) / 1e6) * e.priceInPerM + ((outTokens || 0) / 1e6) * e.priceOutPerM;
    return usd * e.usdToCny;
  },

  // ===== 真实成本 =====
  // DeepSeek 2026-08-17 价表(元/百万 tokens,空闲价;高峰×2)。命中/未命中/输出单价不同,必须分开算。
  PRICE: {
    flash: { hit: 0.05, miss: 1.5, out: 4.5 },
    pro: { hit: 0.15, miss: 4.5, out: 13.5 }
  },
  // 按模型挑价：含 'pro' 用 pro 价,否则 flash（用户可自填模型,未知模型按较便宜的 flash 档,偏保守）
  priceOf: function (model) {
    return /pro/i.test(String(model || '')) ? this.PRICE.pro : this.PRICE.flash;
  },
  // 当前北京时间是否高峰时段（周一至周五 9:00-12:00、14:00-18:00；周六周日一律空闲）
  isPeak: function (nowMs) {
    const bj = new Date((typeof nowMs === 'number' ? nowMs : Date.now()) + 8 * 3600 * 1000);
    const day = bj.getUTCDay(); // 0=周日
    if (day === 0 || day === 6) return false;
    const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
    return (mins >= 540 && mins < 720) || (mins >= 840 && mins < 1080); // 9-12 / 14-18
  },
  // 真实成本(元): tokens={hit,miss,out}(token 数), peak 为高峰则 ×2
  computeCost: function (model, t, peak) {
    const p = this.priceOf(model);
    const hit = (t && t.hit) || 0, miss = (t && t.miss) || 0, out = (t && t.out) || 0;
    const yuan = (hit / 1e6) * p.hit + (miss / 1e6) * p.miss + (out / 1e6) * p.out;
    return peak ? yuan * 2 : yuan;
  },
  formatYuan: function (n, digits) {
    if (typeof n !== 'number' || !isFinite(n)) return '–';
    return '¥' + n.toFixed(digits == null ? 3 : digits);
  },

  // 数字格式化：≥1万 显示 x.x万
  formatCount: function (n) {
    if (n == null) return '-';
    const l = this._displayLang || 'zh-CN';
    // 中/日/韩用"万"体系（带本字）；其它语言按 K/M 缩写。整千/整万去掉 .0 尾（如 100万 而非 100.0万）
    const wan = (l === 'zh-TW') ? '萬' : (l === 'ko') ? '만' : (l === 'zh-CN' || l === 'ja') ? '万' : null;
    const fmt = function (v, unit) { const r = Math.round(v * 10) / 10; return (Number.isInteger(r) ? String(Math.round(v)) : r.toFixed(1)) + unit; };
    if (wan) return n >= 10000 ? fmt(n / 10000, wan) : String(Math.round(n));
    if (n >= 1e6) return fmt(n / 1e6, 'M');
    if (n >= 1e3) return fmt(n / 1e3, 'K');
    return String(Math.round(n));
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

  // 站点读-改-写串行化：防 popup 与 options 并发改互相覆盖（与 recordUsage 的 promise 链同思路）
  sitesQueue: Promise.resolve(),
  updateSites: function (mutator) {
    this.sitesQueue = this.sitesQueue.then(function () {
      return AITR.loadSites().then(function (sites) {
        mutator(sites);
        return AITR.saveSites(sites);
      });
    });
    return this.sitesQueue;
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
  },

  // ===== 界面显示语言（i18n）：区别于"翻译目标语言 targetLang"，这是插件 UI 文字的语言 =====
  _displayLang: 'zh-CN',
  setDisplayLang: function (l) { this._displayLang = l || 'zh-CN'; },
  // 界面语言下拉复用 AITR.LANGUAGES（与目标语言一致，见 options.js fillDisplayLang）
  // 取界面文案：优先当前显示语言，缺失回退简体中文。params 替换 {x} 占位。
  t: function (key, params) {
    const dict = this.I18N[this._displayLang] || this.I18N['zh-CN'] || {};
    let s = dict[key] || this.I18N['zh-CN'][key] || key;
    if (params) { Object.keys(params).forEach(function (k) { s = String(s).replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]); }); }
    return s;
  },
  // 把 root 内所有 [data-i18n] 的 textContent 与 [data-i18n-ph] 的 placeholder 填上对应语言文案
  applyI18n: function (root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = AITR.t(el.getAttribute('data-i18n')); });
    scope.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.placeholder = AITR.t(el.getAttribute('data-i18n-ph')); });
  },

  // 语言名（横幅"看起来是{语言}"、弹窗"已翻译成{语言}"用）—— 随显示语言
  langName: function (code) {
    const l = this._displayLang || 'zh-CN';
    const m = this.LANGNAME[l] || this.LANGNAME['zh-CN'] || {};
    return m[code] || this.t('unknown.lang'); // 未识别的检测值(如脚本族 latin)回退为"外文"
  },
  LANGNAME: {
    'zh-CN': { 'zh-CN': '中文', 'zh-TW': '繁体中文', 'en': '英文', 'ja': '日文', 'ko': '韩文', 'fr': '法文', 'de': '德文', 'es': '西文', 'ru': '俄文', 'pt': '葡文', 'it': '意文' },
    'zh-TW': { 'zh-CN': '簡體中文', 'zh-TW': '繁體中文', 'en': '英文', 'ja': '日文', 'ko': '韓文', 'fr': '法文', 'de': '德文', 'es': '西文', 'ru': '俄文', 'pt': '葡文', 'it': '意文' },
    'en': { 'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', 'en': 'English', 'ja': 'Japanese', 'ko': 'Korean', 'fr': 'French', 'de': 'German', 'es': 'Spanish', 'ru': 'Russian', 'pt': 'Portuguese', 'it': 'Italian' },
    'ja': { 'zh-CN': '簡体字中国語', 'zh-TW': '繁体字中国語', 'en': '英語', 'ja': '日本語', 'ko': '韓国語', 'fr': 'フランス語', 'de': 'ドイツ語', 'es': 'スペイン語', 'ru': 'ロシア語', 'pt': 'ポルトガル語', 'it': 'イタリア語' },
    'ko': { 'zh-CN': '중국어 간체', 'zh-TW': '중국어 번체', 'en': '영어', 'ja': '일본어', 'ko': '한국어', 'fr': '프랑스어', 'de': '독일어', 'es': '스페인어', 'ru': '러시아어', 'pt': '포르투갈어', 'it': '이탈리아어' },
    'fr': { 'zh-CN': 'Chinois simplifié', 'zh-TW': 'Chinois traditionnel', 'en': 'Anglais', 'ja': 'Japonais', 'ko': 'Coréen', 'fr': 'Français', 'de': 'Allemand', 'es': 'Espagnol', 'ru': 'Russe', 'pt': 'Portugais', 'it': 'Italien' },
    'de': { 'zh-CN': 'Chinesisch (vereinfacht)', 'zh-TW': 'Chinesisch (traditionell)', 'en': 'Englisch', 'ja': 'Japanisch', 'ko': 'Koreanisch', 'fr': 'Französisch', 'de': 'Deutsch', 'es': 'Spanisch', 'ru': 'Russisch', 'pt': 'Portugiesisch', 'it': 'Italienisch' },
    'es': { 'zh-CN': 'Chino simplificado', 'zh-TW': 'Chino tradicional', 'en': 'Inglés', 'ja': 'Japonés', 'ko': 'Coreano', 'fr': 'Francés', 'de': 'Alemán', 'es': 'Español', 'ru': 'Ruso', 'pt': 'Portugués', 'it': 'Italiano' },
    'ru': { 'zh-CN': 'Китайский (упр.)', 'zh-TW': 'Китайский (трад.)', 'en': 'Английский', 'ja': 'Японский', 'ko': 'Корейский', 'fr': 'Французский', 'de': 'Немецкий', 'es': 'Испанский', 'ru': 'Русский', 'pt': 'Португальский', 'it': 'Итальянский' },
    'pt': { 'zh-CN': 'Chinês simplificado', 'zh-TW': 'Chinês tradicional', 'en': 'Inglês', 'ja': 'Japonês', 'ko': 'Coreano', 'fr': 'Francês', 'de': 'Alemão', 'es': 'Espanhol', 'ru': 'Russo', 'pt': 'Português', 'it': 'Italiano' },
    'it': { 'zh-CN': 'Cinese semplificato', 'zh-TW': 'Cinese tradizionale', 'en': 'Inglese', 'ja': 'Giapponese', 'ko': 'Coreano', 'fr': 'Francese', 'de': 'Tedesco', 'es': 'Spagnolo', 'ru': 'Russo', 'pt': 'Portoghese', 'it': 'Italiano' }
  },

  I18N: {
    'zh-CN': {
      // 设置页
      'opt.title': 'AI 页面翻译 · 设置',
      'opt.section.api': 'API 连接', 'opt.baseUrl.label': 'API 地址（OpenAI 兼容端点根）',
      'opt.baseUrl.note': '支持任何 OpenAI 兼容 API。⚠️ 改非 DeepSeek 域名时，Key 会随请求发给该域名，只填可信服务商。',
      'opt.apiKey.label': 'API Key', 'opt.apiKey.note': '只存本机浏览器。建议建专用 Key + 设置额度上限，泄漏可随时吊销。',
      'opt.model.label': '模型', 'opt.model.note': '默认 deepseek-v4-flash（已自动关思考模式，快且稳）。',
      'opt.section.pref': '翻译偏好', 'opt.targetLang.label': '默认目标语言',
      'opt.section.ui': '界面语言', 'opt.displayLang.label': '显示语言（插件界面文字）',
      'opt.displayLang.note': '切换插件按钮、说明、横幅等文字的语言，不影响翻译目标。',
      'opt.test': '测试连接', 'opt.testing': '正在测试连接…', 'opt.testOk': '✓ 连接成功，模型可用', 'opt.testErr': '连接失败：{msg}',
      'opt.save': '保存', 'opt.cancel': '取消', 'opt.saved': '✓ 已保存',
      'opt.section.site': '站点设置', 'opt.site.addPh': 'example.com', 'opt.site.add': '添加',
      'opt.site.note': '给指定域名设置"自动翻译/永不翻译"，优先级高于全局；子域名自动匹配上级。',
      'opt.help.title': '说明', 'opt.help.1': '翻译调用你填的 API，按你的账户计费。DeepSeek 很便宜，普通网页一次约几分钱。',
      'opt.help.2': '非 DeepSeek 域名保存时会弹授权请求。', 'opt.help.3': '弹窗/横幅切"目标语言"实时生效；已翻页切语言自动重翻。',
      'opt.help.4': '代码块、输入框、按钮内文字默认不翻译。',
      'opt.testFailBg': '测试失败：无法连接后台', 'opt.testOk2': '✓ 连接成功。示例译文：「{t}」',
      'opt.site.auto': ' 自动', 'opt.site.never': ' 永不翻译', 'opt.site.del': '删除',
      'opt.confirm1': '你的 API Key 会随翻译请求发送到以下地址：\n\n  {origin}\n\n请确认你信任该服务商（或确认这是你自己的网关）。\n点「确定」继续保存，点「取消」返回修改。',
      // 弹窗
      'pop.title': 'AI 页面翻译', 'pop.loading': '加载中…', 'pop.translate': '翻译此页',
      'pop.retranslate': '重新翻译', 'pop.restore': '还原原文', 'pop.retryFailed': '重试失败段落',
      'pop.targetLang': '目标语言', 'pop.auto': '打开外文页面自动翻译', 'pop.siteAuto': '此站点自动翻译',
      'pop.siteNever': '此站点永不翻译', 'pop.today': '今日', 'pop.month': '本月', 'pop.session': '本次',
      'pop.settings': '设置', 'pop.nokey': '还没配置 API Key。', 'pop.goSettings': '去设置 →',
      'pop.detectedForeign': '检测到外文，未翻译', 'pop.notTranslated': '此页未翻译',
      'pop.noUsageToday': '今天暂无翻译', 'unknown.lang': '外文',
      'pop.unsupported': '此页面不支持翻译（浏览器内部页面或受限站点）。',
      'pop.translating': '翻译中… {n}/{m}', 'pop.done': '已翻译成{lang}', 'pop.failed': '（{n} 段失败）',
      'pop.retranslating': '重新翻译中…',
      // 横幅
      'ban.offer': '此页面看起来是{from}。要用 AI 翻译成{to}吗？', 'ban.translate': 'AI 翻译', 'ban.no': '不翻译',
      'ban.cancel': '取消', 'ban.done': '已用 AI 翻译成{to}',
      'ban.failed': '（{n} 段失败，已保留原文）', 'ban.restore': '显示原文',
      'ban.retranslate': '重新翻译', 'ban.retryFailed': '重试失败段落',
      'ban.nokey': '未配置 AI 翻译的 API Key，请点击扩展图标 → 设置填写。',
      'ban.analyzing': '正在分析全文…', 'ban.translating': '正在用 AI 翻译… {n}/{m}',
      'ban.cost': '本页翻译约 ¥{n}'
    },
    'en': {
      'opt.title': 'AI Page Translate · Settings',
      'opt.section.api': 'API Connection', 'opt.baseUrl.label': 'API URL (OpenAI-compatible endpoint)',
      'opt.baseUrl.note': 'Works with any OpenAI-compatible API. ⚠️ If you change to a non-DeepSeek domain, your Key is sent to that domain — use only trusted providers.',
      'opt.apiKey.label': 'API Key', 'opt.apiKey.note': 'Stored only in your browser. Use a dedicated Key with a spending limit so you can revoke it if leaked.',
      'opt.model.label': 'Model', 'opt.model.note': 'Default deepseek-v4-flash (thinking off for speed & stability).',
      'opt.section.pref': 'Translation', 'opt.targetLang.label': 'Default target language',
      'opt.section.ui': 'Interface', 'opt.displayLang.label': 'Display language (extension UI text)',
      'opt.displayLang.note': 'Changes the language of buttons, notes, and banners; does not affect the target language.',
      'opt.test': 'Test connection', 'opt.testing': 'Testing connection…', 'opt.testOk': '✓ Connection OK, model usable', 'opt.testErr': 'Connection failed: {msg}',
      'opt.save': 'Save', 'opt.cancel': 'Cancel', 'opt.saved': '✓ Saved',
      'opt.section.site': 'Site settings', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Add',
      'opt.site.note': 'Set auto-translate / never-translate per domain (overrides global); subdomains inherit parent.',
      'opt.help.title': 'Notes', 'opt.help.1': 'Translation bills your own API account. DeepSeek is cheap — a page costs a few cents.',
      'opt.help.2': 'Non-DeepSeek domains ask for permission on save.', 'opt.help.3': 'Switching target language applies live; already-translated pages re-translate.',
      'opt.help.4': 'Code blocks, inputs, and buttons are not translated by default.',
      'opt.testFailBg': 'Test failed: cannot reach background', 'opt.testOk2': '✓ Connection OK. Sample: "{t}"',
      'opt.site.auto': ' Auto', 'opt.site.never': ' Never', 'opt.site.del': 'Delete',
      'opt.confirm1': 'Your API Key will be sent to this address with translation requests:\n\n  {origin}\n\nConfirm you trust this provider (or it is your own gateway).\nClick OK to save, Cancel to go back.',
      'pop.title': 'AI Page Translate', 'pop.loading': 'Loading…', 'pop.translate': 'Translate this page',
      'pop.retranslate': 'Re-translate', 'pop.restore': 'Show original', 'pop.retryFailed': 'Retry failed parts',
      'pop.targetLang': 'Target language', 'pop.auto': 'Auto-translate foreign pages', 'pop.siteAuto': 'Auto-translate this site',
      'pop.siteNever': 'Never translate this site', 'pop.today': 'Today', 'pop.month': 'This month', 'pop.session': 'This page',
      'pop.settings': 'Settings', 'pop.nokey': 'No API Key configured.', 'pop.goSettings': 'Go to Settings →',
      'pop.detectedForeign': 'Foreign language detected, not translated', 'pop.notTranslated': 'Not translated',
      'pop.noUsageToday': 'No translations today', 'unknown.lang': 'Foreign',
      'pop.unsupported': 'This page can’t be translated (browser internal or restricted).',
      'pop.translating': 'Translating… {n}/{m}', 'pop.done': 'Translated to {lang}', 'pop.failed': ' ({n} failed)',
      'pop.retranslating': 'Re-translating…',
      'ban.offer': 'This page looks like {from}. Translate it to {to} with AI?', 'ban.translate': 'Translate', 'ban.no': 'No',
      'ban.cancel': 'Cancel', 'ban.done': 'Translated to {to} with AI',
      'ban.failed': ' ({n} failed, kept original)', 'ban.restore': 'Show original',
      'ban.retranslate': 'Re-translate', 'ban.retryFailed': 'Retry failed parts',
      'ban.nokey': 'No API Key. Click the extension icon → Settings to configure.',
      'ban.analyzing': 'Analyzing page…', 'ban.translating': 'Translating… {n}/{m}',
      'ban.cost': 'Cost ~ ¥{n}'
    },
    'zh-TW': {
      'opt.title': 'AI 頁面翻譯 · 設定', 'opt.section.api': 'API 連線', 'opt.baseUrl.label': 'API 位址（OpenAI 相容端點根）',
      'opt.baseUrl.note': '支援任何 OpenAI 相容 API。⚠️ 改非 DeepSeek 網域時，Key 會隨請求發給該網域，只填可信服務商。',
      'opt.apiKey.label': 'API Key', 'opt.apiKey.note': '只存本機瀏覽器。建議建專用 Key + 設定額度上限，外洩可隨時撤銷。',
      'opt.model.label': '模型', 'opt.model.note': '預設 deepseek-v4-flash（已自動關思考模式，快且穩）。',
      'opt.section.pref': '翻譯偏好', 'opt.targetLang.label': '預設目標語言', 'opt.section.ui': '介面語言',
      'opt.displayLang.label': '顯示語言（外掛介面文字）', 'opt.displayLang.note': '切換外掛按鈕、說明、橫幅等文字語言，不影響翻譯目標。',
      'opt.test': '測試連線', 'opt.testing': '正在測試連線…', 'opt.testOk': '✓ 連線成功，模型可用', 'opt.testErr': '連線失敗：{msg}',
      'opt.save': '儲存', 'opt.cancel': '取消', 'opt.saved': '✓ 已儲存', 'opt.section.site': '網站設定', 'opt.site.addPh': 'example.com', 'opt.site.add': '新增',
      'opt.site.note': '給指定網域設定"自動翻譯/永不翻譯"，優先於全域；子網域自動比對上級。',
      'opt.help.title': '說明', 'opt.help.1': '翻譯呼叫你填的 API，依你的帳戶計費。DeepSeek 很便宜，一般網頁一次約幾分錢。',
      'opt.help.2': '非 DeepSeek 網域儲存時會彈授權請求。', 'opt.help.3': '彈窗/橫幅切"目標語言"即時生效；已翻頁切語言自動重翻。',
      'opt.help.4': '程式碼區塊、輸入框、按鈕內文字預設不翻譯。', 'opt.testFailBg': '測試失敗：無法連後台', 'opt.testOk2': '✓ 連線成功。範例譯文:「{t}」',
      'opt.site.auto': ' 自動', 'opt.site.never': ' 永不翻譯', 'opt.site.del': '刪除',
      'opt.confirm1': '你的 API Key 會隨翻譯請求發送到以下位址：\n\n  {origin}\n\n請確認你信任該服務商（或確認這是你自己的閘道）。\n按「確定」繼續儲存，按「取消」返回修改。',
      'pop.title': 'AI 頁面翻譯', 'pop.loading': '載入中…', 'pop.translate': '翻譯此頁', 'pop.retranslate': '重新翻譯',
      'pop.restore': '還原原文', 'pop.retryFailed': '重試失敗段落', 'pop.targetLang': '目標語言', 'pop.auto': '開啟外文頁面自動翻譯',
      'pop.siteAuto': '此網站自動翻譯', 'pop.siteNever': '此網站永不翻譯', 'pop.today': '今日', 'pop.month': '本月', 'pop.session': '本次',
      'pop.settings': '設定', 'pop.nokey': '還沒設定 API Key。', 'pop.goSettings': '去設定 →', 'pop.detectedForeign': '偵測到外文，未翻譯',
      'pop.notTranslated': '此頁未翻譯', 'pop.unsupported': '此頁面不支援翻譯（瀏覽器內部頁面或受限站點）。',
      'pop.translating': '翻譯中… {n}/{m}', 'pop.done': '已翻譯成{lang}', 'pop.failed': '（{n} 段失敗）',
      'pop.retranslating': '重新翻譯中…', 'pop.noUsageToday': '今天尚無翻譯',
      'ban.offer': '此頁面看起來是{from}。要用 AI 翻譯成{to}嗎？', 'ban.translate': 'AI 翻譯', 'ban.no': '不翻譯', 'ban.cancel': '取消',
      'ban.done': '已用 AI 翻譯成{to}', 'ban.failed': '（{n} 段失敗，已保留原文）', 'ban.restore': '顯示原文',
      'ban.retranslate': '重新翻譯', 'ban.retryFailed': '重試失敗段落', 'ban.nokey': '未設定 AI 翻譯的 API Key，請點擴充功能圖示 → 設定填寫。',
      'ban.analyzing': '正在分析全文…', 'ban.translating': '正在用 AI 翻譯… {n}/{m}', 'ban.cost': '本頁翻譯約 ¥{n}'
    },
    'ja': {
      'opt.title': 'AI ページ翻訳 · 設定', 'opt.section.api': 'API 接続', 'opt.baseUrl.label': 'API アドレス（OpenAI 互換エンドポイント）',
      'opt.baseUrl.note': '任意の OpenAI 互換 API に対応。⚠️ DeepSeek 以外のドメインに変更すると、Key はそのドメインに送信されます。信頼できるプロバイダーのみ。',
      'opt.apiKey.label': 'API Key', 'opt.apiKey.note': 'ローカルブラウザのみに保存。専用 Key を作成し上限を設定、漏洩時はいつでも無効化できます。',
      'opt.model.label': 'モデル', 'opt.model.note': 'デフォルト deepseek-v4-flash（思考モード無効、高速で安定）。',
      'opt.section.pref': '翻訳設定', 'opt.targetLang.label': 'デフォルトの目標言語', 'opt.section.ui': 'インターフェース',
      'opt.displayLang.label': '表示言語（拡張のUIテキスト）', 'opt.displayLang.note': 'ボタン・説明・バナーなどの表示言語を切り替えます。翻訳先には影響しません。',
      'opt.test': '接続テスト', 'opt.testing': '接続をテスト中…', 'opt.testOk': '✓ 接続成功、モデル利用可', 'opt.testErr': '接続失敗：{msg}',
      'opt.save': '保存', 'opt.cancel': 'キャンセル', 'opt.saved': '✓ 保存済み', 'opt.section.site': 'サイト設定', 'opt.site.addPh': 'example.com', 'opt.site.add': '追加',
      'opt.site.note': 'ドメインごとに「自動翻訳/翻訳しない」を設定（全体設定より優先）。サブドメインは親を継承。',
      'opt.help.title': '説明', 'opt.help.1': '翻訳はあなたの API アカウントに課金されます。DeepSeek は安価、通常ページは数銭程度。',
      'opt.help.2': 'DeepSeek 以外のドメインでは保存時に認可リクエスト。', 'opt.help.3': '目標言語の切り替えは即時反映。翻訳済みページは自動で再翻訳。',
      'opt.help.4': 'コードブロック・入力欄・ボタン内の文字はデフォルトで翻訳しません。', 'opt.testFailBg': 'テスト失敗：バックグラウンドに接続できません', 'opt.testOk2': '✓ 接続成功。サンプル訳文:「{t}」',
      'opt.site.auto': ' 自動', 'opt.site.never': ' 翻訳しない', 'opt.site.del': '削除',
      'opt.confirm1': 'API Key は翻訳リクエストと共に以下のアドレスへ送信されます：\n\n  {origin}\n\nこのプロバイダーを信頼するか（または自身のゲートウェイか）確認してください。\n「OK」で保存、「キャンセル」で戻ります。',
      'pop.title': 'AI ページ翻訳', 'pop.loading': '読み込み中…', 'pop.translate': 'このページを翻訳', 'pop.retranslate': '再翻訳',
      'pop.restore': '原文を表示', 'pop.retryFailed': '失敗部分を再試行', 'pop.targetLang': '目標言語', 'pop.auto': '外国語ページを自動翻訳',
      'pop.siteAuto': 'このサイトを自動翻訳', 'pop.siteNever': 'このサイトを翻訳しない', 'pop.today': '今日', 'pop.month': '今月', 'pop.session': '今回',
      'pop.settings': '設定', 'pop.nokey': 'API Key が未設定です。', 'pop.goSettings': '設定へ →', 'pop.detectedForeign': '外国語を検出、未翻訳',
      'pop.notTranslated': '未翻訳', 'pop.unsupported': 'このページは翻訳できません（ブラウザ内部または制限付き）。',
      'pop.translating': '翻訳中… {n}/{m}', 'pop.done': '{lang} に翻訳済み', 'pop.failed': '（{n} 件失敗）',
      'pop.retranslating': '再翻訳中…', 'pop.noUsageToday': '今日の翻訳はありません',
      'ban.offer': 'このページは{from}のようです。AI で{to}に翻訳しますか？', 'ban.translate': 'AI 翻訳', 'ban.no': 'しない', 'ban.cancel': 'キャンセル',
      'ban.done': 'AI で{to}に翻訳しました', 'ban.failed': '（{n} 件失敗、原文を保持）', 'ban.restore': '原文を表示',
      'ban.retranslate': '再翻訳', 'ban.retryFailed': '失敗部分を再試行', 'ban.nokey': 'AI 翻訳の API Key 未設定。拡張アイコン → 設定で入力してください。',
      'ban.analyzing': '全文を分析中…', 'ban.translating': 'AI で翻訳中… {n}/{m}', 'ban.cost': 'このページ約 ¥{n}'
    },
    'ko': {
      'opt.title': 'AI 페이지 번역 · 설정', 'opt.section.api': 'API 연결', 'opt.baseUrl.label': 'API 주소 (OpenAI 호환 엔드포인트)',
      'opt.baseUrl.note': '모든 OpenAI 호환 API 지원. ⚠️ DeepSeek가 아닌 도메인으로 바꾸면 Key가 그 도메인으로 전송됩니다. 신뢰할 수 있는 제공자만 사용하세요.',
      'opt.apiKey.label': 'API Key', 'opt.apiKey.note': '로컬 브라우저에만 저장. 전용 Key를 만들고 한도를 설정해 유출 시 즉시 폐기하세요.',
      'opt.model.label': '모델', 'opt.model.note': '기본값 deepseek-v4-flash (생각 모드 끔, 빠르고 안정적).',
      'opt.section.pref': '번역 설정', 'opt.targetLang.label': '기본 번역 대상 언어', 'opt.section.ui': '인터페이스',
      'opt.displayLang.label': '표시 언어 (확장 UI 텍스트)', 'opt.displayLang.note': '버튼·설명·배너 등 UI 언어를 전환합니다. 번역 대상에는 영향 없음.',
      'opt.test': '연결 테스트', 'opt.testing': '연결 테스트 중…', 'opt.testOk': '✓ 연결 성공, 모델 사용 가능', 'opt.testErr': '연결 실패: {msg}',
      'opt.save': '저장', 'opt.cancel': '취소', 'opt.saved': '✓ 저장됨', 'opt.section.site': '사이트 설정', 'opt.site.addPh': 'example.com', 'opt.site.add': '추가',
      'opt.site.note': '도메인별로 "자동 번역/번역 안 함" 설정 (전역보다 우선). 하위 도메인은 상위를 상속.',
      'opt.help.title': '설명', 'opt.help.1': '번역은 귀하의 API 계정으로 청구됩니다. DeepSeek는 저렴하며 일반 페이지는 몇 센트.',
      'opt.help.2': 'DeepSeek 외 도메인은 저장 시 권한 요청.', 'opt.help.3': '대상 언어 전환은 즉시 적용. 번역된 페이지는 자동 재번역.',
      'opt.help.4': '코드 블록·입력란·버튼 내 텍스트는 기본적으로 번역하지 않습니다.', 'opt.testFailBg': '테스트 실패: 백그라운드에 연결할 수 없음', 'opt.testOk2': '✓ 연결 성공. 예시 번역: "{t}"',
      'opt.site.auto': ' 자동', 'opt.site.never': ' 안 함', 'opt.site.del': '삭제',
      'opt.confirm1': 'API Key가 번역 요청과 함께 다음 주소로 전송됩니다:\n\n  {origin}\n\n이 제공자를 신뢰하는지(또는 자신의 게이트웨이) 확인하세요.\n"확인" 저장, "취소" 돌아가기.',
      'pop.title': 'AI 페이지 번역', 'pop.loading': '불러오는 중…', 'pop.translate': '이 페이지 번역', 'pop.retranslate': '다시 번역',
      'pop.restore': '원본 표시', 'pop.retryFailed': '실패한 부분 재시도', 'pop.targetLang': '대상 언어', 'pop.auto': '외국어 페이지 자동 번역',
      'pop.siteAuto': '이 사이트 자동 번역', 'pop.siteNever': '이 사이트 번역 안 함', 'pop.today': '오늘', 'pop.month': '이번 달', 'pop.session': '이 페이지',
      'pop.settings': '설정', 'pop.nokey': 'API Key가 설정되지 않았습니다.', 'pop.goSettings': '설정으로 →', 'pop.detectedForeign': '외국어 감지됨, 번역 안 됨',
      'pop.notTranslated': '번역되지 않음', 'pop.unsupported': '이 페이지는 번역할 수 없습니다 (브라우저 내부 또는 제한됨).',
      'pop.translating': '번역 중… {n}/{m}', 'pop.done': '{lang}(으)로 번역됨', 'pop.failed': '({n}개 실패)',
      'pop.retranslating': '다시 번역 중…', 'pop.noUsageToday': '오늘 번역 없음',
      'ban.offer': '이 페이지는 {from}인 것 같습니다. AI로 {to}로 번역할까요?', 'ban.translate': 'AI 번역', 'ban.no': '아니요', 'ban.cancel': '취소',
      'ban.done': 'AI로 {to}로 번역됨', 'ban.failed': '({n}개 실패, 원본 유지)', 'ban.restore': '원본 표시',
      'ban.retranslate': '다시 번역', 'ban.retryFailed': '실패한 부분 재시도', 'ban.nokey': 'AI 번역 API Key 미설정. 확장 아이콘 → 설정에서 입력하세요.',
      'ban.analyzing': '전문 분석 중…', 'ban.translating': 'AI 번역 중… {n}/{m}', 'ban.cost': '이 페이지 약 ¥{n}'
    },
    'fr': {
      'opt.title': 'AI Page Translate · Réglages', 'opt.section.api': 'Connexion API', 'opt.baseUrl.label': 'URL de l\'API (point de terminaison compatible OpenAI)',
      'opt.baseUrl.note': 'Fonctionne avec toute API compatible OpenAI. ⚠️ Si vous changez vers un domaine non-DeepSeek, votre clé est envoyée à ce domaine — utilisez des fournisseurs de confiance.',
      'opt.apiKey.label': 'Clé API', 'opt.apiKey.note': 'Stockée uniquement dans votre navigateur. Utilisez une clé dédiée avec une limite de dépenses pour pouvoir la révoquer si elle fuite.',
      'opt.model.label': 'Modèle', 'opt.model.note': 'Par défaut deepseek-v4-flash (réflexion désactivée pour la rapidité et la stabilité).',
      'opt.section.pref': 'Traduction', 'opt.targetLang.label': 'Langue cible par défaut', 'opt.section.ui': 'Interface',
      'opt.displayLang.label': 'Langue d\'affichage (texte de l\'extension)', 'opt.displayLang.note': 'Change la langue des boutons, notes et bannières ; n\'affecte pas la langue cible.',
      'opt.test': 'Tester la connexion', 'opt.testing': 'Test de connexion…', 'opt.testOk': '✓ Connexion OK, modèle utilisable', 'opt.testErr': 'Échec de connexion : {msg}',
      'opt.save': 'Enregistrer', 'opt.cancel': 'Annuler', 'opt.saved': '✓ Enregistré', 'opt.section.site': 'Réglages du site', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Ajouter',
      'opt.site.note': 'Définir auto-traduction / ne jamais traduire par domaine (prioritaire sur le global) ; les sous-domaines héritent.',
      'opt.help.title': 'Notes', 'opt.help.1': 'La traduction facture votre propre compte API. DeepSeek est bon marché — une page coûte quelques centimes.',
      'opt.help.2': 'Les domaines non-DeepSeek demandent une autorisation lors de la sauvegarde.', 'opt.help.3': 'Changer la langue cible s\'applique en direct ; les pages traduites sont retraduites.',
      'opt.help.4': 'Les blocs de code, champs de saisie et boutons ne sont pas traduits par défaut.', 'opt.testFailBg': 'Échec du test : impossible d\'atteindre l\'arrière-plan', 'opt.testOk2': '✓ Connexion OK. Exemple : "{t}"',
      'opt.site.auto': ' Auto', 'opt.site.never': ' Jamais', 'opt.site.del': 'Supprimer',
      'opt.confirm1': 'Votre clé API sera envoyée à cette adresse avec les requêtes de traduction :\n\n  {origin}\n\nConfirmez que vous faites confiance à ce fournisseur (ou que c\'est votre propre passerelle).\nOK pour enregistrer, Annuler pour revenir.',
      'pop.title': 'AI Page Translate', 'pop.loading': 'Chargement…', 'pop.translate': 'Traduire cette page', 'pop.retranslate': 'Retraduire',
      'pop.restore': 'Afficher l\'original', 'pop.retryFailed': 'Réessayer les échecs', 'pop.targetLang': 'Langue cible', 'pop.auto': 'Traduire automatiquement les pages étrangères',
      'pop.siteAuto': 'Auto-traduire ce site', 'pop.siteNever': 'Ne jamais traduire ce site', 'pop.today': 'Aujourd\'hui', 'pop.month': 'Ce mois', 'pop.session': 'Cette page',
      'pop.settings': 'Réglages', 'pop.nokey': 'Aucune clé API configurée.', 'pop.goSettings': 'Aller aux réglages →', 'pop.detectedForeign': 'Langue étrangère détectée, non traduite',
      'pop.notTranslated': 'Non traduit', 'pop.unsupported': 'Cette page ne peut pas être traduite (page interne du navigateur ou restreinte).',
      'pop.translating': 'Traduction… {n}/{m}', 'pop.done': 'Traduit en {lang}', 'pop.failed': ' ({n} échecs)',
      'pop.retranslating': 'Retraduction…', 'pop.noUsageToday': 'Aucune traduction aujourd\'hui',
      'ban.offer': 'Cette page semble être en {from}. La traduire en {to} avec l\'IA ?', 'ban.translate': 'Traduire', 'ban.no': 'Non', 'ban.cancel': 'Annuler',
      'ban.done': 'Traduit en {to} avec l\'IA', 'ban.failed': ' ({n} échecs, original conservé)', 'ban.restore': 'Afficher l\'original',
      'ban.retranslate': 'Retraduire', 'ban.retryFailed': 'Réessayer les échecs', 'ban.nokey': 'Aucune clé API. Cliquez sur l\'icône de l\'extension → Réglages.',
      'ban.analyzing': 'Analyse de la page…', 'ban.translating': 'Traduction… {n}/{m}', 'ban.cost': 'Coût ~ ¥{n}'
    },
    'de': {
      'opt.title': 'AI Seite Übersetzen · Einstellungen', 'opt.section.api': 'API-Verbindung', 'opt.baseUrl.label': 'API-URL (OpenAI-kompatibler Endpunkt)',
      'opt.baseUrl.note': 'Funktioniert mit jeder OpenAI-kompatiblen API. ⚠️ Bei einem Nicht-DeepSeek-Domain wird Ihr Key an diese Domain gesendet — nur vertrauenswürdige Anbieter.',
      'opt.apiKey.label': 'API-Schlüssel', 'opt.apiKey.note': 'Nur in Ihrem Browser gespeichert. Verwenden Sie einen dedizierten Key mit Ausgabenlimit, um ihn bei Verlust widerrufen zu können.',
      'opt.model.label': 'Modell', 'opt.model.note': 'Standard deepseek-v4-flash (Denken deaktiviert für Schnelligkeit & Stabilität).',
      'opt.section.pref': 'Übersetzung', 'opt.targetLang.label': 'Standard-Zielsprache', 'opt.section.ui': 'Oberfläche',
      'opt.displayLang.label': 'Anzeigesprache (Extension-UI-Text)', 'opt.displayLang.note': 'Ändert die Sprache von Schaltflächen, Hinweisen und Bannern; beeinflusst die Zielsprache nicht.',
      'opt.test': 'Verbindung testen', 'opt.testing': 'Verbindung wird getestet…', 'opt.testOk': '✓ Verbindung OK, Modell nutzbar', 'opt.testErr': 'Verbindung fehlgeschlagen: {msg}',
      'opt.save': 'Speichern', 'opt.cancel': 'Abbrechen', 'opt.saved': '✓ Gespeichert', 'opt.section.site': 'Website-Einstellungen', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Hinzufügen',
      'opt.site.note': 'Pro Domain „Immer übersetzen / Nie übersetzen“ (überschreibt global); Subdomains erben.',
      'opt.help.title': 'Hinweise', 'opt.help.1': 'Übersetzung wird Ihrem eigenen API-Konto berechnet. DeepSeek ist günstig — eine Seite kostet Cent.',
      'opt.help.2': 'Nicht-DeepSeek-Domains fragen beim Speichern nach Erlaubnis.', 'opt.help.3': 'Zielsprache wechseln wirkt sofort; übersetzte Seiten werden neu übersetzt.',
      'opt.help.4': 'Codeblöcke, Eingabefelder und Schaltflächen werden standardmäßig nicht übersetzt.', 'opt.testFailBg': 'Test fehlgeschlagen: Hintergrund nicht erreichbar', 'opt.testOk2': '✓ Verbindung OK. Beispiel: "{t}"',
      'opt.site.auto': ' Auto', 'opt.site.never': ' Nie', 'opt.site.del': 'Löschen',
      'opt.confirm1': 'Ihr API-Schlüssel wird mit Übersetzungsanfragen an diese Adresse gesendet:\n\n  {origin}\n\nBestätigen Sie, dass Sie diesem Anbieter vertrauen (oder es Ihr eigenes Gateway ist).\nOK zum Speichern, Abbrechen zum Zurückgehen.',
      'pop.title': 'AI Seite Übersetzen', 'pop.loading': 'Laden…', 'pop.translate': 'Diese Seite übersetzen', 'pop.retranslate': 'Erneut übersetzen',
      'pop.restore': 'Original anzeigen', 'pop.retryFailed': 'Fehler erneut versuchen', 'pop.targetLang': 'Zielsprache', 'pop.auto': 'Fremdsprachige Seiten automatisch übersetzen',
      'pop.siteAuto': 'Diese Website automatisch übersetzen', 'pop.siteNever': 'Diese Website nie übersetzen', 'pop.today': 'Heute', 'pop.month': 'Dieser Monat', 'pop.session': 'Diese Seite',
      'pop.settings': 'Einstellungen', 'pop.nokey': 'Kein API-Schlüssel konfiguriert.', 'pop.goSettings': 'Zu den Einstellungen →', 'pop.detectedForeign': 'Fremdsprache erkannt, nicht übersetzt',
      'pop.notTranslated': 'Nicht übersetzt', 'pop.unsupported': 'Diese Seite kann nicht übersetzt werden (Browser-intern oder eingeschränkt).',
      'pop.translating': 'Übersetze… {n}/{m}', 'pop.done': 'Nach {lang} übersetzt', 'pop.failed': ' ({n} fehlgeschlagen)',
      'pop.retranslating': 'Übersetze erneut…', 'pop.noUsageToday': 'Heute keine Übersetzungen',
      'ban.offer': 'Diese Seite scheint {from} zu sein. Mit KI nach {to} übersetzen?', 'ban.translate': 'Übersetzen', 'ban.no': 'Nein', 'ban.cancel': 'Abbrechen',
      'ban.done': 'Mit KI nach {to} übersetzt', 'ban.failed': ' ({n} fehlgeschlagen, Original beibehalten)', 'ban.restore': 'Original anzeigen',
      'ban.retranslate': 'Erneut übersetzen', 'ban.retryFailed': 'Fehler erneut versuchen', 'ban.nokey': 'Kein API-Schlüssel. Klicken Sie auf das Extension-Symbol → Einstellungen.',
      'ban.analyzing': 'Seite wird analysiert…', 'ban.translating': 'Übersetze… {n}/{m}', 'ban.cost': 'Kosten ~ ¥{n}'
    },
    'es': {
      'opt.title': 'Traducción IA · Ajustes', 'opt.section.api': 'Conexión API', 'opt.baseUrl.label': 'URL de API (extremo compatible con OpenAI)',
      'opt.baseUrl.note': 'Funciona con cualquier API compatible con OpenAI. ⚠️ Si cambias a un dominio que no sea DeepSeek, tu clave se envía a ese dominio: usa solo proveedores de confianza.',
      'opt.apiKey.label': 'Clave API', 'opt.apiKey.note': 'Solo se guarda en tu navegador. Usa una clave dedicada con límite de gasto para poder revocarla si se filtra.',
      'opt.model.label': 'Modelo', 'opt.model.note': 'Por defecto deepseek-v4-flash (pensamiento desactivado para rapidez y estabilidad).',
      'opt.section.pref': 'Traducción', 'opt.targetLang.label': 'Idioma de destino predeterminado', 'opt.section.ui': 'Interfaz',
      'opt.displayLang.label': 'Idioma de pantalla (texto de la extensión)', 'opt.displayLang.note': 'Cambia el idioma de botones, notas y banners; no afecta al idioma de destino.',
      'opt.test': 'Probar conexión', 'opt.testing': 'Probando conexión…', 'opt.testOk': '✓ Conexión correcta, modelo usable', 'opt.testErr': 'Error de conexión: {msg}',
      'opt.save': 'Guardar', 'opt.cancel': 'Cancelar', 'opt.saved': '✓ Guardado', 'opt.section.site': 'Ajustes del sitio', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Añadir',
      'opt.site.note': 'Configura auto-traducir / nunca traducir por dominio (prioridad sobre global); los subdominios heredan.',
      'opt.help.title': 'Notas', 'opt.help.1': 'La traducción se factura a tu propia cuenta de API. DeepSeek es barato: una página cuesta unos céntimos.',
      'opt.help.2': 'Los dominios que no son DeepSeek piden permiso al guardar.', 'opt.help.3': 'Cambiar el idioma de destino se aplica al instante; las páginas traducidas se vuelven a traducir.',
      'opt.help.4': 'Los bloques de código, campos de entrada y botones no se traducen por defecto.', 'opt.testFailBg': 'Error de prueba: no se puede conectar con el fondo', 'opt.testOk2': '✓ Conexión correcta. Ejemplo: "{t}"',
      'opt.site.auto': ' Auto', 'opt.site.never': ' Nunca', 'opt.site.del': 'Eliminar',
      'opt.confirm1': 'Tu clave API se enviará a esta dirección con las solicitudes de traducción:\n\n  {origin}\n\nConfirma que confías en este proveedor (o que es tu propio gateway).\nOK para guardar, Cancelar para volver.',
      'pop.title': 'Traducción IA', 'pop.loading': 'Cargando…', 'pop.translate': 'Traducir esta página', 'pop.retranslate': 'Volver a traducir',
      'pop.restore': 'Mostrar original', 'pop.retryFailed': 'Reintentar fallos', 'pop.targetLang': 'Idioma de destino', 'pop.auto': 'Traducir automáticamente páginas extranjeras',
      'pop.siteAuto': 'Auto-traducir este sitio', 'pop.siteNever': 'Nunca traducir este sitio', 'pop.today': 'Hoy', 'pop.month': 'Este mes', 'pop.session': 'Esta página',
      'pop.settings': 'Ajustes', 'pop.nokey': 'No hay clave API configurada.', 'pop.goSettings': 'Ir a ajustes →', 'pop.detectedForeign': 'Idioma extranjero detectado, no traducido',
      'pop.notTranslated': 'No traducido', 'pop.unsupported': 'Esta página no se puede traducir (página interna del navegador o restringida).',
      'pop.translating': 'Traduciendo… {n}/{m}', 'pop.done': 'Traducido a {lang}', 'pop.failed': ' ({n} fallos)',
      'pop.retranslating': 'Traduciendo de nuevo…', 'pop.noUsageToday': 'Sin traducciones hoy',
      'ban.offer': 'Esta página parece estar en {from}. ¿Traducirla a {to} con IA?', 'ban.translate': 'Traducir', 'ban.no': 'No', 'ban.cancel': 'Cancelar',
      'ban.done': 'Traducido a {to} con IA', 'ban.failed': ' ({n} fallos, original conservado)', 'ban.restore': 'Mostrar original',
      'ban.retranslate': 'Volver a traducir', 'ban.retryFailed': 'Reintentar fallos', 'ban.nokey': 'Sin clave API. Haz clic en el icono de la extensión → Ajustes.',
      'ban.analyzing': 'Analizando la página…', 'ban.translating': 'Traduciendo… {n}/{m}', 'ban.cost': 'Coste ~ ¥{n}'
    },
    'ru': {
      'opt.title': 'Перевод ИИ · Настройки', 'opt.section.api': 'Подключение API', 'opt.baseUrl.label': 'URL API (совместимый с OpenAI)',
      'opt.baseUrl.note': 'Работает с любым совместимым с OpenAI API. ⚠️ При смене на не-DeepSeek домен ключ отправляется этому домену — используйте только доверенные сервисы.',
      'opt.apiKey.label': 'Ключ API', 'opt.apiKey.note': 'Хранится только в вашем браузере. Используйте выделенный ключ с лимитом расходов, чтобы его можно было отозвать при утечке.',
      'opt.model.label': 'Модель', 'opt.model.note': 'По умолчанию deepseek-v4-flash (мышление отключено для скорости и стабильности).',
      'opt.section.pref': 'Перевод', 'opt.targetLang.label': 'Язык перевода по умолчанию', 'opt.section.ui': 'Интерфейс',
      'opt.displayLang.label': 'Язык интерфейса (текст расширения)', 'opt.displayLang.note': 'Меняет язык кнопок, примечаний и баннеров; не влияет на язык перевода.',
      'opt.test': 'Проверить подключение', 'opt.testing': 'Проверка подключения…', 'opt.testOk': '✓ Подключение OK, модель доступна', 'opt.testErr': 'Ошибка подключения: {msg}',
      'opt.save': 'Сохранить', 'opt.cancel': 'Отмена', 'opt.saved': '✓ Сохранено', 'opt.section.site': 'Настройки сайта', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Добавить',
      'opt.site.note': 'Задать «автоперевод / не переводить» для домена (приоритет над глобальным); поддомены наследуют.',
      'opt.help.title': 'Примечания', 'opt.help.1': 'Перевод тарифицируется по вашему собственному аккаунту API. DeepSeek дешёв — страница стоит копейки.',
      'opt.help.2': 'Не-DeepSeek домены запрашивают разрешение при сохранении.', 'opt.help.3': 'Смена языка перевода применяется сразу; переведённые страницы переведены заново.',
      'opt.help.4': 'Блоки кода, поля ввода и кнопки по умолчанию не переводятся.', 'opt.testFailBg': 'Ошибка теста: не удаётся подключиться к фону', 'opt.testOk2': '✓ Подключение OK. Пример: «{t}»',
      'opt.site.auto': ' Авто', 'opt.site.never': ' Никогда', 'opt.site.del': 'Удалить',
      'opt.confirm1': 'Ваш ключ API будет отправлен по этому адресу вместе с запросами перевода:\n\n  {origin}\n\nПодтвердите, что доверяете этому провайдеру (или это ваш собственный шлюз).\nOK — сохранить, Отмена — назад.',
      'pop.title': 'Перевод ИИ', 'pop.loading': 'Загрузка…', 'pop.translate': 'Перевести эту страницу', 'pop.retranslate': 'Перевести заново',
      'pop.restore': 'Показать оригинал', 'pop.retryFailed': 'Повторить ошибки', 'pop.targetLang': 'Язык перевода', 'pop.auto': 'Автопереводить иностранные страницы',
      'pop.siteAuto': 'Автопереводить этот сайт', 'pop.siteNever': 'Никогда не переводить этот сайт', 'pop.today': 'Сегодня', 'pop.month': 'В этом месяце', 'pop.session': 'Эта страница',
      'pop.settings': 'Настройки', 'pop.nokey': 'Ключ API не настроен.', 'pop.goSettings': 'К настройкам →', 'pop.detectedForeign': 'Обнаружен иностранный язык, не переведено',
      'pop.notTranslated': 'Не переведено', 'pop.unsupported': 'Эта страница не может быть переведена (внутренняя страница браузера или ограниченная).',
      'pop.translating': 'Перевод… {n}/{m}', 'pop.done': 'Переведено на {lang}', 'pop.failed': ' ({n} ошибок)',
      'pop.retranslating': 'Переведено заново…', 'pop.noUsageToday': 'Сегодня переводов нет',
      'ban.offer': 'Похоже, эта страница на {from}. Перевести её на {to} с помощью ИИ?', 'ban.translate': 'Перевести', 'ban.no': 'Нет', 'ban.cancel': 'Отмена',
      'ban.done': 'Переведено на {to} с помощью ИИ', 'ban.failed': ' ({n} ошибок, оригинал сохранён)', 'ban.restore': 'Показать оригинал',
      'ban.retranslate': 'Перевести заново', 'ban.retryFailed': 'Повторить ошибки', 'ban.nokey': 'Нет ключа API. Нажмите на значок расширения → Настройки.',
      'ban.analyzing': 'Анализ страницы…', 'ban.translating': 'Перевод… {n}/{m}', 'ban.cost': 'Стоимость ~ ¥{n}'
    },
    'pt': {
      'opt.title': 'Tradução IA · Configurações', 'opt.section.api': 'Conexão API', 'opt.baseUrl.label': 'URL da API (ponto de extremidade compatível com OpenAI)',
      'opt.baseUrl.note': 'Funciona com qualquer API compatível com OpenAI. ⚠️ Se mudar para um domínio que não seja DeepSeek, sua chave é enviada a esse domínio — use apenas provedores confiáveis.',
      'opt.apiKey.label': 'Chave API', 'opt.apiKey.note': 'Armazenada apenas no seu navegador. Use uma chave dedicada com limite de gastos para poder revogá-la se vazar.',
      'opt.model.label': 'Modelo', 'opt.model.note': 'Padrão deepseek-v4-flash (pensamento desativado para rapidez e estabilidade).',
      'opt.section.pref': 'Tradução', 'opt.targetLang.label': 'Idioma de destino padrão', 'opt.section.ui': 'Interface',
      'opt.displayLang.label': 'Idioma de exibição (texto da extensão)', 'opt.displayLang.note': 'Muda o idioma de botões, notas e banners; não afeta o idioma de destino.',
      'opt.test': 'Testar conexão', 'opt.testing': 'A testar a ligação…', 'opt.testOk': '✓ Ligação OK, modelo utilizável', 'opt.testErr': 'Falha na ligação: {msg}',
      'opt.save': 'Guardar', 'opt.cancel': 'Cancelar', 'opt.saved': '✓ Guardado', 'opt.section.site': 'Configurações do site', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Adicionar',
      'opt.site.note': 'Definir tradução automática / nunca traduzir por domínio (prioridade sobre o global); subdomínios herdam.',
      'opt.help.title': 'Notas', 'opt.help.1': 'A tradução é cobrada na sua própria conta de API. DeepSeek é barato — uma página custa alguns cêntimos.',
      'opt.help.2': 'Domínios que não sejam DeepSeek pedem permissão ao guardar.', 'opt.help.3': 'Mudar o idioma de destino aplica-se de imediato; páginas traduzidas são retraduzidas.',
      'opt.help.4': 'Blocos de código, campos de entrada e botões não são traduzidos por padrão.', 'opt.testFailBg': 'Falha no teste: não é possível alcançar o fundo', 'opt.testOk2': '✓ Ligação OK. Exemplo: "{t}"',
      'opt.site.auto': ' Auto', 'opt.site.never': ' Nunca', 'opt.site.del': 'Eliminar',
      'opt.confirm1': 'A sua chave API será enviada para este endereço com os pedidos de tradução:\n\n  {origin}\n\nConfirme que confia neste fornecedor (ou que é o seu próprio gateway).\nOK para guardar, Cancelar para voltar.',
      'pop.title': 'Tradução IA', 'pop.loading': 'A carregar…', 'pop.translate': 'Traduzir esta página', 'pop.retranslate': 'Retraduzir',
      'pop.restore': 'Mostrar original', 'pop.retryFailed': 'Repetir falhas', 'pop.targetLang': 'Idioma de destino', 'pop.auto': 'Traduzir automaticamente páginas estrangeiras',
      'pop.siteAuto': 'Tradução automática deste site', 'pop.siteNever': 'Nunca traduzir este site', 'pop.today': 'Hoje', 'pop.month': 'Este mês', 'pop.session': 'Esta página',
      'pop.settings': 'Configurações', 'pop.nokey': 'Nenhuma chave API configurada.', 'pop.goSettings': 'Ir para as configurações →', 'pop.detectedForeign': 'Idioma estrangeiro detetado, não traduzido',
      'pop.notTranslated': 'Não traduzido', 'pop.unsupported': 'Esta página não pode ser traduzida (página interna do navegador ou restrita).',
      'pop.translating': 'A traduzir… {n}/{m}', 'pop.done': 'Traduzido para {lang}', 'pop.failed': ' ({n} falhas)',
      'pop.retranslating': 'A retraduzir…', 'pop.noUsageToday': 'Sem traduções hoje',
      'ban.offer': 'Esta página parece estar em {from}. Traduzi-la para {to} com IA?', 'ban.translate': 'Traduzir', 'ban.no': 'Não', 'ban.cancel': 'Cancelar',
      'ban.done': 'Traduzido para {to} com IA', 'ban.failed': ' ({n} falhas, original mantido)', 'ban.restore': 'Mostrar original',
      'ban.retranslate': 'Retraduzir', 'ban.retryFailed': 'Repetir falhas', 'ban.nokey': 'Sem chave API. Clique no ícone da extensão → Configurações.',
      'ban.analyzing': 'A analisar a página…', 'ban.translating': 'A traduzir… {n}/{m}', 'ban.cost': 'Custo ~ ¥{n}'
    },
    'it': {
      'opt.title': 'Traduzione IA · Impostazioni', 'opt.section.api': 'Connessione API', 'opt.baseUrl.label': 'URL API (endpoint compatibile OpenAI)',
      'opt.baseUrl.note': 'Funziona con qualsiasi API compatibile OpenAI. ⚠️ Se passi a un dominio non-DeepSeek, la chiave viene inviata a quel dominio — usa solo provider di fiducia.',
      'opt.apiKey.label': 'Chiave API', 'opt.apiKey.note': 'Salvata solo nel browser. Usa una chiave dedicata con limite di spesa per poterla revocare se trapela.',
      'opt.model.label': 'Modello', 'opt.model.note': 'Predefinito deepseek-v4-flash (pensiero disattivato per velocità e stabilità).',
      'opt.section.pref': 'Traduzione', 'opt.targetLang.label': 'Lingua di destinazione predefinita', 'opt.section.ui': 'Interfaccia',
      'opt.displayLang.label': 'Lingua di visualizzazione (testo dell\'estensione)', 'opt.displayLang.note': 'Cambia la lingua di pulsanti, note e banner; non influisce sulla lingua di destinazione.',
      'opt.test': 'Testa connessione', 'opt.testing': 'Test connessione…', 'opt.testOk': '✓ Connessione OK, modello utilizzabile', 'opt.testErr': 'Errore di connessione: {msg}',
      'opt.save': 'Salva', 'opt.cancel': 'Annulla', 'opt.saved': '✓ Salvato', 'opt.section.site': 'Impostazioni sito', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Aggiungi',
      'opt.site.note': 'Imposta traduci automaticamente / mai tradurre per dominio (priorità sul globale); i sottodomini ereditano.',
      'opt.help.title': 'Note', 'opt.help.1': 'La traduzione addebita il tuo account API. DeepSeek è economico — una pagina costa pochi centesimi.',
      'opt.help.2': 'I domini non-DeepSeek chiedono il permesso al salvataggio.', 'opt.help.3': 'Cambiare la lingua di destinazione si applica subito; le pagine tradotte vengono ritradotte.',
      'opt.help.4': 'Blocchi di codice, campi di input e pulsanti non vengono tradotti per impostazione predefinita.', 'opt.testFailBg': 'Test fallito: impossibile raggiungere il background', 'opt.testOk2': '✓ Connessione OK. Esempio: "{t}"',
      'opt.site.auto': ' Auto', 'opt.site.never': ' Mai', 'opt.site.del': 'Elimina',
      'opt.confirm1': 'La tua chiave API verrà inviata a questo indirizzo con le richieste di traduzione:\n\n  {origin}\n\nConferma che ti fidi di questo provider (o che è il tuo gateway).\nOK per salvare, Annulla per tornare.',
      'pop.title': 'Traduzione IA', 'pop.loading': 'Caricamento…', 'pop.translate': 'Traduci questa pagina', 'pop.retranslate': 'Ritraduci',
      'pop.restore': 'Mostra originale', 'pop.retryFailed': 'Riprova errori', 'pop.targetLang': 'Lingua di destinazione', 'pop.auto': 'Traduci automaticamente le pagine straniere',
      'pop.siteAuto': 'Traduci automaticamente questo sito', 'pop.siteNever': 'Non tradurre mai questo sito', 'pop.today': 'Oggi', 'pop.month': 'Questo mese', 'pop.session': 'Questa pagina',
      'pop.settings': 'Impostazioni', 'pop.nokey': 'Nessuna chiave API configurata.', 'pop.goSettings': 'Vai alle impostazioni →', 'pop.detectedForeign': 'Lingua straniera rilevata, non tradotta',
      'pop.notTranslated': 'Non tradotto', 'pop.unsupported': 'Questa pagina non può essere tradotta (pagina interna del browser o limitata).',
      'pop.translating': 'Traduzione… {n}/{m}', 'pop.done': 'Tradotto in {lang}', 'pop.failed': ' ({n} errori)',
      'pop.retranslating': 'Ritraduzione…', 'pop.noUsageToday': 'Nessuna traduzione oggi',
      'ban.offer': 'Questa pagina sembra essere in {from}. Tradurla in {to} con l\'IA?', 'ban.translate': 'Traduci', 'ban.no': 'No', 'ban.cancel': 'Annulla',
      'ban.done': 'Tradotto in {to} con l\'IA', 'ban.failed': ' ({n} errori, originale mantenuto)', 'ban.restore': 'Mostra originale',
      'ban.retranslate': 'Ritraduci', 'ban.retryFailed': 'Riprova errori', 'ban.nokey': 'Nessuna chiave API. Clicca l\'icona dell\'estensione → Impostazioni.',
      'ban.analyzing': 'Analisi della pagina…', 'ban.translating': 'Traduzione… {n}/{m}', 'ban.cost': 'Costo ~ ¥{n}'
    }
  }
};

if (typeof module !== 'undefined' && module.exports) { module.exports = AITR; }
