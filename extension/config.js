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
    displayLang: 'zh-CN',                // 插件界面显示语言（UI 文字语言，区别于 targetLang）
    displayMode: 'replace'               // 翻译显示模式：replace=替换原文（默认）｜bilingual=双语对照（块级上下，保留原文）
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

  // token 数 → 费用估算（返回人民币）—— 字符级兜底估算，仅在后台未返回真实 token 时使用（主路径已是下方 computeCost 真实单价）
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
      'opt.section.api': 'API 连接', 'opt.baseUrl.label': 'API 地址（OpenAI 兼容）',
      'opt.baseUrl.note': '换成非 DeepSeek 域名时，Key 会发给那个服务商。',
      'opt.apiKey.label': 'API Key', 'opt.apiKey.note': '只保存在本机。',
      'opt.model.label': '模型', 'opt.model.note': '默认 deepseek-v4-flash。',
      'opt.section.pref': '翻译偏好', 'opt.targetLang.label': '默认目标语言',
      'opt.displayMode.label': '显示模式', 'opt.displayMode.replace': '替换原文', 'opt.displayMode.bilingual': '双语对照',
      'opt.section.ui': '界面语言', 'opt.displayLang.label': '显示语言（插件界面文字）',
      'opt.displayLang.note': '只改插件界面，不影响翻译语言。',
      'opt.test': '测试连接', 'opt.testing': '正在测试…', 'opt.testErr': '连接失败：{msg}',
      'opt.save': '保存', 'opt.cancel': '取消', 'opt.saved': '✓ 已保存',
      'opt.section.site': '站点设置', 'opt.site.addPh': 'example.com', 'opt.site.add': '添加',
      'opt.site.note': '优先于全局设置；子域名跟随上级。',
      'opt.help.title': '说明', 'opt.help.1': '翻译走你自己的 API，费用由服务商收取。',
      'opt.help.3': '已翻译的页面换目标语言会自动重翻。',
      'opt.help.4': '代码块和输入框不翻。',
      'opt.testFailBg': '测试失败：无法连接后台', 'opt.testOk2': '✓ 连接正常。示例：「{t}」',
      'opt.site.auto': ' 自动', 'opt.site.never': ' 永不翻译', 'opt.site.del': '删除',
      'opt.confirm1': 'Key 会随翻译请求发送到 {origin}。确定继续？',
      // 弹窗
      'pop.title': 'AI 页面翻译', 'pop.loading': '加载中…', 'pop.translate': '翻译此页',
      'pop.retranslate': '重新翻译', 'pop.restore': '还原原文', 'pop.retryFailed': '重试失败段落',
      'pop.targetLang': '目标语言', 'pop.auto': '外文页面自动翻译', 'pop.siteAuto': '此站点自动翻译',
      'pop.displayMode.label': '显示模式', 'pop.displayMode.replace': '替换原文', 'pop.displayMode.bilingual': '双语对照',
      'pop.siteNever': '此站点永不翻译', 'pop.today': '今日', 'pop.month': '本月', 'pop.session': '本次',
      'pop.settings': '设置', 'pop.nokey': '还没配置 API Key。', 'pop.goSettings': '去设置 →',
      'pop.detectedForeign': '检测到外文，未翻译', 'pop.notTranslated': '此页未翻译',
      'pop.noUsageToday': '今天还没翻译', 'unknown.lang': '外文',
      'pop.unsupported': '这个页面不能翻译（浏览器内部页或受限站点）。',
      'pop.translating': '翻译中… {n}/{m}', 'pop.done': '已翻译成{lang}', 'pop.failed': '（{n} 段失败）',
      'pop.retranslating': '重新翻译中…',
      // 横幅
      'ban.offer': '此页面看起来是{from}。翻译成{to}？', 'ban.translate': 'AI 翻译', 'ban.no': '不翻译',
      'ban.cancel': '取消', 'ban.done': '已翻译成{to}',
      'ban.failed': '（{n} 段没翻成，保留原文）', 'ban.restore': '显示原文',
      'ban.retranslate': '重新翻译', 'ban.retryFailed': '重试失败段落',
      'ban.nokey': '还没填 API Key。点扩展图标 → 设置。',
      'ban.analyzing': '正在分析全文…', 'ban.translating': '正在翻译… {n}/{m}',
      'ban.cost': '本页翻译约 ¥{n}'
    },
    'en': {
      'opt.title': 'AI Page Translate · Settings',
      'opt.section.api': 'API Connection', 'opt.baseUrl.label': 'API URL (OpenAI-compatible)',
      'opt.baseUrl.note': 'A non-DeepSeek domain receives your key with each request.',
      'opt.apiKey.label': 'API Key', 'opt.apiKey.note': 'Stored on this device.',
      'opt.model.label': 'Model', 'opt.model.note': 'Default: deepseek-v4-flash.',
      'opt.section.pref': 'Translation', 'opt.targetLang.label': 'Default target language',
      'opt.displayMode.label': 'Display mode', 'opt.displayMode.replace': 'Replace', 'opt.displayMode.bilingual': 'Bilingual',
      'opt.section.ui': 'Interface', 'opt.displayLang.label': 'Display language (extension UI text)',
      'opt.displayLang.note': 'UI language only — does not change what pages are translated into.',
      'opt.test': 'Test connection', 'opt.testing': 'Testing…', 'opt.testErr': 'Connection failed: {msg}',
      'opt.save': 'Save', 'opt.cancel': 'Cancel', 'opt.saved': '✓ Saved',
      'opt.section.site': 'Site settings', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Add',
      'opt.site.note': 'Overrides the global setting; subdomains follow their parent.',
      'opt.help.title': 'Notes', 'opt.help.1': 'Translation runs on your own API account.',
      'opt.help.3': 'Changing the target language re-translates open pages.',
      'opt.help.4': 'Code blocks and inputs are left alone.',
      'opt.testFailBg': 'Test failed: cannot reach background', 'opt.testOk2': '✓ Connected. Sample: “{t}”',
      'opt.site.auto': ' Auto', 'opt.site.never': ' Never', 'opt.site.del': 'Delete',
      'opt.confirm1': 'Your key will be sent to {origin} with each translation request. Continue?',
      'pop.title': 'AI Page Translate', 'pop.loading': 'Loading…', 'pop.translate': 'Translate this page',
      'pop.retranslate': 'Re-translate', 'pop.restore': 'Show original', 'pop.retryFailed': 'Retry failed parts',
      'pop.targetLang': 'Target language', 'pop.auto': 'Auto-translate foreign pages', 'pop.siteAuto': 'Auto-translate this site',
      'pop.displayMode.label': 'Display mode', 'pop.displayMode.replace': 'Replace', 'pop.displayMode.bilingual': 'Bilingual',
      'pop.siteNever': 'Never translate this site', 'pop.today': 'Today', 'pop.month': 'This month', 'pop.session': 'This page',
      'pop.settings': 'Settings', 'pop.nokey': 'No API Key configured.', 'pop.goSettings': 'Go to Settings →',
      'pop.detectedForeign': 'Foreign language detected, not translated', 'pop.notTranslated': 'Not translated',
      'pop.noUsageToday': 'Nothing translated today', 'unknown.lang': 'Foreign',
      'pop.unsupported': 'This page can’t be translated (browser internal or restricted).',
      'pop.translating': 'Translating… {n}/{m}', 'pop.done': 'Translated to {lang}', 'pop.failed': ' ({n} failed)',
      'pop.retranslating': 'Re-translating…',
      'ban.offer': 'This page looks like {from}. Translate to {to}?', 'ban.translate': 'Translate', 'ban.no': 'No',
      'ban.cancel': 'Cancel', 'ban.done': 'Translated to {to}',
      'ban.failed': ' ({n} parts kept in original)', 'ban.restore': 'Show original',
      'ban.retranslate': 'Re-translate', 'ban.retryFailed': 'Retry failed parts',
      'ban.nokey': 'No API key yet. Click the extension icon → Settings.',
      'ban.analyzing': 'Analyzing page…', 'ban.translating': 'Translating… {n}/{m}',
      'ban.cost': 'Cost ~ ¥{n}'
    },
    'zh-TW': {
      'opt.title': 'AI 頁面翻譯 · 設定', 'opt.section.api': 'API 連線', 'opt.baseUrl.label': 'API 位址（OpenAI 相容）',
      'opt.baseUrl.note': '換成非 DeepSeek 網域時，Key 會發給該服務商。',
      'opt.apiKey.label': 'API Key', 'opt.apiKey.note': '只保存在本機。',
      'opt.model.label': '模型', 'opt.model.note': '預設 deepseek-v4-flash。',
      'opt.section.pref': '翻譯偏好', 'opt.targetLang.label': '預設目標語言', 'opt.section.ui': '介面語言',
      'opt.displayMode.label': '顯示模式', 'opt.displayMode.replace': '取代原文', 'opt.displayMode.bilingual': '雙語對照',
      'opt.displayLang.label': '顯示語言（外掛介面文字）', 'opt.displayLang.note': '只改外掛介面，不影響翻譯語言。',
      'opt.test': '測試連線', 'opt.testing': '正在測試…', 'opt.testErr': '連線失敗：{msg}',
      'opt.save': '儲存', 'opt.cancel': '取消', 'opt.saved': '✓ 已儲存', 'opt.section.site': '網站設定', 'opt.site.addPh': 'example.com', 'opt.site.add': '新增',
      'opt.site.note': '優先於全域設定；子網域跟隨上級。',
      'opt.help.title': '說明', 'opt.help.1': '翻譯走你自己的 API，費用由服務商收取。',
      'opt.help.3': '已翻譯的頁面換目標語言會自動重翻。',
      'opt.help.4': '程式碼區塊和輸入框不翻。', 'opt.testFailBg': '測試失敗：無法連後台', 'opt.testOk2': '✓ 連線正常。範例：「{t}」',
      'opt.site.auto': ' 自動', 'opt.site.never': ' 永不翻譯', 'opt.site.del': '刪除',
      'opt.confirm1': 'Key 會隨翻譯請求傳送到 {origin}。確定繼續？',
      'pop.title': 'AI 頁面翻譯', 'pop.loading': '載入中…', 'pop.translate': '翻譯此頁', 'pop.retranslate': '重新翻譯',
      'pop.restore': '還原原文', 'pop.retryFailed': '重試失敗段落', 'pop.targetLang': '目標語言', 'pop.auto': '外文頁面自動翻譯',
      'pop.displayMode.label': '顯示模式', 'pop.displayMode.replace': '取代原文', 'pop.displayMode.bilingual': '雙語對照',
      'pop.siteAuto': '此網站自動翻譯', 'pop.siteNever': '此網站永不翻譯', 'pop.today': '今日', 'pop.month': '本月', 'pop.session': '本次',
      'pop.settings': '設定', 'pop.nokey': '還沒設定 API Key。', 'pop.goSettings': '去設定 →', 'pop.detectedForeign': '偵測到外文，未翻譯',
      'pop.notTranslated': '此頁未翻譯', 'pop.unsupported': '這個頁面不能翻譯（瀏覽器內部頁或受限站點）。',
      'pop.translating': '翻譯中… {n}/{m}', 'pop.done': '已翻譯成{lang}', 'pop.failed': '（{n} 段失敗）',
      'pop.retranslating': '重新翻譯中…', 'pop.noUsageToday': '今天還沒翻譯',
      'ban.offer': '此頁面看起來是{from}。翻譯成{to}？', 'ban.translate': 'AI 翻譯', 'ban.no': '不翻譯', 'ban.cancel': '取消',
      'ban.done': '已翻譯成{to}', 'ban.failed': '（{n} 段沒翻成，保留原文）', 'ban.restore': '顯示原文',
      'ban.retranslate': '重新翻譯', 'ban.retryFailed': '重試失敗段落', 'ban.nokey': '還沒填 API Key。點擴充功能圖示 → 設定。',
      'ban.analyzing': '正在分析全文…', 'ban.translating': '正在翻譯… {n}/{m}', 'ban.cost': '本頁翻譯約 ¥{n}'
    },
    'ja': {
      'opt.title': 'AI ページ翻訳 · 設定', 'opt.section.api': 'API 接続', 'opt.baseUrl.label': 'API アドレス（OpenAI 互換）',
      'opt.baseUrl.note': 'DeepSeek 以外のドメインに変えると、Key はそのサービスに送られます。',
      'opt.apiKey.label': 'API Key', 'opt.apiKey.note': 'この端末にのみ保存されます。',
      'opt.model.label': 'モデル', 'opt.model.note': 'デフォルト deepseek-v4-flash（思考モード無効、高速で安定）。',
      'opt.section.pref': '翻訳設定', 'opt.targetLang.label': 'デフォルトの目標言語', 'opt.section.ui': 'インターフェース',
      'opt.displayMode.label': '表示モード', 'opt.displayMode.replace': '原文を置き換え', 'opt.displayMode.bilingual': 'バイリンガル対訳',
      'opt.displayLang.label': '表示言語（拡張のUIテキスト）', 'opt.displayLang.note': '拡張の表示言語のみ。翻訳先の言語は変わりません。',
      'opt.test': '接続テスト', 'opt.testing': 'テスト中…', 'opt.testErr': '接続失敗：{msg}',
      'opt.save': '保存', 'opt.cancel': 'キャンセル', 'opt.saved': '✓ 保存済み', 'opt.section.site': 'サイト設定', 'opt.site.addPh': 'example.com', 'opt.site.add': '追加',
      'opt.site.note': '全体設定より優先。サブドメインは親に従います。',
      'opt.help.title': '説明', 'opt.help.1': '翻訳はあなたの API アカウントで課金されます。',
      'opt.help.3': '翻訳済みのページで言語を変えると、自動で翻訳し直します。',
      'opt.help.4': 'コードブロックと入力欄は翻訳しません。', 'opt.testFailBg': 'テスト失敗：バックグラウンドに接続できません', 'opt.testOk2': '✓ 接続できました。例：「{t}」',
      'opt.site.auto': ' 自動', 'opt.site.never': ' 翻訳しない', 'opt.site.del': '削除',
      'opt.confirm1': 'Key は翻訳リクエストとともに {origin} へ送られます。続けますか？',
      'pop.title': 'AI ページ翻訳', 'pop.loading': '読み込み中…', 'pop.translate': 'このページを翻訳', 'pop.retranslate': '再翻訳',
      'pop.restore': '原文を表示', 'pop.retryFailed': '失敗部分を再試行', 'pop.targetLang': '目標言語', 'pop.auto': '外国語ページを自動翻訳',
      'pop.displayMode.label': '表示モード', 'pop.displayMode.replace': '原文を置き換え', 'pop.displayMode.bilingual': 'バイリンガル対訳',
      'pop.siteAuto': 'このサイトを自動翻訳', 'pop.siteNever': 'このサイトを翻訳しない', 'pop.today': '今日', 'pop.month': '今月', 'pop.session': '今回',
      'pop.settings': '設定', 'pop.nokey': 'API Key が未設定です。', 'pop.goSettings': '設定へ →', 'pop.detectedForeign': '外国語を検出、未翻訳',
      'pop.notTranslated': '未翻訳', 'pop.unsupported': 'このページは翻訳できません（ブラウザ内部のページなど）。',
      'pop.translating': '翻訳中… {n}/{m}', 'pop.done': '{lang} に翻訳済み', 'pop.failed': '（{n} 件失敗）',
      'pop.retranslating': '再翻訳中…', 'pop.noUsageToday': '今日はまだ翻訳していません',
      'ban.offer': 'このページは{from}のようです。{to}に翻訳しますか？', 'ban.translate': 'AI 翻訳', 'ban.no': 'しない', 'ban.cancel': 'キャンセル',
      'ban.done': '{to}に翻訳しました', 'ban.failed': '（{n} 件は原文のまま）', 'ban.restore': '原文を表示',
      'ban.retranslate': '再翻訳', 'ban.retryFailed': '失敗部分を再試行', 'ban.nokey': 'API Key が未設定です。拡張アイコン → 設定から入力してください。',
      'ban.analyzing': '全文を分析中…', 'ban.translating': '翻訳中… {n}/{m}', 'ban.cost': 'このページ約 ¥{n}'
    },
    'ko': {
      'opt.title': 'AI 페이지 번역 · 설정', 'opt.section.api': 'API 연결', 'opt.baseUrl.label': 'API 주소 (OpenAI 호환)',
      'opt.baseUrl.note': 'DeepSeek가 아닌 도메인으로 바꾸면 Key가 그 서비스로 전송됩니다.',
      'opt.apiKey.label': 'API Key', 'opt.apiKey.note': '이 기기에만 저장됩니다.',
      'opt.model.label': '모델', 'opt.model.note': '기본값 deepseek-v4-flash (생각 모드 끔, 빠르고 안정적).',
      'opt.section.pref': '번역 설정', 'opt.targetLang.label': '기본 번역 대상 언어', 'opt.section.ui': '인터페이스',
      'opt.displayMode.label': '표시 모드', 'opt.displayMode.replace': '원문 대체', 'opt.displayMode.bilingual': '이중언어 대조',
      'opt.displayLang.label': '표시 언어 (확장 UI 텍스트)', 'opt.displayLang.note': '확장 UI 언어만 바뀝니다. 번역 대상 언어는 그대로입니다.',
      'opt.test': '연결 테스트', 'opt.testing': '테스트 중…', 'opt.testErr': '연결 실패: {msg}',
      'opt.save': '저장', 'opt.cancel': '취소', 'opt.saved': '✓ 저장됨', 'opt.section.site': '사이트 설정', 'opt.site.addPh': 'example.com', 'opt.site.add': '추가',
      'opt.site.note': '전역 설정보다 우선합니다. 하위 도메인은 상위 설정을 따릅니다.',
      'opt.help.title': '설명', 'opt.help.1': '번역은 사용자의 API 계정으로 청구됩니다.',
      'opt.help.3': '번역된 페이지에서 언어를 바꾸면 자동으로 다시 번역합니다.',
      'opt.help.4': '코드 블록과 입력란은 번역하지 않습니다.', 'opt.testFailBg': '테스트 실패: 백그라운드에 연결할 수 없음', 'opt.testOk2': '✓ 연결되었습니다. 예: “{t}”',
      'opt.site.auto': ' 자동', 'opt.site.never': ' 안 함', 'opt.site.del': '삭제',
      'opt.confirm1': 'Key가 번역 요청과 함께 {origin}(으)로 전송됩니다. 계속할까요?',
      'pop.title': 'AI 페이지 번역', 'pop.loading': '불러오는 중…', 'pop.translate': '이 페이지 번역', 'pop.retranslate': '다시 번역',
      'pop.restore': '원본 표시', 'pop.retryFailed': '실패한 부분 재시도', 'pop.targetLang': '대상 언어', 'pop.auto': '외국어 페이지 자동 번역',
      'pop.displayMode.label': '표시 모드', 'pop.displayMode.replace': '원문 대체', 'pop.displayMode.bilingual': '이중언어 대조',
      'pop.siteAuto': '이 사이트 자동 번역', 'pop.siteNever': '이 사이트 번역 안 함', 'pop.today': '오늘', 'pop.month': '이번 달', 'pop.session': '이 페이지',
      'pop.settings': '설정', 'pop.nokey': 'API Key가 설정되지 않았습니다.', 'pop.goSettings': '설정으로 →', 'pop.detectedForeign': '외국어 감지됨, 번역 안 됨',
      'pop.notTranslated': '번역되지 않음', 'pop.unsupported': '이 페이지는 번역할 수 없습니다(브라우저 내부 페이지 등).',
      'pop.translating': '번역 중… {n}/{m}', 'pop.done': '{lang}(으)로 번역됨', 'pop.failed': '({n}개 실패)',
      'pop.retranslating': '다시 번역 중…', 'pop.noUsageToday': '오늘은 아직 번역하지 않았습니다',
      'ban.offer': '이 페이지는 {from}인 것 같습니다. {to}(으)로 번역할까요?', 'ban.translate': 'AI 번역', 'ban.no': '아니요', 'ban.cancel': '취소',
      'ban.done': '{to}(으)로 번역했습니다', 'ban.failed': '({n}개는 원문 유지)', 'ban.restore': '원본 표시',
      'ban.retranslate': '다시 번역', 'ban.retryFailed': '실패한 부분 재시도', 'ban.nokey': 'API Key가 없습니다. 확장 아이콘 → 설정에서 입력하세요.',
      'ban.analyzing': '전문 분석 중…', 'ban.translating': '번역 중… {n}/{m}', 'ban.cost': '이 페이지 약 ¥{n}'
    },
    'fr': {
      'opt.title': 'AI Page Translate · Réglages', 'opt.section.api': 'Connexion API', 'opt.baseUrl.label': 'Adresse API (compatible OpenAI)',
      'opt.baseUrl.note': 'Un domaine autre que DeepSeek reçoit votre clé avec chaque requête.',
      'opt.apiKey.label': 'Clé API', 'opt.apiKey.note': 'Stockée sur cet appareil.',
      'opt.model.label': 'Modèle', 'opt.model.note': 'Par défaut deepseek-v4-flash (réflexion désactivée pour la rapidité et la stabilité).',
      'opt.section.pref': 'Traduction', 'opt.targetLang.label': 'Langue cible par défaut', 'opt.section.ui': 'Interface',
      'opt.displayMode.label': 'Mode d\'affichage', 'opt.displayMode.replace': 'Remplacer', 'opt.displayMode.bilingual': 'Bilingue',
      'opt.displayLang.label': 'Langue d\'affichage (texte de l\'extension)', 'opt.displayLang.note': 'Langue de l’interface uniquement ; ne change pas la langue de traduction.',
      'opt.test': 'Tester la connexion', 'opt.testing': 'Test…', 'opt.testErr': 'Échec de connexion : {msg}',
      'opt.save': 'Enregistrer', 'opt.cancel': 'Annuler', 'opt.saved': '✓ Enregistré', 'opt.section.site': 'Réglages du site', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Ajouter',
      'opt.site.note': 'Prioritaire sur le réglage global ; les sous-domaines suivent leur parent.',
      'opt.help.title': 'Notes', 'opt.help.1': 'La traduction utilise votre propre compte API.',
      'opt.help.3': 'Changer la langue cible retraduit les pages ouvertes.',
      'opt.help.4': 'Les blocs de code et les champs de saisie ne sont pas traduits.', 'opt.testFailBg': 'Échec du test : impossible d\'atteindre l\'arrière-plan', 'opt.testOk2': '✓ Connexion OK. Exemple : « {t} »',
      'opt.site.auto': ' Auto', 'opt.site.never': ' Jamais', 'opt.site.del': 'Supprimer',
      'opt.confirm1': 'Votre clé sera envoyée à {origin} avec chaque requête de traduction. Continuer ?',
      'pop.title': 'AI Page Translate', 'pop.loading': 'Chargement…', 'pop.translate': 'Traduire cette page', 'pop.retranslate': 'Retraduire',
      'pop.restore': 'Afficher l\'original', 'pop.retryFailed': 'Réessayer les échecs', 'pop.targetLang': 'Langue cible', 'pop.auto': 'Traduire automatiquement les pages étrangères',
      'pop.displayMode.label': 'Mode d\'affichage', 'pop.displayMode.replace': 'Remplacer', 'pop.displayMode.bilingual': 'Bilingue',
      'pop.siteAuto': 'Auto-traduire ce site', 'pop.siteNever': 'Ne jamais traduire ce site', 'pop.today': 'Aujourd\'hui', 'pop.month': 'Ce mois', 'pop.session': 'Cette page',
      'pop.settings': 'Réglages', 'pop.nokey': 'Aucune clé API configurée.', 'pop.goSettings': 'Aller aux réglages →', 'pop.detectedForeign': 'Langue étrangère détectée, non traduite',
      'pop.notTranslated': 'Non traduit', 'pop.unsupported': 'Cette page ne peut pas être traduite (page interne du navigateur ou restreinte).',
      'pop.translating': 'Traduction… {n}/{m}', 'pop.done': 'Traduit en {lang}', 'pop.failed': ' ({n} échecs)',
      'pop.retranslating': 'Retraduction…', 'pop.noUsageToday': 'Aucune traduction aujourd’hui',
      'ban.offer': 'Cette page semble en {from}. Traduire en {to} ?', 'ban.translate': 'Traduire', 'ban.no': 'Non', 'ban.cancel': 'Annuler',
      'ban.done': 'Traduit en {to}', 'ban.failed': ' ({n} passages laissés en original)', 'ban.restore': 'Afficher l\'original',
      'ban.retranslate': 'Retraduire', 'ban.retryFailed': 'Réessayer les échecs', 'ban.nokey': 'Pas encore de clé API. Cliquez sur l’icône de l’extension → Réglages.',
      'ban.analyzing': 'Analyse de la page…', 'ban.translating': 'Traduction… {n}/{m}', 'ban.cost': 'Coût ~ ¥{n}'
    },
    'de': {
      'opt.title': 'AI Seite Übersetzen · Einstellungen', 'opt.section.api': 'API-Verbindung', 'opt.baseUrl.label': 'API-Adresse (OpenAI-kompatibel)',
      'opt.baseUrl.note': 'Bei einer anderen Domain als DeepSeek geht Ihr Key mit jeder Anfrage dorthin.',
      'opt.apiKey.label': 'API-Schlüssel', 'opt.apiKey.note': 'Nur auf diesem Gerät gespeichert.',
      'opt.model.label': 'Modell', 'opt.model.note': 'Standard deepseek-v4-flash (Denken deaktiviert für Schnelligkeit & Stabilität).',
      'opt.section.pref': 'Übersetzung', 'opt.targetLang.label': 'Standard-Zielsprache', 'opt.section.ui': 'Oberfläche',
      'opt.displayMode.label': 'Anzeigemodus', 'opt.displayMode.replace': 'Ersetzen', 'opt.displayMode.bilingual': 'Zweisprachig',
      'opt.displayLang.label': 'Anzeigesprache (Extension-UI-Text)', 'opt.displayLang.note': 'Nur die Sprache der Oberfläche; die Zielsprache bleibt gleich.',
      'opt.test': 'Verbindung testen', 'opt.testing': 'Teste…', 'opt.testErr': 'Verbindung fehlgeschlagen: {msg}',
      'opt.save': 'Speichern', 'opt.cancel': 'Abbrechen', 'opt.saved': '✓ Gespeichert', 'opt.section.site': 'Website-Einstellungen', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Hinzufügen',
      'opt.site.note': 'Hat Vorrang vor der globalen Einstellung; Subdomains folgen der Hauptdomain.',
      'opt.help.title': 'Hinweise', 'opt.help.1': 'Die Übersetzung läuft über Ihr eigenes API-Konto.',
      'opt.help.3': 'Beim Wechsel der Zielsprache werden offene Seiten neu übersetzt.',
      'opt.help.4': 'Codeblöcke und Eingabefelder bleiben unverändert.', 'opt.testFailBg': 'Test fehlgeschlagen: Hintergrund nicht erreichbar', 'opt.testOk2': '✓ Verbunden. Beispiel: „{t}“',
      'opt.site.auto': ' Auto', 'opt.site.never': ' Nie', 'opt.site.del': 'Löschen',
      'opt.confirm1': 'Ihr Key wird mit jeder Übersetzungsanfrage an {origin} gesendet. Fortfahren?',
      'pop.title': 'AI Seite Übersetzen', 'pop.loading': 'Laden…', 'pop.translate': 'Diese Seite übersetzen', 'pop.retranslate': 'Erneut übersetzen',
      'pop.restore': 'Original anzeigen', 'pop.retryFailed': 'Fehler erneut versuchen', 'pop.targetLang': 'Zielsprache', 'pop.auto': 'Fremdsprachige Seiten automatisch übersetzen',
      'pop.displayMode.label': 'Anzeigemodus', 'pop.displayMode.replace': 'Ersetzen', 'pop.displayMode.bilingual': 'Zweisprachig',
      'pop.siteAuto': 'Diese Website automatisch übersetzen', 'pop.siteNever': 'Diese Website nie übersetzen', 'pop.today': 'Heute', 'pop.month': 'Dieser Monat', 'pop.session': 'Diese Seite',
      'pop.settings': 'Einstellungen', 'pop.nokey': 'Kein API-Schlüssel konfiguriert.', 'pop.goSettings': 'Zu den Einstellungen →', 'pop.detectedForeign': 'Fremdsprache erkannt, nicht übersetzt',
      'pop.notTranslated': 'Nicht übersetzt', 'pop.unsupported': 'Diese Seite lässt sich nicht übersetzen (Browser-intern oder eingeschränkt).',
      'pop.translating': 'Übersetze… {n}/{m}', 'pop.done': 'Nach {lang} übersetzt', 'pop.failed': ' ({n} fehlgeschlagen)',
      'pop.retranslating': 'Übersetze erneut…', 'pop.noUsageToday': 'Heute noch nichts übersetzt',
      'ban.offer': 'Diese Seite scheint {from} zu sein. Nach {to} übersetzen?', 'ban.translate': 'Übersetzen', 'ban.no': 'Nein', 'ban.cancel': 'Abbrechen',
      'ban.done': 'Nach {to} übersetzt', 'ban.failed': ' ({n} Abschnitte im Original)', 'ban.restore': 'Original anzeigen',
      'ban.retranslate': 'Erneut übersetzen', 'ban.retryFailed': 'Fehler erneut versuchen', 'ban.nokey': 'Noch kein API-Key. Klicken Sie auf das Extension-Symbol → Einstellungen.',
      'ban.analyzing': 'Seite wird analysiert…', 'ban.translating': 'Übersetze… {n}/{m}', 'ban.cost': 'Kosten ~ ¥{n}'
    },
    'es': {
      'opt.title': 'Traducción IA · Ajustes', 'opt.section.api': 'Conexión API', 'opt.baseUrl.label': 'Dirección API (compatible con OpenAI)',
      'opt.baseUrl.note': 'Si usas un dominio que no es DeepSeek, tu clave se envía allí con cada solicitud.',
      'opt.apiKey.label': 'Clave API', 'opt.apiKey.note': 'Solo se guarda en este dispositivo.',
      'opt.model.label': 'Modelo', 'opt.model.note': 'Por defecto deepseek-v4-flash (pensamiento desactivado para rapidez y estabilidad).',
      'opt.section.pref': 'Traducción', 'opt.targetLang.label': 'Idioma de destino predeterminado', 'opt.section.ui': 'Interfaz',
      'opt.displayMode.label': 'Modo de visualización', 'opt.displayMode.replace': 'Reemplazar', 'opt.displayMode.bilingual': 'Bilingüe',
      'opt.displayLang.label': 'Idioma de pantalla (texto de la extensión)', 'opt.displayLang.note': 'Solo cambia el idioma de la interfaz, no el de traducción.',
      'opt.test': 'Probar conexión', 'opt.testing': 'Probando…', 'opt.testErr': 'Error de conexión: {msg}',
      'opt.save': 'Guardar', 'opt.cancel': 'Cancelar', 'opt.saved': '✓ Guardado', 'opt.section.site': 'Ajustes del sitio', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Añadir',
      'opt.site.note': 'Tiene prioridad sobre el ajuste global; los subdominios siguen a su dominio principal.',
      'opt.help.title': 'Notas', 'opt.help.1': 'La traducción usa tu propia cuenta de API.',
      'opt.help.3': 'Cambiar el idioma de destino vuelve a traducir las páginas abiertas.',
      'opt.help.4': 'Los bloques de código y los campos de entrada no se traducen.', 'opt.testFailBg': 'Error de prueba: no se puede conectar con el fondo', 'opt.testOk2': '✓ Conectado. Ejemplo: «{t}»',
      'opt.site.auto': ' Auto', 'opt.site.never': ' Nunca', 'opt.site.del': 'Eliminar',
      'opt.confirm1': 'Tu clave se enviará a {origin} con cada solicitud de traducción. ¿Continuar?',
      'pop.title': 'Traducción IA', 'pop.loading': 'Cargando…', 'pop.translate': 'Traducir esta página', 'pop.retranslate': 'Volver a traducir',
      'pop.restore': 'Mostrar original', 'pop.retryFailed': 'Reintentar fallos', 'pop.targetLang': 'Idioma de destino', 'pop.auto': 'Traducir automáticamente páginas extranjeras',
      'pop.displayMode.label': 'Modo de visualización', 'pop.displayMode.replace': 'Reemplazar', 'pop.displayMode.bilingual': 'Bilingüe',
      'pop.siteAuto': 'Auto-traducir este sitio', 'pop.siteNever': 'Nunca traducir este sitio', 'pop.today': 'Hoy', 'pop.month': 'Este mes', 'pop.session': 'Esta página',
      'pop.settings': 'Ajustes', 'pop.nokey': 'No hay clave API configurada.', 'pop.goSettings': 'Ir a ajustes →', 'pop.detectedForeign': 'Idioma extranjero detectado, no traducido',
      'pop.notTranslated': 'No traducido', 'pop.unsupported': 'Esta página no se puede traducir (interna del navegador o restringida).',
      'pop.translating': 'Traduciendo… {n}/{m}', 'pop.done': 'Traducido a {lang}', 'pop.failed': ' ({n} fallos)',
      'pop.retranslating': 'Traduciendo de nuevo…', 'pop.noUsageToday': 'Hoy todavía no has traducido nada',
      'ban.offer': 'Esta página parece estar en {from}. ¿Traducir a {to}?', 'ban.translate': 'Traducir', 'ban.no': 'No', 'ban.cancel': 'Cancelar',
      'ban.done': 'Traducido a {to}', 'ban.failed': ' ({n} partes en el original)', 'ban.restore': 'Mostrar original',
      'ban.retranslate': 'Volver a traducir', 'ban.retryFailed': 'Reintentar fallos', 'ban.nokey': 'Aún no hay clave API. Haz clic en el icono de la extensión → Ajustes.',
      'ban.analyzing': 'Analizando la página…', 'ban.translating': 'Traduciendo… {n}/{m}', 'ban.cost': 'Coste ~ ¥{n}'
    },
    'ru': {
      'opt.title': 'Перевод ИИ · Настройки', 'opt.section.api': 'Подключение API', 'opt.baseUrl.label': 'Адрес API (совместим с OpenAI)',
      'opt.baseUrl.note': 'Если указать домен не DeepSeek, ключ будет отправляться туда с каждым запросом.',
      'opt.apiKey.label': 'Ключ API', 'opt.apiKey.note': 'Хранится только на этом устройстве.',
      'opt.model.label': 'Модель', 'opt.model.note': 'По умолчанию deepseek-v4-flash (мышление отключено для скорости и стабильности).',
      'opt.section.pref': 'Перевод', 'opt.targetLang.label': 'Язык перевода по умолчанию', 'opt.section.ui': 'Интерфейс',
      'opt.displayMode.label': 'Режим отображения', 'opt.displayMode.replace': 'Заменить', 'opt.displayMode.bilingual': 'Двуязычный',
      'opt.displayLang.label': 'Язык интерфейса (текст расширения)', 'opt.displayLang.note': 'Меняется только язык интерфейса, а не язык перевода.',
      'opt.test': 'Проверить подключение', 'opt.testing': 'Проверка…', 'opt.testErr': 'Ошибка подключения: {msg}',
      'opt.save': 'Сохранить', 'opt.cancel': 'Отмена', 'opt.saved': '✓ Сохранено', 'opt.section.site': 'Настройки сайта', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Добавить',
      'opt.site.note': 'Важнее общей настройки; поддомены наследуют правило родителя.',
      'opt.help.title': 'Примечания', 'opt.help.1': 'Перевод оплачивается с вашего аккаунта API.',
      'opt.help.3': 'При смене языка перевода открытые страницы переводятся заново.',
      'opt.help.4': 'Блоки кода и поля ввода не переводятся.', 'opt.testFailBg': 'Ошибка теста: не удаётся подключиться к фону', 'opt.testOk2': '✓ Подключено. Пример: «{t}»',
      'opt.site.auto': ' Авто', 'opt.site.never': ' Никогда', 'opt.site.del': 'Удалить',
      'opt.confirm1': 'Ключ будет отправляться на {origin} вместе с запросами перевода. Продолжить?',
      'pop.title': 'Перевод ИИ', 'pop.loading': 'Загрузка…', 'pop.translate': 'Перевести эту страницу', 'pop.retranslate': 'Перевести заново',
      'pop.restore': 'Показать оригинал', 'pop.retryFailed': 'Повторить ошибки', 'pop.targetLang': 'Язык перевода', 'pop.auto': 'Автоматически переводить иностранные страницы',
      'pop.displayMode.label': 'Режим отображения', 'pop.displayMode.replace': 'Заменить', 'pop.displayMode.bilingual': 'Двуязычный',
      'pop.siteAuto': 'Автопереводить этот сайт', 'pop.siteNever': 'Никогда не переводить этот сайт', 'pop.today': 'Сегодня', 'pop.month': 'В этом месяце', 'pop.session': 'Эта страница',
      'pop.settings': 'Настройки', 'pop.nokey': 'Ключ API не настроен.', 'pop.goSettings': 'К настройкам →', 'pop.detectedForeign': 'Обнаружен иностранный язык, не переведено',
      'pop.notTranslated': 'Не переведено', 'pop.unsupported': 'Эту страницу нельзя перевести (внутренняя страница браузера или ограничение).',
      'pop.translating': 'Перевод… {n}/{m}', 'pop.done': 'Переведено на {lang}', 'pop.failed': ' ({n} ошибок)',
      'pop.retranslating': 'Переведено заново…', 'pop.noUsageToday': 'Сегодня переводов ещё не было',
      'ban.offer': 'Похоже, страница на {from}. Перевести на {to}?', 'ban.translate': 'Перевести', 'ban.no': 'Нет', 'ban.cancel': 'Отмена',
      'ban.done': 'Переведено на {to}', 'ban.failed': ' ({n} фрагментов оставлены как есть)', 'ban.restore': 'Показать оригинал',
      'ban.retranslate': 'Перевести заново', 'ban.retryFailed': 'Повторить ошибки', 'ban.nokey': 'Ключ API не задан. Нажмите на значок расширения → Настройки.',
      'ban.analyzing': 'Анализ страницы…', 'ban.translating': 'Перевод… {n}/{m}', 'ban.cost': 'Стоимость ~ ¥{n}'
    },
    'pt': {
      'opt.title': 'Tradução IA · Configurações', 'opt.section.api': 'Conexão API', 'opt.baseUrl.label': 'Endereço da API (compatível com OpenAI)',
      'opt.baseUrl.note': 'Se usar um domínio que não seja DeepSeek, a chave é enviada para lá em cada pedido.',
      'opt.apiKey.label': 'Chave API', 'opt.apiKey.note': 'Guardada apenas neste dispositivo.',
      'opt.model.label': 'Modelo', 'opt.model.note': 'Padrão deepseek-v4-flash (pensamento desativado para rapidez e estabilidade).',
      'opt.section.pref': 'Tradução', 'opt.targetLang.label': 'Idioma de destino padrão', 'opt.section.ui': 'Interface',
      'opt.displayMode.label': 'Modo de exibição', 'opt.displayMode.replace': 'Substituir', 'opt.displayMode.bilingual': 'Bilíngue',
      'opt.displayLang.label': 'Idioma de exibição (texto da extensão)', 'opt.displayLang.note': 'Só muda o idioma da interface, não o de tradução.',
      'opt.test': 'Testar conexão', 'opt.testing': 'A testar…', 'opt.testErr': 'Falha na ligação: {msg}',
      'opt.save': 'Guardar', 'opt.cancel': 'Cancelar', 'opt.saved': '✓ Guardado', 'opt.section.site': 'Configurações do site', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Adicionar',
      'opt.site.note': 'Tem prioridade sobre a definição global; os subdomínios seguem o domínio principal.',
      'opt.help.title': 'Notas', 'opt.help.1': 'A tradução usa a sua própria conta de API.',
      'opt.help.3': 'Mudar o idioma de destino volta a traduzir as páginas abertas.',
      'opt.help.4': 'Blocos de código e campos de entrada não são traduzidos.', 'opt.testFailBg': 'Falha no teste: não é possível alcançar o fundo', 'opt.testOk2': '✓ Ligado. Exemplo: «{t}»',
      'opt.site.auto': ' Auto', 'opt.site.never': ' Nunca', 'opt.site.del': 'Eliminar',
      'opt.confirm1': 'A chave será enviada para {origin} em cada pedido de tradução. Continuar?',
      'pop.title': 'Tradução IA', 'pop.loading': 'A carregar…', 'pop.translate': 'Traduzir esta página', 'pop.retranslate': 'Retraduzir',
      'pop.restore': 'Mostrar original', 'pop.retryFailed': 'Repetir falhas', 'pop.targetLang': 'Idioma de destino', 'pop.auto': 'Traduzir automaticamente páginas estrangeiras',
      'pop.displayMode.label': 'Modo de exibição', 'pop.displayMode.replace': 'Substituir', 'pop.displayMode.bilingual': 'Bilíngue',
      'pop.siteAuto': 'Tradução automática deste site', 'pop.siteNever': 'Nunca traduzir este site', 'pop.today': 'Hoje', 'pop.month': 'Este mês', 'pop.session': 'Esta página',
      'pop.settings': 'Configurações', 'pop.nokey': 'Nenhuma chave API configurada.', 'pop.goSettings': 'Ir para as configurações →', 'pop.detectedForeign': 'Idioma estrangeiro detetado, não traduzido',
      'pop.notTranslated': 'Não traduzido', 'pop.unsupported': 'Esta página não pode ser traduzida (interna do navegador ou restrita).',
      'pop.translating': 'A traduzir… {n}/{m}', 'pop.done': 'Traduzido para {lang}', 'pop.failed': ' ({n} falhas)',
      'pop.retranslating': 'A retraduzir…', 'pop.noUsageToday': 'Ainda não traduziu nada hoje',
      'ban.offer': 'Esta página parece estar em {from}. Traduzir para {to}?', 'ban.translate': 'Traduzir', 'ban.no': 'Não', 'ban.cancel': 'Cancelar',
      'ban.done': 'Traduzido para {to}', 'ban.failed': ' ({n} partes mantidas no original)', 'ban.restore': 'Mostrar original',
      'ban.retranslate': 'Retraduzir', 'ban.retryFailed': 'Repetir falhas', 'ban.nokey': 'Ainda não há chave API. Clique no ícone da extensão → Definições.',
      'ban.analyzing': 'A analisar a página…', 'ban.translating': 'A traduzir… {n}/{m}', 'ban.cost': 'Custo ~ ¥{n}'
    },
    'it': {
      'opt.title': 'Traduzione IA · Impostazioni', 'opt.section.api': 'Connessione API', 'opt.baseUrl.label': 'Indirizzo API (compatibile OpenAI)',
      'opt.baseUrl.note': 'Se usi un dominio diverso da DeepSeek, la chiave viene inviata lì a ogni richiesta.',
      'opt.apiKey.label': 'Chiave API', 'opt.apiKey.note': 'Salvata solo su questo dispositivo.',
      'opt.model.label': 'Modello', 'opt.model.note': 'Predefinito deepseek-v4-flash (pensiero disattivato per velocità e stabilità).',
      'opt.section.pref': 'Traduzione', 'opt.targetLang.label': 'Lingua di destinazione predefinita', 'opt.section.ui': 'Interfaccia',
      'opt.displayMode.label': 'Modalità di visualizzazione', 'opt.displayMode.replace': 'Sostituisci', 'opt.displayMode.bilingual': 'Bilingue',
      'opt.displayLang.label': 'Lingua di visualizzazione (testo dell\'estensione)', 'opt.displayLang.note': 'Cambia solo la lingua dell’interfaccia, non quella di traduzione.',
      'opt.test': 'Testa connessione', 'opt.testing': 'Verifica…', 'opt.testErr': 'Errore di connessione: {msg}',
      'opt.save': 'Salva', 'opt.cancel': 'Annulla', 'opt.saved': '✓ Salvato', 'opt.section.site': 'Impostazioni sito', 'opt.site.addPh': 'example.com', 'opt.site.add': 'Aggiungi',
      'opt.site.note': 'Ha priorità sull’impostazione globale; i sottodomini seguono il dominio principale.',
      'opt.help.title': 'Note', 'opt.help.1': 'La traduzione usa il tuo account API.',
      'opt.help.3': 'Cambiando la lingua di destinazione, le pagine aperte vengono ritradotte.',
      'opt.help.4': 'Blocchi di codice e campi di input non vengono tradotti.', 'opt.testFailBg': 'Test fallito: impossibile raggiungere il background', 'opt.testOk2': '✓ Connesso. Esempio: «{t}»',
      'opt.site.auto': ' Auto', 'opt.site.never': ' Mai', 'opt.site.del': 'Elimina',
      'opt.confirm1': 'La chiave verrà inviata a {origin} con ogni richiesta di traduzione. Continuare?',
      'pop.title': 'Traduzione IA', 'pop.loading': 'Caricamento…', 'pop.translate': 'Traduci questa pagina', 'pop.retranslate': 'Ritraduci',
      'pop.restore': 'Mostra originale', 'pop.retryFailed': 'Riprova errori', 'pop.targetLang': 'Lingua di destinazione', 'pop.auto': 'Traduci automaticamente le pagine straniere',
      'pop.displayMode.label': 'Modalità di visualizzazione', 'pop.displayMode.replace': 'Sostituisci', 'pop.displayMode.bilingual': 'Bilingue',
      'pop.siteAuto': 'Traduci automaticamente questo sito', 'pop.siteNever': 'Non tradurre mai questo sito', 'pop.today': 'Oggi', 'pop.month': 'Questo mese', 'pop.session': 'Questa pagina',
      'pop.settings': 'Impostazioni', 'pop.nokey': 'Nessuna chiave API configurata.', 'pop.goSettings': 'Vai alle impostazioni →', 'pop.detectedForeign': 'Lingua straniera rilevata, non tradotta',
      'pop.notTranslated': 'Non tradotto', 'pop.unsupported': 'Questa pagina non può essere tradotta (interna del browser o limitata).',
      'pop.translating': 'Traduzione… {n}/{m}', 'pop.done': 'Tradotto in {lang}', 'pop.failed': ' ({n} errori)',
      'pop.retranslating': 'Ritraduzione…', 'pop.noUsageToday': 'Oggi non hai ancora tradotto nulla',
      'ban.offer': 'Questa pagina sembra in {from}. Tradurre in {to}?', 'ban.translate': 'Traduci', 'ban.no': 'No', 'ban.cancel': 'Annulla',
      'ban.done': 'Tradotto in {to}', 'ban.failed': ' ({n} parti lasciate in originale)', 'ban.restore': 'Mostra originale',
      'ban.retranslate': 'Ritraduci', 'ban.retryFailed': 'Riprova errori', 'ban.nokey': 'Nessuna chiave API. Clicca sull’icona dell’estensione → Impostazioni.',
      'ban.analyzing': 'Analisi della pagina…', 'ban.translating': 'Traduzione… {n}/{m}', 'ban.cost': 'Costo ~ ¥{n}'
    }
  }
};

if (typeof module !== 'undefined' && module.exports) { module.exports = AITR; }
