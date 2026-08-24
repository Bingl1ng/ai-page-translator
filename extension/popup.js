// AI 页面翻译 —— 弹窗逻辑
'use strict';

let cfg = Object.assign({}, AITR.DEFAULTS);
let tabId = null;
let currentHost = ''; // 当前活动 tab 的 hostname（站点设置用）
let pendingReapply = false;   // A6b：翻译进行中切了目标语言/显示模式 → 完成后补一次重翻
let langOrModeChanged = false; // A6a：仅目标语言/显示模式真正变化才重翻

const $ = function (id) { return document.getElementById(id); };

// 分段胶囊：译文显示模式（replace/bilingual）
function setPopupSeg(mode) {
  document.querySelectorAll('#modeSeg .seg-btn').forEach(function (b) {
    const act = b.getAttribute('data-mode') === (mode || 'replace');
    b.classList.toggle('is-active', act);
    b.setAttribute('aria-checked', act ? 'true' : 'false');
  });
}
function bindPopupSeg() {
  document.querySelectorAll('#modeSeg .seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      const mode = b.getAttribute('data-mode');
      setPopupSeg(mode);
      cfg.displayMode = mode;
      saveAndApply();
    });
  });
}

function init() {
  AITR.loadConfig().then(function (c) {
    cfg = c;
    AITR.setDisplayLang(c.displayLang);
    fillLang();
    AITR.applyI18n(document);
    $('auto').checked = !!cfg.autoTranslate;
    setPopupSeg(c.displayMode || 'replace');
    const nokey = $('nokey');
    if (nokey) { nokey.style.display = cfg.apiKey ? 'none' : 'block'; }
    queryTab();
  });
  initUsage();
  bindEvents();
  bindPopupSeg();
}

// 用量：今日/本月真实金额（后台已按真实单价+峰谷算好 cost），外加 token 数
function initUsage() {
  AITR.loadUsage().then(function (u) {
    const now = new Date();
    const y = now.getFullYear();
    const ym = y + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const today = ym + '-' + String(now.getDate()).padStart(2, '0');
    let inT = 0, outT = 0, monthCost = 0, todayCost = 0;
    Object.keys(u.byDay || {}).forEach(function (k) {
      const d = u.byDay[k] || {};
      if (k.indexOf(ym) === 0) {
        inT += (d.in || 0); outT += (d.out || 0); monthCost += (d.cost || 0);
      }
      if (k === today) todayCost += (d.cost || 0);
    });
    $('usageMonth').textContent = AITR.formatYuan(monthCost, 3) + ' · ' + AITR.formatCount(inT + outT) + ' token';
    $('usageToday').textContent = todayCost > 0 ? AITR.formatYuan(todayCost, 4) : AITR.t('pop.noUsageToday');
  });
}

// 本次用量：优先真实成本（sessionCost,后台按真实 token+单价算），缺则回退字符估算
function updateUsageNow(m) {
  const c = m.sessionCost || 0;
  if (c > 0) { $('usageNow').textContent = AITR.formatYuan(c, 4); return; }
  const inC = m.sessionIn || 0, outC = m.sessionOut || 0;
  const est = AITR.estimateCost(inC / 1.7, outC / 1.7);
  $('usageNow').textContent = AITR.formatCount(inC + outC) + ' 字符 ≈ ' + AITR.formatYuan(est, 4);
}

function fillLang() {
  const sel = $('lang');
  sel.innerHTML = '';
  AITR.LANGUAGES.forEach(function (l) {
    const o = document.createElement('option');
    o.value = l.value;
    o.textContent = l.label;
    if (l.value === cfg.targetLang) o.selected = true;
    sel.appendChild(o);
  });
}

function queryTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const t = tabs && tabs[0];
    if (!t) return;
    tabId = t.id;
    // 受限页面（edge:// 等）内容脚本不注入
    // 站点设置区块：可读 hostname 才显示
    try { currentHost = new URL(t.url).hostname; } catch (e) { currentHost = ''; }
    if (currentHost) {
      AITR.loadSites().then(function (sites) {
        const s = AITR.matchSite(sites, currentHost);
        $('siteBox').style.display = 'block';
        $('siteAuto').checked = !!(s && s.auto);
        $('siteNever').checked = !!(s && s.never);
      });
    } else {
      $('siteBox').style.display = 'none';
    }
    chrome.tabs.sendMessage(tabId, { type: 'aitr-status' }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        setStatus(AITR.t('pop.unsupported'), true);
        $('translateBtn').disabled = true;
        $('restoreBtn').disabled = true;
        return;
      }
      reflectStatus(resp);
    });
  });
}

// 渲染三态（translating/translated/未译）：按钮禁用态 + 状态文字 + 进度清零。
// 弹窗轮询(reflectStatus)与内容脚本推送(onMessage)共用。
function renderStatus(s) {
  if (s.translating) {
    setStatus(AITR.t('pop.translating', { n: s.done || 0, m: s.total || 0 }));
    $('translateBtn').disabled = true;
    $('retranslateBtn').disabled = true;
    $('retryFailedBtn').style.display = 'none';
    $('restoreBtn').disabled = false;
  } else if (s.translated) {
    setStatus(AITR.t('pop.done', { lang: AITR.langName(s.target) || '' }) + (s.errors ? AITR.t('pop.failed', { n: s.errors }) : ''));
    $('translateBtn').disabled = false;
    $('retranslateBtn').disabled = false;
    $('retryFailedBtn').style.display = (s.failedCount > 0 && s.hasKey) ? 'block' : 'none';
    $('restoreBtn').disabled = false;
  } else {
    setStatus(s.detected ? AITR.t('pop.detectedForeign') : AITR.t('pop.notTranslated'));
    $('translateBtn').disabled = false;
    $('retranslateBtn').disabled = true;
    $('retryFailedBtn').style.display = 'none';
    $('restoreBtn').disabled = true;
  }
  $('pg').textContent = '';
}

function reflectStatus(s) {
  setPopupProgress(s);
  updateUsageNow(s);
  renderStatus(s);
}

function setStatus(text, isErr) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (isErr ? ' err' : '');
}

// 弹窗进度条（节点级百分比）
function setPopupProgress(m) {
  const w = $('progressWrap');
  if (m.translating) {
    w.style.display = 'block';
    const pct = (m.totalNodes > 0 && m.doneNodes != null) ? Math.round(m.doneNodes / m.totalNodes * 100) : 0;
    $('popupFill').style.width = pct + '%';
  } else {
    w.style.display = 'none';
  }
}

function bindEvents() {
  $('translateBtn').addEventListener('click', function () {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'aitr-translate' }).catch(function () {});
    setStatus(AITR.t('pop.translating', { n: 0, m: 0 }));
  });
  $('restoreBtn').addEventListener('click', function () {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'aitr-restore' }).catch(function () {});
  });
  $('retranslateBtn').addEventListener('click', function () {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'aitr-retranslate' }).catch(function () {});
    setStatus(AITR.t('pop.retranslating'));
  });
  $('retryFailedBtn').addEventListener('click', function () {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'aitr-retry-failed' }).catch(function () {});
    setStatus('重试失败段落中…');
  });
  $('lang').addEventListener('change', function () {
    cfg.targetLang = this.value;
    saveAndApply();
  });
  $('auto').addEventListener('change', function () {
    cfg.autoTranslate = this.checked;
    saveAndApply();
  });
  $('siteAuto').addEventListener('change', saveSiteToggle);
  $('siteNever').addEventListener('change', saveSiteToggle);
  function openOptions() { chrome.runtime.openOptionsPage(); }
  const oe = $('openOptions'); if (oe) oe.addEventListener('click', openOptions);
  const ol = $('optionsLink'); if (ol) ol.addEventListener('click', openOptions);
}

// 站点开关：写 aitrSites（两关则删除该域记录）
function saveSiteToggle() {
  if (!currentHost) return;
  AITR.updateSites(function (sites) {
    const s = sites[currentHost] || {};
    s.auto = $('siteAuto').checked;
    s.never = $('siteNever').checked;
    if (s.auto || s.never) sites[currentHost] = s;
    else delete sites[currentHost];
  });
}

function saveAndApply() {
  // 以最新存储为基准合并，只覆盖本弹窗改动的字段，避免用陈旧快照覆盖别处（options/另一弹窗）的修改
  AITR.loadConfig().then(function (cur) {
    // A6a：仅"目标语言 / 显示模式"真正变化才需重翻（切"自动翻译"等不影响已译页，避免误重翻闪+费）
    langOrModeChanged = (cur.targetLang !== cfg.targetLang) ||
      ((cur.displayMode || 'replace') !== (cfg.displayMode || 'replace'));
    return AITR.saveConfig(Object.assign({}, cur, cfg));
  }).then(function () {
    if (!langOrModeChanged) return;
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'aitr-status' }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) return;
      if (resp.translated && !resp.translating) {
        chrome.tabs.sendMessage(tabId, { type: 'aitr-restore' }).catch(function () {});
        setTimeout(function () {
          chrome.tabs.sendMessage(tabId, { type: 'aitr-translate' }).catch(function () {});
        }, 150);
      } else if (resp.translating) {
        // A6b：翻译进行中切了语言/模式 → 记下待办，完成后补一次重翻
        pendingReapply = true;
      }
    });
  });
}

// 内容脚本主动推送的进度
chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.type !== 'aitr-progress') return;
  setPopupProgress(msg);
  updateUsageNow(msg);
  renderStatus(msg);
  // A6b：翻译完成且有待办重翻（中途切了语言/模式）→ 还原后补翻一次
  if (pendingReapply && msg.translating === false && msg.translated) {
    pendingReapply = false;
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'aitr-restore' }).catch(function () {});
    setTimeout(function () {
      chrome.tabs.sendMessage(tabId, { type: 'aitr-translate' }).catch(function () {});
    }, 150);
  }
});

document.addEventListener('DOMContentLoaded', init);
