// 值序列化: IndexedDB 值 ↔ 纯 JSON 可表达结构(Blob/ArrayBuffer 编码为标记对象)
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function serializeValue(v) {
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

export function serializePlain(v) {
  // out-of-line 键通常是字符串/数字
  if (v instanceof Blob || v instanceof ArrayBuffer) return String(v);
  return v;
}

export async function deserializeValue(v) {
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
