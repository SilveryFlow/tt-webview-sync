# tt-webview-sync — TauriTavern WebView 存储同步器

把扩展存放在浏览器 IndexedDB / localStorage 里的数据（玉子手机 QQ、数据库 SP·数据库配置、斗罗状态栏头像库等）**镜像进 TauriTavern 的同步数据集**，借助 TT 自带的局域网同步（lan_sync）在多台设备间保持一致。

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

## 使用

1. **设备 A**：扩展设置面板底部「WebView 存储同步器」→ **导出镜像到同步**；
2. 触发一次 TT 同步（或等待自动同步）；
3. **设备 B**：重启 TT——启动时检测到来自其他设备的新镜像会自动写入本地并弹提示，按提示再重启一次 TT 让各扩展重新加载。

面板还有「从镜像恢复(强制)」按钮（手动覆盖本地）、镜像库清单编辑、自动导出开关。

## 默认镜像范围（源码实证 10 库）

| IndexedDB 库 | 归属 | 内容 |
| --- | --- | --- |
| `yuzi-phone-qq-v2` | 玉子手机 | QQ：联系人/群聊/会话/预设/头像 |
| `yuzi-phone-appearance-assets` | 玉子手机 | 外观资源 |
| `yuzi-phone-appearance-packs` | 玉子手机 | 外观包 |
| `yuzi-phone-template-workshop-v2` | 玉子手机 | 模板工作台/美化工程 |
| `yuzi-phone-table-image-ownership` | 玉子手机 | 表格图片归属 |
| `shujuku_v120_config_v1` | SP·数据库 | 配置缓存（排除标签等） |
| `douluo-main-text-assets` | 斗罗卡脚本 | 状态栏/正文/角色创建 头像立绘 |
| `wn_phone_media_v1` | 偏航卡脚本 | 手机外壳媒体库（LIME 头像等） |
| `chatu8_config_images` | 柏宝绘 | 配置图片 |
| `baibai_image_vibes` | 柏宝绘 | vibe 数据 |

排除：`yuzi-phone-cache`（纯缓存）。清单可在面板自由增删。

## 已知边界

- **大文件**：超过 100KB 的 Blob 头像默认跳过（避免 settings.json 膨胀），跳过项记录在镜像 `skipped` 里；后续版本将把大媒体走 `user/images`（media.user_images 数据集）；
- **Date 类型**：镜像经 JSON 序列化，Date 字段会变成 ISO 字符串；
- **数据库配置竞态**：SP·数据库自身存在"IndexedDB 缓存回写 settings.json"的竞态（多端同步冲突的常见来源）。本扩展恢复后请重启 TT；若配置再次回滚，多点一次「强制恢复」并重启。

## 原理与数据集依据

- TT 同步数据集为白名单制（`ttsync-core` 的 `DATASETS` 常量），`settings.core` 覆盖 `default-user/settings.json`；
- 镜像整体存在 `extension_settings.webviewSync.mirror`，随 settings.json 传输、断点、压缩、落地全部由 TT 同步系统负责。

## License

MIT
