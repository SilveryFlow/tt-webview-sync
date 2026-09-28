# tt-webview-sync — TauriTavern WebView 存储同步器

把扩展存放在浏览器 IndexedDB / localStorage 里的数据（玉子手机 QQ、SP·数据库配置、斗罗状态栏头像库、推进重roll助手缓存等）**镜像进 TauriTavern 的同步数据集**，借助 TT 自带的局域网同步（lan_sync）在多台设备间保持一致。

## 为什么需要它

TauriTavern 的同步按"数据集"（白名单目录/文件）传输，覆盖 settings.json、chats、worlds、user/images 等。但很多扩展的**真实配置存在 WebView 的 IndexedDB / localStorage 里**——这部分不在任何数据集内，TT 同步够不着，换设备后 QQ 联系人、数据库预设、头像库全部消失。

本扩展做一个双向桥：

```
导出：IndexedDB/localStorage ─序列化→ extension_settings.webviewSync.mirror ─→ settings.json ─→ settings.core 数据集 ─→ TT 同步
导入：TT 同步落地 settings.json ─→ 启动时检测镜像版本新于本地 ─→ 反序列化写回 IndexedDB/localStorage ─→ 提示重启生效
```

## 安装

TT → 扩展管理器 → 安装扩展，填入本仓库地址：

```
https://github.com/SilveryFlow/tt-webview-sync
```

## 快速上手

1. **设备 A**：扩展设置面板「WebView 存储同步器」→ **导出镜像到同步**；
2. 触发一次 TT 同步（或等待自动同步）；
3. **设备 B**：重启 TT——启动时检测到来自其他设备的新镜像会自动写入本地并弹提示，按提示再重启一次 TT 让各扩展重新加载。

## 面板与配置项说明

面板位于 TT 扩展设置区（可折叠抽屉「WebView 存储同步器」）。

### 按钮

| 按钮 | 作用 |
| --- | --- |
| **导出镜像到同步** | 立即扫描全部存储并把勾选项打包写入镜像（随 settings.json 走同步）。完成后弹出镜像版本号与跳过统计 |
| **从镜像恢复(强制)** | 无视"本机导出/已导入"的版本判断，把当前镜像强行写入本地 IndexedDB/localStorage。用于设备错乱后手动对齐 |
| **重新扫描** | 重新枚举 IndexedDB 库与 localStorage 键（新装扩展/脚本后点一下，新存储出现在清单里） |

### 清单

| 清单 | 含义 |
| --- | --- |
| **IndexedDB 库列表** | 动态发现的全部库（`indexedDB.databases()`），括号里显示库内的 object store 名。**勾选=纳入同步**，默认全勾 |
| **localStorage 键列表** | 动态发现的全部键，右侧显示值大小。勾选=纳入同步，默认全勾 |

### 选项

| 选项 | 含义 | 默认 |
| --- | --- | --- |
| **随设置保存自动导出** | 勾选后，每次 TT 保存设置时自动执行一次导出（免手动点按钮；会增加 settings.json 写入频率） | 关 |
| **单文件上限(KB)** | 镜像内单个 Blob/ArrayBuffer 的体积上限；**0 = 不限制**（大头像/立绘原图全部进镜像）。设为 N 时超出者跳过并记入镜像的 `skipped` 清单——若 settings.json 过大影响 TT 启动，把它调到 500~1000 可砍掉大媒体、保留小头像 | 0（不限） |

### 镜像与版本机制（自动行为，无需配置）

- 每次导出生成递增版本号（时间戳）+ 设备名；
- 对端启动 4 秒后自动比对：镜像比本地"最近导入版本"新、且**不是本机导出的**→ 自动恢复并弹提示；
- 因此日常使用就是：任何一端改了配置 → 点导出 → 各端重启后自动跟上。

## 动态收集（v0.4.0 起）

不维护写死的库名单。扩展通过 `indexedDB.databases()` 与 localStorage 枚举**实时发现**本机全部 WebView 存储（新装的扩展、卡内脚本、酒馆助手脚本建的库都会自动出现在面板），默认全部纳入，勾掉的排除（默认无排除，一切存储都进镜像）。

### 已知会出现的存储（示例，实际以面板扫描结果为准）

| 类型 | 名称 | 归属 | 内容 |
| --- | --- | --- | --- |
| IDB | `yuzi-phone-qq-v2` | 玉子手机 | QQ：联系人/群聊/会话/预设/头像 |
| IDB | `yuzi-phone-appearance-assets` / `-packs` | 玉子手机 | 外观资源/外观包 |
| IDB | `yuzi-phone-template-workshop-v2` | 玉子手机 | 模板工作台/美化工程 |
| IDB | `yuzi-phone-table-image-ownership` | 玉子手机 | 表格图片归属 |
| IDB | `yuzi-phone-cache` | 玉子手机 | 缓存（同样默认纳入，嫌大可在面板勾掉） |
| IDB | `shujuku_v120_config_v1` | SP·数据库 | 配置缓存（排除标签等） |
| IDB | `douluo-main-text-assets` | 斗罗卡脚本 | 状态栏/正文/角色创建 头像立绘 |
| IDB | `wn_phone_media_v1` | 偏航卡脚本 | 手机外壳媒体库（LIME 头像等） |
| IDB | `chatu8_config_images` / `baibai_image_vibes` | 柏宝绘 | 配置图片 / vibe 数据 |
| localStorage | `Reroll_Cache_*` | 推进重roll助手 | 重roll缓存 |
| localStorage | `dl-main-text-*` 等前缀 | 各卡内脚本 | 状态栏/正文阅读的本地状态 |

## 已知边界

- **Date 类型**：镜像经 JSON 序列化，Date 字段会变成 ISO 字符串；
- **数据库配置竞态**：SP·数据库自身存在"IndexedDB 缓存回写 settings.json"的竞态（多端同步冲突的常见来源）。本扩展恢复后请重启 TT；若配置再次回滚，多点一次「强制恢复」并重启；
- **体积**：不限制大文件时，镜像体积=全部存储体积的 base64（约 +33%）。TT 同步传输层有 zstd 压缩，但两端 TT 加载 settings.json 的耗时会随镜像增大——按需设置单文件上限。

## 原理与数据集依据

- TT 同步数据集为白名单制（`ttsync-core` 的 `DATASETS` 常量），`settings.core` 覆盖 `default-user/settings.json`；
- 镜像整体存在 `extension_settings.webviewSync.mirror`，随 settings.json 传输、断点、压缩、落地全部由 TT 同步系统负责；
- 对端恢复用 `indexedDB.open` 按镜像的 keyPath 重建空库结构后逐 store 写入，Blob 从 base64 还原。

## License

MIT
