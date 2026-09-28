/**
 * WebView 存储同步器 v0.4.0 — 动态收集版
 * 动态发现同 origin 的全部 IndexedDB 库与 localStorage 键（新扩展/新脚本建的库自动出现在面板），
 * 序列化进 extension_settings（settings.json → settings.core 数据集），借 TT lan_sync 同步到对端并在启动时恢复。
 * 黑名单模式：默认全部收集，勾掉的排除；已知纯缓存库默认排除。
 */
(() => {
  'use strict';
  const NS = 'webviewSync';

  const DEFAULTS = {
    enabled: true,
    deviceId: '',
    // 动态发现结果的选择表：{ '<库名或ls键>': true/false }。发现新库默认 true（排除表里的除外）
    dbPick: {},
    lsPick: {},
    // 默认排除（纯缓存/可再生）
    dbExclude: [],
    lsExclude: [],
    blobLimitKb: 0,          // 单 Blob 上限(KB)，0=不限制
    autoExportOnSave: false,
    lastImportedVersion: 0,
    lastExportVersion: 0,
    mirror: null,
  };

  const log = (...a) => console.log('[webview-sync]', ...a);
  const warn = (...a) => console.warn('[webview-sync]', ...a);

  function getSettings() {
    const es = (window.SillyTavern?.getContext?.()?.extensionSettings) || window.extension_settings;
    if (!es) return null;
    if (!es[NS]) {
      es[NS] = JSON.parse(JSON.stringify(DEFAULTS));
      es[NS].deviceId = 'dev-' + Math.random().toString(36).slice(2, 8);
    }
    return es[NS]; // v0.2 的 dbs 白名单已被动态发现接管，无需迁移
  }

  function saveSettingsDebounced() {
    const ctx = window.SillyTavern?.getContext?.();
    (ctx?.saveSettingsDebounced || window.saveSettingsDebounced)?.();
  }

  // ---------- 动态发现 ----------
  async function discoverDbs() {
    if (typeof indexedDB.databases === 'function') {
      try {
        const list = await indexedDB.databases();
        return list.map(d => d.name).filter(Boolean);
      } catch (e) { warn('databases() 失败', e); }
    }
    warn('环境不支持 indexedDB.databases()，退回已选清单');
    return Object.keys(getSettings()?.dbPick || {});
  }

  function discoverLsKeys() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
    return out;
  }

  function pickDb(s, name) {
    if (s.dbExclude.includes(name)) return false;
    if (name in s.dbPick) return !!s.dbPick[name];
    return true; // 新库默认收集
  }
  function pickLs(s, k) {
    if (s.lsExclude.some(p => k.startsWith(p))) return false;
    if (k in s.lsPick) return !!s.lsPick[k];
    return true;
  }

  // ---------- 序列化 ----------
  const skipped = [];
  const blobLimit = () => Math.max(0, Number(getSettings()?.blobLimitKb) || 0) * 1024;

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function serializeValue(v) {
    if (v instanceof Blob) {
      const limit = blobLimit();
      if (limit > 0 && v.size > limit) { skipped.push(`blob ${v.size}B`); return { __blobSkipped: true, size: v.size, type: v.type }; }
      return { __blob: true, mime: v.type, data: await blobToBase64(v) };
    }
    if (v instanceof ArrayBuffer) {
      const limit = blobLimit();
      if (limit > 0 && v.byteLength > limit) { skipped.push(`ab ${v.byteLength}B`); return { __blobSkipped: true, size: v.byteLength }; }
      return { __ab: true, b64: btoa(String.fromCharCode(...new Uint8Array(v))) };
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if (Array.isArray(v)) { const o = []; for (const x of v) o.push(await serializeValue(x)); return o; }
      const o = {}; for (const k of Object.keys(v)) o[k] = await serializeValue(v[k]); return o;
    }
    return v;
  }

  async function exportDb(dbName) {
    let db;
    try {
      db = await new Promise((res, rej) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
        req.onblocked = () => rej(new Error('blocked'));
      });
    } catch (e) {
      return { __missing: String(e?.message || e) };
    }
    const out = {};
    for (const sn of [...db.objectStoreNames]) {
      try {
        const tx = db.transaction(sn, 'readonly');
        const st = tx.objectStore(sn);
        const rows = await new Promise((res, rej) => {
          const q = st.getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
        });
        let keys = null;
        if (!st.keyPath) {
          keys = await new Promise((res, rej) => {
            const q = st.getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
          });
        }
        out[sn] = { rows: [], keys: keys ? keys.map(k => serializePlain(k)) : null, keyPath: st.keyPath || null };
        for (const row of rows) out[sn].rows.push(await serializeValue(row));
      } catch (e) {
        out[sn] = { __error: String(e?.message || e) };
      }
    }
    db.close();
    return out;
  }

  function serializePlain(v) { // out-of-line 键通常是字符串/数字
    if (v instanceof Blob || v instanceof ArrayBuffer) return String(v);
    return v;
  }

  async function importDb(dbName, dump) {
    if (!dump || dump.__missing) return;
    const probe = await new Promise((res, rej) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const version = probe.version; probe.close();
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open(dbName, version);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        for (const sn of Object.keys(dump)) {
          if (d.objectStoreNames.contains(sn)) continue;
          const kp = dump[sn]?.keyPath;
          if (kp) d.createObjectStore(sn, { keyPath: kp });
          else d.createObjectStore(sn);
        }
      };
    });
    for (const sn of Object.keys(dump)) {
      const sd = dump[sn];
      if (sd.__error || !Array.isArray(sd.rows) || !db.objectStoreNames.contains(sn)) continue;
      try {
        const tx = db.transaction(sn, 'readwrite');
        const st = tx.objectStore(sn);
        if (sd.keys) {
          st.clear();
          for (let i = 0; i < sd.rows.length; i++) st.put(await deserializeValue(sd.rows[i]), sd.keys[i]);
        } else {
          for (const r of sd.rows) st.put(await deserializeValue(r));
        }
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      } catch (e) { warn('恢复 store 失败', dbName, sn, e); }
    }
    db.close();
  }

  async function deserializeValue(v) {
    if (v && typeof v === 'object') {
      if (v.__blob) {
        const b64 = v.data.split(',')[1];
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: v.mime });
      }
      if (v.__ab) {
        const bin = atob(v.b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr.buffer;
      }
      if (Array.isArray(v)) { const o = []; for (const x of v) o.push(await deserializeValue(x)); return o; }
      const o = {}; for (const k of Object.keys(v)) o[k] = await deserializeValue(v[k]); return o;
    }
    return v;
  }

  // ---------- 导出 / 导入 ----------
  async function exportMirror() {
    const s = getSettings(); if (!s) return warn('设置不可用');
    skipped.length = 0;
    const dbs = {};
    const found = await discoverDbs();
    const picked = found.filter(n => pickDb(s, n));
    for (const name of picked) dbs[name] = await exportDb(name);
    const ls = {};
    for (const k of discoverLsKeys()) if (pickLs(s, k)) ls[k] = localStorage.getItem(k);
    s.mirror = { version: Date.now(), device: s.deviceId, dbs, ls, skipped: [...skipped] };
    s.lastExportVersion = s.mirror.version;
    saveSettingsDebounced();
    log('镜像已导出 v', s.mirror.version, '| 库:', picked.length, '| ls键:', Object.keys(ls).length, '| 跳过:', skipped.length);
    return s.mirror.version;
  }

  async function importMirror(force = false) {
    const s = getSettings(); if (!s || !s.mirror) return log('无镜像');
    const m = s.mirror;
    if (!force && (m.version <= s.lastImportedVersion || m.version <= s.lastExportVersion)) return log('无需导入');
    for (const name of Object.keys(m.dbs || {})) await importDb(name, m.dbs[name]);
    for (const [k, v] of Object.entries(m.ls || {})) localStorage.setItem(k, v);
    s.lastImportedVersion = m.version;
    saveSettingsDebounced();
    log('镜像已恢复（来自', m.device, 'v', m.version, '），建议重启 TT');
    return m.version;
  }

  // ---------- 面板 ----------
  function fmtKB(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB'; }

  async function buildPanel() {
    const s = getSettings(); if (!s) return;

    const html = `
      <div id="webview-sync-panel" class="extension_settings">
        <div class="inline-drawer">
          <div class="inline-drawer-toggle inline-drawer-header">
            <b>WebView 存储同步器</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
          </div>
          <div class="inline-drawer-content" style="display:none;">
            <div style="padding: 10px; display: flex; flex-direction: column; gap: 10px;">

              <div class="ws-actions">
                <button type="button" class="menu_button" data-act="export">
                  <i class="fa-solid fa-cloud-arrow-up"></i><span>导出镜像到同步</span>
                </button>
                <button type="button" class="menu_button" data-act="import">
                  <i class="fa-solid fa-cloud-arrow-down"></i><span>从镜像恢复(强制)</span>
                </button>
                <button type="button" class="menu_button" data-act="scan">
                  <i class="fa-solid fa-rotate"></i><span>重新扫描</span>
                </button>
              </div>

              <div class="ws-status text_pole" style="margin:0; white-space:normal; word-break:break-all; display:block; text-align:left;">尚无镜像</div>

              <div>
                <div class="ws-sec"><i class="fa-solid fa-database"></i> IndexedDB 库 <small class="ws-sub">（动态发现 · 勾选=同步）</small></div>
                <div class="ws-list ws-dblist"></div>
              </div>

              <div>
                <div class="ws-sec"><i class="fa-solid fa-key"></i> localStorage <small class="ws-sub">（动态发现 · 勾选=同步）</small></div>
                <div class="ws-list ws-lslist"></div>
              </div>

              <div class="ws-actions" style="justify-content: space-between;">
                <label class="checkbox_label" style="display:flex;align-items:center;gap:6px;margin:0;">
                  <input type="checkbox" class="ws-auto"><span>随设置保存自动导出</span>
                </label>
                <label class="checkbox_label" style="display:flex;align-items:center;gap:6px;margin:0;">
                  <span>单文件上限(KB)</span>
                  <input type="number" class="ws-limit text_pole" style="width:70px;" min="0">
                </label>
              </div>

            </div>
          </div>
        </div>
      </div>`;

    const container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!container) return setTimeout(() => buildPanel(), 1000);
    const old = document.getElementById('webview-sync-panel'); old?.remove();
    container.insertAdjacentHTML('beforeend', html);

    const div = document.getElementById('webview-sync-panel');
    const $ = (q) => div.querySelector(q);
    const $st = $('.ws-status'), $dbl = $('.ws-dblist'), $lsl = $('.ws-lslist');

    // 折叠开合（学玉子面板）
    const $header = $(`#${'webview-sync-panel'} .inline-drawer-header`); // eslint-disable-line
    const hdr = div.querySelector('.inline-drawer-header');
    const content = div.querySelector('.inline-drawer-content');
    const icon = div.querySelector('.inline-drawer-icon');
    hdr.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (window.jQuery) {
        if (content.style.display === 'none') { window.jQuery(content).slideDown(200); icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-up'; }
        else { window.jQuery(content).slideUp(200); icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down'; }
      } else {
        content.style.display = content.style.display === 'none' ? '' : 'none';
      }
    });

    async function renderLists() {
      const names = await discoverDbs();
      $dbl.innerHTML = '';
      for (const n of names) {
        const row = document.createElement('label');
        row.className = 'ws-item';
        const checked = pickDb(s, n);
        const excluded = s.dbExclude.includes(n);
        let info = '';
        try {
          const db = await new Promise((res, rej) => { const q = indexedDB.open(n); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
          info = [...db.objectStoreNames].join(','); db.close();
          info = info ? `(${info.slice(0, 60)})` : '(空)';
        } catch (_) { info = '(无法打开)'; }
        row.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''} ${excluded ? 'title="默认排除(缓存类)，勾选可强制同步"' : ''}> <span class="ws-name">${n}</span> <span class="ws-info">${info}</span>`;
        row.querySelector('input').addEventListener('change', (e) => { s.dbPick[n] = e.target.checked; saveSettingsDebounced(); });
        $dbl.appendChild(row);
      }
      $lsl.innerHTML = '';
      const keys = discoverLsKeys().sort();
      for (const k of keys) {
        const row = document.createElement('label');
        row.className = 'ws-item';
        const size = (localStorage.getItem(k) || '').length;
        row.innerHTML = `<input type="checkbox" ${pickLs(s, k) ? 'checked' : ''}> <span class="ws-name">${k.length > 48 ? k.slice(0, 45) + '…' : k}</span> <span class="ws-info">${fmtKB(size)}</span>`;
        row.querySelector('input').addEventListener('change', (e) => { s.lsPick[k] = e.target.checked; saveSettingsDebounced(); });
        $lsl.appendChild(row);
      }
    }

    const refresh = () => {
      const m = s.mirror;
      $st.textContent = m
        ? `镜像 v${m.version} @${m.device} · 库 ${Object.keys(m.dbs || {}).length} · ls ${Object.keys(m.ls || {}).length} · 跳过 ${(m.skipped || []).length} · 已导入 ${s.lastImportedVersion || '无'}`
        : '尚无镜像';
    };
    refresh();
    $('.ws-limit').value = s.blobLimitKb;
    $('.ws-limit').addEventListener('change', (e) => { s.blobLimitKb = Math.max(0, Number(e.target.value) || 0); });
    $('.ws-auto').checked = !!s.autoExportOnSave;
    $('.ws-auto').addEventListener('change', (e) => { s.autoExportOnSave = e.target.checked; });

    div.addEventListener('click', async (e) => {
      const act = e.target?.closest('[data-act]')?.dataset?.act;
      if (!act) return;
      if (act === 'export') { const v = await exportMirror(); refresh(); alert('镜像已导出 v' + v + (skipped.length ? '\n跳过 ' + skipped.length + ' 个大文件' : '')); }
      if (act === 'import') { const v = await importMirror(true); refresh(); alert('已从镜像恢复 v' + v + '\n建议重启 TT 让各扩展重载'); }
      if (act === 'scan') { await renderLists(); alert('已重新扫描'); }
    });

    renderLists();
  }

  // ---------- 启动 ----------
  async function boot() {
    try { await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__); } catch (_) {}
    const s = getSettings();
    if (!s) return warn('宿主设置不可用');
    if (!s.enabled) return log('已停用');
    await buildPanel();
    setTimeout(() => importMirror(false).then(v => {
      if (v) alert('[WebView同步] 检测到来自其他设备的新镜像(v' + v + ')，已写入本地存储。\n建议重启 TT 让各扩展重新加载。');
    }), 4000);
    log('已启动(动态收集模式)', s.deviceId);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
