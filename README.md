# tt-webview-sync — TauriTavern WebView 存储同步器

把扩展存放在浏览器 IndexedDB / localStorage 里的数据（玉子手机 QQ、SP·数据库配置、斗罗状态栏头像库、推进重roll助手缓存等）**镜像进 TauriTavern 的同步数据集**，借助 TT 自带的局域网同步（lan_sync）在多台设备间保持一致。

## 为什么需要它

TauriTavern 的同步按"数据集"（白名单目录/文件）传输，覆盖 settings.json、chats、worlds、user/images 等。但很多扩展的**真实配置存在 WebView 的 IndexedDB / localStorage 里**——这部分不在任何数据集内，TT 同步够不着，换设备后 QQ 联系人、数据库预设、头像库全部消失。

本扩展做一个双向桥：

```
导出：IndexedDB/localStorage ─gzip压缩→ 按库分文件写入 user/files/wvs__*.json ─→ user.files 数据集 ─→ TT 同步
导入：TT 同步落地 user/files ─→ 启动时读 wvs__manifest.json 比对版本 ─→ 逐库解压恢复 ─→ 倒计时自动刷新
```

## 安装

TT → 扩展管理器 → 安装扩展，填入本仓库地址：

```
https://github.com/SilveryFlow/tt-webview-sync
```

## 快速上手

0. 前置：两台设备的 TT 同步范围都勾选「**user.files**」数据集；
1. **设备 A**：扩展设置面板 → **导出镜像**；
2. 触发一次 TT 同步（或等待自动同步）；
3. **设备 B**：重启 TT——启动时检测到新镜像会自动写入本地存储，toast 通知并**倒计时 3 秒自动刷新界面**让各扩展重载配置。

## 面板与配置项

面板位于 TT 扩展设置区（可折叠抽屉「WebView 存储同步器」），两排 3+3 按钮布局。

### 按钮

| 按钮 | 作用 |
| --- | --- |
| **导出镜像** | 扫描全部存储 → 压缩 → 按库分文件写入 user/files。按钮转圈显示进行中，完成后 toast 通知版本号与跳过统计 |
| **从镜像恢复** | 强制将当前镜像写入本地（无视版本判断）。完成后倒计时 3 秒自动刷新。用于设备错乱后手动对齐 |
| **刷新界面** | 手动刷新页面（任何时候可用） |
| **重新扫描** | 重新枚举 IndexedDB 库与 localStorage 键（新装扩展后点一下，新存储出现在清单） |
| **导出日志** | 下载最近 500 条操作日志（`webview-sync-log.txt`），排障用 |
| **删除镜像** | 弹 TT 原生确认框（Popup.show.confirm）→ 确认后删除 user/files 下全部 `wvs__*.json`。删除会随 TT 同步传播到其他设备；本机浏览器数据不受影响。无镜像时直接 toast 提示不弹框 |

### 清单

| 清单 | 含义 |
| --- | --- |
| **IndexedDB 库** | 动态发现（`indexedDB.databases()`），显示每库的 object store 列表。勾选=纳入同步，默认全勾。标题实时显示发现数量与扫描模式 |
| **localStorage** | 动态发现全部键，右侧显示值大小。勾选=纳入同步，默认全勾 |

### 选项

| 选项 | 含义 | 默认 |
| --- | --- | --- |
| **随设置保存自动导出** | TT 保存设置时自动执行一次导出 | 关 |
| **单文件上限(KB)** | 镜像内单个 Blob 的体积上限；0=不限制。镜像太大拖慢同步时调到 500~1000 可砍大媒体保留小头像 | 0 |

### 自动行为（无需配置）

- 每次导出生成递增版本号 + 设备名，镜像清单最后写入（提交点）；
- 对端启动 4 秒后自动比对版本 → 新于本地且非本机导出 → 自动恢复 → toast 倒计时 → 自动刷新；
- 三重防刷新死循环：localStorage 版本闸 + 30 秒导入冷却期 + 15 秒启动安全阀。

## 动态收集

不维护写死的库名单。实时枚举本机全部 WebView 存储（新装的扩展、卡内脚本、酒馆助手脚本建的库自动出现在面板），默认全部纳入。

`databases()` 不可用时自动降级为已知库探活模式（逐个尝试打开），标题显示当前模式。所有库操作带 3~5 秒超时。

### 已知存储示例（实际以面板扫描为准）

| 类型 | 名称 | 归属 | 内容 |
| --- | --- | --- | --- |
| IDB | `yuzi-phone-qq-v2` | 玉子手机 | QQ：联系人/群聊/会话/预设/头像 |
| IDB | `yuzi-phone-appearance-*` 等 7 个 | 玉子手机 | 外观/模板工作台/图片归属/缓存 |
| IDB | `shujuku_v120_config_v1` | SP·数据库 | 配置缓存（排除标签等） |
| IDB | `douluo-main-text-assets` | 斗罗卡 | 状态栏/正文/角色创建 头像立绘 |
| IDB | `wn_phone_media_v1` | 偏航卡 | 手机外壳媒体库（LIME 头像） |
| IDB | `chatu8_config_images` 等 | 柏宝绘 | 配置图片 / vibe |
| IDB | `SillyTavern_Prompts` 等 | TT 前端 | 提示词缓存（可勾掉减小体积） |
| LS | `Reroll_Cache_*` | 推进重roll助手 | 重roll缓存 |
| LS | `dl-main-text-*` 等 | 各卡内脚本 | 状态栏/正文阅读本地状态 |

## 压缩与分卷（v0.10+ / v0.9+）

- **gzip 流式压缩**（CompressionStream）：JSON 文本通常缩至 10~20%，275MB 的库压缩后可能仅 30~60MB；
- **分卷**：超过 10MB 的库自动切段上传（`__c001.json` ~ `__cNNN.json`），manifest 记录段数，恢复端按序拼接；
- 兼容旧版（未压缩/单文件）镜像格式。

## 已知边界

- **Date 类型**：JSON 序列化后 Date 变 ISO 字符串（现有扩展均用时间戳数字，实际无感）；
- **SP·数据库竞态**：恢复后如配置被旧值覆盖，点一次「从镜像恢复」再刷新；
- **体积建议**：TT 前端的 `SillyTavern_Prompts`（~34MB）和 `WorldbookCacheInspectorDB`（~34MB）是提示词/世界书缓存，建议在面板勾掉以大幅减小镜像体积。

## 排障

点「**导出日志**」下载 txt 发给开发者。日志带东八区时间戳、级别标签（INFO/WARN/ERROR），覆盖扫描/导出/导入/删除全流程，每一步的操作对象和异常原因都记录在案。

## 原理

- 镜像存放在 `user/files/` 目录（`wvs__` 前缀平铺文件），随「user.files」数据集同步——TT 同步范围里独立可勾选；
- 上传走 `POST /api/files/upload`（TT 标准 API，文件名禁含路径分隔符故用前缀代替子目录）；
- 传输、断点、压缩、落地全部由 TT 同步系统负责；
- 恢复用 `indexedDB.open` 按镜像的 keyPath 重建空库结构后逐 store 写入，Blob 从 base64 还原；
- 通知用 toastr（TT 生态标准），确认弹窗用 `Popup.show.confirm`（TT 原生 UI）——原生 `alert`/`confirm` 在 Tauri WebView 中被静默跳过。

## License

MIT
