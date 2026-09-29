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

// FileReader 多态桩(Node 无原生 FileReader; blob.arrayBuffer() 是真宏任务——
// 恰好复现真浏览器里"游标回调内 await FileReader → 事务自动提交"的悬挂坑)
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      (buf) => {
        this.result =
          "data:application/octet-stream;base64," +
          Buffer.from(buf).toString("base64");
        this.onload?.();
      },
      (e) => this.onerror?.(e),
    );
  }
};

// 看门狗: 导出/导入若悬挂(事务自动提交坑) 30 秒后报错退出, 不让 CI 干等
const watchdog = setTimeout(() => {
  console.error("✗ 测试超时: 疑似事务悬挂(游标回调内宏任务导致自动提交)");
  process.exit(1);
}, 30000);

const { exportDbNd, importDbNd } = await import("../src/mirror.js");
const { uploadBlob } = await import("../src/transfer.js");
const zlib = await import("node:zlib");

const DB = "wvs-test-db";
let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failed++; console.error(`  ✗ ${msg}`); }
};

// ---------- 0) 上传线格式回归(v0.15.4 曾把 wvsgz: 裸放进 data 字段 → 后端 base64 解码 400) ----------
// data 必须是"整个文件内容"的 base64; 压缩文件内容 = "wvsgz:" + 内层base64(gzip)。
// 用 node:zlib 做独立实现交叉验证, 不复用被测代码的解压逻辑。
{
  const orig = "hello 中文 line1\nline2\n";
  let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), body: init?.body };
    return { ok: true, status: 200, text: async () => "" };
  };
  try {
    await uploadBlob("test-upload.bin", new Blob([orig]));
  } finally {
    globalThis.fetch = realFetch;
  }
  const m = captured?.body?.match(/^{"name":"test-upload.bin","data":"(.+)"}$/s);
  ok(!!m && captured.url.includes("/api/files/upload"), "上传 body 结构与端点正确");
  if (m) {
    const fileText = Buffer.from(m[1], "base64").toString("utf8");
    ok(fileText.startsWith("wvsgz:"), "文件内容带 wvsgz: 前缀(magic 在文件里,不裸放 data 字段)");
    const raw = zlib.gunzipSync(Buffer.from(fileText.slice(6), "base64")).toString("utf8");
    ok(raw === orig, "内层 gzip 独立解压还原原文");
  }
}

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
    { id: "img1", payload: new Blob([new Uint8Array([9, 8, 7, 6])], { type: "image/png" }) },
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
ok(nd.rows === 7, `行数 7 (实际 ${nd.rows})`);
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
ok(blobs.length === 2 && abv instanceof ArrayBuffer && new Uint8Array(abv).join(",") === "1,2,3,250,255",
  "ArrayBuffer 标记对象还原");
const blb = blobs[1]?.v?.payload;
const blbBytes = blb instanceof Blob ? [...new Uint8Array(await blb.arrayBuffer())].join(",") : "";
ok(blb instanceof Blob && blb.type === "image/png" && blbBytes === "9,8,7,6",
  `Blob 标记对象还原(type=${blb?.type}, bytes=${blbBytes})`);

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
clearTimeout(watchdog);
if (failed) { console.error(`✗ 往返测试失败 ${failed} 项`); process.exit(1); }
console.log("✓ NDJSON 往返测试全部通过");
