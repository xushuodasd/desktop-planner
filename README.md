# 悬浮工作台（desktop-planner）

一句话简介：Win11 桌面悬浮工作计划板——桌面常驻一个精致的悬浮球，点击展开半透明毛玻璃面板，逐行记录"今日计划"与"已办"，数据以本地 JSON 存储、AI 程序可直接读写。免安装、离线、无广告。

## 快速开始（双击即用）

1. 首次使用：在项目根目录运行一次运行时准备脚本（本机已有 Electron 缓存，全程不联网）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup-runtime.ps1
   ```

   脚本会从本机缓存解压 Electron 43.3.0 到 `runtime\`，并生成"启动悬浮工作台"快捷方式。

2. 之后双击 **启动悬浮工作台**（快捷方式 `.lnk`，或备用方式 `启动悬浮工作台.vbs`）即可：
   - 桌面出现悬浮球（56px，按住可拖动，位置自动记忆）；
   - 单击悬浮球展开半透明面板（360×560，不抢焦点）；再点悬浮球或按 `Esc` 收起；
   - 面板上半区为"今日计划"，输入"时间段 + 事项"回车即新增一行；勾选完成自动转入"已办"并记录完成时刻；
   - 面板下半区为"已办"，可手动补记、删除、撤销回计划区；
   - 设置行可调面板透明度（60%–100%）与主题（跟随系统/深/浅）。

## 数据文件：`data/workboard.json`（AI 可直接读写）

数据保存在软件目录下的 `data/workboard.json`（UTF-8），每次修改即时保存（原子写：临时文件+替换）。**AI 程序可以直接读写该文件**：以 `days.<日期>` 为单位整理、分析每日工作；程序会监听外部修改并自动重载界面（读入时校验，非法字段忽略；JSON 损坏时自动备份为 `.bak` 后重建并提示）。

```json
{
  "schemaVersion": 1,
  "app": "desktop-planner",
  "days": {
    "2026-11-17": {
      "plans": [
        { "id": "p-1731810000000", "time": "9:00-10:00", "text": "开会",
          "createdAt": "2026-11-17T09:00:00+08:00" }
      ],
      "dones": [
        { "id": "d-1731813600000", "time": "9:00-10:00", "text": "面试",
          "source": "manual", "completedAt": "2026-11-17T10:00:00+08:00" }
      ]
    }
  },
  "settings": { "opacity": 0.85, "theme": "auto", "autostart": false,
                "ballPosition": { "x": 100, "y": 200 } }
}
```

- `plans`：当日计划行（时间段 `time` + 事项 `text`，`createdAt` 为创建时刻）；
- `dones`：当日已办行（`source: manual|from-plan` 区分手动补记与计划勾选流转；`completedAt` 为完成时刻）；
- `settings`：界面与行为设置（面板透明度、主题、开机自启、悬浮球位置）；
- `schemaVersion`：数据结构版本，预留升级。

## 托盘、退出与开机自启

- 程序常驻系统托盘（蓝色对勾球图标）：托盘右键菜单 = **显示/隐藏悬浮球**、**开机自启**（开关，默认关）、**退出**；单击托盘图标可快速开合面板。
- 收起面板不会退出程序；彻底退出请使用托盘菜单的"退出"。
- "开机自启"开关即时生效（用户级设置，无需管理员权限）；开启后下次开机自动启动悬浮球。

## 目录结构

```
desktop-planner/
├─ app/                        应用本体（主进程 main.js + 预加载 preload.js + 渲染层）
│  ├─ assets/                  应用图标（icon.png / icon.ico）
│  └─ package.json
├─ scripts/
│  ├─ setup-runtime.ps1        从本机 Electron 缓存准备 runtime\ 并生成快捷方式
│  └─ gen-icons.py             图标生成脚本（Pillow，开发期工具）
├─ runtime/                    Electron 运行时（setup 脚本生成，不入库）
├─ data/                       数据目录（workboard.json，不入库、随文件夹保留）
├─ 启动悬浮工作台.lnk          setup 脚本生成
└─ 启动悬浮工作台.vbs          备用免控制台启动方式
```

安全说明：渲染层 `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`，CSP 仅允许自身资源；全程无任何网络请求、无远程内容。
