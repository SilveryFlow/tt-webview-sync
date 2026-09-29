// 宿主 UI 适配: toastr 通知 / Popup 确认 / 倒计时刷新
// (Tauri WebView2 会吞原生 alert/confirm，必须走宿主能力)
import { record, warn } from "./log.js";

export function toast(type, title, msg, opts = {}) {
  const t = window.SillyTavern?.getContext?.()?.toastr || window.toastr;
  if (t?.[type]) {
    t[type](msg, title, { timeOut: opts.timeOut || 5000, ...opts });
  } else {
    // toastr 不可用时的兜底(写入日志)
    record("INFO", [`[toast:${type}]`, title, msg]);
  }
}

// 倒计时刷新: toast 文本实时倒数 3→1 秒,到 0 刷新
export function countdownReload(seconds = 3) {
  const t = window.SillyTavern?.getContext?.()?.toastr || window.toastr;
  if (!t?.info) {
    setTimeout(() => location.reload(), seconds * 1000);
    return;
  }
  let remaining = seconds;
  const toastEl = t.info(`${remaining} 秒后自动刷新界面`, "WebView同步", {
    timeOut: (seconds + 1) * 1000,
    extendedTimeOut: 0,
  });
  const tick = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(tick);
      location.reload();
      return;
    }
    // toastr 返回 jQuery 包装的 DOM,直接改文本实现倒数
    try {
      const el =
        typeof toastEl?.find === "function"
          ? toastEl
          : window.jQuery
            ? window.jQuery(toastEl)
            : null;
      el?.find(".toast-message").text(`${remaining} 秒后自动刷新界面`);
    } catch (_) {}
  }, 1000);
}

// TT 原生确认弹窗(SillyTavern.getContext().Popup, 原生 confirm() 被 Tauri WebView 吞)
export async function popupConfirm(title, message) {
  try {
    const ctx = window.SillyTavern?.getContext?.();
    if (ctx?.Popup?.show?.confirm) {
      const result = await ctx.Popup.show.confirm(title, message);
      return result === 1;
    }
    if (ctx?.callGenericPopup) {
      const result = await ctx.callGenericPopup(
        message,
        1, // POPUP_TYPE.CONFIRM
      );
      return result === 1; // POPUP_RESULT.AFFIRMATIVE
    }
  } catch (e) {
    warn("Popup 不可用:", e);
  }
  return confirm(title);
}
