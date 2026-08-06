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

function init() {
  AITR.loadConfig().then(function (c) {
    cfg = c;
    savedCfg = Object.assign({}, c);
    $('baseUrl').value = c.baseUrl;
    $('apiKey').value = c.apiKey;
    $('model').value = c.model;
    fillLang();
    updateDirty();
  });
  renderSites();
}

function collect() {
  cfg.baseUrl = ($('baseUrl').value || AITR.DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
  cfg.apiKey = ($('apiKey').value || '').trim();
  cfg.model = ($('model').value || AITR.DEFAULTS.model).trim();
  cfg.targetLang = $('targetLang').value;
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
    $('targetLang').value !== (savedCfg.targetLang || '');
  $('actionBar').style.display = changed ? 'flex' : 'none';
  return changed;
}

// 取消：4 个配置字段恢复为已保存值，隐藏操作区
function cancelEdit() {
  $('baseUrl').value = savedCfg.baseUrl || '';
  $('apiKey').value = savedCfg.apiKey || '';
  $('model').value = savedCfg.model || '';
  $('targetLang').value = savedCfg.targetLang || '';
  cfg = Object.assign({}, savedCfg);
  $('saved').style.display = 'none';
  updateDirty();
}

async function save(showMsg) {
  collect();
  // 安全确认：baseUrl 换成非官方域名时，API Key 会随翻译请求发送到该地址，需用户明确同意
  let baseOrigin = '';
  try { baseOrigin = new URL(cfg.baseUrl).origin; } catch (e) { /* 非法地址交给后续逻辑 */ }
  if (baseOrigin && baseOrigin !== 'https://api.deepseek.com') {
    const ok = confirm(
      '你的 API Key 会随翻译请求发送到以下地址：\n\n  ' + baseOrigin + '\n\n' +
      '请确认你信任该服务商（或确认这是你自己的网关）。\n' +
      '点「确定」继续保存，点「取消」返回修改。'
    );
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
      autoLabel.appendChild(document.createTextNode(' 自动'));
      li.appendChild(autoLabel);

      const neverLabel = document.createElement('label');
      const neverCb = document.createElement('input');
      neverCb.type = 'checkbox';
      neverCb.checked = !!st.never;
      neverCb.addEventListener('change', function () { saveOne(host, { auto: autoCb.checked, never: neverCb.checked }); });
      neverLabel.appendChild(neverCb);
      neverLabel.appendChild(document.createTextNode(' 永不翻译'));
      li.appendChild(neverLabel);

      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '删除';
      del.addEventListener('click', function () {
        AITR.loadSites().then(function (s) { delete s[host]; AITR.saveSites(s).then(renderSites); });
      });
      li.appendChild(del);
      ul.appendChild(li);
    });
  });
}

function saveOne(host, st) {
  AITR.loadSites().then(function (s) {
    if (st.auto || st.never) s[host] = { auto: !!st.auto, never: !!st.never };
    else delete s[host];
    AITR.saveSites(s);
  });
}

function addSite() {
  const host = $('newSite').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host) return;
  AITR.loadSites().then(function (s) {
    if (!s[host]) s[host] = { auto: false, never: false };
    AITR.saveSites(s).then(function () {
      $('newSite').value = '';
      renderSites();
    });
  });
}

function initEvents() {
  $('saveBtn').addEventListener('click', function () { save(true); });
  $('cancelBtn').addEventListener('click', cancelEdit);
  ['baseUrl', 'apiKey', 'model'].forEach(function (id) {
    $(id).addEventListener('input', updateDirty);
  });
  $('targetLang').addEventListener('change', updateDirty);
  $('addSiteBtn').addEventListener('click', addSite);
  $('newSite').addEventListener('keydown', function (e) { if (e.key === 'Enter') addSite(); });
  // 测试连接：用当前输入值直接测，不落盘（改完配置先测通再点保存）
  $('testBtn').addEventListener('click', function () {
    setResult('正在测试连接…', false);
    chrome.runtime.sendMessage({
      type: 'aitr-test',
      baseUrl: ($('baseUrl').value || '').trim().replace(/\/+$/, ''),
      apiKey: ($('apiKey').value || '').trim(),
      model: ($('model').value || '').trim(),
      targetLang: $('targetLang').value
    }, function (resp) {
      if (chrome.runtime.lastError || !resp) { setResult('测试失败：无法连接后台', true); return; }
      if (resp.ok) {
        setResult('✓ 连接成功。示例译文：「' + resp.translated + '」', false);
      } else {
        setResult('测试失败：' + (resp.message || '未知错误'), true);
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', function () { init(); initEvents(); });
