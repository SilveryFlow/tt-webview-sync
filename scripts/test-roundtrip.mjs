#!/usr/bin/env node
/** NDJSON 镜像往返冒烟测试(fake-indexeddb, Node 离线运行):
 *  建库写入 → exportDbNd 流式导出 → 删库 → mock fetch 喂分段文本 → importDbNd 流式导入 → 深比对。
 *  覆盖: schema 头/补建缺失 store、inline 与 out-of-line 键、中文键值、嵌套结构、
 *  ArrayBuffer 标记对象、out-of-line store 的清空语义、分段(多文件)路径。 */
// 浏览器环境最小垫片(必须在动态 import 模块前就位——log.js 在模块加载期写 window)
globalThis.window = globalThis;
globalThis.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
};
await import("fake-indexeddb/auto");

const { exportDbNd, importDbNd } = await import("../src/mirror.js");

const DB = "wvs-test-db";
let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failed++; console.error(`  ✗ ${msg}`); }
};

// ---------- 1) 建库写入 ----------
const seed = {
  meta: { store: "meta", keyPath: "id", rows: [
    { id: "m1", name: "配置A", nested: { a: [1, 2, { b: 3 }] } },
    { id: "m2", name: "配置B", tags: ["x", "中文标签"] },
    { id: "m3", name: "配置C", empty: null, flag: false },
  ] },
  kv: { store: "kv", keyPath: null, rows: [
    { k: "alpha", v: { count: 1 } },
    { k: "中文键", v: { 路径: ["斗罗", "偏航"] } },
  ] },
  blobs: { store: "blobs", keyPath: "id", rows: [
    { id: "ab1", payload: new Uint8Array([1, 2, 3, 250, 255]).buffer },
  ] },
};
await new Promise((res, rej) => {
  const q = indexedDB.open(DB, 1);
  q.onupgradeneeded = (e) => {
    const d = e.target.result;
    d.createObjectStore("meta", { keyPath: "id" });
    d.createObjectStore("kv");
    d.createObjectStore("blobs", { keyPath: "id" });
  };
  q.onsuccess = () => {
    const db = q.result;
    const tx = db.transaction(["meta", "kv", "blobs"], "readwrite");
    for (const r of seed.meta.rows) tx.objectStore("meta").put(r);
    for (const r of seed.kv.rows) tx.objectStore("kv").put(r.v, r.k);
    for (const r of seed.blobs.rows) tx.objectStore("blobs").put(r);
    tx.oncomplete = () => { db.close(); res(); };
    tx.onerror = () => rej(tx.error);
  };
  q.onerror = () => rej(q.error);
});

// ---------- 2) 流式导出 ----------
const nd = await exportDbNd(DB);
ok(!nd.err, `导出无错误${nd.err ? ": " + nd.err : ""}`);
ok(nd.rows === 6, `行数 6 (实际 ${nd.rows})`);
ok(nd.chunks.length >= 1, `段数 ${nd.chunks.length} >= 1`);
const fullText = (await Promise.all(nd.chunks.map((c) => c.text()))).join("");
const lines = fullText.split("\n").filter(Boolean);
const header = JSON.parse(lines[0]);
ok(header.__nd === 1, "首行是 schema 头");
ok(header.schema.meta === "id" && header.schema.kv === null, "schema 键映射正确");

// ---------- 3) 删库后流式导入(走 mock fetch 喂文本, 模拟分段文件) ----------
await new Promise((res) => { const q = indexedDB.deleteDatabase(DB); q.onsuccess = q.onblocked = q.onerror = () => res(); });

const HALF = Math.floor(fullText.length / 2) + 5; // 故意从行中间切开, 验证 carry 半行缓冲
let cut = fullText.indexOf("\n", HALF) + 1;
if (cut <= 0) cut = fullText.length;
const part1 = fullText.slice(0, cut);
const part2 = fullText.slice(cut);
const fileMap = { "wvs__db__wvs-test-db__c001.ndjson": part1, "wvs__db__wvs-test-db__c002.ndjson": part2 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const name = decodeURIComponent(String(url).replace("/user/files/", ""));
  if (name in fileMap) return { ok: true, status: 200, text: async () => fileMap[name] };
  return { ok: false, status: 404, text: async () => "" };
};
try {
  await importDbNd(DB, { file: "wvs__db__wvs-test-db__c001.ndjson", chunks: 2, fmt: "nd" });
} finally {
  globalThis.fetch = realFetch;
}

// ---------- 4) 深比对 ----------
const readAll = (db, store) => new Promise((res, rej) => {
  const out = [];
  const q = db.transaction(store).objectStore(store).openCursor();
  q.onsuccess = () => { const c = q.result; if (!c) return res(out); out.push({ k: c.key, v: c.value }); c.continue(); };
  q.onerror = () => rej(q.error);
});
const db2 = await new Promise((res, rej) => { const q = indexedDB.open(DB); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
const meta = await readAll(db2, "meta");
const kv = await readAll(db2, "kv");
const blobs = await readAll(db2, "blobs");
ok(meta.length === 3 && meta.every((r) => seed.meta.rows.some((s) => s.id === r.k && JSON.stringify(s) === JSON.stringify(r.v))),
  `meta 3 条深一致 (实际 ${meta.length})`);
ok(kv.length === 2 && kv.some((r) => r.k === "alpha" && r.v.count === 1) && kv.some((r) => r.k === "中文键" && r.v.路径[1] === "偏航"),
  `kv 2 条含中文键 (实际 ${kv.length})`);
const abv = blobs[0]?.v?.payload;
ok(blobs.length === 1 && abv instanceof ArrayBuffer && new Uint8Array(abv).join(",") === "1,2,3,250,255",
  "ArrayBuffer 标记对象还原");

// ---------- 5) 清空语义: out-of-line store 里的陈旧记录应被清掉 ----------
{
  const tx = db2.transaction("kv", "readwrite");
  tx.objectStore("kv").put({ stale: true }, "stale-key");
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db2.close();
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => fullText });
  try {
    await importDbNd(DB, { file: "wvs__db__wvs-test-db.ndjson", chunks: 0, fmt: "nd" });
  } finally {
    globalThis.fetch = realFetch;
  }
  const db3 = await new Promise((res, rej) => { const q = indexedDB.open(DB); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const kv2 = await readAll(db3, "kv");
  ok(!kv2.some((r) => r.k === "stale-key") && kv2.length === 2, "out-of-line store 陈旧键被清空");
  db3.close();
}

// ---------- 6) 零记录 out-of-line store: begin 后无记录 → 对端也清空 ----------
{
  const emptyText = JSON.stringify({ __nd: 1, schema: { kv: null } }) + "\n" + JSON.stringify({ s: "kv", begin: 1 }) + "\n";
  const db4 = await new Promise((res, rej) => { const q = indexedDB.open(DB); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const tx = db4.transaction("kv", "readwrite");
  tx.objectStore("kv").put({ v: 1 }, "some-key");
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db4.close();
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => emptyText });
  try {
    await importDbNd(DB, { file: "wvs__db__wvs-test-db.ndjson", chunks: 0, fmt: "nd" });
  } finally {
    globalThis.fetch = realFetch;
  }
  const db5 = await new Promise((res, rej) => { const q = indexedDB.open(DB); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const kv3 = await readAll(db5, "kv");
  ok(kv3.length === 0, "零记录 out-of-line store 被清空");
  db5.close();
}

await new Promise((res) => { const q = indexedDB.deleteDatabase(DB); q.onsuccess = q.onblocked = q.onerror = () => res(); });
if (failed) { console.error(`✗ 往返测试失败 ${failed} 项`); process.exit(1); }
console.log("✓ NDJSON 往返测试全部通过");
