// 日志环形缓冲(用户可导出) + 控制台镜像
const LOG_MAX = 500;
const logBuf = [];

export function record(level, args) {
  logBuf.push(
    `[${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false })}] [${level}] ` +
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

export const log = (...a) => {
  record("INFO", a);
  console.log("[webview-sync]", ...a);
};
export const warn = (...a) => {
  record("WARN", a);
  console.warn("[webview-sync]", ...a);
};
export const error = (...a) => {
  record("ERROR", a);
  console.error("[webview-sync]", ...a);
};

export function exportLog() {
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
