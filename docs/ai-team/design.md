# 架构与设计 —— 桌面悬浮工作计划板（desktop-planner）

> 状态：**实现中（便携版可启动；安装包已构建，待全新机器安装验收）**；版本：v1.2；负责人：研发总监；更新：2026-11-17  
> 需求关联：requirements.md v0.3（REQ-001~008）  
> 说明：v1.1 记录的「安装包与本机启动闭环未完成、暂停开发」已过期；当前以本文与 README「当前状态」为准。

## 1. 设计目标与边界

- 关联需求：REQ-001~008。目标：纯本地 Win11 悬浮待办；正式交付形态为 **NSIS 安装包 + 桌面快捷方式**；数据 AI 可读 JSON。
- 环境：Windows 11（Win10 尽力）；**Electron 43.3.0**；打包 **electron-builder 25**。
- 质量约束：启动 ≤5s；常驻 ≤200MB；离线；UI 无第三方框架。
- 非目标（本期）：云同步、多用户、历史视图、报表、自动更新、代码签名。

## 2. 产品交互

- 流程：启动 → 面板（360×560）→ 计划/已办编辑 → 写 JSON → 托盘收起/退出。
- 面板：360×560 无边框；标题区（日期/今日待办那一行）可拖动；拖动停稳 260ms 后防抖写入 `settings.panelPosition`（复用 300ms 设置防抖 + 原子写）；默认主屏工作区右上角（左 = 右-24-360，上 = 上+60），重启恢复。
- 贴顶自动隐藏（QQ 式）：拖到离工作区顶端 `DOCK_SNAP=26` 内吸顶并向上收起，只在顶端留 `DOCK_STRIP=6` 细边；鼠标移到细边滑出完整面板，离开 450ms 后重新收起；往下拖超过 `UNDOCK_DIST=46` 解除吸顶。
- 显隐：托盘图标左键切换；面板内 Esc 收起；托盘右键菜单「打开/收起面板、开机自启、设置…、退出」。
- 透明度：独立设置窗口中调节，默认 **50%**、范围 **20%–100%**（主进程 clamp 0.2–1）；CSS `--glass: calc(0.16 + var(--panel-alpha) * 0.72)`。
- 透明窗口：`transparent: true` + 透明 backgroundColor，透明度完全由 CSS 决定，**失去焦点也保持透明**；原因是 Windows 的 `backgroundMaterial: 'acrylic'` 在失焦时会退化为实色。代价是无窗口背后的磨砂模糊；圆角改为 CSS 20px 绘制，无 DWM 阴影。
- 托盘：Win11 上 Electron.Tray 常不进入通知区，走 **wscript → STA PowerShell NotifyIcon** 兜底（`scripts/tray-host.ps1`）。

## 3. 结构与数据

### 3.1 模块

| 路径 | 职责 |
|---|---|
| `app/main.js` | 单面板窗口、拖动/吸顶、IPC、JSON 原子写与 watch、托盘拉起、单实例锁、开机自启 |
| `app/preload.js` | contextIsolation 白名单桥 |
| `app/renderer.js` + `index.html` + `style.css` | 计划/已办 UI |
| `app/settings.html` + `settings.js` | 独立设置窗口（透明度 / 主题 / 开机自启） |
| `app/assets/` | icon / tray 图标（扁平蓝底白勾） |
| 根 `package.json` | electron-builder：NSIS、桌面/开始菜单快捷方式、`extraResources` 打入托盘脚本 |
| `scripts/setup-runtime.ps1` | 开发：解压 Electron → `runtime\`，生成 `DesktopPlanner.exe` |
| `scripts/tray-host.ps1` + `start-tray-host.vbs` | 托盘兜底 |
| `scripts/afterPack.js` | 关闭 asar 完整性 fuse |
| `scripts/make-portable.ps1` | 干净便携包（不经 builder 改 exe）→ `dist/portable` |
| `scripts/run-dist.js` | 带本地 cache/tmp 调 builder |

### 3.2 数据路径

- **打包后**（`app.isPackaged`）：工作数据在 `文档\悬浮工作台\workboard.json`；Chromium userData 固定为 `%APPDATA%\desktop-planner\appdata`（纯 ASCII，需预先创建）
- **开发**：`项目\data\workboard.json` + `项目\data\appdata\`
- 模型：requirements.md §5；`settings` 含 opacity（默认 0.5，clamp 0.2–1）/ theme / autostart / panelPosition

### 3.3 安全

- `contextIsolation` + CSP 仅自身资源；无网络；渲染层不触盘。
- 本机必须 `--no-sandbox`（Chromium 沙箱初始化崩溃 `0x80000003`），因此 Chromium 沙箱不可用，这是已知妥协。

## 4. 交付与构建

- 目标产物：`dist/悬浮工作台-Setup-*.exe`（NSIS，`createDesktopShortcut: always`）
- 可执行文件名：`DesktopPlanner.exe`（便于 Win11 通知区识别）
- 构建：`npm run dist`（见 README）；构建后需把 `dist` 产物从低完整性标签统一设为 **Medium**（工作区曾感染低完整性标签，导致打包 exe 异常）
- 开发启动：`runtime\DesktopPlanner.exe --no-sandbox "--user-data-dir=<项目>\data\appdata" "<项目>\app"`；VBS 须 **ASCII**（UTF-8 中文会编译失败）
- 启动参数（本机必须）：`--no-sandbox`（Chromium 沙箱初始化崩溃 `0x80000003`）+ `--user-data-dir` 指向纯 ASCII 路径且目录需预先创建（Chromium 不会自动创建）
- 安装包：`scripts/installer.nsh` 在安装时创建 `%APPDATA%\desktop-planner\appdata`，并给桌面/开始菜单快捷方式追加上述参数

## 5. ADR 摘要

- ADR-001 Electron 43.3.0  
- ADR-002 UI = vanilla JS；构建依赖 = electron-builder  
- ADR-003 面板半透明：CSS + 可选 acrylic。（**已更新**）`backgroundMaterial: 'acrylic'` 在 Windows 失焦时退化为实色，现改为 `transparent: true` + CSS 透明度，失去焦点仍透明；圆角由 CSS 20px 绘制（无 DWM 阴影），代价是无磨砂模糊  
- ADR-004 正式交付 = NSIS + 桌面快捷方式；数据在「文档\悬浮工作台」；绿文件夹仅开发  
- ADR-005 托盘 = WinForms/PowerShell 兜底（Electron.Tray 在 Win11 不可靠）  
- ADR-006 未签名构建须在 afterPack 关闭 `EnableEmbeddedAsarIntegrityValidation`，否则可能进 JS 前秒退  
- ADR-007 移除悬浮球，改为单面板 + 贴顶自动隐藏（v0.3）：`app/ball.html` / `ball.js` / `ball:*` IPC / `settings.ballPosition / ballDock` 已删除；位置改用 `settings.panelPosition`  
- ADR-008 启动必须带 `--no-sandbox` + ASCII `--user-data-dir`（`%APPDATA%\desktop-planner\appdata`，预先创建）；安装包快捷方式固化该参数  

## 6. 启动与安装问题现状

已解决（历史记录，勿重复排查）：

1. Chromium 沙箱退出码 `0x80000003` → 启动必须带 `--no-sandbox`
2. userData 含中文导致 ProcessSingleton 锁文件失败 → 固定 `%APPDATA%\desktop-planner\appdata`（ASCII），且目录需预先创建；安装包与启动脚本已自动创建
3. 打包 exe 进 JS 前秒退 → 已关闭 asar 完整性 fuse（afterPack）+ 补齐上述启动参数
4. `dist` 产物曾被工作区低完整性标签感染 → 构建结束后统一设为 Medium
5. 便携版与 NSIS 安装包均已在本机资源管理器实测可启动；Cursor 终端内启动仍不可作为判据

仍未闭环：

1. 未签名 → SmartScreen「仍要运行」（预期行为，需证书才能根治）
2. **尚未做全新机器安装/卸载验收**：安装写文件、快捷方式参数、数据保留需在干净机器上实测
3. NSIS 写入 `Uninstall DesktopPlanner.exe` 偶发被 Defender 占用（历史问题，待安装验收时复核）

## 7. 设计评审

- 需求覆盖：REQ-001~008 代码侧具备；便携版启动与贴顶隐藏已实测可用，**REQ-008 待全新机器安装验收**。  
- 本文随实现更新；以实现代码 + README「当前状态」为准。
