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
- 贴顶自动隐藏（QQ 式）：拖到离工作区顶端 `DOCK_SNAP=26` 内吸顶并向上收起。收起后隐藏主窗口，只显示 104 × 4 的短细条。鼠标在细条停留 90ms 后滑出（460ms），离开 650ms 后收起（400ms）。动画可从当前位置反向。往下拖超过 `UNDOCK_DIST=46` 解除吸顶。主进程按 140ms 轮询实际光标位置。
- 显隐：托盘图标左键切换；面板内 Esc 收起；托盘右键菜单「打开/收起面板、开机自启、设置…、退出」。
- 透明度：独立设置窗口中调节，默认 **50%**、范围 **20%–100%**（主进程 clamp 0.2–1）；CSS `--glass: calc(0.16 + var(--panel-alpha) * 0.72)`。
- 透明窗口：`transparent: true` + 透明 backgroundColor，透明度完全由 CSS 决定，**失去焦点也保持透明**；原因是 Windows 的 `backgroundMaterial: 'acrylic'` 在失焦时会退化为实色。代价是无窗口背后的磨砂模糊；圆角改为 CSS 绘制（v0.3 为 20px，v0.5 起为 24px），无 DWM 阴影。
- 托盘：Win11 上 Electron.Tray 常不进入通知区，走 **wscript → STA PowerShell NotifyIcon** 兜底（`scripts/tray-host.ps1`）。
- 时间输入（v0.5）：每条记录只有一个时间点，不再是起止时间段。底部时间文字默认取当前时刻并按 5 分钟向上取整；点击在输入卡内就地展开「小时 / 分钟」滚轮（分钟 0/5/…/55，`scroll-snap` 吸附），滚动即更新、滑动即生效；点时间文字、输入卡外部或按 Esc 收起；不再有自由文本时间输入。
- 长文本（v0.5）：列表行单行省略；仅当正文实际溢出（`scrollWidth > clientWidth`）时正文可点，点击就地展开为多行、再次点击收回；展开期间复选框 / 时间 / 操作按钮顶部对齐；不弹窗、不跳转。
- 行内编辑（v0.5）：点「编辑」后原行替换为一张编辑卡（不弹窗）——时间芯片（点击在卡内展开与底部同一套滚轮）、自动增高到 116px 的多行文本框（`Enter` 保存 / `Shift+Enter` 换行 / `Esc` 取消）、右下角「取消 / 保存」文字按钮；卡片高度变化有 260ms 阻尼过渡。
- 视觉体系（v0.5，Obsidian Glass）：玻璃材质 = 渐变底 + 顶部 1px 内高光 + 1px 内描边 + 外投影四层叠加；圆角阶梯 面板 24 / 卡片 18 / 控件 13（内圆角 = 外圆角 − 内边距，保持同心）；全界面单一强调色（蓝）只用于选中态与时间；动效统一 `cubic-bezier(0.32,0.72,0,1)`，输入卡展开 300ms、行入场 340ms、勾选淡出 200ms。

## 3. 结构与数据

### 3.1 模块

| 路径 | 职责 |
|---|---|
| `app/main.js` | 单面板窗口、拖动/吸顶、IPC、JSON 原子写与 watch、托盘拉起、单实例锁、开机自启 |
| `app/preload.js` | contextIsolation 白名单桥 |
| `app/renderer.js` + `index.html` + `style.css` | 计划/已办 UI |
| `app/settings.html` + `settings.js` | 独立设置窗口（透明度 / 主题 / 开机自启） |
| `app/review.html` + `review.js` | 独立回顾窗口（日/周/月、搜索、导出） |
| `app/assets/` | icon / tray 图标（方案 A「玻璃卡片」，由 `scripts/make-icons.py` 生成） |
| 根 `package.json` | electron-builder：NSIS、桌面/开始菜单快捷方式、`extraResources` 打入托盘脚本 |
| `scripts/setup-runtime.ps1` | 开发：解压 Electron → `runtime\`，生成 `DesktopPlanner.exe` |
| `scripts/tray-host.ps1` + `start-tray-host.vbs` | 托盘兜底 |
| `scripts/afterPack.js` | 用缓存里的 rcedit 把 `icon.ico` 写进 exe，再关闭 asar 完整性 fuse（`signAndEditExecutable: false` 时图标不会自动写入） |
| `scripts/make-icons.py` | Pillow 程序化绘制图标（4x 超采样、同心圆角、玻璃渐变 alpha），输出 `icon.png/ico` 与托盘版 |
| `scripts/installer.nsh` | 安装时创建 `%APPDATA%\desktop-planner\appdata`，并给快捷方式追加启动参数 |
| `scripts/make-portable.ps1` | 干净便携包（不经 builder 改 exe）→ `dist/portable` |
| `scripts/run-dist.js` | 带本地 cache/tmp 调 builder；构建前清理上次 blockmap/latest.yml，成功后统一设 Medium 完整性 |

### 3.2 数据路径

- **打包后**（`app.isPackaged`）：工作数据在 `文档\悬浮工作台\workboard.json`（只存设置）+ `文档\悬浮工作台\months\YYYY-MM.json`（每月明细）；v1 迁移前会留 `workboard.v1.bak`（首次迁移时创建，仅保留最早一份）；Chromium userData 固定为 `%APPDATA%\desktop-planner\appdata`（纯 ASCII，需预先创建）
- **开发**：`项目\data\workboard.json` + `项目\data\months\` + `项目\data\appdata\`
- 模型：requirements.md §5；`settings` 含 opacity（默认 0.5，clamp 0.2–1）/ theme / autostart / panelPosition
- 读写：`data:load` 返回未完成待办、当天已办与设置。`task:change` 按原日期和事项 ID 更新一条记录。回顾通过 `history:query` 和 `history:export` 按完成日查询、导出已办。
- 监听：根文件或月分片被外部修改时刷新面板；月分片更新同时刷新回顾。

### 3.3 安全

- `contextIsolation` + CSP 仅自身资源；无网络；渲染层不触盘。
- 本机必须 `--no-sandbox`（Chromium 沙箱初始化崩溃 `0x80000003`），因此 Chromium 沙箱不可用，这是已知妥协。

## 4. 交付与构建

- 目标产物：`dist/desktop-planner-Setup-*.exe`（NSIS，`createDesktopShortcut: always`）。产物名必须 ASCII：中文名会让 NSIS 报 `Can't open output file`
- 可执行文件名：`DesktopPlanner.exe`（便于 Win11 通知区识别）；产品名 / 快捷方式名 / 卸载项显示名均为「悬浮工作台」
- 构建：`npm run dist`（见 README）。`scripts/run-dist.js` 用项目内 `.electron-cache/.electron-builder-cache/.tmp`，构建前把 `dist` 设低完整性并删除上次的 `.blockmap` / `latest.yml`（残留 Medium 标签会导致 `Access is denied`），成功后统一设为 **Medium**（工作区曾感染低完整性标签，导致打包 exe 异常）
- 图标：`win.signAndEditExecutable: false`（避免下载 winCodeSign 时 macOS 软链接解压失败），因此 exe 图标由 `scripts/afterPack.js` 用缓存 rcedit 手工写入，再执行 flipFuses；安装包与卸载器图标由 `MUI_ICON` 指定 `app/assets/icon.ico`
- 开发启动：`runtime\DesktopPlanner.exe --no-sandbox "--user-data-dir=<项目>\data\appdata" "<项目>\app"`；VBS 须 **ASCII**（UTF-8 中文会编译失败）
- 启动参数（本机必须）：`--no-sandbox`（Chromium 沙箱初始化崩溃 `0x80000003`）+ `--user-data-dir` 指向纯 ASCII 路径且目录需预先创建（Chromium 不会自动创建）
- 安装包：`scripts/installer.nsh` 在安装时创建 `%APPDATA%\desktop-planner\appdata`，并给桌面/开始菜单快捷方式追加上述参数
- 升级：`appId` 固定 → NSIS 原地升级（先卸旧程序文件再装新版），快捷方式/卸载项不重复；工作数据在「文档\悬浮工作台」，与安装目录解耦；单实例锁防止新旧进程同时运行。若安装时手工改到别的目录，旧目录文件可能残留（数据不会分叉）

## 5. ADR 摘要

- ADR-001 Electron 43.3.0  
- ADR-002 UI = vanilla JS；构建依赖 = electron-builder  
- ADR-003 面板半透明：CSS + 可选 acrylic。（**已更新**）`backgroundMaterial: 'acrylic'` 在 Windows 失焦时退化为实色，现改为 `transparent: true` + CSS 透明度，失去焦点仍透明；圆角由 CSS 20px 绘制（无 DWM 阴影），代价是无磨砂模糊  
- ADR-004 正式交付 = NSIS + 桌面快捷方式；数据在「文档\悬浮工作台」；绿文件夹仅开发  
- ADR-005 托盘 = WinForms/PowerShell 兜底（Electron.Tray 在 Win11 不可靠）  
- ADR-006 未签名构建须在 afterPack 关闭 `EnableEmbeddedAsarIntegrityValidation`，否则可能进 JS 前秒退  
- ADR-007 移除悬浮球，改为单面板 + 贴顶自动隐藏（v0.3）：`app/ball.html` / `ball.js` / `ball:*` IPC / `settings.ballPosition / ballDock` 已删除；位置改用 `settings.panelPosition`  
- ADR-008 启动必须带 `--no-sandbox` + ASCII `--user-data-dir`（`%APPDATA%\desktop-planner\appdata`，预先创建）；安装包快捷方式固化该参数  
- ADR-009 明细按月分片（v2）：上班族每天记录会无限累积，单文件会越写越大；改为根文件只存设置 + `months/YYYY-MM.json` 存明细，面板只加载当天，回顾窗口按范围读取命中月份；明细永久保留，v1 数据启动时自动迁移
- ADR-010 时间用滚轮而非文本（v0.5）：手写「9:00-10:00」既慢又格式不统一，改为单时间点 + 小时/分钟滚轮（5 分钟刻度），默认当前时刻；代价是不再记录起止区间（日报场景只关心「几点做了什么」）
- ADR-011 长文本行内展开，不弹窗（v0.5）：列表保持单行节奏，仅溢出项可点；展开/收起在行内完成，避免弹层打断浏览，也不额外增加「详情」按钮
- ADR-012 空状态显隐必须显式写 `[hidden]`（v0.5）：`.empty` 的 `display:flex` 会覆盖 UA 的 `[hidden]{display:none}`，导致有数据仍显示空态；凡自定义 display 的可隐藏元素，都要补 `xxx[hidden]{display:none}`
- ADR-013 删除必须二次确认，且用行内确认（v0.5）：直接删除误触成本高，系统 `confirm`/模态框既丑又打断；改为该行就地变为「删除这条记录？取消/删除」，3.5s 无操作自动还原，点外部或 Esc 也还原
- ADR-014 视觉与交互规则文档化（v0.5）：把令牌、组件、动效、禁止项沉淀到 `docs/ai-team/design-system.md`，作为强制规范，防止后续改动（含 AI 生成）退回低质量默认样式
- ADR-015 贴顶滑动改为「缓动 + 惯性 + 悬停意图」（v0.5）：原来的 8 步线性位移（约 112ms）生硬且无收势；改为时间基准 16ms 帧驱动，滑出 280ms `easeOutExpo`、收起 220ms `easeInCubic`，可反向打断；细边悬停 90ms 才弹出；渲染层叠加 5–7px 内容惯性。代价是主进程多一个定时器与一次跨进程状态广播
- ADR-016 品牌图标必须在 afterPack 手工写入 exe（v0.6）：`signAndEditExecutable: false` 时 electron-builder 不会改 exe 资源，图标永远是 Electron 默认；打开它又会触发 winCodeSign 下载与 macOS 符号链接解压失败。改为 `afterPack` 里用缓存中的 `rcedit-x64.exe` 写 `icon.ico`，随后 `flipFuses` 关闭 asar 完整性；两个 exe 均已反提取验证图标
- ADR-017 升级安全：迁移前备份 + 失败不落盘（v0.6）：覆盖安装本身由固定 `appId` 保证原地升级，真正风险在数据格式迁移。规定：迁移前复制 `workboard.v1.bak`（仅首次）、迁移抛错时不重写根文件并保留内存旧数据（下次启动重试）。保证「装新包」在任何失败路径下都不会清掉旧记录

- ADR-018 列表优先展示事项正文。已办行的完成时间和操作按钮共用右侧布局区域，悬停和聚焦时正文宽度保持稳定，右侧区域需容纳两者中较宽的内容。回顾日视图合并日期与统计，周/月保留每日小计；回顾列表底色提高遮盖度，以减弱壁纸对文字对比度的影响。
- ADR-019 时间滚轮支持左键操作。底部输入和行内编辑共用指针拖动逻辑，拖动期间暂停吸附，释放后对齐最近刻度。相邻刻度可单击选择，鼠标滚轮继续走原生滚动。
- ADR-020 贴顶动效由窗口位移统一驱动（取代 ADR-015 的内容惯性）。滑出和收起采用两端减速的曲线，内容随窗口同步移动。动画反向时按剩余距离缩短时长，离开延迟用于容忍短暂移出。
- ADR-021 跨天待办以添加日保存，主面板汇总未完成事项。完成和撤销只原子更新原日分片，已办视图通过完成日期归档，旧记录沿用原有日期。定位保护期结束后检查位置，补处理期间完成的拖动。
- ADR-022 收起完成后隐藏主窗口，改用独立、鼠标穿透的短细条作为悬停触发标记。工作区顶边偏移或缩放时，主面板底部也不会留在屏幕上。
- ADR-023 主面板定位与贴顶动画统一提交 360 × 560 的完整窗口边界。收到系统尺寸变更后按原位置恢复尺寸，避免原生窗口移动带来的宽高漂移。

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

- 需求覆盖：REQ-001~010 代码侧具备；便携版启动与贴顶隐藏已实测可用，**REQ-008 待全新机器安装验收**（当前交付版本 1.0.1）。  
- **UI 改动的强制规范见 [design-system.md](design-system.md)**：视觉令牌、组件、动效、删除确认、禁止清单与提交前自检，任何界面改动先读该文。
- 本文随实现更新；以实现代码 + README「当前状态」为准。
