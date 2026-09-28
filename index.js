/**
 * WebView 存储同步器 v0.1.0
 * 把扩展的 IndexedDB/localStorage 数据镜像进 TT 同步数据集：
 *   - 全局镜像 → extension_settings.webviewSync.mirror（settings.json → settings.core 数据集）
 *   - 借 TT lan_sync 传输，对端启动时检测新版并写回本地存储
 * 镜像中跳过超大 blob（>BLOB_LIMIT），记录在 skipped 里待二期走媒体数据集。
 */
(() => {
  'use strict';
  const NS = 'webviewSync';
  const MIRROR_KEY = 'mirror';
  const BLOB_LIMIT = 100 * 1024; // 超过此体积的 Blob 跳过（base64 前的原始字节数）

  const DEFAULTS = {
    enabled: true,
    deviceId: '',            // 首次运行生成
    dbs: [                   // 要镜像的 IndexedDB 库名单（源码实证清单，可在面板增删）
      'yuzi-phone-qq-v2',                 // 玉子手机 QQ：联系人/群聊/会话/预设/头像
      'yuzi-phone-appearance-assets',     // 玉子手机 外观资源
      'yuzi-phone-appearance-packs',      // 玉子手机 外观包
      'yuzi-phone-template-workshop-v2',  // 玉子手机 模板工作台/美化工程
      'yuzi-phone-table-image-ownership', // 玉子手机 表格图片归属
      'shujuku_v120_config_v1',           // SP·数据库 配置缓存
      'douluo-main-text-assets',          // 斗罗状态栏/正文/角色创建 头像立绘
      'wn_phone_media_v1',                // 偏航手机外壳 媒体库(LIME头像等)
      'chatu8_config_images',             // 柏宝绘 chatu8 配置图片
      'baibai_image_vibes',               // 柏宝绘 vibe 数据
    ],
    lsPrefixes: [],          // localStorage 键前缀过滤；空数组=不同步 localStorage
    autoExportOnSave: false, // 每次 TT 保存设置时顺带导出（MVP 默认关，手动按钮为主）
    lastImportedVersion: 0,
    lastExportVersion: 0,
    mirror: null,           // { version, device, dbs:{name:{stores:{s:{rows:[...],keys:[...]}}}}, ls:{k:v}, skipped:[...] }
  };

  // ---------- 工具 ----------
  const log = (...a) => console.log('[webview-sync]', ...a);
  const warn = (...a) => console.warn('[webview-sync]', ...a);

  function getSettings() {
    const es = (window.SillyTavern?.getContext?.()?.extensionSettings) || window.extension_settings;
    if (!es) return null;
    if (!es[NS]) es[NS] = JSON.parse(JSON.stringify(DEFAULTS));
    return es[NS];
  }

  function deviceName(s) {
    if (!s.deviceId) {
      s.deviceId = 'dev-' + Math.random().toString(36).slice(2, 8);
    }
    return s.deviceId;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // ---------- IndexedDB 采集 ----------
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
    const storeNames = [...db.objectStoreNames];
    const out = {};
    for (const sn of storeNames) {
      try {
        const tx = db.transaction(sn, 'readonly');
        const st = tx.objectStore(sn);
        const rows = await new Promise((res, rej) => {
          const q = st.getAll();
          q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
        });
        let keys = null;
        if (!st.keyPath) { // out-of-line 键必须单独存
          keys = await new Promise((res, rej) => {
            const q = st.getAllKeys();
            q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
          });
        }
        out[sn] = { rows: [], keys: keys ? keys.map(k => serializeValue(k)) : null, keyPath: st.keyPath || null };
        for (const row of rows) out[sn].rows.push(await serializeRow(row));
      } catch (e) {
        out[sn] = { __error: String(e?.message || e) };
      }
    }
    db.close();
    return out;
  }

  const skipped = [];
  async function serializeRow(row) {
    if (row && typeof row === 'object' && !(row instanceof Date)) {
      const clone = Array.isArray(row) ? [] : {};
      for (const k of Object.keys(row)) clone[k] = await serializeValue(row[k], row, k);
      return clone;
    }
    return await serializeValue(row);
  }

  async function serializeValue(v) {
    if (v instanceof Blob) {
      if (v.size > BLOB_LIMIT) { skipped.push(`blob ${v.size}B`); return { __blobSkipped: true, size: v.size, type: v.type }; }
      return { __blob: true, mime: v.type, data: await blobToBase64(v) };
    }
    if (v instanceof ArrayBuffer) {
      if (v.byteLength > BLOB_LIMIT) { skipped.push(`ab ${v.byteLength}B`); return { __blobSkipped: true, size: v.byteLength }; }
      return { __ab: true, b64: btoa(String.fromCharCode(...new Uint8Array(v))) };
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if (Array.isArray(v)) { const o = []; for (const x of v) o.push(await serializeValue(x)); return o; }
      const o = {}; for (const k of Object.keys(v)) o[k] = await serializeValue(v[k]); return o;
    }
    return v;
  }

  // ---------- IndexedDB 恢复 ----------
  async function importDb(dbName, dump) {
    if (!dump || dump.__missing) return;
    // 先打开一次拿版本号
    const probe = await new Promise((res, rej) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => { res(req.result); };
      req.onerror = () => rej(req.error);
    });
    const version = probe.version; probe.close();
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open(dbName, version);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onupgradeneeded = (e) => {
        // 目标库结构应由宿主扩展自己建；空库时按镜像的 keyPath 建出同名 store
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
        if (sd.keys) { // out-of-line：清空重放
          st.clear();
          for (let i = 0; i < sd.rows.length; i++) st.put(await deserializeValue(sd.rows[i]), await deserializeValue(sd.keys[i]));
        } else { // keyPath：put 幂等覆盖
          for (const r of sd.rows) st.put(await deserializeValue(r));
        }
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      } catch (e) { warn('import store 失败', dbName, sn, e); }
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
    for (const name of s.dbs) dbs[name] = await exportDb(name);
    const ls = {};
    if (s.lsPrefixes.length) {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (s.lsPrefixes.some(p => k.startsWith(p))) ls[k] = localStorage.getItem(k);
      }
    }
    s.mirror = { version: Date.now(), device: deviceName(s), dbs, ls, skipped: [...skipped] };
    s.lastExportVersion = s.mirror.version;
    const ctx = window.SillyTavern?.getContext?.();
    if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
    else if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
    log('镜像已导出 version=', s.mirror.version, 'skipped=', skipped.length);
    return s.mirror.version;
  }

  async function importMirror(force = false) {
    const s = getSettings(); if (!s || !s.mirror) return log('无镜像');
    const m = s.mirror;
    if (!force && m.version <= s.lastImportedVersion) return log('镜像不新于本地导入记录，跳过');
    if (m.version <= s.lastExportVersion && !force) return log('镜像来自本机最近导出，跳过');
    for (const name of Object.keys(m.dbs || {})) await importDb(name, m.dbs[name]);
    for (const [k, v] of Object.entries(m.ls || {})) localStorage.setItem(k, v);
    s.lastImportedVersion = m.version;
    const ctx = window.SillyTavern?.getContext?.();
    if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
    log('镜像已导入（来自', m.device, 'version=', m.version, '）。建议重启 TT 让各扩展重载。');
    return m.version;
  }

  // ---------- UI ----------
  function buildPanel() {
    const s = getSettings(); if (!s) return;
    const div = document.createElement('div');
    div.className = 'webview-sync-panel';
    div.innerHTML = `
      <div class="webview-sync-title">WebView 存储同步器 <span class="ws-dev">${deviceName(s)}</span></div>
      <div class="ws-row">
        <button class="ws-btn" data-act="export">导出镜像到同步</button>
        <button class="ws-btn" data-act="import">从镜像恢复(强制)</button>
      </div>
      <div class="ws-status"></div>
      <textarea class="ws-dbs" rows="3" title="每行一个 IndexedDB 库名"></textarea>
      <div class="ws-row"><label><input type="checkbox" class="ws-auto"> 随设置保存自动导出</label></div>
    `;
    const $st = div.querySelector('.ws-status');
    const $dbs = div.querySelector('.ws-dbs');
    const $auto = div.querySelector('.ws-auto');
    $dbs.value = s.dbs.join('\n');
    $auto.checked = !!s.autoExportOnSave;
    const refresh = () => {
      const m = s.mirror;
      $st.textContent = m
        ? `镜像: v${m.version} @${m.device} | 库:${Object.keys(m.dbs||{}).length} | 跳过:${(m.skipped||[]).length}项 | 上次导入:${s.lastImportedVersion || '无'}`
        : '尚无镜像';
    };
    refresh();
    div.addEventListener('click', async (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      $dbs.value.split('\n').map(x => x.trim()).filter(Boolean) && (s.dbs = $dbs.value.split('\n').map(x => x.trim()).filter(Boolean));
      if (act === 'export') { const v = await exportMirror(); refresh(); alert('镜像已导出 v' + v + (skipped.length ? `\n跳过 ${skipped.length} 个超大 blob` : '')); }
      if (act === 'import') { const v = await importMirror(true); refresh(); alert('已从镜像恢复 v' + v + '\n建议重启 TT 让各扩展重载配置'); }
    });
    $auto.addEventListener('change', () => { s.autoExportOnSave = $auto.checked; });
    // 挂到扩展菜单
    const mount = () => {
      const host = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
      if (!host) return setTimeout(mount, 1000);
      host.appendChild(div);
    };
    mount();
  }

  // ---------- 启动 ----------
  async function boot() {
    try { await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__); } catch (_) {}
    const s = getSettings();
    if (!s) return warn('宿主设置不可用，扩展待机');
    if (!s.enabled) return log('已停用');
    buildPanel();
    // 启动导入检测：TT 刚落地同步时各扩展可能已在初始化——检测到新镜像就恢复并提示重启
    setTimeout(() => importMirror(false).then(v => { if (v) alert('[WebView同步] 检测到来自其他设备的新镜像(v' + v + ')，已写入本地存储。\n建议重启 TT 让数据库/玉子手机等扩展重新加载配置。'); }), 4000);
    log('已启动', deviceName(s), '监控库:', s.dbs.join(','));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
