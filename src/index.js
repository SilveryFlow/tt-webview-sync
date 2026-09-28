/**
 * WebView 存储同步器 v0.6.0 — 独立同步项版
 * 动态发现全部 IndexedDB 库与 localStorage 键，按库分文件写到 user/files/ 下的平铺文件
 * （wvs__ 前缀；user/files = TT「user.files」数据集，同步范围里独立可勾选，不碰 settings.json），
 * 借 TT lan_sync 同步到对端并在启动时恢复。黑名单模式：默认全收，勾掉的排除。
 * 上传走 POST /api/files/upload（TT 源码 validate_upload_name 规则：文件名禁含路径分隔符，故用前缀命名）。
 */
(() => {
  "use strict";
  const NS = "webviewSync";
  const PREFIX = "wvs__"; // user/files 下的镜像文件前缀（API 禁止子目录，用前缀代替）
  const MANIFEST_NAME = PREFIX + "manifest.json";
  const API_UPLOAD = "/api/files/upload";
  const API_DELETE = "/api/files/delete";
  const FILE_BASE = "/user/files/";

  const DEFAULTS = {
    enabled: true,
    deviceId: "",
    // 动态发现结果的选择表：{ '<库名或ls键>': true/false }。发现新库默认 true（排除表里的除外）
    dbPick: {},
    lsPick: {},
    // 默认排除（纯缓存/可再生）
    dbExclude: [],
    lsExclude: [],
    blobLimitKb: 0, // 单 Blob 上限(KB)，0=不限制
    autoExportOnSave: false,
    lastImportedVersion: 0,
    lastExportVersion: 0,
  };

  // ---------- 日志环形缓冲(用户可导出) ----------
  const LOG_MAX = 500;
  const logBuf = [];
  function record(level, args) {
    logBuf.push(
      `[${new Date().toISOString()}] [${level}] ` +
        args
          .map((a) => {
            if (a instanceof Error) return a.stack || String(a);
            if (typeof a === "object") {
              try {
                return JSON.stringify(a).slice(0, 200);
              } catch (_) {
                return String(a);
              }
            }
            return String(a);
          })
          .join(" "),
    );
    if (logBuf.length > LOG_MAX) logBuf.shift();
  }
  const log = (...a) => {
    record("INFO", a);
    console.log("[webview-sync]", ...a);
  };
  const warn = (...a) => {
    record("WARN", a);
    console.warn("[webview-sync]", ...a);
  };
  const error = (...a) => {
    record("ERROR", a);
    console.error("[webview-sync]", ...a);
  };
  function exportLog() {
    const text = logBuf.join("\n") || "(无日志)";
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "webview-sync-log.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return text.split("\n").length;
  }
  window.__webviewSyncExportLog = exportLog;

  function getSettings() {
    const es =
      window.SillyTavern?.getContext?.()?.extensionSettings ||
      window.extension_settings;
    if (!es) return null;
    if (!es[NS]) es[NS] = {};
    // 结构演进迁移：用默认值补齐缺失字段（不覆盖已有值），并清掉已废弃的旧字段
    const cur = es[NS];
    for (const k of Object.keys(DEFAULTS))
      if (!(k in cur)) cur[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
    for (const k of ["mirror", "dbs", "lsPrefixes"]) delete cur[k];
    if (!cur.deviceId)
      cur.deviceId = "dev-" + Math.random().toString(36).slice(2, 8);
    return cur;
  }

  function saveSettingsDebounced() {
    const ctx = window.SillyTavern?.getContext?.();
    (ctx?.saveSettingsDebounced || window.saveSettingsDebounced)?.();
  }

  // ---------- 动态发现 ----------
  // databases() 不可用/返回空时的探活兜底清单（历史实证过的库）
  const KNOWN_DBS = [
    "yuzi-phone-qq-v2",
    "yuzi-phone-appearance-assets",
    "yuzi-phone-appearance-packs",
    "yuzi-phone-template-workshop-v2",
    "yuzi-phone-table-image-ownership",
    "yuzi-phone-cache",
    "shujuku_v120_config_v1",
    "douluo-main-text-assets",
    "wn_phone_media_v1",
    "chatu8_config_images",
    "baibai_image_vibes",
  ];
  let lastDiscoverMode = "未扫描";

  function openWithTimeout(name, ms = 3000, useVersion) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          fn(arg);
        }
      };
      const q =
        useVersion === undefined
          ? indexedDB.open(name)
          : indexedDB.open(name, useVersion);
      const t = setTimeout(() => done(reject, new Error("open 超时")), ms);
      q.onsuccess = () => done(resolve, q.result);
      q.onerror = () => done(reject, q.error);
      q.onblocked = () => done(reject, new Error("open 被占用"));
    });
  }

  async function probeDb(name) {
    try {
      const db = await openWithTimeout(name);
      db.close();
      return true;
    } catch (e) {
      error("探活失败:", name, e);
      return false;
    }
  }

  async function discoverDbs() {
    // 首选：原生枚举
    if (typeof indexedDB.databases === "function") {
      try {
        const list = (await indexedDB.databases())
          .map((d) => d.name)
          .filter(Boolean);
        if (list.length) {
          lastDiscoverMode = "databases()";
          return list;
        }
        lastDiscoverMode = "databases()空,探活兜底";
      } catch (e) {
        lastDiscoverMode = "databases()异常,探活兜底";
        error("databases() 失败", e);
      }
    } else {
      lastDiscoverMode = "无databases(),探活兜底";
    }
    // 兜底：已知清单 + 已选键 逐个探活
    const candidates = [
      ...new Set([...KNOWN_DBS, ...Object.keys(getSettings()?.dbPick || {})]),
    ];
    const found = [];
    for (const n of candidates) if (await probeDb(n)) found.push(n);
    return found;
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
    if (s.lsExclude.some((p) => k.startsWith(p))) return false;
    if (k in s.lsPick) return !!s.lsPick[k];
    return true;
  }

  // ---------- 文件层（user/files → user.files 数据集） ----------
  function reqHeaders() {
    const ctx = window.SillyTavern?.getContext?.();
    return ctx?.getRequestHeaders?.() || {};
  }
  async function uploadText(name, text) {
    const r = await fetch(API_UPLOAD, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...reqHeaders() },
      body: JSON.stringify({
        name,
        data: btoa(unescape(encodeURIComponent(text))),
      }),
    });
    if (!r.ok)
      throw new Error(
        "upload " +
          name +
          " -> " +
          r.status +
          ": " +
          (await r.text()).slice(0, 200),
      );
  }
  async function deleteText(fileName) {
    const r = await fetch(API_DELETE, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...reqHeaders() },
      body: JSON.stringify({ path: "/user/files/" + fileName }),
    });
    if (!r.ok && r.status !== 404)
      throw new Error("delete " + fileName + " -> " + r.status);
  }
  async function fetchText(fileName) {
    const r = await fetch(FILE_BASE + encodeURIComponent(fileName), {
      cache: "no-store",
    });
    if (!r.ok) throw new Error("fetch " + fileName + " -> " + r.status);
    return await r.text();
  }
  function dbFileName(dbName) {
    return PREFIX + "db__" + dbName.replace(/[^A-Za-z0-9_.-]/g, "_") + ".json";
  }

  // ---------- 序列化 ----------
  const skipped = [];
  const blobLimit = () =>
    Math.max(0, Number(getSettings()?.blobLimitKb) || 0) * 1024;

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
      if (limit > 0 && v.size > limit) {
        skipped.push(`blob ${v.size}B`);
        return { __blobSkipped: true, size: v.size, type: v.type };
      }
      return { __blob: true, mime: v.type, data: await blobToBase64(v) };
    }
    if (v instanceof ArrayBuffer) {
      const limit = blobLimit();
      if (limit > 0 && v.byteLength > limit) {
        skipped.push(`ab ${v.byteLength}B`);
        return { __blobSkipped: true, size: v.byteLength };
      }
      return {
        __ab: true,
        b64: btoa(String.fromCharCode(...new Uint8Array(v))),
      };
    }
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if (Array.isArray(v)) {
        const o = [];
        for (const x of v) o.push(await serializeValue(x));
        return o;
      }
      const o = {};
      for (const k of Object.keys(v)) o[k] = await serializeValue(v[k]);
      return o;
    }
    return v;
  }

  async function exportDb(dbName) {
    let db;
    try {
      db = await openWithTimeout(dbName, 5000);
    } catch (e) {
      error("打开库失败(跳过):", dbName, e);
      return { __missing: String(e?.message || e) };
    }
    const out = {};
    for (const sn of [...db.objectStoreNames]) {
      try {
        const tx = db.transaction(sn, "readonly");
        const st = tx.objectStore(sn);
        const rows = await new Promise((res, rej) => {
          const q = st.getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        let keys = null;
        if (!st.keyPath) {
          keys = await new Promise((res, rej) => {
            const q = st.getAllKeys();
            q.onsuccess = () => res(q.result);
            q.onerror = () => rej(q.error);
          });
        }
        out[sn] = {
          rows: [],
          keys: keys ? keys.map((k) => serializePlain(k)) : null,
          keyPath: st.keyPath || null,
        };
        for (const row of rows) out[sn].rows.push(await serializeValue(row));
      } catch (e) {
        error("读取 store 失败:", dbName, sn, e);
        out[sn] = { __error: String(e?.message || e) };
      }
    }
    db.close();
    return out;
  }

  function serializePlain(v) {
    // out-of-line 键通常是字符串/数字
    if (v instanceof Blob || v instanceof ArrayBuffer) return String(v);
    return v;
  }

  async function importDb(dbName, dump) {
    if (!dump || dump.__missing) return;
    const probe = await openWithTimeout(dbName);
    const version = probe.version;
    probe.close();
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open(dbName, version);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error("open 被占用"));
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
      if (
        sd.__error ||
        !Array.isArray(sd.rows) ||
        !db.objectStoreNames.contains(sn)
      )
        continue;
      try {
        const tx = db.transaction(sn, "readwrite");
        const st = tx.objectStore(sn);
        if (sd.keys) {
          st.clear();
          for (let i = 0; i < sd.rows.length; i++)
            st.put(await deserializeValue(sd.rows[i]), sd.keys[i]);
        } else {
          for (const r of sd.rows) st.put(await deserializeValue(r));
        }
        await new Promise((res, rej) => {
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
      } catch (e) {
        error("恢复 store 失败:", dbName, sn, e);
      }
    }
    db.close();
  }

  async function deserializeValue(v) {
    if (v && typeof v === "object") {
      if (v.__blob) {
        const b64 = v.data.split(",")[1];
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
      if (Array.isArray(v)) {
        const o = [];
        for (const x of v) o.push(await deserializeValue(x));
        return o;
      }
      const o = {};
      for (const k of Object.keys(v)) o[k] = await deserializeValue(v[k]);
      return o;
    }
    return v;
  }

  // ---------- 导出 / 导入 ----------
  async function exportMirror() {
    const s = getSettings();
    if (!s) throw new Error("设置不可用");
    skipped.length = 0;
    log("导出开始...");
    const found = await discoverDbs();
    const picked = found.filter((n) => pickDb(s, n));
    log(
      "发现",
      found.length,
      "库, 勾选",
      picked.length,
      "| 模式:",
      lastDiscoverMode,
    );
    const ls = {};
    for (const k of discoverLsKeys())
      if (pickLs(s, k)) ls[k] = localStorage.getItem(k);

    // 先写数据文件，最后写清单（清单=提交点；对端只见新清单即视为新镜像）
    const exports = {};
    for (const name of picked) {
      log("导出库:", name);
      const dump = await exportDb(name);
      const json = JSON.stringify(dump);
      log("库", name, "序列化完成", Math.round(json.length / 1024), "KB");
      await uploadText(dbFileName(name), json);
      exports[name] = dbFileName(name);
    }
    const version = Date.now();
    await uploadText(
      MANIFEST_NAME,
      JSON.stringify({
        version,
        device: s.deviceId,
        exports,
        ls,
        skipped: [...skipped],
        blobLimitKb: s.blobLimitKb,
      }),
    );

    s.lastExportVersion = version;
    s.lastImportedVersion = version; // 本机导出即本机最新
    saveSettingsDebounced();
    log(
      "镜像已导出 v",
      version,
      "| 库:",
      picked.length,
      "| ls键:",
      Object.keys(ls).length,
      "| 跳过:",
      skipped.length,
    );
    return version;
  }

  async function fetchManifest() {
    try {
      return JSON.parse(await fetchText(MANIFEST_NAME));
    } catch (e) {
      error("读取镜像清单失败:", e);
      return null;
    }
  }

  async function importMirror(force = false) {
    const s = getSettings();
    if (!s) return log("设置不可用");
    const m = await fetchManifest();
    if (!m) return log("远端无镜像清单");
    if (
      !force &&
      (m.version <= s.lastImportedVersion || m.version <= s.lastExportVersion)
    )
      return log("无需导入");
    for (const [name, file] of Object.entries(m.exports || {})) {
      try {
        const dump = JSON.parse(await fetchText(file));
        await importDb(name, dump);
      } catch (e) {
        error("恢复库失败:", name, e);
      }
    }
    for (const [k, v] of Object.entries(m.ls || {})) localStorage.setItem(k, v);
    s.lastImportedVersion = m.version;
    saveSettingsDebounced();
    log("镜像已恢复（来自", m.device, "v", m.version, "），建议重启 TT");
    return m.version;
  }

  // ---------- 面板 ----------
  function fmtKB(n) {
    return n >= 1048576
      ? (n / 1048576).toFixed(1) + "MB"
      : Math.max(1, Math.round(n / 1024)) + "KB";
  }

  async function buildPanel() {
    const s = getSettings();
    if (!s) return;

    const html = `
      <div id="webview-sync-panel" class="extension_settings">
        <div class="inline-drawer">
          <div class="inline-drawer-toggle inline-drawer-header">
            <b>WebView 存储同步器</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
          </div>
          <div class="inline-drawer-content" style="display:none;">
            <div style="padding: 10px; display: flex; flex-direction: column; gap: 10px;">

              <div class="ws-actions ws-grid2">
                <button type="button" class="menu_button ws-primary" data-act="export">
                  <i class="fa-solid fa-cloud-arrow-up"></i><span>导出镜像到同步</span>
                </button>
                <button type="button" class="menu_button" data-act="import">
                  <i class="fa-solid fa-cloud-arrow-down"></i><span>从镜像恢复(强制)</span>
                </button>
              </div>
              <div class="ws-actions ws-grid3">
                <button type="button" class="menu_button" data-act="scan">
                  <i class="fa-solid fa-rotate"></i><span>重新扫描</span>
                </button>
                <button type="button" class="menu_button" data-act="log">
                  <i class="fa-solid fa-file-export"></i><span>导出日志</span>
                </button>
                <button type="button" class="menu_button ws-danger" data-act="wipe">
                  <i class="fa-solid fa-trash-can"></i><span>删除镜像</span>
                </button>
              </div>

              <div class="ws-status text_pole">尚无镜像</div>

              <div>
                <div class="ws-sec"><i class="fa-solid fa-database"></i> IndexedDB 库 <small class="ws-sub ws-dbmeta">（扫描中…）</small></div>
                <div class="ws-list ws-dblist"></div>
              </div>

              <div>
                <div class="ws-sec"><i class="fa-solid fa-key"></i> localStorage <small class="ws-sub">（动态发现 · 勾选=同步）</small></div>
                <div class="ws-list ws-lslist"></div>
              </div>

              <div class="ws-options">
                <label class="checkbox_label">
                  <input type="checkbox" class="ws-auto"><span>随设置保存自动导出</span>
                </label>
                <label class="checkbox_label">
                  <span>单文件上限(KB)</span>
                  <input type="number" class="ws-limit text_pole" style="width:70px;" min="0">
                </label>
              </div>

            </div>
          </div>
        </div>
      </div>`;

    const container =
      document.getElementById("extensions_settings") ||
      document.getElementById("extensions_settings2");
    if (!container) return setTimeout(() => buildPanel(), 1000);
    const old = document.getElementById("webview-sync-panel");
    old?.remove();
    container.insertAdjacentHTML("beforeend", html);

    const div = document.getElementById("webview-sync-panel");
    const $ = (q) => div.querySelector(q);
    const $st = $(".ws-status"),
      $dbl = $(".ws-dblist"),
      $lsl = $(".ws-lslist");

    // 折叠开合（学玉子面板）
    const $header = $(`#${"webview-sync-panel"} .inline-drawer-header`); // eslint-disable-line
    const hdr = div.querySelector(".inline-drawer-header");
    const content = div.querySelector(".inline-drawer-content");
    const icon = div.querySelector(".inline-drawer-icon");
    hdr.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.jQuery) {
        if (content.style.display === "none") {
          window.jQuery(content).slideDown(200);
          icon.className = "inline-drawer-icon fa-solid fa-circle-chevron-up";
        } else {
          window.jQuery(content).slideUp(200);
          icon.className = "inline-drawer-icon fa-solid fa-circle-chevron-down";
        }
      } else {
        content.style.display = content.style.display === "none" ? "" : "none";
      }
    });

    async function renderLists() {
      const $dbMeta = div.querySelector(".ws-dbmeta");
      try {
        if ($dbMeta) $dbMeta.textContent = "（扫描中…）";
        const names = await discoverDbs();
        $dbl.innerHTML = "";
        for (const n of names) {
          const row = document.createElement("label");
          row.className = "ws-item";
          const checked = pickDb(s, n);
          const excluded = s.dbExclude.includes(n);
          let info = "";
          try {
            const db = await openWithTimeout(n);
            info = [...db.objectStoreNames].join(",");
            db.close();
            info = info ? `(${info.slice(0, 60)})` : "(空)";
          } catch (e) {
            info = `(无法打开: ${String(e?.message || e).slice(0, 30)})`;
          }
          row.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""} ${excluded ? 'title="默认排除(缓存类)，勾选可强制同步"' : ""}> <span class="ws-name">${n}</span> <span class="ws-info">${info}</span>`;
          row.querySelector("input").addEventListener("change", (e) => {
            s.dbPick[n] = e.target.checked;
            saveSettingsDebounced();
          });
          $dbl.appendChild(row);
        }
        if ($dbMeta)
          $dbMeta.textContent = `（发现 ${names.length} 库 · ${lastDiscoverMode} · 勾选=同步）`;
      } catch (e) {
        if ($dbMeta)
          $dbMeta.textContent = `（扫描失败: ${String(e?.message || e).slice(0, 80)}）`;
        console.error("[webview-sync] 扫描失败", e);
        return;
      }
      $lsl.innerHTML = "";
      const keys = discoverLsKeys().sort();
      for (const k of keys) {
        const row = document.createElement("label");
        row.className = "ws-item";
        const size = (localStorage.getItem(k) || "").length;
        row.innerHTML = `<input type="checkbox" ${pickLs(s, k) ? "checked" : ""}> <span class="ws-name">${k.length > 48 ? k.slice(0, 45) + "…" : k}</span> <span class="ws-info">${fmtKB(size)}</span>`;
        row.querySelector("input").addEventListener("change", (e) => {
          s.lsPick[k] = e.target.checked;
          saveSettingsDebounced();
        });
        $lsl.appendChild(row);
      }
    }

    const refresh = async () => {
      const m = await fetchManifest();
      $st.textContent = m
        ? `镜像 v${m.version} @${m.device} · 库 ${Object.keys(m.exports || {}).length} · ls ${Object.keys(m.ls || {}).length} · 跳过 ${(m.skipped || []).length} · 本机已同步 ${s.lastImportedVersion || "无"}`
        : "尚无镜像（user/files 下的 wvs__ 文件）——点「导出镜像到同步」生成第一份";
    };
    refresh();
    $(".ws-limit").value = s.blobLimitKb;
    $(".ws-limit").addEventListener("change", (e) => {
      s.blobLimitKb = Math.max(0, Number(e.target.value) || 0);
    });
    $(".ws-auto").checked = !!s.autoExportOnSave;
    $(".ws-auto").addEventListener("change", (e) => {
      s.autoExportOnSave = e.target.checked;
    });

    let busy = false;
    div.addEventListener("click", async (e) => {
      const act = e.target?.closest("[data-act]")?.dataset?.act;
      if (!act) return;
      if (act === "log") {
        exportLog();
        return;
      }
      if (busy) {
        alert("[WebView同步] 上一个操作还在进行中，请等它完成");
        return;
      }
      if (act === "export") {
        busy = true;
        const btn = div.querySelector('[data-act="export"]');
        const old = btn ? btn.innerHTML : null;
        if (btn)
          btn.innerHTML =
            '<i class="fa-solid fa-spinner fa-spin"></i><span>导出中...</span>';
        try {
          const v = await exportMirror();
          await refresh();
          alert(
            "镜像已导出 v" +
              v +
              (skipped.length ? "\n跳过 " + skipped.length + " 个大文件" : ""),
          );
        } catch (err) {
          console.error("[webview-sync] 导出失败", err);
          record("ERROR", ["导出失败:", err]);
          alert(
            "导出失败: " +
              (err?.message || err) +
              "\n请点「导出日志」并把文件发给开发者",
          );
        } finally {
          if (btn && old) btn.innerHTML = old;
          busy = false;
        }
      }
      if (act === "import") {
        const v = await importMirror(true);
        refresh();
        if (
          v &&
          confirm(
            "[WebView同步] 已从镜像恢复 v" +
              v +
              ".\n立即刷新界面让各扩展重新加载配置?\n(取消=稍后自行刷新,期间各扩展可能仍用旧数据)",
          )
        )
          location.reload();
      }
      if (act === "scan") {
        await renderLists();
        alert("已重新扫描");
      }
      if (act === "wipe") {
        if (
          !confirm(
            "删除已导出的全部镜像文件（user/files 下的 wvs__*.json）？\n下次 TT 同步会把删除同步到其他设备（它们的镜像也会消失，本地 IndexedDB 数据不受影响）。",
          )
        )
          return;
        try {
          const m = await fetchManifest();
          const files = Object.values(m?.exports || {});
          if (m) files.push(MANIFEST_NAME);
          for (const f of files) await deleteText(f);
          s.lastImportedVersion = 0;
          s.lastExportVersion = 0;
          saveSettingsDebounced();
          refresh();
          alert("已删除 " + files.length + " 个镜像文件");
        } catch (e) {
          error("删除镜像失败:", e);
          alert("删除失败: " + (e?.message || e));
        }
      }
    });

    renderLists();
  }

  // ---------- 启动 ----------
  async function boot() {
    try {
      await (window.__TAURITAVERN__?.ready ??
        window.__TAURITAVERN_MAIN_READY__);
    } catch (_) {}
    const s = getSettings();
    if (!s) return warn("宿主设置不可用");
    if (!s.enabled) return log("已停用");
    await buildPanel();
    setTimeout(
      () =>
        importMirror(false)
          .catch((e) => error("启动自动恢复失败:", e))
          .then((v) => {
            if (
              v &&
              confirm(
                "[WebView同步] 检测到来自其他设备的新镜像(v" +
                  v +
                  ")，已写入本地存储。\n立即刷新界面让各扩展重新加载配置？\n（取消=稍后自行刷新，期间各扩展可能仍用旧数据）",
              )
            )
              location.reload();
          }),
      4000,
    );
    log(
      "已启动(动态收集模式)",
      s.deviceId,
      "| databases():",
      typeof indexedDB.databases,
      "| localStorage键数:",
      localStorage.length,
    );
    if (typeof indexedDB.databases !== "function") {
      warn("本环境无 indexedDB.databases()，将使用探活兜底清单");
    }
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
