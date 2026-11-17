# 悬浮工作台（desktop-planner）

Win11 桌面悬浮工作计划板：常驻悬浮球、半透明面板、本地 JSON（方便 AI 读写）、离线无账号。

## 当前状态（2026-11-17）

| 项 | 状态 |
|---|---|
| 核心功能（计划/已办/托盘/磨砂面板） | 已实现 |
| 四边吸附 / 细边缩进 / 悬停滑出 | 已实现（代码在 `app/main.js`） |
| 扁平苹果风对勾图标 | 已实现 |
| NSIS 安装包流水线 | 已配置（`npm run dist`） |
| 本机安装/启动验收 | **未完成**（SmartScreen、安装写文件失败、打包 exe 秒退等问题未闭环，已暂停） |

下文「开发 / 打包」供续做时使用；用户验收请等工作稳定后再发安装包。

## 数据位置

| 运行方式 | 数据文件 |
|---|---|
| 安装包 / 便携打包（`app.isPackaged`） | `%USERPROFILE%\Documents\悬浮工作台\workboard.json` |
| 开发绿文件夹 | 项目根 `data\workboard.json` |

## 开发调试

```powershell
# 首次：准备 Electron 43.3.0 到 runtime\
powershell -ExecutionPolicy Bypass -File scripts\setup-runtime.ps1

# 启动（推荐在资源管理器双击，勿在 Cursor 终端里起 Electron）
# 启动悬浮工作台.vbs  或  启动.bat
```

开发态：`runtime\DesktopPlanner.exe` + 参数指向 `app\`。

**注意：** 在 Cursor / 部分自动化终端里启动 Electron 常会得到退出码 `-2147483645` 并秒退，属环境限制，不代表程序逻辑一定坏了。请用资源管理器双击 VBS/BAT 验证。

## 打包

```powershell
npm install --registry https://registry.npmmirror.com
npm run dist          # NSIS → dist\悬浮工作台-Setup-*.exe
npm run dist:dir      # 仅解压目录 → dist\win-unpacked\
```

辅助脚本：

- `scripts/run-dist.js`：使用项目内 `.electron-cache` / `.tmp`，避开 AppData 权限问题
- `scripts/afterPack.js`：关闭 asar 完整性 fuse（未签名构建必要）
- `scripts/make-portable.ps1`：不经 builder 改 exe，从 `runtime\` 拷贝干净便携包 → `dist\portable\`

已知打包/安装坑（续做时优先看）：

1. 未签名 → SmartScreen「仍要运行」
2. NSIS 写入 `Uninstall DesktopPlanner.exe` 可能被 Defender 占用
3. builder 默认 asar integrity + `signAndEditExecutable: false` 组合曾导致进 JS 前秒退（已用 afterPack 关 fuse；便携脚本可绕过）
4. VBS 必须 ASCII，UTF-8 中文会 `800A0408 无效字符`

## 功能摘要

- 悬浮球拖动；靠近边缘吸附；缩进后露细边；悬停滑出大半、移开缩回
- 单击开合面板；托盘（WinForms 兜底）开合 / 开机自启 / 退出
- 今日计划 ↔ 已办；透明度与主题设置
- 数据原子写 + 外部修改自动重载

## 目录结构

```
desktop-planner/
├─ app/                      应用本体
├─ scripts/                  setup / 托盘宿主 / 图标 / 打包辅助
├─ package.json              electron-builder 入口
├─ docs/ai-team/             需求与设计
├─ dist/                     构建产物（不入库）
├─ runtime/                  开发用 Electron（不入库）
└─ data/                     开发态数据（不入库）
```

更细的架构与 ADR 见 [docs/ai-team/design.md](docs/ai-team/design.md)；需求条目见 [docs/ai-team/requirements.md](docs/ai-team/requirements.md)。
