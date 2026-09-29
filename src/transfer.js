// 文件层: user/files 上传/取回/删除 + gzip + 分卷命名
// (user/files = TT「user.files」数据集，同步范围里独立可勾选)
import { API_UPLOAD, API_DELETE, FILE_BASE, GZ_MAGIC, PREFIX } from "./env.js";
import { log, warn } from "./log.js";

export function reqHeaders() {
  const ctx = window.SillyTavern?.getContext?.();
  return ctx?.getRequestHeaders?.() || {};
}

function base64FromText(text) {
  // TextEncoder → Uint8Array → 分块 btoa(每块 32KB,防 call stack 爆)
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const STEP = 32768;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

function bytesToBase64(bytes) {
  let binary = "";
  const STEP = 32768;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

async function gzipBlobToB64(blob) {
  // Blob 流直连 CompressionStream——省掉 blob.text()(UTF-8→UTF-16) 和
  // TextEncoder(UTF-16→UTF-8) 的一来一回双重全量编码
  const reader = blob
    .stream()
    .pipeThrough(new CompressionStream("gzip"))
    .getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const gz = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    gz.set(c, off);
    off += c.length;
  }
  return bytesToBase64(gz);
}

async function gunzipText(b64) {
  // base64 → Uint8Array → DecompressionStream 流式解压 → 文本
  const binary = atob(b64);
  const gz = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) gz[i] = binary.charCodeAt(i);
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(gz);
  writer.close();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(out);
}

export async function uploadBlob(name, blob) {
  // 压缩(JSON 文本 gzip 后通常只剩 10~20%),标记前缀区分
  let payloadB64;
  try {
    payloadB64 = GZ_MAGIC + (await gzipBlobToB64(blob));
    log(
      `压缩 ${name}: ${Math.round(blob.size / 1024)}KB -> ${Math.round(payloadB64.length / 1024)}KB`,
    );
  } catch (e) {
    warn(`压缩失败,原始上传 ${name}:`, e);
    payloadB64 = base64FromText(await blob.text());
  }
  // 手拼 body: base64 字符集无引号/反斜杠,免去 JSON.stringify 对十余 MB 数据的转义扫描
  const r = await fetch(API_UPLOAD, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...reqHeaders() },
    body: '{"name":' + JSON.stringify(name) + ',"data":"' + payloadB64 + '"}',
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

export function uploadText(name, text) {
  return uploadBlob(name, new Blob([text]));
}

export async function deleteText(fileName) {
  const r = await fetch(API_DELETE, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...reqHeaders() },
    body: JSON.stringify({ path: "/user/files/" + fileName }),
  });
  if (!r.ok && r.status !== 404)
    throw new Error("delete " + fileName + " -> " + r.status);
}

export async function fetchText(fileName) {
  const r = await fetch(FILE_BASE + encodeURIComponent(fileName), {
    cache: "no-store",
  });
  if (!r.ok) throw new Error("fetch " + fileName + " -> " + r.status);
  let text = await r.text();
  // 压缩文件: 前缀标记 + base64(gzip) → 解压
  if (text.startsWith(GZ_MAGIC)) {
    const b64 = text.slice(GZ_MAGIC.length);
    text = await gunzipText(b64);
    log(
      `解压 ${fileName}: ${Math.round(b64.length / 1024)}KB -> ${Math.round(text.length / 1024)}KB`,
    );
  }
  return text;
}

export function ndFileName(dbName, chunk) {
  const safe = dbName.replace(/[^A-Za-z0-9_.-]/g, "_");
  return chunk !== undefined
    ? `${PREFIX}db__${safe}__c${String(chunk).padStart(3, "0")}.ndjson`
    : `${PREFIX}db__${safe}.ndjson`;
}

// 展开清单条目为实际文件名列表（兼容 v0.7 字符串条目 / 旧 json 分段 / 新 ndjson 分段）
export function refFiles(ref) {
  if (typeof ref === "string") return [ref];
  if (!ref || !ref.file) return [];
  if (!(ref.chunks > 1)) return [ref.file];
  const files = [];
  for (let ci = 1; ci <= ref.chunks; ci++)
    files.push(
      ref.file.replace(
        /__c\d+(\.(?:json|ndjson))$/,
        `__c${String(ci).padStart(3, "0")}$1`,
      ),
    );
  return files;
}
