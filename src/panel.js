// 扩展设置面板: 操作按钮 + 库/ls 勾选列表 + 状态行
import { MANIFEST_NAME } from "./env.js";
import { record, exportLog } from "./log.js";
import { toast, countdownReload, popupConfirm } from "./ui.js";
import { getSettings, saveSettingsDebounced } from "./settings.js";
import {
  discoverDbs,
  discoverLsKeys,
  openWithTimeout,
  getLastDiscoverMode,
  pickDb,
  pickLs,
} from "./discover.js";
import { deleteText, refFiles } from "./transfer.js";
import { fetchManifest, exportMirror, importMirror, skipped } from "./mirror.js";

function fmtKB(n) {
  return n >= 1048576
    ? (n / 1048576).toFixed(1) + "MB"
    : Math.max(1, Math.round(n / 1024)) + "KB";
}

export async function buildPanel() {
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

              <div class="ws-actions ws-grid3">
                <button type="button" class="menu_button ws-primary" data-act="export">
                  <i class="fa-solid fa-cloud-arrow-up"></i><span>导出镜像</span>
                </button>
                <button type="button" class="menu_button" data-act="import">
                  <i class="fa-solid fa-cloud-arrow-down"></i><span>从镜像恢复</span>
                </button>
                <button type="button" class="menu_button ws-primary" data-act="reload">
                  <i class="fa-solid fa-arrows-rotate"></i><span>刷新界面</span>
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
      // 逐库开连接查 store 清单——并行跑,25 库不用串行等 25 轮
      const infos = await Promise.all(
        names.map(async (n) => {
          try {
            const db = await openWithTimeout(n);
            const stores = [...db.objectStoreNames].join(", ");
            db.close();
            return {
              info: stores ? `(${stores.slice(0, 60)})` : "(空)",
              title: stores || "(空)",
            };
          } catch (e) {
            return {
              info: `(无法打开: ${String(e?.message || e).slice(0, 30)})`,
              title: `无法打开: ${String(e?.message || e)}`,
            };
          }
        }),
      );
      $dbl.innerHTML = "";
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        const { info, title } = infos[i];
        const row = document.createElement("label");
        row.className = "ws-item";
        const checked = pickDb(s, n);
        const excluded = s.dbExclude.includes(n);
        row.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""} ${excluded ? 'title="默认排除(缓存类)，勾选可强制同步"' : ""}> <span class="ws-name" title="${n}">${n}</span> <span class="ws-info" title="${title}">${info}</span>`;
        row.querySelector("input").addEventListener("change", (e) => {
          s.dbPick[n] = e.target.checked;
          saveSettingsDebounced();
        });
        $dbl.appendChild(row);
      }
      if ($dbMeta)
        $dbMeta.textContent = `（发现 ${names.length} 库 · ${getLastDiscoverMode()} · 勾选=同步）`;
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
      row.innerHTML = `<input type="checkbox" ${pickLs(s, k) ? "checked" : ""}> <span class="ws-name" title="${k}">${k}</span> <span class="ws-info">${fmtKB(size)}</span>`;
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
      : "尚无镜像（user/files 下的 wvs__ 文件）——点「导出镜像」生成第一份";
  };
  refresh();

  let busy = false;
  div.addEventListener("click", async (e) => {
    const act = e.target?.closest("[data-act]")?.dataset?.act;
    if (!act) return;
    if (act === "log") {
      exportLog();
      return;
    }
    if (busy) {
      toast("warning", "WebView同步", "上一个操作还在进行中");
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
        toast(
          "success",
          "镜像已导出",
          "v" +
            v +
            (skipped.length ? "，跳过 " + skipped.length + " 项" : ""),
        );
      } catch (err) {
        console.error("[webview-sync] 导出失败", err);
        record("ERROR", ["导出失败:", err]);
        toast(
          "error",
          "导出失败",
          String(err?.message || err) + "，请导出日志",
          {
            timeOut: 10000,
          },
        );
      } finally {
        if (btn && old) btn.innerHTML = old;
        busy = false;
      }
    }
    if (act === "import") {
      busy = true;
      const btn = div.querySelector('[data-act="import"]');
      const oldHtml = btn ? btn.innerHTML : null;
      if (btn)
        btn.innerHTML =
          '<i class="fa-solid fa-spinner fa-spin"></i><span>恢复中...</span>';
      try {
        const v = await importMirror(true);
        await refresh();
        if (v) {
          countdownReload(3);
        } else
          toast("info", "WebView同步", "无需导入（远端没有比本地新的镜像）");
      } catch (err) {
        console.error("[webview-sync] 恢复失败", err);
        record("ERROR", ["恢复失败:", err]);
        toast(
          "error",
          "恢复失败",
          String(err?.message || err) + "，请导出日志",
          {
            timeOut: 10000,
          },
        );
      } finally {
        if (btn && oldHtml) btn.innerHTML = oldHtml;
        busy = false;
      }
    }
    if (act === "reload") {
      location.reload();
    }
    if (act === "scan") {
      await renderLists();
      toast("success", "已重新扫描", "");
    }
    if (act === "wipe") {
      // 先检查有没有镜像,没有就直接提示
      const m = await fetchManifest();
      if (!m) {
        toast("info", "无镜像", "当前没有已导出的镜像文件");
        return;
      }
      const okToDelete = await popupConfirm(
        "删除镜像",
        "将删除 user/files 下全部镜像文件（含各库数据与清单）。\n删除会同步到其他设备；本机浏览器存储不受影响。",
      );
      if (!okToDelete) return;
      try {
        const files = new Set([MANIFEST_NAME]);
        for (const ref of Object.values(m?.exports || {}))
          for (const f of refFiles(ref)) files.add(f);
        for (const f of files) await deleteText(f);
        s.lastImportedVersion = 0;
        s.lastExportVersion = 0;
        saveSettingsDebounced();
        refresh();
        toast("success", "已删除", files.size + " 个镜像文件");
      } catch (e) {
        console.error("[webview-sync] 删除镜像失败", e);
        record("ERROR", ["删除镜像失败:", e]);
        toast("error", "删除失败", e?.message || e);
      }
    }
  });

  renderLists();
}
