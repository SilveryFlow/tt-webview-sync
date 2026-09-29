// 镜像引擎: NDJSON 流式导出/导入 + 旧格式兼容恢复
//
// v0.15 镜像格式：每库一个 NDJSON 文件(.ndjson，首行 schema 头，其后每行一条记录)，
// 导出端逐行 stringify + 按行边界组段 Blob，导入端逐段取回逐行解析分批写回——
// 双端内存峰值 ≈ 单条记录 + 单段文本，不再出现整库大字符串(撞 V8 ~536M 字符上限)。
// 旧格式(.json 整库 JSON，v0.8~v0.14)导入端永久兼容；旧版本扩展读到 .ndjson 会在
// JSON.parse 处安全失败(per-库 try/catch + 形状守卫)，不写不删不损坏本机数据。
import { CHUNK_SIZE, MANIFEST_NAME } from "./env.js";
import { log, warn, error } from "./log.js";
import { getSettings, saveSettingsDebounced } from "./settings.js";
import {
  discoverDbs,
  discoverLsKeys,
  getLastDiscoverMode,
  openWithTimeout,
  pickDb,
  pickLs,
} from "./discover.js";
import {
  uploadText,
  uploadBlob,
  deleteText,
  fetchText,
  ndFileName,
  refFiles,
} from "./transfer.js";
import {
  serializeValue,
  serializePlain,
  deserializeValue,
} from "./serialize.js";

export const skipped = []; // 最近一次导出被跳过的项(面板提示用)

// 分段并行上传池(压缩与传输重叠, gzip 走原生线程池)
const UPLOAD_PARALLEL = 3;
async function runPool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const idx = next++;
        await fn(items[idx], idx);
      }
    }),
  );
}

export async function exportDbNd(dbName) {
  // NDJSON 流式导出。行协议：
  //   {"__nd":1,"schema":{store:keyPath|null}}   首行 schema 头
  //   {"s":store,"begin":1}                      store 开始(导入端据此预清 out-of-line store)
  //   {"s":store,"k":key|null,"r":value}         一条记录
  //   {"s":store,"err":"..."}                    源端读该 store 失败(导入端跳过不写)
  let db;
  try {
    db = await openWithTimeout(dbName, 5000);
  } catch (e) {
    return { err: "open失败: " + String(e?.message || e) };
  }
  const storeNames = [...db.objectStoreNames];
  const schema = {};
  if (storeNames.length) {
    const tx = db.transaction(storeNames, "readonly");
    for (const sn of storeNames) schema[sn] = tx.objectStore(sn).keyPath || null;
  }
  // 按行边界组段：段内永远是完整行，导入端无需跨段拼行
  const parts = [];
  let partsLen = 0;
  let total = 0;
  const chunks = [];
  const emit = (line) => {
    parts.push(line);
    partsLen += line.length;
    total += line.length;
    if (partsLen >= CHUNK_SIZE) {
      chunks.push(new Blob(parts));
      parts.length = 0;
      partsLen = 0;
    }
  };
  emit(JSON.stringify({ __nd: 1, schema }) + "\n");
  let rows = 0;
  for (const sn of storeNames) {
    try {
      emit(JSON.stringify({ s: sn, begin: 1 }) + "\n");
      // getAll/getAllKeys 批量读(引擎级,一次请求取整 store,远快于逐行游标);
      // 两个请求在事务回调外同步发出、oncomplete 一次性收——事务内零 await
      // (Blob 行的 FileReader 是宏任务,真浏览器里事务会先自动提交,
      //  之后 cur.continue() 抛 TransactionInactiveError 且被吞=永久悬挂,v0.15.2 实证)。
      // 值是结构化克隆副本,事务提交后仍有效,可从容逐行序列化。
      const { vals, keys } = await new Promise((resolve, reject) => {
        const tx = db.transaction(sn, "readonly");
        const st = tx.objectStore(sn);
        const vq = st.getAll();
        const kq = st.keyPath ? null : st.getAllKeys();
        tx.oncomplete = () => resolve({ vals: vq.result, keys: kq?.result });
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("事务中止"));
      });
      const outOfLine = schema[sn] === null;
      for (let i = 0; i < vals.length; i++) {
        emit(
          JSON.stringify({
            s: sn,
            k: outOfLine ? serializePlain(keys[i]) : null,
            r: await serializeValue(vals[i]),
          }) + "\n",
        );
        rows++;
      }
    } catch (e) {
      // begin 已发出则对端可能已写入部分行——记 err 行让对端停写该 store，下次导出自愈
      error("读取 store 失败:", dbName, sn, e);
      emit(JSON.stringify({ s: sn, err: String(e?.message || e) }) + "\n");
    }
  }
  if (parts.length) chunks.push(new Blob(parts));
  db.close();
  return { schema, chunks, total, rows };
}

export async function exportMirror() {
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
    getLastDiscoverMode(),
  );
  const ls = {};
  for (const k of discoverLsKeys())
    if (pickLs(s, k)) ls[k] = localStorage.getItem(k);

  // 先写数据文件，最后写清单（清单=提交点；对端只见新清单即视为新镜像）
  // 旧清单留底：提交后清理它引用、新清单不再引用的孤儿文件（旧格式遗留 / 分段数收缩的尾巴）
  const prevManifest = await fetchManifest();
  const exports = {};
  for (const name of picked) {
    log("导出库:", name);
    const nd = await exportDbNd(name);
    if (nd.err) {
      warn(`库 ${name} ${nd.err}，跳过`);
      skipped.push(`db ${name} ${nd.err}`);
      continue;
    }
    const kb = Math.round(nd.total / 1024);
    const limitKb = Math.max(0, Number(s.dbLimitMb) || 0) * 1024;
    if (limitKb > 0 && nd.total > limitKb * 1024) {
      warn(`库 ${name} 序列化后 ${kb}KB 超过单库上限 ${s.dbLimitMb}MB,跳过`);
      skipped.push(`db ${name} ${kb}KB`);
      continue;
    }
    log(
      "库",
      name,
      "流式序列化完成",
      kb,
      "KB,",
      nd.rows,
      "行,",
      nd.chunks.length,
      "段",
    );
      if (nd.chunks.length <= 1) {
        await uploadBlob(ndFileName(name), nd.chunks[0]);
        exports[name] = { file: ndFileName(name), chunks: 0, fmt: "nd" };
      } else {
        await runPool(
          nd.chunks,
          UPLOAD_PARALLEL,
          async (chunk, ci) => {
            await uploadBlob(ndFileName(name, ci + 1), chunk);
            log(`库 ${name} 分段 ${ci + 1}/${nd.chunks.length} 上传完成`);
          },
        );
        exports[name] = {
          file: ndFileName(name, 1),
          chunks: nd.chunks.length,
          fmt: "nd",
        };
      }
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
    }),
  );
  // 孤儿清理：失败只警告——残留文件无害(无清单引用)，下次导出再试
  try {
    const live = new Set();
    for (const ref of Object.values(exports)) live.add(...refFiles(ref));
    const stale = new Set();
    for (const ref of Object.values(prevManifest?.exports || {}))
      for (const f of refFiles(ref)) if (!live.has(f)) stale.add(f);
    for (const f of stale) {
      await deleteText(f);
      log("清理旧镜像文件:", f);
    }
  } catch (e) {
    warn("清理旧镜像文件失败(不影响本次导出):", e);
  }

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

export async function fetchManifest() {
  try {
    return JSON.parse(await fetchText(MANIFEST_NAME));
  } catch (e) {
    error("读取镜像清单失败:", e);
    return null;
  }
}

// 旧格式恢复(v0.8~v0.14 整库 JSON dump)：形状守卫保证错误数据不落库
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

export async function importDbNd(dbName, ref) {
  // NDJSON 流式恢复：逐段取回、逐行 parse、分批事务写回。
  // 内存峰值 ≈ 单段文本(CHUNK_SIZE) + 单批记录，不再拼接整库字符串。
  // 反序列化(Blob 重建)在行处理阶段完成——事务内不做任何 await，防止 IndexedDB 自动提交。
  const files = refFiles(ref);
  const schema = {};
  let db = null;
  let curStore = null;
  let batch = [];
  let rows = 0;
  const begun = new Set();
  const cleared = new Set();
  const deadStores = new Set();
  const BATCH = 500;

  const txDone = (tx) =>
    new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error("事务中止"));
    });

  const flush = async () => {
    if (!batch.length) return;
    const sn = curStore;
    const tx = db.transaction(sn, "readwrite");
    const st = tx.objectStore(sn);
    if (schema[sn] === null && !cleared.has(sn)) {
      st.clear(); // 与旧格式语义一致：out-of-line store 全量替换
      cleared.add(sn);
    }
    for (const rec of batch) {
      if (rec.k === null) st.put(rec.v);
      else st.put(rec.v, rec.k);
    }
    await txDone(tx);
    rows += batch.length;
    batch = [];
  };

  const handleLine = async (line) => {
    const obj = JSON.parse(line);
    if (obj.__nd) {
      // schema 头：打开库并补建缺失 store（旧版 importDb 固定原版本号，升级回调实际不触发，此处修正）
      Object.assign(schema, obj.schema || {});
      const probe = await openWithTimeout(dbName);
      const known = [...probe.objectStoreNames];
      const ver = probe.version;
      probe.close();
      const need = Object.keys(schema).filter((sn) => !known.includes(sn));
      db = await new Promise((res, rej) => {
        const q = indexedDB.open(dbName, need.length ? ver + 1 : ver);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
        q.onblocked = () => rej(new Error("open 被占用"));
        q.onupgradeneeded = (e) => {
          const d = e.target.result;
          for (const sn of Object.keys(schema)) {
            if (d.objectStoreNames.contains(sn)) continue;
            const kp = schema[sn];
            if (kp) d.createObjectStore(sn, { keyPath: kp });
            else d.createObjectStore(sn);
          }
        };
      });
    } else if (obj.begin) {
      if (obj.s !== curStore) {
        await flush();
        curStore = obj.s;
      }
      begun.add(obj.s);
    } else if (obj.err) {
      await flush(); // 缓冲中的行属于源端读取失败前的有效数据，先落盘
      deadStores.add(obj.s);
      curStore = null;
    } else {
      if (deadStores.has(obj.s)) return;
      if (obj.s !== curStore) {
        await flush();
        curStore = obj.s;
      }
      const v = await deserializeValue(obj.r);
      batch.push({ k: obj.k ?? null, v });
      if (batch.length >= BATCH) await flush();
    }
  };

  let carry = ""; // 防御：段边界未对齐行时的半行缓冲
  for (const fn of files) {
    const text = carry + (await fetchText(fn));
    const lines = text.split("\n");
    carry = text.endsWith("\n") ? "" : lines.pop() ?? "";
    for (const line of lines) if (line) await handleLine(line);
  }
  if (carry.trim()) await handleLine(carry);
  await flush();
  // begin 过但零记录的 out-of-line store：源端已清空，对端同步清空
  for (const sn of begun) {
    if (
      schema[sn] === null &&
      !cleared.has(sn) &&
      db.objectStoreNames.contains(sn)
    ) {
      const tx = db.transaction(sn, "readwrite");
      tx.objectStore(sn).clear();
      await txDone(tx);
      cleared.add(sn);
    }
  }
  db.close();
  log("库", dbName, "流式恢复完成", rows, "行,", files.length, "段");
}

export async function importMirror(force = false) {
  const s = getSettings();
  if (!s) return log("设置不可用");
  const m = await fetchManifest();
  if (!m) return log("远端无镜像清单");
  // 防刷新死循环: localStorage 跨刷新可靠(不用 settings 里的版本号——它会随 settings.json 同步到新设备导致误挡)
  const importedV = Number(localStorage.getItem("wvs_imported_v")) || 0;
  if (!force && m.version <= importedV)
    return log("已导入过 v" + importedV + "，跳过");
  // 冷却期: 距上次导入不足 30 秒不再触发(防循环兜底)
  const lastTs = Number(localStorage.getItem("wvs_last_import_ts")) || 0;
  if (!force && Date.now() - lastTs < 30000)
    return log("冷却期内,跳过自动恢复");
  for (const [name, ref] of Object.entries(m.exports || {})) {
    try {
      if (typeof ref === "string") {
        // v0.7 兼容(旧 manifest 导出值是文件名)
        await importDb(name, JSON.parse(await fetchText(ref)));
      } else if (ref.fmt === "nd") {
        await importDbNd(name, ref);
      } else {
        // v0.8~v0.14 旧格式：整库 JSON 分段文件，拼接后一次 parse
        const files = refFiles(ref);
        const json = [];
        for (const fn of files) json.push(await fetchText(fn));
        const text = json.join("");
        if (files.length > 1)
          log(
            `库 ${name} 分段 ${files.length} 拼接完成`,
            Math.round(text.length / 1024),
            "KB",
          );
        await importDb(name, JSON.parse(text));
      }
    } catch (e) {
      error("恢复库失败:", name, e);
    }
  }
  for (const [k, v] of Object.entries(m.ls || {})) localStorage.setItem(k, v);
  s.lastImportedVersion = m.version;
  localStorage.setItem("wvs_imported_v", String(m.version));
  localStorage.setItem("wvs_last_import_ts", String(Date.now()));
  saveSettingsDebounced();
  log("镜像已恢复（来自", m.device, "v", m.version, "），建议重启 TT");
  return m.version;
}
