// 值序列化: IndexedDB 值 ↔ 纯 JSON 可表达结构(Blob/ArrayBuffer 编码为标记对象)
// 性能: 绝大多数行不含二进制/标记——同步扫描后原对象直通(JSON.stringify/put 各自一遍),
// 跳过逐属性 await 重建的深拷贝; 只有命中的行才走慢路径重建。
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function containsBinary(v) {
  if (v instanceof Blob || v instanceof ArrayBuffer) return true;
  if (!v || typeof v !== "object" || v instanceof Date) return false;
  if (Array.isArray(v)) {
    for (const x of v) if (containsBinary(x)) return true;
    return false;
  }
  for (const k of Object.keys(v)) if (containsBinary(v[k])) return true;
  return false;
}

// JSON.parse 产物: 只可能是普通对象/数组/原始值
function containsMarker(v) {
  if (!v || typeof v !== "object") return false;
  if (Array.isArray(v)) {
    for (const x of v) if (containsMarker(x)) return true;
    return false;
  }
  if (v.__blob || v.__ab) return true;
  for (const k of Object.keys(v)) if (containsMarker(v[k])) return true;
  return false;
}

async function serializeSlow(v) {
  if (v instanceof Blob) {
    return { __blob: true, mime: v.type, data: await blobToBase64(v) };
  }
  if (v instanceof ArrayBuffer) {
    return {
      __ab: true,
      b64: btoa(String.fromCharCode(...new Uint8Array(v))),
    };
  }
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if (Array.isArray(v)) {
      const o = [];
      for (const x of v) o.push(await serializeValue(x));
      return o;
    }
    const o = {};
    for (const k of Object.keys(v)) o[k] = await serializeValue(v[k]);
    return o;
  }
  return v;
}

export async function serializeValue(v) {
  if (!containsBinary(v)) return v;
  return serializeSlow(v);
}

async function deserializeSlow(v) {
  if (v && typeof v === "object") {
    if (v.__blob) {
      const b64 = v.data.split(",")[1];
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: v.mime });
    }
    if (v.__ab) {
      const bin = atob(v.b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr.buffer;
    }
    if (Array.isArray(v)) {
      const o = [];
      for (const x of v) o.push(await deserializeValue(x));
      return o;
    }
    const o = {};
    for (const k of Object.keys(v)) o[k] = await deserializeValue(v[k]);
    return o;
  }
  return v;
}

export async function deserializeValue(v) {
  if (!containsMarker(v)) return v;
  return deserializeSlow(v);
}

export function serializePlain(v) {
  // out-of-line 键通常是字符串/数字
  if (v instanceof Blob || v instanceof ArrayBuffer) return String(v);
  return v;
}
