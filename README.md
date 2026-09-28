# tt-webview-sync — TauriTavern WebView 存储同步器

把扩展存放在浏览器 IndexedDB / localStorage 里的数据（玉子手机 QQ、SP·数据库配置、斗罗状态栏头像库等）**镜像进 TauriTavern 的同步数据集**，借助 TT 自带的局域网同步在多台设备间保持一致。

## 为什么需要它

TT 的同步按"数据集"（白名单目录/文件）传输，覆盖 settings.json、chats、worlds、user/images 等。但很多扩展的**真实配置存在 WebView 的 IndexedDB / localStorage 里**——这部分不在任何数据集内，TT 同步够不着，换设备后 QQ 联系人、数据库预设、头像库全部消失。

```
导出：IndexedDB/localStorage ─gzip压缩→ 按库分文件写入 user/files/wvs__*.json ─→ user.files 数据集 ─→ TT 同步
导入：TT 同步落地 user/files ─→ 启动时读 manifest 比对版本 ─→ 逐库解压恢复 ─→ toast 倒计时 → 自动刷新
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
| **导出镜像** | 扫描全部存储 → 压缩 → 按库分文件上传。按钮转圈显示进度，完成后 toast 通知版本号 |
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

### 选项

| 选项 | 含义 | 默认 |
| --- | --- | --- |
| **单文件上限(KB)** | 镜像内单个 Blob 的体积上限；0=不限制。镜像太大时调到 500~1000 砍大媒体 | 0 |

## 功能细节

- **动态收集**：`indexedDB.databases()` 实时枚举全部存储（新扩展建的库自动出现在面板），不维护写死清单；不可用时自动降级为已知库探活
- **gzip 压缩**：JSON 文本通常缩至 10~20%，275MB 库压缩后约 30~60MB
- **分卷**：超 10MB 的库自动切段（`__c001.json` ~ `__cNNN.json`），恢复端按序拼接
- **三重防刷新死循环**：localStorage 版本闸 + 30 秒导入冷却 + 15 秒启动安全阀
- **错误全入日志**：14 个错误记录点覆盖扫描/导出/导入/删除全流程，时间戳为东八区

## 已知边界

- Date 类型经 JSON 序列化变 ISO 字符串（现有扩展均用时间戳，实际无感）
- SP·数据库恢复后如配置被旧值覆盖，点一次「从镜像恢复」再刷新
- 建议在面板勾掉 TT 前端的 `SillyTavern_Prompts`（~34MB）和 `WorldbookCacheInspectorDB`（~34MB）以减小镜像体积

## 排障

点「**导出日志**」下载 txt 发给开发者。日志带时间戳和级别标签，每一步的操作对象和异常原因都记录在案。

## 原理

- 镜像存放在 `user/files/`（`wvs__` 前缀平铺文件），随「user.files」数据集同步
- 上传走 `POST /api/files/upload`（TT 标准 API，文件名禁含路径分隔符故用前缀代替子目录）
- 传输、断点、压缩、落地全部由 TT 同步系统负责
- 通知用 toastr（TT 生态标准），确认弹窗用 `Popup.show.confirm`（TT 原生 UI）——原生 `alert`/`confirm` 在 Tauri WebView 中被静默跳过

## License

MIT
