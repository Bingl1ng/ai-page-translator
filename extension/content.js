// AI 页面翻译 —— 内容脚本
// 职责：检测外文页面 → 出横幅；采集 DOM 文本 → 分批 → 经长连接送后台翻译 → 替换；
//       支持还原、增量翻译（SPA）、弹窗控制。
(function () {
  'use strict';

  // ================= 常量与状态 =================
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'SVG', 'MATH', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'VIDEO', 'AUDIO', 'HEAD'
  ]);
  // 注意：BUTTON 不跳过——按钮文字也翻译（用户要求），只改文本节点不影响点击/aria-label

  // 目标语言 -> 其"脚本族"（用于外文检测）
  const TARGET_SCRIPTS = {
    'zh-CN': ['cjk'], 'zh-TW': ['cjk'],
    'en': ['latin'], 'fr': ['latin'], 'de': ['latin'], 'es': ['latin'], 'pt': ['latin'], 'it': ['latin'],
    'ja': ['cjk', 'kana'],
    'ko': ['hangul'],
    'ru': ['cyrillic']
  };
  /* 语言名已由 AITR.langName() 提供(随显示语言变化),此处不再维护 */
  const MAX_SAMPLE_CHARS = 4000; // 语言检测采样上限
  const BATCH_TIMEOUT = 90000; // 单批最久等待（毫秒）；background 60s 超时后已返回结果，此值兜底 SW 完全无响应
  const MAX_CONCURRENT = 8;            // 大页并发时在途批数上限（实测 DeepSeek 并发 8 仍有 ~7.8 倍加速；慢批占位稀释，取 8 稳）
  const CONCURRENT_MIN_BATCHES = 4;    // 批数 ≥ 此值走并发。原为 8（只护大页）；flash 禁整页单批后中小页也是多批，
  // 4+ 批并发可把 ~6 批的中页从串行 ~22s 降到 ~5s（完成即落地乱序安全，位置索引独立，实测无回归）
  const DIRECTION_SAMPLE_CHARS = 3500; // 大页面方向预读采样上限
  const MAX_AUTO_RETRIES = 4;   // 失败节点自动重试预算（超出不再被兜底/增量自动重发，防费用风暴）
  // flash 批次 ~10-20% 数量不匹配，2 次预算在"主循环1次+自动重试1轮"就耗尽 → 40 段失败实测（2026-08-06）；提到 4 次可多轮收敛

  // 分批参数按模型决定（Stage A 实测 2026-08-06，arXiv 真实文本）：
  // - flash：40条/1000字符——40 条是最优批量（20 条更差、60/100/全批逐级差）；
  //   长段落 2000 字符封顶仅 70% 完美、1000 封顶 95% → 字符封顶降 1000；
  //   禁整页单批（无条数上限 ~150 条仅 54%）。
  // - 非 flash（如 deepseek-chat 别名）：40条/2000字符保持原样，整页单批 ≤8000 字符（实测稳定，零回归）。
  function batchLimits() {
    const isFlash = /flash/i.test(config.model || '');
    return isFlash
      ? { items: 40, chars: 1000, fullTextLimit: 0 }
      : { items: 40, chars: 2000, fullTextLimit: 8000 };
  }

  let config = { baseUrl: '', apiKey: '', model: '', targetLang: 'zh-CN', autoTranslate: false, displayLang: 'zh-CN' };

  // content 不需要真实 API key（翻译请求由 background 持 key 发起），这里抹掉明文：
  // 只保留"有没有 key"（`!!config.apiKey` 用于横幅提示），即使 content 被攻破也没有明文可泄。
  function redactConfig(cfg) {
    var c = Object.assign({}, cfg || {});
    c.apiKey = (cfg && cfg.apiKey) ? '***' : '';
    return c;
  }
  let siteConfig = null;        // 当前域名的站点设置 {auto,never}，null=未设置（跟随全局）
  let translated = false;       // 是否有节点处于已翻译状态
  let translating = false;      // 是否正在翻译中
  let abortRequested = false;
  let translationAborted = false; // 取消/还原后禁止增量/兜底扫描自动续翻
  let restoredDuringAbort = false; // 翻译进行中用户点了"还原"（origMap 已被清空，收尾不弹 offer）
  let bodyWaitTimer = null;      // body 轮询兜底定时器（DOMContentLoaded 迟迟不触发时）
  let detectedLang = null;      // 检测到的页面语言
  let bannerShown = false;      // 当前是否显示横幅
  let bannerDismissed = false;  // 本页用户点过"不翻译/×"
  let currentBatch = 0, totalBatch = 0, errorCount = 0;
  let pageDirection = '';       // 大页面方向预读结果（增量翻译复用）
  let lastErrorMsg = '';        // 最近一次失败批次的原因（显示在横幅）

  const handled = new Set();    // 已处理的文本节点（增量翻译跳过）
  const origMap = new Map();    // Text节点 -> 原文
  const transMap = new Map();   // Text节点 -> 我们设置的译文（检测页面改写后重翻）
  const failedNodes = new Map(); // 失败节点 -> 失败时的原文（供"重试失败段落"；不进 handled，保持可被增量重采）
  const failedRetries = new Map(); // 节点 -> 自动重试次数（超预算移入 skipRetry，防 4s 兜底无限重发）
  const skipRetry = new Set();   // 自动重试达上限的永久失败节点（手动"重试失败段落"仍可重试）
  const retryLog = [];           // 自动重试诊断：每轮 {round, before, sent, after}（经 aitr-status 暴露）
  let totalNodes = 0, doneNodes = 0;    // 节点级进度（applyBatch 累计，阶段二进度条用）
  let sessionInChars = 0, sessionOutChars = 0, sessionCost = 0; // 本页累计用量与真实成本（重翻/重试/增量均计入，随 status/broadcast 上报）

  // ================= 重载还原持久化（sessionStorage） =================
  // #13：内容脚本重启（扩展重载/更新）后，已译页仍能"显示原文"还原。
  // 每个被改写的文本节点记 {p: 路径, o: 原文, c: 译文} 到 sessionStorage（键=pathname+search，
  // SPA hash 变化共享；tab 关闭自动清除）。路径含 Shadow DOM 跨层标记 '#'。
  // 重注入后按"路径 + 译文文本"双重校验重定位——路径错位/页面已改写一律跳过，防还原错节点。
  const SESSION_PREFIX = 'aitr:sess:';
  let persisted = null;        // Map<pathKey, {p,o,c}>；null=尚未从 sessionStorage 读
  let persistedDirty = false;  // 有增量待落盘
  let persistTimer = null;     // 节流落盘定时器
  let lastPersistSave = 0;     // 上次落盘时间戳（节流：≥1s 一次，翻译完成时 flushPersist 兜底）

  function sessKey() { return SESSION_PREFIX + location.pathname + location.search; }
  function pathKey(p) { return p.join('.'); }

  // 节点 → documentElement 下的子索引路径；跨 open shadow root 用 '#' 标记（后跟 shadow 内首层索引）
  function nodePath(node) {
    if (!node || node === document.documentElement) return null;
    const path = [];
    let cur = node;
    while (cur && cur !== document.documentElement) {
      const parent = cur.parentNode;
      if (parent) {
        let idx = 0;
        for (let sib = parent.firstChild; sib && sib !== cur; sib = sib.nextSibling) idx++;
        path.unshift(idx);
        cur = parent;
      } else if (cur.nodeType === Node.DOCUMENT_FRAGMENT_NODE && cur.host) {
        // 已爬到 shadow root：记 '#' 后跳回其宿主（light DOM），继续向上
        path.unshift('#');
        cur = cur.host;
      } else {
        return null;
      }
    }
    return cur === document.documentElement ? path : null;
  }

  function nodeFromPath(path) {
    let cur = document.documentElement;
    for (let i = 0; i < path.length; i++) {
      const step = path[i];
      if (step === '#') {
        if (!cur || !cur.shadowRoot) return null;
        cur = cur.shadowRoot; // 下一数值步在 shadow 内遍历
        continue;
      }
      let sib = cur.firstChild, idx = 0;
      while (sib && idx < step) { sib = sib.nextSibling; idx++; }
      if (!sib) return null;
      cur = sib;
    }
    return cur && cur.nodeType === Node.TEXT_NODE ? cur : null;
  }

  function loadPersisted() {
    if (persisted) return persisted;
    persisted = new Map();
    try {
      const raw = sessionStorage.getItem(sessKey());
      if (raw) {
        const arr = JSON.parse(raw);
        for (const e of arr) persisted.set(pathKey(e.p), e);
      }
    } catch (e) { persisted = new Map(); }
    return persisted;
  }

  function flushPersist() {
    if (!persistedDirty || !persisted) return;
    try {
      const arr = [];
      persisted.forEach(function (e) { arr.push(e); });
      sessionStorage.setItem(sessKey(), JSON.stringify(arr));
      persistedDirty = false;
    } catch (e) { /* 配额满/受限页：放弃本次，内存 map 仍有效 */ }
  }

  // 记录一个已翻译节点（原文 orig → 译文 current）。节流落盘，避免大页每批都全量序列化。
  function persistNode(node, orig, current) {
    const p = nodePath(node);
    if (!p) return;
    loadPersisted().set(pathKey(p), { p: p, o: orig, c: current });
    persistedDirty = true;
    const now = Date.now();
    if (now - lastPersistSave >= 1000) {
      lastPersistSave = now;
      flushPersist();
    } else if (!persistTimer) {
      persistTimer = setTimeout(function () { persistTimer = null; flushPersist(); }, 1000);
    }
  }

  function clearPersisted() {
    persisted = null; persistedDirty = false;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    try { sessionStorage.removeItem(sessKey()); } catch (e) {}
  }

  // 内容脚本重启后调用：sessionStorage 里本页已译记录若与当前 DOM 匹配（仍译态），
  // 重建 origMap/handled/transMap 并重挂可用横幅（"显示原文"按钮）。
  function restoreFromPersisted() {
    const saved = loadPersisted();
    if (!saved.size) return;
    let matched = 0;
    saved.forEach(function (e) {
      const node = nodeFromPath(e.p);
      if (node && node.isConnected && node.data === e.c) {
        origMap.set(node, e.o);
        handled.add(node);
        transMap.set(node, e.c);
        matched++;
      }
    });
    if (!matched) { clearPersisted(); return; } // 页面已非译态（重新加载过）：清掉过期记录
    translated = true;
    startObserver();    // 恢复增量/兜底翻译能力（与正常翻译后一致）
    showBanner('done'); // 重挂横幅（旧横幅按钮随旧脚本已失效）
  }

  // ================= 语言检测（不花 token） =================
  function classifyChar(ch) {
    const c = ch.codePointAt(0);
    if (/[a-zA-ZÀ-ÖØ-öø-ÿ]/.test(ch)) return 'latin';
    if (c >= 0x4E00 && c <= 0x9FFF) return 'cjk';
    if (c >= 0x3040 && c <= 0x30FF) return 'kana';
    if (c >= 0xAC00 && c <= 0xD7AF) return 'hangul';
    if (c >= 0x0400 && c <= 0x04FF) return 'cyrillic';
    if (c >= 0x0600 && c <= 0x06FF) return 'arabic';
    if (c >= 0x0590 && c <= 0x05FF) return 'hebrew';
    return 'other';
  }

  function detectForeign() {
    const sample = collectSampleText();
    if (!sample) return null;
    const counts = {};
    let meaningful = 0;
    for (const ch of sample) {
      const cls = classifyChar(ch);
      if (cls !== 'other') {
        counts[cls] = (counts[cls] || 0) + 1;
        meaningful++;
      }
    }
    if (meaningful < 60) return null; // 页面几乎没文字，不打扰
    let dominant = 'other', max = 0;
    for (const k in counts) { if (counts[k] > max) { max = counts[k]; dominant = k; } }
    const targetSet = TARGET_SCRIPTS[config.targetLang] || ['latin'];
    if (targetSet.indexOf(dominant) !== -1) return null; // 已经是目标语言
    return dominant;
  }

  // 是否应跳过该文本节点（祖先链检查；Shadow DOM 内祖先链到 host 为止，天然正确）
  function isSkippable(node) {
    if (!node.data || !node.data.trim()) return true;
    let el = node.parentElement;
    while (el) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.hasAttribute && (el.getAttribute('translate') === 'no' ||
          el.hasAttribute('data-aitr-skip') || el.getAttribute('aria-hidden') === 'true' ||
          el.isContentEditable)) return true;
      el = el.parentElement;
    }
    return false;
  }

  // 遍历 root 内所有文本节点，并递归进入 open shadow root（现代组件库的按钮/菜单/弹窗在 shadow 里）
  function walkWithShadows(root, cb) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) cb(n);
    if (!root.querySelectorAll) return;
    const els = root.querySelectorAll('*');
    for (let i = 0; i < els.length; i++) {
      const sr = els[i].shadowRoot;
      if (sr && sr.mode === 'open') walkWithShadows(sr, cb);
    }
  }

  function collectSampleText() {
    if (!document.body) return '';
    let out = '';
    walkWithShadows(document.body, function (node) {
      if (out.length >= MAX_SAMPLE_CHARS) return;
      if (isSkippable(node)) return;
      out += node.data;
    });
    return out.slice(0, MAX_SAMPLE_CHARS);
  }

  // ================= 采集与分批 =================
  function collectUnhandledTextNodes() {
    if (!document.body) return [];
    const out = [];
    walkWithShadows(document.body, function (node) {
      // 已翻译且仍是我们的译文 → 跳过；若页面把已翻译节点改写回原文/其它，
      // transMap.get(node) !== node.data → 重新采到重翻（真·实时监测）。
      if (handled.has(node) && transMap.get(node) === node.data) return;
      if (skipRetry.has(node)) return; // 永久失败节点不再被自动重发（手动"重试失败段落"走 failedNodes，不受影响）
      if (isSkippable(node)) return;
      out.push(node);
    });
    return out;
  }

  function buildBatches(nodes) {
    const lim = batchLimits();
    const batches = [];
    let cur = [], curChars = 0;
    for (const node of nodes) {
      const len = node.data.length;
      if (cur.length >= lim.items || (cur.length > 0 && curChars + len > lim.chars)) {
        batches.push({ nodes: cur, texts: cur.map(function (n) { return n.data; }) });
        cur = []; curChars = 0;
      }
      cur.push(node);
      curChars += len;
    }
    if (cur.length) batches.push({ nodes: cur, texts: cur.map(function (n) { return n.data; }) });
    return batches;
  }

  // 整页一批：全部节点塞进一个 batch（不套 40 条/2000 字符上限），仅小页面用
  function buildFullBatch(nodes) {
    return { nodes: nodes, texts: nodes.map(function (n) { return n.data; }) };
  }

  // 首屏优先：估算 batch 到视口的距离（只测首节点代表整批，一次性开销可忽略）
  function batchViewportDist(b) {
    const n = b.nodes[0];
    if (!n || !n.parentElement) return Infinity;
    const r = n.parentElement.getBoundingClientRect();
    if (r.height === 0 && r.width === 0) return Infinity; // 隐藏面板（display:none/aria-hidden）最后翻
    return r.top < 0 ? 0 : r.top;                         // 视口上方贴齐为 0；越靠下越大
  }

  // 从全文采样（开头 ~1200 字符 + 剩余节点均匀取 ≤8 段），供大页面方向预读
  function sampleNodes(nodes) {
    const parts = [];
    let used = 0;
    const head = [];
    for (const n of nodes) {
      if (used >= 1200) break;
      head.push(n.data);
      used += n.data.length;
    }
    if (head.length) parts.push(head.join('\n'));
    const rest = nodes.slice(head.length);
    if (rest.length) {
      const want = Math.min(8, rest.length);
      const stride = Math.max(1, Math.floor(rest.length / want));
      let picked = 0;
      for (let i = 0; i < rest.length && picked < want; i += stride) {
        const seg = rest[i].data;
        if (used + seg.length > DIRECTION_SAMPLE_CHARS) break;
        parts.push(seg);
        used += seg.length;
        picked++;
      }
    }
    return parts;
  }

  // 大页面：让 AI 先通读全文采样，返回翻译方向（风格/术语/语气）。失败返回 ''，不阻塞翻译。
  function getDirection(nodes) {
    const sample = sampleNodes(nodes);
    if (!sample.length) return Promise.resolve('');
    return new Promise(function (resolve) {
      let settled = false;
      const timer = setTimeout(function () { if (!settled) { settled = true; resolve(''); } }, 30000);
      try {
        chrome.runtime.sendMessage(
          { type: 'aitr-direction', sample: sample, target: config.targetLang },
          function (resp) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const err = chrome.runtime.lastError;
            if (!err && resp && typeof resp.direction === 'string' && resp.direction.trim()) resolve(resp.direction.trim());
            else resolve('');
          }
        );
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(''); }
      }
    });
  }

  // ================= 后台通信（一次性消息，每次可靠唤醒 SW） =================
  // 实测：MV3 里 chrome.runtime.connect 的端口消息在 SW 冷启动时有竞态，消息会丢；
  // 改为 sendMessage，每次都能唤醒 SW，等上一批返回再发下一批（内容脚本已串行）。
  let batchSeq = 0;

  function allIndexes(n) {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = i;
    return a;
  }

  function sendBatch(batch, direction) {
    // 本页用量累计（重翻/重试/增量均计入）
    sessionInChars += batch.texts.reduce(function (s, t) { return s + (t ? t.length : 0); }, 0);
    return new Promise(function (resolve) {
      const id = ++batchSeq;
      let settled = false;
      const finish = function (res) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (res && typeof res.cost === 'number') sessionCost += res.cost; // 累计本页真实成本
        resolve(res);
      };
      const timer = setTimeout(function () {
        finish({ translated: batch.texts.slice(), errors: batch.texts.length, failed: allIndexes(batch.texts.length), message: '批次超时' });
      }, BATCH_TIMEOUT);
      try {
        chrome.runtime.sendMessage(
          { type: 'aitr-batch', id: id, target: config.targetLang, direction: direction || '', texts: batch.texts },
          function (resp) {
            const err = chrome.runtime.lastError;
            if (err) { finish({ translated: batch.texts.slice(), errors: batch.texts.length, failed: allIndexes(batch.texts.length), message: '后台错误: ' + err.message }); return; }
            if (!resp || resp.type !== 'batchResult') { finish({ translated: batch.texts.slice(), errors: batch.texts.length, failed: allIndexes(batch.texts.length), message: '后台无响应' }); return; }
            finish({ translated: resp.translated, errors: resp.errors, failed: resp.failed || [], cost: resp.cost || 0, message: resp.message });
          }
        );
      } catch (e) {
        finish({ translated: batch.texts.slice(), errors: batch.texts.length, failed: allIndexes(batch.texts.length), message: '发送失败: ' + e.message });
      }
    });
  }

  // ================= 批次执行（自适应并发） =================
  // 中小页（≤ CONCURRENT_MIN_BATCHES-1 批，预计 ≤10s）走原串行：逐批等返回再发下一批，行为与 v1.2.0 完全一致；
  // 大页走并发窗口：同时至多 MAX_CONCURRENT 批在途，结果按批号严格落地（DOM 顺序稳定、进度单调）。
  async function runBatches(batches, direction) {
    if (batches.length < CONCURRENT_MIN_BATCHES) {
      for (let i = 0; i < batches.length; i++) {
        if (abortRequested) break;
        currentBatch = i + 1;
        setProgress(currentBatch, batches.length, errorCount);
        const res = await sendBatch(batches[i], direction);
        if (abortRequested) break;
        applyBatch(batches[i], res.translated, res.failed, true);
        errorCount = failedNodes.size;
        if (res.failed && res.failed.length && res.message) lastErrorMsg = res.message;
      }
      return batches.length;
    }
    // 完成即落地：不被慢批阻塞吞吐（每批独立 apply，乱序安全；进度按完成数）。
    // 按序 await 的坑：窗口里有 1 个慢批（如正文长段落 5-7s）时整轮等待它，快批空闲，吞吐=窗口÷最慢批。
    const n = batches.length;
    let sent = 0, completed = 0;
    const pump = function () {
      if (abortRequested) return;
      while (sent < n && sent - completed < MAX_CONCURRENT) {
        const idx = sent++;
        sendBatch(batches[idx], direction).then(function (res) {
          if (abortRequested) return; // 取消：在途结果丢弃，不再 apply
          applyBatch(batches[idx], res.translated, res.failed, true);
          errorCount = failedNodes.size;
          if (res.failed && res.failed.length && res.message) lastErrorMsg = res.message;
          completed++;
          currentBatch = completed;
          setProgress(completed, n, errorCount);
          pump();
        });
      }
    };
    pump();
    await new Promise(function (resolve) {
      const iv = setInterval(function () {
        if (completed >= n || abortRequested) { clearInterval(iv); resolve(); }
      }, 100);
    });
    return completed;
  }

  // 清理某节点的失败/重试记录（重试成功或模型原样返回时调用）
  function clearNodeFailure(node) {
    if (failedNodes.has(node)) failedNodes.delete(node);
    if (skipRetry.has(node)) skipRetry.delete(node);
    if (failedRetries.has(node)) failedRetries.delete(node);
  }

  // ================= 应用 / 还原 =================
  // failedList: number[]（本批失败 index）。失败段保留原文、记入 failedNodes（不进 handled，
  // 保持"失败段可被后续增量/兜底扫描重新采到"的既有行为）。withProgress=true 时累计节点级进度。
  function applyBatch(batch, translatedList, failedList, withProgress) {
    const failedSet = failedList && (Array.isArray(failedList) ? new Set(failedList) : failedList);
    batch.nodes.forEach(function (node, i) {
      if (!node.isConnected) { if (withProgress) doneNodes++; return; }
      if (failedSet && failedSet.has(i)) {
        if (!origMap.has(node)) origMap.set(node, node.data);
        failedNodes.set(node, node.data);
        // 自动重试预算：失败计数，超阈值后移入 skipRetry（不再被增量/兜底扫描自动重发）
        const c = (failedRetries.get(node) || 0) + 1;
        if (c >= MAX_AUTO_RETRIES) { skipRetry.add(node); failedRetries.delete(node); }
        else failedRetries.set(node, c);
        if (withProgress) doneNodes++;
        return;
      }
      const t = translatedList && translatedList[i];
      if (typeof t !== 'string') { if (withProgress) doneNodes++; return; }
      if (t === node.data) {
        // 模型原样返回（缩写/单位/URL 等无需翻译）：标记已处理，避免被兜底扫描每 4s 重发
        // （v1.5.2 横幅闪烁暴露；此前一直在静默烧 API 费用）。
        handled.add(node);
        transMap.set(node, t);
        clearNodeFailure(node);
        if (withProgress) doneNodes++;
        return;
      }
      if (!origMap.has(node)) origMap.set(node, node.data);
      node.data = t;
      persistNode(node, origMap.get(node), t); // #13：写 sessionStorage，内容脚本重启后可还原
      handled.add(node);
      transMap.set(node, t);
      clearNodeFailure(node); // 重试成功/永久失败节点移出失败记录
      sessionOutChars += t.length;
      if (withProgress) doneNodes++;
    });
    if (withProgress) updateProgressFill();
  }

  // 还原目标清单 = 内存 origMap + 持久化记录（内容脚本重启后 origMap 为空，从 sessionStorage 按路径重定位）
  function collectRestoreEntries() {
    const out = [];
    const seen = new Set();
    origMap.forEach(function (orig, node) { seen.add(node); out.push({ node: node, orig: orig }); });
    if (persisted && persisted.size) {
      persisted.forEach(function (e) {
        const node = nodeFromPath(e.p);
        if (!node || !node.isConnected) return;
        if (node.data !== e.c) return; // 路径错位/页面已改写：不恢复（防还原错节点）
        if (seen.has(node)) return;
        seen.add(node);
        out.push({ node: node, orig: e.o });
      });
    }
    return out;
  }

  function restore() {
    translating = false;
    abortRequested = true; // 中断进行中的翻译（runBatches 据此停发新批/丢弃在途结果）
    restoredDuringAbort = true;
    const entries = collectRestoreEntries();
    for (const en of entries) {
      if (en.node.isConnected) en.node.data = en.orig;
    }
    origMap.clear();
    transMap.clear();
    handled.clear();
    failedNodes.clear();
    skipRetry.clear();
    failedRetries.clear();
    clearPersisted();
    translated = false;
    setState('restored');
    broadcast();
  }

  // 重新翻译：先写回原文再清表重翻。
  // 绝不能直接清 transMap 后 translatePage()——已译节点当前 data 是译文，直接重采会把译文当原文二次翻译。
  function retranslate() {
    if (translating) return;
    if (!config.apiKey) { showBanner('nokey'); return; }
    for (const [node, orig] of origMap) {
      if (node.isConnected) node.data = orig;
    }
    origMap.clear();
    transMap.clear();
    handled.clear();
    failedNodes.clear();
    skipRetry.clear();
    failedRetries.clear();
    translated = false;
    translatePage();
  }

  // 只重翻失败段落（done 态有失败时）——保留成功段译文，仅复位失败节点原文后重发
  // 自动重试（translatePage 末尾，多轮循环，includeSkip=false）与手动按钮（includeSkip=true）共用。
  // 返回本轮实际重发的节点数（0=无可自动重发，调用方据此停循环）。
  async function retryFailedOnce(includeSkip) {
    if (translating) return 0;
    if (!config.apiKey) { showBanner('nokey'); return 0; }
    if (!failedNodes.size) { setState('done'); broadcast(); return 0; }
    const nodes = [];
    failedNodes.forEach(function (orig, node) {
      if (!node.isConnected) return;
      if (skipRetry.has(node) && !includeSkip) return; // 预算耗尽节点：自动重试跳过，手动"重试失败段落"仍可
      if (node.data !== orig) node.data = orig; // 页面可能已改写，复位原文再发
      nodes.push(node);
    });
    if (!nodes.length) { setState('done'); broadcast(); return 0; } // 全在 skipRetry：保持 failedNodes 供横幅显示
    abortRequested = false;
    translating = true;
    totalNodes = nodes.length; doneNodes = 0;
    const batches = buildBatches(nodes);
    totalBatch = batches.length; currentBatch = 0;
    showBanner('translating');
    await runBatches(batches, pageDirection);
    translating = false;
    translated = true; // 页面保持已翻译态（重试只补失败段）
    flushPersist();
    setState('done');
    broadcast();
    return nodes.length;
  }

  async function retryFailed() {
    await retryFailedOnce(true); // 手动重试：含预算耗尽的 skipRetry 节点
  }

  // ================= 翻译主流程 =================
  async function translatePage() {
    if (translating) return;
    if (!document.body) return; // body 未就绪（document_start 早注入）→ 不空翻不误报完成，稍后由 init 兜底触发
    if (!config.apiKey) {
      showBanner('nokey');
      return;
    }
    abortRequested = false;
    translationAborted = false;
    restoredDuringAbort = false;
    const nodes = collectUnhandledTextNodes();
    if (!nodes.length) {
      translated = true;
      setState('done');
      broadcast();
      return;
    }
    translating = true;
    translated = false;
    currentBatch = 0; totalBatch = 0; errorCount = 0; lastErrorMsg = '';
    failedNodes.clear();
    retryLog.length = 0;
    totalNodes = nodes.length; doneNodes = 0;
    showBanner('translating'); // totalBatch=0 → 进度显示"正在分析全文…"（批次未构建的过渡态）
    startObserver();

    // 自适应：总量小 → 整页一批发全文（AI 看整页再翻）；
    //          总量大 → 先预读全文方向，再分批翻译并带上方向。
    let batches, direction = '';
    const lim = batchLimits();
    const totalChars = nodes.reduce(function (s, n) { return s + n.data.length; }, 0);
    // flash 的 fullTextLimit=0 → 永不走整页单批（无条数上限不稳定，Stage A 实测）；非 flash 保持 ≤8000 整页一批
    if (totalChars <= lim.fullTextLimit) {
      batches = [buildFullBatch(nodes)];
      pageDirection = '';
    } else {
      batches = buildBatches(nodes);
      if (lim.fullTextLimit === 0) {
        // flash：不走方向预读——实测 direction 会放大数量不匹配（sim 0→4 漏译，扩展 43 段失败），可靠优先
        direction = '';
        pageDirection = '';
      } else {
        direction = await getDirection(nodes);
        pageDirection = direction;
      }
    }
    totalBatch = batches.length;

    // 首屏优先：视口内的批次先发先翻（长页才有意义；短页排序开销可忽略）
    if (batches.length > 1) {
      batches.sort(function (a, b) { return batchViewportDist(a) - batchViewportDist(b); });
    }
    await runBatches(batches, direction);
    translating = false; // 主循环结束，先复位再让自动重试进入（否则 retryFailedOnce 的 translating 守卫挡回）
    // 失败段自动多轮补翻（免手动点"重试失败段落"；abort 时不自动补）。
    // flash 批次 ~10-20% 数量不匹配，单轮重试后仍有失败节点（2026-08-06 实测 arXiv 40 段失败）→ 预算内循环收敛；
    // retryFailedOnce 返回本轮重发数，0=无可重发（全在 skipRetry）即停。
    if (!abortRequested && failedNodes.size) {
      for (let r = 0; r < MAX_AUTO_RETRIES && failedNodes.size && !abortRequested; r++) {
        const before = failedNodes.size;
        const sent = await retryFailedOnce(false);
        retryLog.push({ round: r + 1, before, sent, after: failedNodes.size });
        if (!sent) break;
      }
    }
    // 诊断：共享 DOM 属性暴露重试轮记录+方向（隔离世界内容主世界可读，调试用）
    if (host) { try { host.setAttribute('data-aitr-retry', JSON.stringify({ dir: pageDirection, log: retryLog })); } catch (e) {} }

    translating = false;
    translated = totalBatch > 0;
    if (abortRequested) {
      translationAborted = true; // 取消/还原后禁止增量/兜底自动续翻
      translated = origMap.size > 0;
      if (translated) setState('done');
      else if (!restoredDuringAbort) hideBanner(); // 还原场景 restore 已隐藏；取消且未译任何 → 直接隐藏
    } else {
      setState('done');
    }
    restoredDuringAbort = false;
    flushPersist(); // 确保最终已译状态落盘（内容脚本随时可能被重启）
    if (pendingFlush) { pendingFlush = false; scheduleFlush(); } // 主流程期间到达的 DOM 变更补一次增量
    broadcast();
  }

  // ================= 增量翻译（SPA 动态内容 + Shadow DOM + 属性揭示） =================
  let observer = null, observerTimer = null, applying = false, pendingFlush = false;
  const observedShadows = new Set(); // 已挂观察器的 open shadow root
  // 除节点增删/文本变更外，还监听"揭示类"属性变更：
  // aria-hidden/hidden（MDN 类标签页切换面板）、class/style（CSS 显隐切换）。
  const OBSERVE_OPTS = {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['aria-hidden', 'hidden', 'class', 'style']
  };

  // MutationObserver 不会自动观察 shadow root 内部，需手动逐个 observe
  function observeShadowRoots(root) {
    if (!root || !root.querySelectorAll) return;
    const els = root.querySelectorAll('*');
    for (let i = 0; i < els.length; i++) {
      const sr = els[i].shadowRoot;
      if (sr && sr.mode === 'open' && !observedShadows.has(sr)) {
        observedShadows.add(sr);
        try { observer.observe(sr, OBSERVE_OPTS); } catch (e) { /* 忽略 */ }
      }
    }
  }

  function scheduleFlush() {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(flushIncremental, 600);
  }

  function startObserver() {
    if (observer) return;
    if (!document.body) return;
    observer = new MutationObserver(function () {
      // applying / 主流程(translating) 期间到达的变更不再静默丢弃：标记，结束后补一次 flush
      if (applying || translating) { pendingFlush = true; return; }
      scheduleFlush();
    });
    observer.observe(document.body, OBSERVE_OPTS);
    observeShadowRoots(document.body);
    // 锚点/history 导航（用户观察到 URL 变化）也会揭示内容 → 触发增量
    window.addEventListener('hashchange', onNavChange);
    window.addEventListener('popstate', onNavChange);
    ensureSafetyScan();
  }

  function onNavChange() {
    if (!translated || translating || translationAborted) return;
    scheduleFlush();
  }

  function flushIncremental() {
    if (applying) return;
    if (!translated && !translating) return;
    if (translating) return; // 主流程正在跑，它自己会采集
    if (translationAborted) return; // 取消/还原后不再自动续翻
    if (document.hidden) return;
    observeShadowRoots(document.body); // 捕捉新 attach 的 shadow root
    const nodes = collectUnhandledTextNodes();
    if (!nodes.length) return;
    applying = true;
    const batches = buildBatches(nodes);
    // SPA 跳页增量翻译期间横幅切回"翻译中"（否则一直停在"已用 AI 翻译成中文"）。
    // 用户已点 × 关闭横幅 → 静默翻译，不强行弹回。
    const bannerVisible = bannerShown;
    if (bannerVisible) {
      totalNodes = nodes.length; doneNodes = 0;
      currentBatch = 0; totalBatch = batches.length; errorCount = failedNodes.size;
      setState('translating');
    }
    (async function () {
      for (const b of batches) {
        if (abortRequested) break; // "取消"按钮生效，与主流程一致
        const res = await sendBatch(b, pageDirection);
        currentBatch++;
        errorCount = failedNodes.size;
        applyBatch(b, res.translated, res.failed, bannerVisible); // withProgress → 节点级进度条同步更新
        if (bannerVisible) setProgress(currentBatch, totalBatch, errorCount);
      }
      applying = false;
      if (abortRequested) translationAborted = true; // 取消后禁止兜底/增量自动续翻（与主流程取消语义一致）
      if (pendingFlush) {
        pendingFlush = false;
        scheduleFlush();
      }
      errorCount = failedNodes.size;
      flushPersist();
      if (bannerVisible) setState('done'); // 收尾切回完成态，失败数/重试按钮自动反映
      broadcast();
    })();
  }

  // 兜底定时扫描：覆盖后挂 shadow root、翻译窗口期漏采等 observer 管不到的情况。
  // 仅页面已翻译且空闲时跑；没新节点时 collectUnhandledTextNodes 返回空，零 API 调用。
  let safetyTimer = null;
  function ensureSafetyScan() {
    if (safetyTimer) return;
    safetyTimer = setInterval(function () {
      if (!translated || isBusy() || document.hidden || translationAborted) return;
      flushIncremental();
    }, 4000);
  }

  // ================= 横幅（Shadow DOM 隔离样式） =================
  let host = null, shadow = null, bannerEl = null, progressEl = null, textEl = null;
  let progressWrapEl = null, progressFillEl = null; // 进度条（节点级百分比）

  function ensureBanner() {
    if (host) return;
    // 内容脚本重启后 DOM 里可能残留旧横幅（按钮随旧脚本失效）：复用其 shadow root，
    // 而不是新建一个导致两个横幅叠放
    const existing = document.querySelector('[data-aitr-host]');
    if (existing && existing.shadowRoot && existing.shadowRoot.querySelector('.bar')) {
      host = existing;
      shadow = existing.shadowRoot;
      bannerEl = shadow.querySelector('.bar');
      textEl = shadow.querySelector('.txt');
      progressWrapEl = shadow.querySelector('.progress');
      progressFillEl = shadow.querySelector('.progress-fill');
      return;
    }
    host = document.createElement('div');
    host.setAttribute('data-aitr-host', '');
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
      ':host{all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;display:none;font-family:system-ui,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;}' +
      '.bar{display:flex;align-items:center;gap:12px;padding:9px 16px;background:#f8f9fb;color:#202124;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.15);border-bottom:1px solid #d9dce1;font-size:13px;line-height:1.4;flex-wrap:wrap;transition:background .25s ease;}' +
      '.txt{flex:1;min-width:160px;}' +
      '.actions{display:flex;gap:8px;align-items:center;}' +
      '.cost{display:block;margin-top:8px;font-size:12px;color:#8a8a8a;}' +
      'button{font:inherit;border:1px solid #c9cdd4;background:#fff;color:#1a73e8;border-radius:6px;padding:4px 14px;cursor:pointer;}' +
      'button:hover{background:#f0f4ff;}' +
      'button.primary{background:#1a73e8;border-color:#1a73e8;color:#fff;}' +
      'button.primary:hover{background:#1765cc;}' +
      'button.ghost{border-color:transparent;background:transparent;color:#5f6368;}' +
      'button:disabled{opacity:.5;cursor:default;}' +
      '.spinner{width:13px;height:13px;border:2px solid #c9cdd4;border-top-color:#1a73e8;border-radius:50%;animation:aitr-spin .8s linear infinite;display:inline-block;vertical-align:-2px;}' +
      '@keyframes aitr-spin{to{transform:rotate(360deg)}}' +
      // 进度条：占满一行，细条 + 填充；节点数未知（方向预读期）用不确定滑动条
      '.progress{flex-basis:100%;height:3px;background:rgba(128,134,139,.25);border-radius:2px;overflow:hidden;display:none;margin:-2px 0 4px;}' +
      '.progress-fill{height:100%;width:0%;background:#1a73e8;transition:width .3s ease;}' +
      '.progress.indet .progress-fill{width:35%;animation:aitr-slide 1.2s ease-in-out infinite;}' +
      '@keyframes aitr-slide{0%{margin-left:-35%}100%{margin-left:100%}}' +
      // 完成动画：上滑淡入（底色与询问/翻译中一致，不染色——用户要求去除浅绿）
      '.bar.aitr-done-pop{animation:aitr-pop .45s ease;}' +
      '@keyframes aitr-pop{0%{transform:translateY(-6px);opacity:.5}60%{transform:translateY(1px);opacity:1}100%{transform:translateY(0)}}' +
      // 暗色模式
      '@media (prefers-color-scheme: dark){' +
      '.bar{background:#202124;color:#e8eaed;border-bottom-color:#3c4043;}' +
      'button{border-color:#5f6368;background:#292a2d;color:#8ab4f8;}' +
      'button:hover{background:#35363a;}' +
      'button.primary{background:#8ab4f8;border-color:#8ab4f8;color:#202124;}' +
      'button.primary:hover{background:#9cc1f9;}' +
      'button.ghost{color:#9aa0a6;}' +
      '.cost{color:#9aa0a6;}' +
      '.spinner{border-color:#5f6368;border-top-color:#8ab4f8;}' +
      '.progress{background:#3c4043;}' +
      '.progress-fill{background:#8ab4f8;}' +
      '}' +
      '</style>' +
      '<div class="bar">' +
      '<div class="progress"><div class="progress-fill"></div></div>' +
      '<div class="txt"></div>' +
      '<div class="actions"></div>' +
      '</div>';
    bannerEl = shadow.querySelector('.bar');
    textEl = shadow.querySelector('.txt');
    progressWrapEl = shadow.querySelector('.progress');
    progressFillEl = shadow.querySelector('.progress-fill');
    document.documentElement.appendChild(host);
  }

  function clearActions() {
    const box = shadow.querySelector('.actions');
    while (box.firstChild) box.removeChild(box.firstChild);
    return box;
  }

  function showBanner(state) {
    ensureBanner();
    bannerShown = true;
    host.style.display = 'block';
    const box = clearActions();
    // 进度条仅翻译中显示
    if (progressWrapEl) progressWrapEl.style.display = (state === 'translating') ? 'block' : 'none';

    if (state === 'offer') {
      const from = AITR.langName(detectedLang);
      const to = AITR.langName(config.targetLang);
      textEl.textContent = AITR.t('ban.offer', { from: from, to: to });
      const btn = mkBtn(AITR.t('ban.translate'), 'primary');
      btn.onclick = function () { translatePage(); };
      box.appendChild(btn);
      const no = mkBtn(AITR.t('ban.no'));
      no.onclick = function () { bannerDismissed = true; hideBanner(); };
      box.appendChild(no);
      const x = mkBtn('×', 'ghost');
      x.onclick = function () { bannerDismissed = true; hideBanner(); };
      box.appendChild(x);
    } else if (state === 'translating') {
      textEl.textContent = '';
      const sp = document.createElement('span');
      sp.className = 'spinner';
      progressEl = document.createElement('span');
      progressEl.style.marginLeft = '6px';
      textEl.appendChild(sp);
      textEl.appendChild(progressEl);
      setProgress(currentBatch, totalBatch, errorCount);
      if (progressWrapEl) { progressWrapEl.style.display = 'block'; updateProgressFill(); }
      const cancel = mkBtn(AITR.t('ban.cancel'));
      cancel.onclick = function () { abortRequested = true; };
      box.appendChild(cancel);
    } else if (state === 'done') {
      if (bannerEl) { bannerEl.classList.remove('aitr-done-pop'); void bannerEl.offsetWidth; bannerEl.classList.add('aitr-done-pop'); }
      const to = AITR.langName(config.targetLang);
      textEl.textContent = AITR.t('ban.done', { to: to }) +
        (errorCount ? AITR.t('ban.failed', { n: errorCount }) + (lastErrorMsg ? '：' + lastErrorMsg : '') : '') + ' ✓';
      const rev = mkBtn(AITR.t('ban.restore'));
      rev.onclick = function () { restore(); };
      box.appendChild(rev);
      const again = mkBtn(AITR.t('ban.retranslate'));
      again.onclick = function () { retranslate(); };
      box.appendChild(again);
      if (errorCount > 0) {
        const retryBtn = mkBtn(AITR.t('ban.retryFailed'));
        retryBtn.onclick = function () { retryFailed(); };
        box.appendChild(retryBtn);
      }
      const x = mkBtn('×', 'ghost');
      x.onclick = function () { hideBanner(); };
      box.appendChild(x);
      if (sessionCost > 0) {
        const cEl = document.createElement('span');
        cEl.className = 'cost';
        cEl.textContent = AITR.t('ban.cost', { n: sessionCost.toFixed(4) });
        box.appendChild(cEl);
      }
    } else if (state === 'restored') {
      hideBanner();
    } else if (state === 'nokey') {
      textEl.textContent = AITR.t('ban.nokey');
      const x = mkBtn('×', 'ghost');
      x.onclick = function () { hideBanner(); };
      box.appendChild(x);
    }
    broadcast();
  }

  function setProgress(done, total, errors) {
    if (progressEl) {
      // total===0 是批次尚未构建的过渡态（含 flash 已停用方向预读的场景，文案中性化）
      progressEl.textContent = total === 0 ? AITR.t('ban.analyzing') : AITR.t('ban.translating', { n: done, m: total });
    }
  }

  // 节点级进度条：doneNodes/totalNodes → 百分比；总节点数未知（方向预读期）用不确定滑动条
  function updateProgressFill() {
    if (!progressFillEl) return;
    if (totalNodes > 0) {
      progressFillEl.style.width = Math.min(100, Math.round(doneNodes / totalNodes * 100)) + '%';
      progressWrapEl.classList.remove('indet');
    } else {
      progressWrapEl.classList.add('indet');
    }
  }

  function setState(state) {
    if (!bannerShown && state !== 'done' && state !== 'nokey') return;
    showBanner(state);
  }

  function hideBanner() {
    bannerShown = false;
    if (host) host.style.display = 'none';
    broadcast();
  }

  function mkBtn(label, cls) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    return b;
  }

  function isBusy() { return translating || applying; }
  // status/broadcast 共用的状态负载（含 isBusy），供弹窗与角标读取
  function statusPayload() {
    return {
      translated: translated,
      translating: isBusy(),
      total: totalBatch,
      done: currentBatch,
      errors: errorCount,
      failedCount: failedNodes.size,
      totalNodes: totalNodes,
      doneNodes: doneNodes,
      sessionIn: sessionInChars,
      sessionOut: sessionOutChars,
      sessionCost: sessionCost,
      detected: detectedLang,
      target: config.targetLang,
      hasKey: !!config.apiKey
    };
  }

  // ================= 与弹窗通信 =================
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (sender.id !== chrome.runtime.id) return; // 只处理本扩展自己发出的消息（与 background 一致）
    if (msg.type === 'aitr-translate') { translatePage(); sendResponse({ ok: true }); return; }
    if (msg.type === 'aitr-restore') { restore(); sendResponse({ ok: true }); return; }
    if (msg.type === 'aitr-retranslate') { retranslate(); sendResponse({ ok: true }); return; }
    if (msg.type === 'aitr-retry-failed') { retryFailed(); sendResponse({ ok: true }); return; }
    if (msg.type === 'aitr-hide-banner') { hideBanner(); sendResponse({ ok: true }); return; }
    if (msg.type === 'aitr-status') {
      sendResponse(Object.assign({ ok: true, bannerShown: bannerShown, retryLog: retryLog.slice(-30) }, statusPayload()));
      return;
    }
  });

  function broadcast() {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: 'aitr-progress', state: bannerShown ? (isBusy() ? 'translating' : translated ? 'done' : 'offer') : 'hidden' }, statusPayload()));
    } catch (e) { /* 弹窗未开时忽略 */ }
  }

  // ================= 配置与启动 =================
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    // 站点设置变化：never → 还原已译页并停手；auto → 未译则自动翻
    if (changes.aitrSites) {
      siteConfig = AITR.matchSite(changes.aitrSites.newValue || {}, location.hostname);
      if (siteConfig && siteConfig.never) {
        if (translated) restore();
        return;
      }
      if (siteConfig && siteConfig.auto) {
        if (!translated && !translating && !bannerShown) {
          const f = detectForeign();
          if (f) translatePage();
        }
        return;
      }
    }
    if (!changes.aitrConfig) return;
    config = redactConfig(Object.assign({}, AITR.DEFAULTS, changes.aitrConfig.newValue || {}));
    AITR.setDisplayLang(config.displayLang);
    if (config.autoTranslate && !translated && !translating && !bannerShown) {
      const foreign = detectForeign();
      if (foreign) translatePage();
    }
  });

  function init() {
    AITR.loadConfig().then(function (cfg) {
      config = redactConfig(cfg);
      AITR.setDisplayLang(config.displayLang);
      AITR.loadSites().then(function (sites) {
        siteConfig = AITR.matchSite(sites, location.hostname);
        if (!document.body) {
          // 重页面可能长时间不触发 DOMContentLoaded（广告/追踪脚本挂起），用轮询兜底，body 一出现就跑
          document.addEventListener('DOMContentLoaded', function () { clearInterval(bodyWaitTimer); run(); });
          bodyWaitTimer = setInterval(function () { if (document.body) { clearInterval(bodyWaitTimer); run(); } }, 1000);
          return;
        }
        run();
      });
    });
  }

  function run() {
    if (siteConfig && siteConfig.never) return; // 此站点永翻：不出横幅、不自动翻
    restoreFromPersisted(); // #13：内容脚本重启后，页面仍译态则重建还原能力并重挂横幅
    if (tryShowBanner()) return;
    // document_start 早注入 / 懒加载页面在 DOMContentLoaded 时正文还没渲染，采样不足
    // → 延迟重试检测，等页面内容逐渐出现
    scheduleDetectRetry();
  }

  // 检测外文并出横幅；成功返回 true
  function tryShowBanner() {
    if (siteConfig && siteConfig.never) return false;
    detectedLang = detectForeign();
    if (!detectedLang) return false;
    // 站点级覆盖全局：never > auto > 全局 autoTranslate
    const effAuto = siteConfig ? (siteConfig.auto ? true : config.autoTranslate) : config.autoTranslate;
    if (effAuto) {
      translatePage();
    } else if (!bannerDismissed) {
      showBanner('offer');
    }
    return true;
  }

  let detectTimer = null, detectRetries = 0;
  const DETECT_RETRY_LIMIT = 15;  // 最多重试 15 次（约 45 秒），覆盖广告/追踪脚本拖累的重页面
  const DETECT_RETRY_MS = 3000;

  function scheduleDetectRetry() {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(function () {
      if (siteConfig && siteConfig.never) return;
      if (bannerShown || translated || translating || bannerDismissed) return;
      if (tryShowBanner()) return;
      detectRetries++;
      if (detectRetries < DETECT_RETRY_LIMIT) scheduleDetectRetry();
    }, DETECT_RETRY_MS);
  }

  init();
})();
