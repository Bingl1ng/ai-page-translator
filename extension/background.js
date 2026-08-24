// AI 页面翻译 —— 后台 service worker
// 职责：接收内容脚本的翻译批次，调用 DeepSeek（OpenAI 兼容端点），返回译文数组。
importScripts('config.js');
'use strict';

// ---- 配置读取 ----
function getConfig() {
  return AITR.loadConfig();
}

// ---- 用量统计（真实 token，按天聚合，仅留最近 62 天） ----
// 串行化：并发批次（MAX_CONCURRENT=8）同时完成时，read-modify-write 会相互覆盖丢统计。
// 用 promise 链排队，保证每次 get→改→set 原子执行。
let usageQueue = Promise.resolve();
// t={in,out,hit,miss}(token 数)，cost 用真实单价按模型+峰谷算出，按天聚合(与 popup 本地月份一致)
function recordUsage(model, t, peak) {
  usageQueue = usageQueue.then(function () {
    return new Promise(function (resolve) {
      chrome.storage.local.get(AITR.USAGE_KEY, function (obj) {
        const u = obj[AITR.USAGE_KEY] || { byDay: {} };
        // 用本地日期（与 popup 本地月份聚合一致；toISOString 是 UTC，会错位少算）
        const now = new Date();
        const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        const d = u.byDay[today] || { in: 0, out: 0, hit: 0, miss: 0, cost: 0 };
        d.in += (t.in || 0);
        d.out += (t.out || 0);
        d.hit += (t.hit || 0);
        d.miss += (t.miss || 0);
        d.cost += AITR.computeCost(model, t, peak);
        u.byDay[today] = d;
        const keys = Object.keys(u.byDay).sort();
        while (keys.length > 62) delete u.byDay[keys.shift()];
        const o = {};
        o[AITR.USAGE_KEY] = u;
        chrome.storage.local.set(o, resolve);
      });
    });
  }).catch(function () {}); // A4：记账失败不阻塞后续记账/翻译（原链接若某次 set 报错会永久毒化整条链）
}

// 从 API 响应的 usage 提取 {in,hit,miss,out} token。DeepSeek 用 prompt_cache_hit/miss_tokens 区分缓存；
// 缺缓存字段时全当 miss（保守：不误按"命中价"少算）。fallback*Chars 是缺 usage 时的字符估算法入场。
function usageFromData(data, fallbackInChars, fallbackOutChars) {
  const u = (data && data.usage) || {};
  let inT = 0, outT = 0;
  if (typeof u.prompt_tokens === 'number') {
    inT = u.prompt_tokens;
  } else {
    inT = Math.round((fallbackInChars || 0) / 1.7);
  }
  let hit = (typeof u.prompt_cache_hit_tokens === 'number') ? u.prompt_cache_hit_tokens : 0;
  if (hit > inT) hit = inT;
  const miss = Math.max(0, inT - hit);
  outT = (typeof u.completion_tokens === 'number') ? u.completion_tokens : Math.round((fallbackOutChars || 0) / 1.7);
  return { in: inT, out: outT, hit: hit, miss: miss };
}

// ---- JSON 宽容解析 ----
// 实测 DeepSeek 偶发在译文 JSON 字符串里漏转义真实换行（\n 原样输出），导致 JSON.parse 失败。
// fixJSONNewlines：状态机只修"字符串内"的未转义换行/回车（CRLF 归并为 \n），不碰其它内容。
function fixJSONNewlines(s) {
  let out = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') { out += ch + (s[i + 1] || ''); i++; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\r' && s[i + 1] === '\n') { out += '\\n'; i++; continue; }
      if (ch === '\n' || ch === '\r') { out += '\\n'; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

// 解析单个字符串为 translations 数组；失败返回 null
function parseExact(s) {
  try {
    const p = JSON.parse(s);
    const arr = p && Array.isArray(p.translations) ? p.translations : null;
    return arr || null;
  } catch (e) { return null; }
}

// 返回 translations 数组；解析失败返回 null
// 实测模型三种坏法：①字符串内漏转义真实换行；②末尾漏闭合大括号 }；③JSON 完整闭合后又吐多余尾巴（如 "}）。
// 策略：原样 / 换行修复 / 补 1..3 个 } 组成候选，每个候选先直接解析，再尝试从末尾逐字符裁剪（剥掉多余尾巴）。
function parseTranslations(content) {
  const fixed = fixJSONNewlines(content);
  const candidates = [content];
  if (fixed !== content) candidates.push(fixed);
  for (let add = 1; add <= 3; add++) {
    const close = '}'.repeat(add);
    candidates.push(content + close);
    candidates.push(fixed + close);
  }
  const maxTrim = 24;
  let attempts = 0; // 总解析次数上限：防最坏 ~192 次 JSON.parse 同步阻塞 SW 事件循环
  const MAX_PARSE_ATTEMPTS = 32;
  for (let i = 0; i < candidates.length; i++) {
    const base = candidates[i];
    const r = parseExact(base);
    if (++attempts >= MAX_PARSE_ATTEMPTS) return null;
    if (r) return r;
    const limit = Math.min(maxTrim, Math.max(0, base.length - 2));
    for (let cut = 1; cut <= limit; cut++) {
      const r2 = parseExact(base.slice(0, base.length - cut));
      if (++attempts > MAX_PARSE_ATTEMPTS) return null; // A3：>=32 会丢弃第 32 次合法解析，改 >
      if (r2) return r2;
    }
  }
  return null;
}

// ---- 调 DeepSeek 翻译一批文本 ----
// texts: string[]，target: 目标语言代码，direction: 大页面预读的翻译方向（可选）
// 返回 Promise<{ translated: string[], errors: number, failed: number[], message?: string }>
//   errors = 失败段数（= failed.length），failed = 本批中失败/被兜底的文本 index（供"重试失败段落"）
// 容错：宽容解析 → 全量重试一次 → 仍失败则对半切分递归翻译（小批次更稳）
function allIndexes(n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

// A5：过滤 cfgOverride 里的 undefined/null（保留空串 ''，如测试连接故意传假 key 触发 401），
// 防止 baseUrl/model 被覆写成 undefined 导致 cfg.baseUrl.replace 抛出、content 超时"后台无响应"
function compactObj(o) {
  const r = {};
  if (!o) return r;
  for (const k in o) {
    if (o[k] !== undefined && o[k] !== null) r[k] = o[k];
  }
  return r;
}

async function translateBatch(texts, target, direction, countUsage, cfgOverride, depth) {
  // cfgOverride：临时配置覆盖（如设置页"测试连接"用当前输入值测，不落盘）
  // depth：递归切分深度（内部参数，防 API 故障时递归风暴）
  const cfg = Object.assign({}, await getConfig(), compactObj(cfgOverride));
  if (!cfg.apiKey) {
    return { translated: texts.slice(), errors: texts.length, failed: allIndexes(texts.length), message: '未配置 API Key，请到选项页填写' };
  }
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const targetName = AITR.langLabel(target);

  // 大页面场景：把 AI 已通读全文得出的翻译方向注入系统提示，保证各批风格/术语一致
  const directionBlock = (direction && String(direction).trim())
    ? '翻译方向（AI 已通读全文得出的风格与术语指导，翻译时务必遵循）：\n' + String(direction).trim() + '\n\n'
    : '';

  const systemPrompt =
    directionBlock +
    '你是专业网页翻译引擎。你会收到一个 JSON 数组，包含若干条需要翻译的网页文本片段。' +
    '请把它们逐条忠实翻译成' + targetName + '。\n' +
    '严格要求：\n' +
    '1. 返回 JSON 对象 {"translations": [字符串数组]}，元素个数与输入完全一致、顺序一一对应；\n' +
    '2. 保留数字、单位、专有名词、品牌名、URL、占位符（如 {{x}} 或 {n}）、换行符 \\n；\n' +
    '3. 短片段（一个词/一句话）也要翻译；翻译后省略号用中文习惯；\n' +
    '4. 不添加任何解释、不改写、不合并条目；\n' +
    '5. 只输出 JSON，不要输出其他内容。';

  // 单次尝试。perfect=true 完全成功；数量不匹配返回非 perfect 尽量对齐；解析失败/网络错抛异常
  async function attemptOnce() {
    let lastCost = 0; // 本批真实成本(元)，随返回带给 content,供"本次花费"显示
    const payload = {
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(texts) }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
      max_tokens: 8192
    };
    // v4-flash 直调默认思考模式（卡批/慢/烧token，Stage A 实测 2026-08-06）；
    // 显式关掉让 flash 走非思考路径（与 deepseek-chat 别名同行为）。仅 flash 加，避免未知模型拒绝参数。
    if (/flash/i.test(cfg.model)) payload.thinking = { type: 'disabled' };
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 60000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.apiKey
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(function () { return ''; });
        throw new Error('HTTP ' + resp.status + ' ' + detail.slice(0, 300));
      }
      const data = await resp.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('响应中没有 content 字段');
      const arr = parseTranslations(content);
      if (!arr) throw new Error('响应不是 {"translations":[...]} 结构');
      // 用量统计：优先 API usage 真实 token（含缓存命中/未命中分项），缺则回退字符估算
      if (countUsage !== false) {
        const utok = usageFromData(data, texts.join('').length, arr.filter(function (s) { return typeof s === 'string'; }).join('').length);
        const peak = AITR.isPeak();
        lastCost = AITR.computeCost(cfg.model, utok, peak);
        recordUsage(cfg.model, utok, peak);
      }
      if (arr.length !== texts.length) {
        // 数量不匹配：能对多少对多少，其余用原文兜底，并记录失败 index 供重试
        const padded = texts.map(function (t, i) { return (i < arr.length && typeof arr[i] === 'string') ? arr[i] : t; });
        const failed = [];
        texts.forEach(function (t, i) {
          if (!(i < arr.length && typeof arr[i] === 'string')) failed.push(i);
        });
        // usable：本批实际译出条数（供部分成功判定）。43/40 覆盖且前缀全为字符串 → failed.length===0 视为 perfect
        return {
          translated: padded, errors: failed.length, failed: failed,
          usable: texts.length - failed.length,
          cost: lastCost,
          perfect: failed.length === 0,
          message: failed.length ? '返回数量不匹配(' + arr.length + '/' + texts.length + ')，已兜底' : ''
        };
      }
      // 数量一致但个别条目非字符串（模型偶发返回 null 等）：兜底原文并记失败
      const fixed = arr.map(function (s, i) { return typeof s === 'string' ? s : texts[i]; });
      const bad = [];
      arr.forEach(function (s, i) { if (typeof s !== 'string') bad.push(i); });
      return {
        translated: fixed,
        errors: bad.length,
        failed: bad,
        usable: texts.length - bad.length,
        cost: lastCost,
        perfect: bad.length === 0,
        message: bad.length ? '个别条目非字符串，已兜底原文' : ''
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // 全量尝试两次（服务端偶发错误 / 偶发坏 JSON / 数量不匹配）。模式 B：
  // 部分成功（count mismatch 但 usable>0）不立即返回，多试一次争取 clean 覆盖（防中间合并的静默错位）；
  // 但两次都不 clean 时接受 partial 立即返回，不再对半切分（砍掉最贵的递归）。
  let best = null, totalCost = 0; // totalCost：累加本轮所有 API 调用成本（重试/切分时 content 计费不低估，A1）
  for (let k = 0; k < 2; k++) {
    try {
      const r = await attemptOnce();
      totalCost += (r.cost || 0);
      if (r.perfect) { r.cost = totalCost; return r; }
      // A2：保留"可用更多"那次（避免丢弃更好的 partial 重试）；仍不合并，防静默错位
      if (!best || r.usable > best.usable) best = r;
    } catch (e) {
      if (!best) best = { translated: texts.slice(), errors: texts.length, failed: allIndexes(texts.length), usable: 0, perfect: false, cost: 0, message: String(e && e.message || e) };
    }
  }
  if (best) best.cost = totalCost;

  // 部分成功：接受当前结果立即返回，失败子集交给 content 自动重试只重发失败段（更小更稳更省）
  if (best.usable > 0) return best;

  // 整批失败（0 可用）：对半切分递归翻译，小批次稳定得多（解决偶发坏 JSON）
  if (texts.length <= 2 || (depth || 0) >= 3) return best; // 深度上限 3 层：防 API 故障时递归风暴
  // 认证失败（401/403）：key 无效/过期，重试与切分无意义，直接返回避免费用风暴
  if (best && best.message && /HTTP 401|HTTP 403/.test(best.message)) return best;
  const half = Math.floor(texts.length / 2);
  const halves = await Promise.all([
    translateBatch(texts.slice(0, half), target, direction, countUsage, cfgOverride, (depth || 0) + 1),
    translateBatch(texts.slice(half), target, direction, countUsage, cfgOverride, (depth || 0) + 1)
  ]);
  return {
    translated: halves[0].translated.concat(halves[1].translated),
    errors: halves[0].errors + halves[1].errors,
    usable: texts.length - halves[0].errors - halves[1].errors,
    cost: (halves[0].cost || 0) + (halves[1].cost || 0) + totalCost,
    perfect: halves[0].errors + halves[1].errors === 0,
    // 第二半的 index 偏移 half（第一半长度），供 content 定位失败节点
    failed: halves[0].failed.concat(halves[1].failed.map(function (i) { return i + half; })),
    message: (halves[0].errors ? halves[0].message : '') || (halves[1].errors ? halves[1].message : '') || ''
  };
}

// ---- 大页面方向预读：通读全文采样，返回翻译方向要点 ----
// sample: string[]（全文不同位置的采样片段），target: 目标语言代码
// 返回 Promise<string>（方向要点，失败返回 ''）
async function getDirection(sample, target) {
  const cfg = await getConfig();
  if (!cfg.apiKey) return '';
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const targetName = AITR.langLabel(target);

  const systemPrompt =
    '你是资深网页翻译顾问。下面是某个网页全文不同位置抽取的文本片段（JSON 数组，含开头、中间、结尾），' +
    '不是要翻译的完整正文，而是帮你判断方向用的采样。\n' +
    '请通读这些片段，判断该网页整体的主题、文体与语气，然后给出把它翻译成' + targetName + '时应当遵循的翻译方向，' +
    '输出 3-6 条精炼要点，例如：关键术语应如何翻译、专有名词/品牌名是否保留原文、用正式还是口语风格、中文习惯表达建议。\n' +
    '总长不超过 200 字。不要翻译正文，不要输出 JSON，直接输出要点文本。';

  const payload = {
    model: cfg.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(sample) }
    ],
    temperature: 0.4,
    max_tokens: 400
  };
  if (/flash/i.test(cfg.model)) payload.thinking = { type: 'disabled' }; // 同 attemptOnce：flash 关思考

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 30000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!resp.ok) return '';
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content === 'string' && content.trim()) {
      // 方向预读也是真实 API 调用，计入用量（缺 usage 回退字符估算）
      const utok = usageFromData(data, sample.join('').length, content.length);
      recordUsage(cfg.model, utok, AITR.isPeak());
      return content.trim();
    }
    return '';
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// ---- 工具栏角标（badge）：翻译中显示进度百分比，完成显示 ✓，有失败显示 ! ----
// content 的 broadcast() 发 aitr-progress，background 也作为监听者收到 → 写角标。
function updateBadge(m, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (tabId == null) return;
  let text = '', color = '';
  if (m.translating) {
    color = '#1a73e8';
    if (m.totalNodes > 0 && m.doneNodes != null) text = String(Math.min(99, Math.round(m.doneNodes / m.totalNodes * 100)));
    else if (m.total > 0) text = (m.done || 0) + '/' + (m.total || 0);
    else text = '…';
  } else if (m.translated) {
    text = m.errors > 0 ? '!' : '✓';
    color = m.errors > 0 ? '#d93025' : '#188038';
  }
  try { const p = chrome.action.setBadgeText({ tabId: tabId, text: text }); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  if (color) { try { const p = chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color }); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
}

// 导航开始（loading）时清空该 tab 的角标（新页面重新检测/翻译后再写）
chrome.tabs.onUpdated.addListener(function (tabId, info) {
  if (info.status === 'loading') {
    try { const p = chrome.action.setBadgeText({ tabId: tabId, text: '' }); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }
});

// ---- 一次性消息：翻译批次 / 方向预读 / 测试连接 / 查询配置 / 角标 ----
// 内容脚本逐批 sendMessage（每批等返回再发下一批），这里直接处理即可。
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  if (sender.id !== chrome.runtime.id) return; // 只处理本扩展自己发出的消息（防其他扩展/页面伪装）
  if (msg.type === 'aitr-progress') { updateBadge(msg, sender); return; }
  if (msg.type === 'aitr-batch') {
    translateBatch(Array.isArray(msg.texts) ? msg.texts : [], msg.target || AITR.DEFAULTS.targetLang, msg.direction)
      .then(function (r) {
        sendResponse({ type: 'batchResult', id: msg.id, translated: r.translated, errors: r.errors, failed: r.failed || [], cost: r.cost || 0, message: r.message });
      });
    return true; // 异步 sendResponse
  }
  if (msg.type === 'aitr-direction') {
    getDirection(Array.isArray(msg.sample) ? msg.sample : [], msg.target || AITR.DEFAULTS.targetLang)
      .then(function (d) { sendResponse({ type: 'directionResult', direction: d }); });
    return true;
  }
  if (msg.type === 'aitr-test') {
    translateBatch(['Hello, world! This is a test.'], msg.targetLang || msg.target || AITR.DEFAULTS.targetLang, '', false,
      { baseUrl: msg.baseUrl, apiKey: msg.apiKey, model: msg.model })
      .then(function (r) {
        sendResponse({ ok: r.errors === 0, translated: r.translated && r.translated[0], message: r.message });
      });
    return true; // 异步 sendResponse
  }
});
