// AI 页面翻译 —— 选项页逻辑
'use strict';

const $ = function (id) { return document.getElementById(id); };
let cfg = Object.assign({}, AITR.DEFAULTS);
let savedCfg = Object.assign({}, AITR.DEFAULTS); // 已保存基准（检测改动 / 取消恢复）

function fillLang() {
  const sel = $('targetLang');
  sel.innerHTML = '';
  AITR.LANGUAGES.forEach(function (l) {
    const o = document.createElement('option');
    o.value = l.value;
    o.textContent = l.label;
    if (l.value === cfg.targetLang) o.selected = true;
    sel.appendChild(o);
  });
}

function fillDisplayLang() {
  const sel = $('displayLang');
  sel.innerHTML = '';
  AITR.LANGUAGES.forEach(function (l) {
    const o = document.createElement('option');
    o.value = l.value;
    o.textContent = l.label;
    if (l.value === cfg.displayLang) o.selected = true;
    sel.appendChild(o);
  });
}

// 分段胶囊：译文显示模式（replace/bilingual）
function segMode() {
  const a = document.querySelector('#displayModeSeg .seg-btn.is-active');
  return a ? a.getAttribute('data-mode') : 'replace';
}
function setSegMode(mode) {
  document.querySelectorAll('#displayModeSeg .seg-btn').forEach(function (b) {
    const act = b.getAttribute('data-mode') === (mode || 'replace');
    b.classList.toggle('is-active', act);
    b.setAttribute('aria-checked', act ? 'true' : 'false');
  });
}
function bindSeg() {
  document.querySelectorAll('#displayModeSeg .seg-btn').forEach(function (b) {
    b.addEventListener('click', function () { setSegMode(b.getAttribute('data-mode')); updateDirty(); });
  });
}

function init() {
  AITR.loadConfig().then(function (c) {
    cfg = c;
    savedCfg = Object.assign({}, c);
    AITR.setDisplayLang(c.displayLang);
    $('baseUrl').value = c.baseUrl;
    $('apiKey').value = c.apiKey;
    $('model').value = c.model;
    fillLang();
    fillDisplayLang();
    setSegMode(c.displayMode || 'replace');
    bindSeg();
    AITR.applyI18n(document);
    updateDirty();
  });
  renderSites();
}

function collect() {
  cfg.baseUrl = ($('baseUrl').value || AITR.DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
  cfg.apiKey = ($('apiKey').value || '').trim();
  cfg.model = ($('model').value || AITR.DEFAULTS.model).trim();
  cfg.targetLang = $('targetLang').value;
  cfg.displayLang = $('displayLang').value;
  cfg.displayMode = segMode();
  return cfg;
}

function originOf(url) {
  try { return new URL(url).origin + '/*'; } catch (e) { return null; }
}

// 有任一配置字段改动 → 显示保存/取消操作区；改回原值自动隐藏
function updateDirty() {
  const normBase = function (v) { return (v || '').trim().replace(/\/+$/, ''); };
  const changed =
    normBase($('baseUrl').value) !== normBase(savedCfg.baseUrl) ||
    ($('apiKey').value || '').trim() !== (savedCfg.apiKey || '') ||
    ($('model').value || '').trim() !== (savedCfg.model || '') ||
    $('targetLang').value !== (savedCfg.targetLang || '') ||
    $('displayLang').value !== (savedCfg.displayLang || 'zh-CN') ||
    segMode() !== (savedCfg.displayMode || 'replace');
  $('actionBar').style.display = changed ? 'flex' : 'none';
  return changed;
}

// 取消：4 个配置字段恢复为已保存值，隐藏操作区
function cancelEdit() {
  $('baseUrl').value = savedCfg.baseUrl || '';
  $('apiKey').value = savedCfg.apiKey || '';
  $('model').value = savedCfg.model || '';
  $('targetLang').value = savedCfg.targetLang || '';
  $('displayLang').value = savedCfg.displayLang || 'zh-CN';
  setSegMode(savedCfg.displayMode || 'replace');
  cfg = Object.assign({}, savedCfg);
  AITR.setDisplayLang(cfg.displayLang);
  AITR.applyI18n(document); // 取消恢复界面语言
  $('saved').style.display = 'none';
  updateDirty();
}

async function save(showMsg) {
  collect();
  // 安全确认：baseUrl 换成非官方域名时，API Key 会随翻译请求发送到该地址，需用户明确同意
  let baseOrigin = '';
  try { baseOrigin = new URL(cfg.baseUrl).origin; } catch (e) { /* 非法地址交给后续逻辑 */ }
  if (baseOrigin && baseOrigin !== 'https://api.deepseek.com') {
    const ok = confirm(AITR.t('opt.confirm1', { origin: baseOrigin }));
    if (!ok) { cancelEdit(); return; } // 取消 → 4 个字段整体恢复为已保存值（含 cfg，避免残留变异字段）
  }
  await AITR.saveConfig(cfg);
  // 若换了非默认 API 域名，请求可选 host 权限（精确匹配官方域名，避免 lookalike 域名跳过）
  const origin = originOf(cfg.baseUrl);
  if (origin && origin !== 'https://api.deepseek.com/*') {
    try {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) setResult('注意：未授予 ' + origin + ' 的调用权限，翻译将无法请求该地址。', true);
    } catch (e) { /* 权限请求被忽略 */ }
  }
  savedCfg = Object.assign({}, cfg); // 保存成功 → 更新基准，隐藏操作区
  updateDirty();
  if (showMsg) {
    $('saved').style.display = 'inline';
    setTimeout(function () { $('saved').style.display = 'none'; }, 1800);
  }
}

function setResult(text, isErr) {
  const el = $('result');
  el.textContent = text;
  el.className = isErr ? 'err' : 'ok';
}

// ===== 站点管理 =====
function renderSites() {
  AITR.loadSites().then(function (sites) {
    const ul = $('siteList');
    ul.innerHTML = '';
    Object.keys(sites).sort().forEach(function (host) {
      const st = sites[host] || {};
      const li = document.createElement('li');
      const hostSpan = document.createElement('span');
      hostSpan.className = 'host';
      hostSpan.textContent = host;
      li.appendChild(hostSpan);

      const autoLabel = document.createElement('label');
      const autoCb = document.createElement('input');
      autoCb.type = 'checkbox';
      autoCb.checked = !!st.auto;
      autoCb.addEventListener('change', function () { saveOne(host, { auto: autoCb.checked, never: neverCb.checked }); });
      autoLabel.appendChild(autoCb);
      autoLabel.appendChild(document.createTextNode(AITR.t('opt.site.auto')));
      li.appendChild(autoLabel);

      const neverLabel = document.createElement('label');
      const neverCb = document.createElement('input');
      neverCb.type = 'checkbox';
      neverCb.checked = !!st.never;
      neverCb.addEventListener('change', function () { saveOne(host, { auto: autoCb.checked, never: neverCb.checked }); });
      neverLabel.appendChild(neverCb);
      neverLabel.appendChild(document.createTextNode(AITR.t('opt.site.never')));
      li.appendChild(neverLabel);

      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = AITR.t('opt.site.del');
      del.addEventListener('click', function () {
        AITR.updateSites(function (s) { delete s[host]; }).then(renderSites);
      });
      li.appendChild(del);
      ul.appendChild(li);
    });
  });
}

function saveOne(host, st) {
  AITR.updateSites(function (s) {
    if (st.auto || st.never) s[host] = { auto: !!st.auto, never: !!st.never };
    else delete s[host];
  });
}

function addSite() {
  const host = $('newSite').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host) return;
  AITR.updateSites(function (s) {
    if (!s[host]) s[host] = { auto: false, never: false };
  }).then(function () {
    $('newSite').value = '';
    renderSites();
  });
}

function initEvents() {
  $('saveBtn').addEventListener('click', function () { save(true); });
  $('cancelBtn').addEventListener('click', cancelEdit);
  ['baseUrl', 'apiKey', 'model'].forEach(function (id) {
    $(id).addEventListener('input', updateDirty);
  });
  $('targetLang').addEventListener('change', updateDirty);
  $('displayLang').addEventListener('change', function () {
    AITR.setDisplayLang($('displayLang').value); // 即时预览界面文字
    AITR.applyI18n(document);
    updateDirty(); // 标记待保存
  });
  $('addSiteBtn').addEventListener('click', addSite);
  $('newSite').addEventListener('keydown', function (e) { if (e.key === 'Enter') addSite(); });
  // 测试连接：用当前输入值直接测，不落盘（改完配置先测通再点保存）
  $('testBtn').addEventListener('click', function () {
    setResult(AITR.t('opt.testing'), false);
    chrome.runtime.sendMessage({
      type: 'aitr-test',
      baseUrl: ($('baseUrl').value || '').trim().replace(/\/+$/, ''),
      apiKey: ($('apiKey').value || '').trim(),
      model: ($('model').value || '').trim(),
      targetLang: $('targetLang').value
    }, function (resp) {
      if (chrome.runtime.lastError || !resp) { setResult(AITR.t('opt.testFailBg'), true); return; }
      if (resp.ok) {
        setResult(AITR.t('opt.testOk2', { t: resp.translated }), false);
      } else {
        setResult(AITR.t('opt.testErr', { msg: resp.message || '?' }), true);
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', function () { init(); initEvents(); });
