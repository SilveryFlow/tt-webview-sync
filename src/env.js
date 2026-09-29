// 全局常量与默认设置
export const NS = "webviewSync";
export const PREFIX = "wvs__"; // user/files 下的镜像文件前缀（API 禁止子目录，用前缀代替）
export const MANIFEST_NAME = PREFIX + "manifest.json";
export const API_UPLOAD = "/api/files/upload";
export const API_DELETE = "/api/files/delete";
export const FILE_BASE = "/user/files/";
export const CHUNK_SIZE = 10 * 1024 * 1024; // 单段原始字节(10MB)
export const GZ_MAGIC = "wvsgz:"; // 压缩文件标记前缀(恢复时识别)

export const DEFAULTS = {
  enabled: true,
  deviceId: "",
  // 动态发现结果的选择表：{ '<库名或ls键>': true/false }。发现新库默认 true（排除表里的除外）
  dbPick: {},
  lsPick: {},
  // 默认排除（纯缓存/可再生）
  dbExclude: [],
  lsExclude: [],
  dbLimitMb: 0, // 单库上限(MB)，0=不限(流式序列化已消除大字符串瓶颈，仅作病态大库保险丝)
  lastImportedVersion: 0,
  lastExportVersion: 0,
};
