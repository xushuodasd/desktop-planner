# 架构与设计 —— 桌面悬浮工作计划板（desktop-planner）

> 状态：**已批准（总监决策）**；版本：v1.0；负责人：研发总监；更新：2026-11-17
> 需求关联：requirements.md v0.1（REQ-001~008）；授权依据：老板 2026-11-17 一次性批准一期范围并授权总监定技术、直达可验收交付。

## 1. 设计目标与边界
- 关联需求：REQ-001~008（requirements.md v0.1）。本期目标：免安装、双击即用、纯本地的 Win11 悬浮待办工具，数据为 AI 可读 JSON。
- 环境：Windows 11（兼容 Win10 尽力而为）；Node v24.20.0 / npm 11.19.0 已装；**Electron 锁定 43.3.0**（本机已有完整缓存 zip，零网络依赖）；无 Rust/.NET。
- 质量约束：启动 ≤5s；常驻内存 ≤200MB；离线运行；无第三方 UI 框架（降低供应链与体积风险）。
- 非目标：云同步、多用户、历史视图、报表、自动更新、打包成单文件安装器。

## 2. 产品交互与流程
- 使用流程：双击启动 → 桌面出现悬浮球 → 单击展开半透明面板 → 上半区"今日计划"逐行录入（时间段+事项）→ 勾选完成自动转入下半区"已办"（或直接在已办区手动补记）→ 数据即时写入 data/workboard.json → 托盘退出。
- 界面清单：悬浮球窗口（56px 圆形）、主面板窗口（约 360×560：日期头 + 计划区 + 已办区 + 底部输入行）、托盘菜单（显示/隐藏悬浮球、开机自启开关、退出）。
- 交互状态：空状态（引导文案"添加今天第一行计划"）；文件被外部修改 → 自动重载；JSON 损坏 → 备份为 .bak 后以空数据重建并提示。
- 可用性：中文字体（微软雅黑/Segoe UI Variable）；面板半透明度 60%–100% 可调（设置滑杆，持久化）；Esc 或点击悬浮球收起。

## 3. 结构与数据
- 上下文：单机单用户；信任边界仅本机文件；无网络、无遥测。
- 模块职责（Electron 双窗口 + 预加载桥）：
  - `app/main.js` 主进程：创建悬浮球窗（frameless/transparent/alwaysOnTop/skipTaskbar/可拖拽）与面板窗（frameless/transparent/alwaysOnTop）；托盘；单实例锁；JSON 读写（原子写：tmp+rename）+ 文件监听（外部修改→广播重载）；开机自启（app.setLoginItemSettings，用户级无需管理员）。〔对应 REQ-001/002/006/007〕
  - `app/preload.js`：contextIsolation 桥，仅暴露 data:load/save、settings:get/set、panel:toggle 等白名单 IPC。
  - `app/renderer.*`：纯 HTML/CSS/JS UI（无框架）：计划/已办双区、增删改、勾选流转、设置（透明度/主题跟随系统）。
  - `app/assets/`：悬浮球与托盘图标（.ico/.png，渐变球+对勾母题）。
  - `scripts/setup-runtime.ps1`：从本机 electron 缓存提取 v43.3.0 → `runtime/`；生成"启动悬浮工作台"快捷方式（.lnk + 备用 .vbs）。〔对应 REQ-008〕
- 数据模型：见 requirements.md §5（workboard.json v1：days.<日期>.plans[]/dones[]，settings；UTF-8；schemaVersion 字段预留升级）。
- 接口契约：IPC 白名单（invoke/handle），渲染层永不直接触盘；JSON 字段校验：读入时忽略非法字段并保留原值，不静默丢数据。
- 数据迁移：一期无迁移；schemaVersion 预留；删除软件文件夹即数据随 `data/` 一并带走（可备份）。

## 4. 运行与安全
- 本地运行：`runtime\electron.exe app`（快捷方式封装）；前置条件=Windows 10/11 x64；停止=托盘退出；全程离线。
- 配置与密钥：无密钥；设置存 workboard.json settings 节。
- 安全措施：contextIsolation=true、nodeIntegration=false、sandbox=true、CSP 仅允许自身资源；无远程内容加载；文件操作限定 app 目录 data/ 内。
- 故障处理：JSON 损坏自动 .bak+重建并界面提示；单实例锁防重复启动；崩溃即退出（无守护），重开即可；数据写入原子化，断电最多丢最后一次未保存修改。
- 协作：本地 Git 仓库（无远端、不推送）；main 受保护由总监集成；任务走 feat/ 分支 + worktree；本地检查留证替代 CI。

## 5. 权衡与扩展（ADR 摘要）
- ADR-001 Electron 43.3.0（锁定缓存版本）：✅ 零网络依赖、Win11 透明/置顶/托盘能力成熟；代价=内存约 150–200MB。被否方案：Tauri（需装 Rust 工具链，网络+授权双风险）、Python+PySide6（UI 精美度与打包可靠性差）。
- ADR-002 无构建工具链（零 npm 依赖，vanilla JS）：✅ 供应链风险为零、可维护；代价=无 TS 类型检查（二期可加）。
- ADR-003 面板半透明：CSS rgba 为基线（保底必现）；`setBackgroundMaterial('acrylic')` try/catch 增强（Win11 真毛玻璃，失败静默回退）。
- ADR-004 交付形态=绿色文件夹+快捷方式（不打包安装器）：✅ 免管理员、可删可移；代价=首次启动需运行 setup-runtime.ps1（总监集成时执行）。
- 技术债：无；扩展点：schemaVersion、数据文件位置、主题系统均为二期预留。

## 6. 设计评审
- 评审范围：需求一致性（REQ-001~008 全覆盖）、安全（本地单机，无远端攻击面）、数据（原子写+外部编辑兼容+损坏恢复）。
- 批准：总监 2026-11-17（授权依据见文件头）；实现偏离时更新本文并记录。
