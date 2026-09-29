/**
 * WebView 存储同步器 v0.15.0 — 入口
 * 动态发现全部 IndexedDB 库与 localStorage 键，按库分文件写到 user/files/ 下的平铺文件
 * （wvs__ 前缀；user/files = TT「user.files」数据集，同步范围里独立可勾选，不碰 settings.json），
 * 借 TT lan_sync 同步到对端并在启动时恢复。黑名单模式：默认全收，勾掉的排除。
 * 上传走 POST /api/files/upload（TT 源码 validate_upload_name 规则：文件名禁含路径分隔符，故用前缀命名）。
 *
 * 模块结构（TT 以 type=module 加载 index.js 垫片 → 本文件）：
 *   env.js      常量与默认设置
 *   log.js      日志环形缓冲    ui.js       toastr/Popup/倒计时(宿主 UI 适配)
 *   settings.js 扩展设置读写    discover.js IndexedDB/localStorage 动态发现
 *   transfer.js user/files 上传/取回/删除 + gzip + 分卷命名
 *   serialize.js 值序列化(Blob/ArrayBuffer ↔ 标记对象)
 *   mirror.js   镜像引擎(NDJSON 流式导出/导入 + 旧格式兼容)
 *   panel.js    设置面板        main.js     启动入口(本文件)
 */
import { log, warn, error } from "./log.js";
import { countdownReload } from "./ui.js";
import { getSettings } from "./settings.js";
import { buildPanel } from "./panel.js";
import { importMirror } from "./mirror.js";

async function boot() {
  try {
    await (window.__TAURITAVERN__?.ready ??
      window.__TAURITAVERN_MAIN_READY__);
  } catch (_) {}
  const s = getSettings();
  if (!s) return warn("宿主设置不可用");
  if (!s.enabled) return log("已停用");
  await buildPanel();
  setTimeout(() => {
    // 启动安全阀: 15 秒内已刷新过就不再自动恢复(终极防循环)
    const bootGuard = Number(localStorage.getItem("wvs_boot_guard")) || 0;
    if (Date.now() - bootGuard < 15000)
      return log("启动安全阀: 距上次刷新不足 15s, 跳过自动恢复");
    localStorage.setItem("wvs_boot_guard", String(Date.now()));
    importMirror(false)
      .catch((e) => error("启动自动恢复失败:", e))
      .then((v) => {
        if (v) countdownReload(3);
      });
  }, 4000);
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
