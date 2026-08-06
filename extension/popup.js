// AI 页面翻译 —— 弹窗逻辑
'use strict';

let cfg = Object.assign({}, AITR.DEFAULTS);
let tabId = null;
let currentHost = ''; // 当前活动 tab 的 hostname（站点设置用）

const $ = function (id) { return document.getElementById(id); };

function init() {
  AITR.loadConfig().then(function (c) {
    cfg = c;
    fillLang();
    $('auto').checked = !!cfg.autoTranslate;
    if (!cfg.apiKey) $('nokey').style.display = 'block';
    else $('nokey').style.display = 'none';
    queryTab();
  });
  initUsage();
  bindEvents();
}

// 本月用量（真实 token，从 aitrUsage 聚合当月）
function initUsage() {
  AITR.loadUsage().then(function (u) {
    const now = new Date();
    const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    let inT = 0, outT = 0;
    Object.keys(u.byDay || {}).forEach(function (k) {
      if (k.indexOf(ym) === 0) {
        inT += (u.byDay[k].in || 0);
        outT += (u.byDay[k].out || 0);
      }
    });
    const cost = AITR.estimateCost(inT, outT);
    $('usageMonth').textContent = AITR.formatCount(inT + outT) + ' token ≈ ' + AITR.USAGE_EST.symbol + cost.toFixed(3);
  });
}

// 本次用量（本页会话累计字符 → 费用估算）
function updateUsageNow(m) {
  const inC = m.sessionIn || 0, outC = m.sessionOut || 0;
  const est = AITR.estimateCost(inC / 1.7, outC / 1.7);
  $('usageNow').textContent = AITR.formatCount(inC + outC) + ' 字符 ≈ ' + AITR.USAGE_EST.symbol + est.toFixed(4);
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
        setStatus('此页面不支持翻译（浏览器内部页面或受限站点）。', true);
        $('translateBtn').disabled = true;
        $('restoreBtn').disabled = true;
        return;
      }
      reflectStatus(resp);
    });
  });
}

function reflectStatus(s) {
  setPopupProgress(s);
  updateUsageNow(s);
  if (s.translating) {
    setStatus('翻译中… ' + (s.done || 0) + '/' + (s.total || 0));
    $('translateBtn').disabled = true;
    $('retranslateBtn').disabled = true;
    $('retryFailedBtn').style.display = 'none';
    $('restoreBtn').disabled = false;
    $('pg').textContent = '';
  } else if (s.translated) {
    setStatus('已翻译成' + (AITR.langLabel(s.target) || '') + (s.errors ? '（' + s.errors + ' 段失败）' : ''));
    $('translateBtn').disabled = false;
    $('retranslateBtn').disabled = false;
    $('retryFailedBtn').style.display = (s.failedCount > 0 && s.hasKey) ? 'block' : 'none';
    $('restoreBtn').disabled = false;
    $('pg').textContent = '';
  } else {
    const from = s.detected ? '检测到外文，未翻译' : '';
    setStatus(from || '此页未翻译');
    $('translateBtn').disabled = false;
    $('retranslateBtn').disabled = true;
    $('retryFailedBtn').style.display = 'none';
    $('restoreBtn').disabled = true;
    $('pg').textContent = '';
  }
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
    setStatus('翻译中…');
  });
  $('restoreBtn').addEventListener('click', function () {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'aitr-restore' }).catch(function () {});
  });
  $('retranslateBtn').addEventListener('click', function () {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'aitr-retranslate' }).catch(function () {});
    setStatus('重新翻译中…');
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
  $('openOptions').addEventListener('click', openOptions);
  $('optionsLink').addEventListener('click', openOptions);
}

// 站点开关：写 aitrSites（两关则删除该域记录）
function saveSiteToggle() {
  if (!currentHost) return;
  AITR.loadSites().then(function (sites) {
    const s = sites[currentHost] || {};
    s.auto = $('siteAuto').checked;
    s.never = $('siteNever').checked;
    if (s.auto || s.never) sites[currentHost] = s;
    else delete sites[currentHost];
    AITR.saveSites(sites);
  });
}

function saveAndApply() {
  // 以最新存储为基准合并，只覆盖本弹窗改动的字段，避免用陈旧快照覆盖别处（options/另一弹窗）的修改
  AITR.loadConfig().then(function (cur) {
    return AITR.saveConfig(Object.assign({}, cur, cfg));
  }).then(function () {
    // 语言变了且页面已翻译 → 还原后按新语言重翻
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'aitr-status' }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) return;
      if (resp.translated && !resp.translating) {
        chrome.tabs.sendMessage(tabId, { type: 'aitr-restore' }).catch(function () {});
        setTimeout(function () {
          chrome.tabs.sendMessage(tabId, { type: 'aitr-translate' }).catch(function () {});
        }, 150);
      }
    });
  });
}

// 内容脚本主动推送的进度
chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.type !== 'aitr-progress') return;
  setPopupProgress(msg);
  updateUsageNow(msg);
  if (msg.translating) {
    setStatus('翻译中… ' + (msg.done || 0) + '/' + (msg.total || 0));
    $('translateBtn').disabled = true;
    $('retranslateBtn').disabled = true;
    $('retryFailedBtn').style.display = 'none';
    $('restoreBtn').disabled = false;
  } else if (msg.translated) {
    setStatus('已翻译成' + (AITR.langLabel(msg.target) || '') + (msg.errors ? '（' + msg.errors + ' 段失败）' : ''));
    $('translateBtn').disabled = false;
    $('retranslateBtn').disabled = false;
    $('retryFailedBtn').style.display = (msg.failedCount > 0 && msg.hasKey) ? 'block' : 'none';
    $('restoreBtn').disabled = false;
  } else {
    setStatus('此页未翻译');
    $('translateBtn').disabled = false;
    $('retranslateBtn').disabled = true;
    $('retryFailedBtn').style.display = 'none';
    $('restoreBtn').disabled = true;
  }
});

document.addEventListener('DOMContentLoaded', init);
