// 设置: 挂在 TT extensionSettings 下(随 settings.json 走 TT 自己的同步)
import { NS, DEFAULTS } from "./env.js";

export function getSettings() {
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

export function saveSettingsDebounced() {
  const ctx = window.SillyTavern?.getContext?.();
  (ctx?.saveSettingsDebounced || window.saveSettingsDebounced)?.();
}
