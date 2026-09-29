// 动态发现: IndexedDB 库与 localStorage 键
import { getSettings } from "./settings.js";
import { error } from "./log.js";

// databases() 不可用/返回空时的探活兜底清单（历史实证过的库）
export const KNOWN_DBS = [
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
export function getLastDiscoverMode() {
  return lastDiscoverMode;
}

export function openWithTimeout(name, ms = 3000, useVersion) {
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

export async function discoverDbs() {
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

export function discoverLsKeys() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
  return out;
}

export function pickDb(s, name) {
  if (s.dbExclude.includes(name)) return false;
  if (name in s.dbPick) return !!s.dbPick[name];
  return true; // 新库默认收集
}
export function pickLs(s, k) {
  if (s.lsExclude.some((p) => k.startsWith(p))) return false;
  if (k in s.lsPick) return !!s.lsPick[k];
  return true;
}
