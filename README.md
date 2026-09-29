# tt-webview-sync — TauriTavern WebView 存储同步器

把扩展存放在浏览器 IndexedDB / localStorage 里的数据（玉子手机 QQ、SP·数据库配置、斗罗状态栏头像库等）**镜像进 TauriTavern 的同步数据集**，借助 TT 自带的局域网同步在多台设备间保持一致。

## 为什么需要它

TT 的同步按"数据集"（白名单目录/文件）传输，覆盖 settings.json、chats、worlds、user/images 等。但很多扩展的**真实配置存在 WebView 的 IndexedDB / localStorage 里**——这部分不在任何数据集内，TT 同步够不着，换设备后 QQ 联系人、数据库预设、头像库全部消失。

```
导出：IndexedDB/localStorage ─逐行 NDJSON 流式序列化→ 按行边界组段 → gzip → 按库写入 user/files/wvs__*.ndjson ─→ user.files 数据集 ─→ TT 同步
导入：TT 同步落地 user/files ─→ 启动时读 manifest 比对版本 ─→ 逐段取回逐行恢复(流式,不拼整库大字符串) ─→ toast 倒计时 → 自动刷新
```

## 安装

TT → 扩展管理器 → 安装扩展：

```
https://github.com/SilveryFlow/tt-webview-sync
```

两台设备都装，并确认 TT 同步范围勾选了「**user.files**」数据集。

## 使用

1. **设备 A**：扩展设置面板 → **导出镜像**；
2. 触发一次 TT 同步（或等自动同步）；
3. **设备 B**：重启 TT——自动检测新镜像 → 写入本地存储 → toast 倒计时 3→2→1 → 自动刷新界面，各扩展重载配置。

日常就是：改了配置 → 点导出 → 其他设备重启跟上。

## 面板说明

### 按钮（3+3 两排）

| 按钮 | 作用 |
| --- | --- |
| **导出镜像** | 扫描全部存储 → 流式序列化+压缩 → 按库分文件上传。按钮转圈显示进度，完成后 toast 通知版本号 |
| **从镜像恢复** | 强制将远端镜像写入本地（无视版本判断）。完成后倒计时自动刷新 |
| **刷新界面** | 手动刷新页面 |
| **重新扫描** | 重新枚举 IndexedDB 库与 localStorage 键（装新扩展后点一下） |
| **导出日志** | 下载最近 500 条操作日志（txt），排障用 |
| **删除镜像** | 弹 TT 原生确认框（Popup.show.confirm）→ 删除全部镜像文件。无镜像时直接 toast 提示不弹框 |

### 清单

| 清单 | 含义 |
| --- | --- |
| **IndexedDB 库** | 动态发现全部库，显示 store 列表。勾选=纳入同步，默认全勾 |
| **localStorage** | 动态发现全部键，显示大小。勾选=纳入同步，默认全勾 |

## 功能细节

- **NDJSON 流式镜像（v0.15+）**：每库一个 `.ndjson` 文件，首行 schema 头，其后每行一条记录。导出端游标遍历逐行序列化、按行边界组段；导入端逐段取回逐行解析、分批事务写回。**双端内存峰值 ≈ 单条记录 + 单段文本**，不再构造整库大字符串（V8 单字符串上限约 512MB，老格式撞墙即崩）
- **旧格式永久兼容**：v0.8~v0.14 的整库 `.json` 镜像仍可恢复；旧版本扩展读到 `.ndjson` 会在 JSON.parse 处安全失败（逐库 try/catch + 形状守卫），不写不删不损坏本机数据
- **动态收集**：`indexedDB.databases()` 实时枚举全部存储（新扩展建的库自动出现在面板），不维护写死清单；不可用时自动降级为已知库探活
- **gzip 压缩**：JSON 文本通常缩至 10~20%，275MB 库压缩后约 30~60MB
- **分卷**：超 10MB 的库按**行边界**切段（`__c001.ndjson` ~ `__cNNN.ndjson`），导入端带半行缓冲防御
- **孤儿清理**：每次导出提交新清单后，自动删除旧清单引用、新清单不再引用的文件（旧格式遗留、分段数收缩的尾巴）
- **三重防刷新死循环**：localStorage 版本闸 + 30 秒导入冷却 + 15 秒启动安全阀
- **错误全入日志**：错误记录点覆盖扫描/导出/导入/删除全流程，时间戳为东八区

## 已知边界

- Date 类型经 JSON 序列化变 ISO 字符串（现有扩展均用时间戳，实际无感）
- SP·数据库恢复后如配置被旧值覆盖，点一次「从镜像恢复」再刷新
- 建议在面板勾掉 TT 前端的 `SillyTavern_Prompts`（~34MB）和 `WorldbookCacheInspectorDB`（~34MB）以减小镜像体积
- 极端病态库（单库序列化后数百 MB）可用 `dbLimitMb` 设置做保险丝（默认 0=不限）

## 排障

点「**导出日志**」下载 txt 发给开发者。日志带时间戳和级别标签，每一步的操作对象和异常原因都记录在案。

## 原理与结构

- 镜像存放在 `user/files/`（`wvs__` 前缀平铺文件），随「user.files」数据集同步
- 上传走 `POST /api/files/upload`（TT 标准 API，文件名禁含路径分隔符故用前缀代替子目录）
- 传输、断点、压缩、落地全部由 TT 同步系统负责
- 通知用 toastr（TT 生态标准），确认弹窗用 `Popup.show.confirm`（TT 原生 UI）——原生 `alert`/`confirm` 在 Tauri WebView 中被静默跳过

### 仓库结构（ES modules，无打包步骤）

TT 以 `type=module` 加载 `index.js`（入口垫片）→ `src/main.js`：

```
index.js            入口垫片
src/main.js         启动入口(等宿主就绪→建面板→延时自动恢复)
src/env.js          常量与默认设置
src/log.js          日志环形缓冲
src/ui.js           toastr/Popup/倒计时(宿主 UI 适配)
src/settings.js     扩展设置读写
src/discover.js     IndexedDB/localStorage 动态发现
src/transfer.js     user/files 上传/取回/删除 + gzip + 分卷命名
src/serialize.js    值序列化(Blob/ArrayBuffer ↔ 标记对象)
src/mirror.js       镜像引擎(NDJSON 流式导出/导入 + 旧格式兼容)
src/panel.js        设置面板
scripts/check.mjs   提交前检查(语法/ESLint/按钮覆盖/导入解析/往返测试/版本)
scripts/test-roundtrip.mjs  fake-indexeddb 离线往返冒烟测试
```

## License

MIT
