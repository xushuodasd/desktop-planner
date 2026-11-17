# 架构与设计 —— 桌面悬浮工作计划板（desktop-planner）

> 状态：**实现中（暂停验收）**；版本：v1.1；负责人：研发总监；更新：2026-11-17  
> 需求关联：requirements.md v0.2（REQ-001~008）  
> 说明：安装包与本机启动闭环未完成，已按老板要求暂停开发，仅维护文档与代码现状。

## 1. 设计目标与边界

- 关联需求：REQ-001~008。目标：纯本地 Win11 悬浮待办；正式交付形态为 **NSIS 安装包 + 桌面快捷方式**；数据 AI 可读 JSON。
- 环境：Windows 11（Win10 尽力）；**Electron 43.3.0**；打包 **electron-builder 25**。
- 质量约束：启动 ≤5s；常驻 ≤200MB；离线；UI 无第三方框架。
- 非目标（本期）：云同步、多用户、历史视图、报表、自动更新、代码签名。

## 2. 产品交互

- 流程：启动 → 悬浮球 → 单击开面板 → 计划/已办编辑 → 写 JSON → 托盘退出。
- 悬浮球：56px；可拖；**靠近工作区边缘吸附**；缩进后露约 6px 细边；悬停滑出约 72% 直径，移开延时缩回。
- 面板：约 360×560；磨砂/半透明；Esc 或再点球收起；不抢焦点（日常）。
- 托盘：显示/隐藏球、开机自启、退出；Win11 上 Electron.Tray 不稳时走 **wscript → STA PowerShell NotifyIcon**（`scripts/tray-host.ps1`）。

## 3. 结构与数据

### 3.1 模块

| 路径 | 职责 |
|---|---|
| `app/main.js` | 双窗口、拖拽/吸附、IPC、JSON 原子写与 watch、托盘拉起、单实例锁、开机自启 |
| `app/preload.js` | contextIsolation 白名单桥 |
| `app/renderer.js` + `index.html` + `style.css` | 计划/已办 UI、设置 |
| `app/ball.html` + `ball.js` | 悬浮球渲染与拖拽/悬停上报 |
| `app/assets/` | icon / tray 图标（扁平蓝底白勾） |
| 根 `package.json` | electron-builder：NSIS、桌面/开始菜单快捷方式、`extraResources` 打入托盘脚本 |
| `scripts/setup-runtime.ps1` | 开发：解压 Electron → `runtime\`，生成 `DesktopPlanner.exe` |
| `scripts/tray-host.ps1` + `start-tray-host.vbs` | 托盘兜底 |
| `scripts/afterPack.js` | 关闭 asar 完整性 fuse |
| `scripts/make-portable.ps1` | 干净便携包（不经 builder 改 exe）→ `dist/portable` |
| `scripts/run-dist.js` | 带本地 cache/tmp 调 builder |

### 3.2 数据路径

- **打包后**（`app.isPackaged`）：`文档\悬浮工作台\`（含 `workboard.json`、`appdata\`）
- **开发**：`项目\data\`
- 模型：requirements.md §5；`settings` 含 opacity / theme / autostart / ballPosition / ballDock

### 3.3 安全

- `contextIsolation` + `sandbox` + CSP 仅自身资源；无网络；渲染层不触盘。

## 4. 交付与构建

- 目标产物：`dist/悬浮工作台-Setup-*.exe`（NSIS，`createDesktopShortcut: always`）
- 可执行文件名：`DesktopPlanner.exe`（便于 Win11 通知区识别）
- 构建：`npm run dist`（见 README）
- 开发启动：`runtime\DesktopPlanner.exe` + `app\`；VBS 须 **ASCII**（UTF-8 中文会编译失败）

## 5. ADR 摘要

- ADR-001 Electron 43.3.0  
- ADR-002 UI = vanilla JS；构建依赖 = electron-builder  
- ADR-003 面板半透明：CSS + 可选 acrylic  
- ADR-004 正式交付 = NSIS + 桌面快捷方式；数据在「文档\悬浮工作台」；绿文件夹仅开发  
- ADR-005 托盘 = WinForms/PowerShell 兜底（Electron.Tray 在 Win11 不可靠）  
- ADR-006 未签名构建须在 afterPack 关闭 `EnableEmbeddedAsarIntegrityValidation`，否则可能进 JS 前秒退  

## 6. 已知未闭环问题（暂停点）

1. SmartScreen 拦截未签名 Setup / exe  
2. NSIS 安装时写入 Uninstall 程序偶发「不能打开要写入的文件」（Defender 占用嫌疑）  
3. 打包/解压版在部分环境下退出码 `-2147483645` 且无 `desktop-planner-early.log`（进 JS 前失败）；Cursor 终端内启动不可作为判据  
4. 便携包 `scripts/make-portable.ps1` 与 `启动-便携版.vbs` 已备，待资源管理器侧复测  

续做建议顺序：资源管理器验证便携版 → 稳定后再 `npm run dist` → 自定义安装目录绕开 Programs 锁文件 → 有证书再签名。

## 7. 设计评审

- 需求覆盖：REQ-001~008 代码侧基本具备；**REQ-008 安装验收未通过**。  
- 本文随实现更新；暂停期间以代码 + README「当前状态」为准。
