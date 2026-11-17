'use strict';

/**

 * 悬浮工作台（desktop-planner）主进程

 * - 主面板窗口（360×560，启动时显示并进入任务栏）

 * - 托盘（打开/收起面板、设置、开机自启、退出）+ 单实例锁

 * - 数据：data/workboard.json（UTF-8，原子写 tmp+rename），fs.watch 监听外部修改（自身写入守卫防回环）

 * - 安全：渲染层 contextIsolation + sandbox，全部走白名单 IPC，主进程之外不触盘

 * 对应 REQ-001/002/004/006/007/008；设计见 docs/ai-team/design.md

 */

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog } = require('electron');

const fs = require('fs');

const path = require('path');

const os = require('os');



function earlyLog(msg) {

  try {

    fs.appendFileSync(

      path.join(os.tmpdir(), 'desktop-planner-early.log'),

      `${new Date().toISOString()} ${msg}\n`,

    );

  } catch (e) { /* ignore */ }

}

earlyLog(`enter main.js electron=${process.versions.electron || '?'} exec=${process.execPath}`);



const APP_DIR = __dirname; // 开发：<绿文件夹>\app；打包：app.asar 内

const IS_PACKAGED = app.isPackaged;

earlyLog(`packaged=${IS_PACKAGED} dirname=${APP_DIR}`);

/** 安装目录（打包）或绿色文件夹根（开发） */

const ROOT_DIR = IS_PACKAGED ? path.dirname(process.execPath) : path.dirname(APP_DIR);

/** 托盘脚本等：打包后在 resources\scripts */

const SCRIPTS_DIR = IS_PACKAGED

  ? path.join(process.resourcesPath, 'scripts')

  : path.join(ROOT_DIR, 'scripts');

/**

 * 工作数据目录：

 * - 安装包：文档\悬浮工作台\

 * - 开发/绿色文件夹：项目根\data\

 * 必须在 requestSingleInstanceLock 之前定好（userData 锁文件依赖它）。

 */

const DATA_DIR = IS_PACKAGED

  ? path.join(app.getPath('documents'), '悬浮工作台')

  : path.join(ROOT_DIR, 'data');

const DATA_FILE = path.join(DATA_DIR, 'workboard.json');

const BAK_FILE = DATA_FILE + '.bak';
/** 按月分片目录：months/YYYY-MM.json（每天一条明细，明细永久保留） */
const MONTHS_DIR = path.join(DATA_DIR, 'months');
const SCHEMA_VERSION = 2;

const BOOT_LOG = path.join(DATA_DIR, 'boot.log');

const ICON_ICO = path.join(APP_DIR, 'assets', 'icon.ico');

const ICON_PNG = path.join(APP_DIR, 'assets', 'icon.png');

const TRAY_ICO = path.join(APP_DIR, 'assets', 'tray-win.ico');

const TRAY_PNG = path.join(APP_DIR, 'assets', 'tray-win.png');

const TRAY_ICO_FALLBACK = path.join(APP_DIR, 'assets', 'tray.ico');

const TRAY_PNG_FALLBACK = path.join(APP_DIR, 'assets', 'tray.png');



function bootLog(msg) {

  earlyLog(msg);

  try {

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${msg}\n`);

  } catch (e) { /* ignore */ }

}

bootLog(`boot pid=${process.pid} packaged=${IS_PACKAGED} electron=${process.versions.electron || '?'} data=${DATA_DIR}`);

process.on('uncaughtException', (err) => {

  bootLog(`uncaughtException ${err && err.stack ? err.stack : err}`);

});

process.on('unhandledRejection', (err) => {

  bootLog(`unhandledRejection ${err && err.stack ? err.stack : err}`);

});



const PANEL_W = 360;

const PANEL_H = 560;

const DOCK_STRIP = 6; // 吸顶隐藏后仍留在屏幕内的细边高度
const DOCK_SNAP = 26; // 拖到离屏幕顶端这么近就吸进去
const UNDOCK_DIST = 46; // 往下拖超过这个距离解除吸顶

const RELOAD_DEBOUNCE_MS = 250;






// Chromium 用户数据必须放在纯 ASCII 路径：本机 Windows 26H2 下，若 userData 目录
// 不存在或包含中文（如 文档\悬浮工作台\appdata），Chromium 的 ProcessSingleton
// 无法创建锁文件（Error 3/5），Electron 会在加载页面之前直接退出。
// 注意：工作数据仍保存在 DATA_DIR（文档\悬浮工作台），这里只放 Chromium 缓存。
const CHROMIUM_DATA_DIR = IS_PACKAGED
  ? path.join(app.getPath('appData'), 'desktop-planner', 'appdata')
  : path.join(ROOT_DIR, 'data', 'appdata');
try {
  if (!fs.existsSync(CHROMIUM_DATA_DIR)) fs.mkdirSync(CHROMIUM_DATA_DIR, { recursive: true });
} catch (e) { /* ignore */ }
app.setPath('userData', CHROMIUM_DATA_DIR);



let panel = null;
let settingsWin = null; // 独立设置窗口（托盘右键「设置…」打开）
let reviewWin = null; // 独立回顾窗口（托盘右键「回顾…」打开）

let tray = null;

let trayHost = null; // WinForms 托盘兜底进程（Win11 上 Electron.Tray 常不进通知区）

let isQuitting = false;

let board = null; // 内存中的合法数据（已校验）

let lastOwnWrite = null; // { text } 自身最近一次写入内容，用于外部修改守卫

let reloadTimer = null;

let suppressPanelSync = false; // 程序化定位面板期间忽略 move 事件（防误写位置/误吸顶）

let panelPosTimer = null; // 面板位置落盘防抖
let panelDock = null; // { docked, revealed }：贴顶隐藏状态
let panelAnimating = false; // 滑入/滑出动画进行中，忽略 move 事件
let dockCheckTimer = null;
let dockHideTimer = null;
let dockSlideTimer = null;

let watcher = null;
let monthWatcher = null; // months/ 目录监听（外部改月份分片时刷新面板/回顾窗口）

let watcherRetries = 0;



/* ---------------------------------- 通用工具 ---------------------------------- */



function isObj(v) {

  return v !== null && typeof v === 'object' && !Array.isArray(v);

}

function isStr(v) {

  return typeof v === 'string';

}

function clamp(n, min, max) {

  return Math.min(max, Math.max(min, n));

}



/** 默认数据（REQ-006 §5 数据模型） */

function defaultBoard(panelPos) {

  return {

    schemaVersion: SCHEMA_VERSION,

    app: 'desktop-planner',

    days: {},

    settings: {

      opacity: 0.5,

      theme: 'auto',

      autostart: false,

      panelPosition: panelPos || null,

    },

  };

}



/**

 * Electron 的 workArea 是 {x,y,width,height}。

 * 补上 left/top/right/bottom，避免把坐标算成 NaN（NaN 传给 setPosition 会直接崩）。

 */

function areaOf(rect) {

  const x = Number(rect && rect.x) || 0;

  const y = Number(rect && rect.y) || 0;

  const width = Number(rect && rect.width) || 0;

  const height = Number(rect && rect.height) || 0;

  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };

}



/** 面板默认位置：主屏工作区右上角（x = 右-24-360，y = 上+60） */
function defaultPanelPosition() {
  const wa = areaOf(screen.getPrimaryDisplay().workArea);
  return { x: wa.right - PANEL_W - 24, y: wa.top + 60 };
}



/** 读入校验：非法字段忽略（REQ-006 边界；不静默丢合法数据） */

function sanitizeBoard(raw, fallbackPanelPos) {

  const b = defaultBoard(fallbackPanelPos);

  if (!isObj(raw)) return b;

  b.schemaVersion = SCHEMA_VERSION;

  if (isStr(raw.app)) b.app = raw.app.slice(0, 64);

  if (isObj(raw.days)) {

    for (const key of Object.keys(raw.days)) {

      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue; // 非日期键忽略

      const day = raw.days[key];

      if (!isObj(day)) continue;

      const usedIds = new Set(); // 同一天内 id 去重（plans 与 dones 共用）

      b.days[key] = {

        plans: sanitizePlans(day.plans, usedIds),

        dones: sanitizeDones(day.dones, usedIds),

      };

    }

  }

  if (isObj(raw.settings)) {

    const s = raw.settings;

    if (typeof s.opacity === 'number' && isFinite(s.opacity)) {

      b.settings.opacity = clamp(s.opacity, 0.2, 1);

    }

    if (s.theme === 'auto' || s.theme === 'dark' || s.theme === 'light') {

      b.settings.theme = s.theme;

    }

    if (typeof s.autostart === 'boolean') b.settings.autostart = s.autostart;

    if (isObj(s.panelPosition) && isFinite(s.panelPosition.x) && isFinite(s.panelPosition.y)) {
      b.settings.panelPosition = {
        x: Math.round(s.panelPosition.x),
        y: Math.round(s.panelPosition.y),
      };
    }

  }

  return b;

}



/** 回填/去重唯一 id（P2-2）：AI/外部写入的条目可能缺 id 或空 id，

 *  渲染层按 id 定位行，缺省会导致错行；缺省则生成，与已用 id 冲突则重新生成。 */

function ensureUniqueId(rawId, kind, used) {

  let id = isStr(rawId) && rawId.trim() ? rawId.slice(0, 64) : '';

  if (!id || used.has(id)) {

    let n = 0;

    do {

      id = `${kind}-${Date.now()}-${n}`;

      n += 1;

    } while (used.has(id));

  }

  used.add(id);

  return id;

}



function sanitizePlans(list, usedIds) {

  if (!Array.isArray(list)) return [];

  const out = [];

  for (const v of list) {

    if (!isObj(v) || !isStr(v.text) || !v.text.trim()) continue;

    out.push({

      id: ensureUniqueId(v.id, 'p', usedIds),

      time: isStr(v.time) ? v.time.slice(0, 40) : '',

      text: v.text.slice(0, 200),

      createdAt: isStr(v.createdAt) ? v.createdAt.slice(0, 40) : '',

    });

  }

  return out;

}



function sanitizeDones(list, usedIds) {

  if (!Array.isArray(list)) return [];

  const out = [];

  for (const v of list) {

    if (!isObj(v) || !isStr(v.text) || !v.text.trim()) continue;

    out.push({

      id: ensureUniqueId(v.id, 'd', usedIds),

      time: isStr(v.time) ? v.time.slice(0, 40) : '',

      text: v.text.slice(0, 200),

      source: v.source === 'from-plan' ? 'from-plan' : 'manual',

      completedAt: isStr(v.completedAt) ? v.completedAt.slice(0, 40) : '',

    });

  }

  return out;

}



/* ---------------------------------- 数据存储 ---------------------------------- */



/** 启动时确保 data/workboard.json 存在（v2：只存设置，days 分片到 months/） */

function ensureDataFile() {

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {

    writeBoard(defaultBoard(defaultPanelPosition()));

  }

}



/** 原子写：tmp + rename（REQ-006；Windows 下 rename 覆盖已存在文件） */

function writeBoard(next) {

  board = next;

  // 根文件只保留设置；每日明细在 months/YYYY-MM.json
  const text = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    app: board.app,
    settings: board.settings,
  }, null, 2) + '\n';

  try {

    fs.writeFileSync(DATA_FILE + '.tmp', text, 'utf8');

    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);

  } catch (err) {

    console.error('[workboard] 原子写失败，降级直写：', err);

    try {

      fs.writeFileSync(DATA_FILE, text, 'utf8');

    } catch (err2) {

      console.error('[workboard] 直写也失败：', err2);

      return;

    }

  }

  lastOwnWrite = { text }; // 登记自身写入，供 fs.watch 守卫

}



let settingsFlushTimer = null;

let settingsDirty = false;



/** 设置类小改动防抖落盘（P2-3）：内存即时生效，300ms 内合并为一次原子写，避免滑杆写放大 */

function persistBoardSoon(delayMs = 300) {

  settingsDirty = true;

  if (settingsFlushTimer) clearTimeout(settingsFlushTimer);

  settingsFlushTimer = setTimeout(flushBoard, delayMs);

}



function flushBoard() {

  if (settingsFlushTimer) {

    clearTimeout(settingsFlushTimer);

    settingsFlushTimer = null;

  }

  if (settingsDirty) {

    settingsDirty = false;

    writeBoard(board);

  }

}



/** 从磁盘加载并校验；损坏则 .bak 备份后以空数据重建并提示（design §2） */

function loadBoardFromDisk() {

  let text = null;

  try {

    text = fs.readFileSync(DATA_FILE, 'utf8');

  } catch (err) {

    if (err && err.code === 'ENOENT') {

      ensureDataFile();

      return;

    }

    console.error('[workboard] 读取失败：', err);

    return;

  }

  if (lastOwnWrite && text === lastOwnWrite.text) return; // 自身写入回环，忽略

  let parsed;

  try {

    parsed = JSON.parse(text);

  } catch (err) {

    // JSON 损坏：备份 .bak → 重建 → 通知渲染层提示

    console.error('[workboard] JSON 损坏，备份后重建：', err);

    try {

      fs.renameSync(DATA_FILE, BAK_FILE); // rename 覆盖旧 .bak

    } catch (e) {

      console.error('[workboard] .bak 备份失败：', e);

    }

    writeBoard(defaultBoard(defaultPanelPosition()));

    broadcastData({
      settings: board.settings,
      dateKey: todayKeyMain(),
      day: readDay(todayKeyMain()),
      notice: '数据文件损坏，已备份为 workboard.json.bak 并重建',
    });

    return;

  }

  // v1 兼容：旧单文件里的 days 按月份拆分到 months/，成功后根文件只保留设置
  const legacyDays = isObj(parsed) && isObj(parsed.days) ? parsed.days : null;

  const legacyCount = legacyDays ? Object.keys(legacyDays).length : 0;

  board = sanitizeBoard(parsed, null);

  board.days = {}; // 真实明细已下沉到月分片，内存不再持有

  if (legacyCount > 0) {

    migrateLegacyDays(legacyDays);

    writeBoard(board); // 重写根文件，清掉 days

    bootLog(`migrated v1 days=${legacyCount}`);

  }

  broadcastData({ settings: board.settings, dateKey: todayKeyMain(), day: readDay(todayKeyMain()) });

}



/** fs.watch 防抖后重读文件，内容变化才广播，避免回环 */

function scheduleReload() {

  if (reloadTimer) clearTimeout(reloadTimer);

  reloadTimer = setTimeout(() => {

    reloadTimer = null;

    loadBoardFromDisk();

  }, RELOAD_DEBOUNCE_MS);

}



function startWatcher() {

  if (watcher) {

    try { watcher.close(); } catch (e) { /* ignore */ }

    watcher = null;

  }

  try {

    watcher = fs.watch(DATA_DIR, { persistent: true }, (evt, fname) => {

      if (fname && fname !== 'workboard.json') return; // 只关心数据文件本身

      scheduleReload();

    });

    watcher.on('error', () => {

      try { watcher.close(); } catch (e) { /* ignore */ }

      watcher = null;

      if (watcherRetries < 5) {

        watcherRetries += 1;

        setTimeout(startWatcher, 3000);

      }

    });

    watcherRetries = 0;

  } catch (err) {

    console.error('[workboard] fs.watch 启动失败：', err);

    if (watcherRetries < 5) {

      watcherRetries += 1;

      setTimeout(startWatcher, 3000);

    }

  }

}



function broadcastData(payload) {

  if (panel && !panel.isDestroyed()) {

    panel.webContents.send('data:onchange', payload);

  }

}



function broadcastSettings() {
  const payload = { settings: board.settings };

  if (panel && !panel.isDestroyed()) {

    panel.webContents.send('settings:onchange', payload);
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings:onchange', payload);

  }
  if (reviewWin && !reviewWin.isDestroyed()) {
    reviewWin.webContents.send('settings:onchange', payload);
  }

}



/* ---------------------------------- 开机自启（用户级） ---------------------------------- */



function loginItemOptions() {
  const loginArgs = ['--no-sandbox', `--user-data-dir=${CHROMIUM_DATA_DIR}`];

  // 自启参数与本机兼容参数保持一致（--no-sandbox + ASCII userData）

  return IS_PACKAGED

    ? { path: process.execPath, args: loginArgs }

    : { path: process.execPath, args: [APP_DIR, ...loginArgs] };

}



function applyAutostart(enabled) {

  try {

    app.setLoginItemSettings({ openAtLogin: !!enabled, ...loginItemOptions() });

    return true;

  } catch (err) {

    console.error('[workboard] 设置开机自启失败：', err);

    return false;

  }

}



function currentAutostart() {

  try {

    return app.getLoginItemSettings(loginItemOptions()).openAtLogin === true;

  } catch (err) {

    return false;

  }

}



/* ---------------------------------- 窗口 ---------------------------------- */



function commonWebPreferences() {

  return {

    preload: path.join(APP_DIR, 'preload.js'),

    contextIsolation: true,

    nodeIntegration: false,

    sandbox: true,

    spellcheck: false,

  };

}



/** Win11 真毛玻璃增强，失败静默回退 CSS rgba（ADR-003） */

function applyAcrylic(win) {

  try {

    win.setBackgroundMaterial('acrylic');

  } catch (err) {

    // Win10 / 不支持该 API：静默回退 CSS rgba 半透明

  }

}



function guardHide(e) {

  if (isQuitting) return;

  e.preventDefault();

  const w = BrowserWindow.fromWebContents(e.sender);

  if (w) {

    w.hide();

    if (w === panel) sendPanelState();

  }

}



function windowIcon() {

  // 用 png 生成多尺寸位图。直接丢 ico 路径时，任务栏经常落到糊掉的某一档，看起来只是个蓝点。

  const src = fs.existsSync(ICON_PNG) ? ICON_PNG : (fs.existsSync(ICON_ICO) ? ICON_ICO : '');

  if (!src) return undefined;

  const img = nativeImage.createFromPath(src);

  if (img.isEmpty()) return undefined;

  return img;

}




function createPanel() {

  // 不用 transparent：Windows 上透明无边框窗口会缩成几十像素，并且不进任务栏。

  // resizable 先保持 true：show:false 时系统会给一个约 30px 的占位尺寸，

  // resizable:false 会把这个错误尺寸锁死，之后 setBounds 不再生效。

  panel = new BrowserWindow({

    width: PANEL_W,

    height: PANEL_H,

    title: '悬浮工作台',

    icon: windowIcon(),

    show: false,

    frame: false,

    transparent: true,
    backgroundColor: '#00000000',

    // 不用系统 acrylic：Windows 的 acrylic 在窗口失焦时会退化成实色，
    // 看起来就是「只有聚焦时才透明」。改成逐像素透明窗口，透明度恒定不变。
    // 代价是失去窗口背后的模糊，玻璃感由 CSS 半透明底色承担。


    roundedCorners: true,

    alwaysOnTop: true,

    // 不进任务栏；常驻右下角系统托盘（通知区域）

    skipTaskbar: true,

    resizable: true,

    maximizable: false,

    minimizable: false,

    fullscreenable: false,

    hasShadow: false,

    webPreferences: commonWebPreferences(),

  });

  panel.setMenuBarVisibility(false);

  panel.loadFile(path.join(APP_DIR, 'index.html'));
  // 拖到屏幕顶端会自动收起，只留一条细边；鼠标移上去再滑出。
  panel.on('move', onPanelMove);

  panel.once('ready-to-show', () => {
    if (!panel || panel.isDestroyed()) return;
    const icon = windowIcon();
    if (icon) panel.setIcon(icon);
    panel.setResizable(false);
    showPanel(true);
  });

  panel.on('close', guardHide);

  // Esc 语义由渲染层裁决（P2-1）：编辑态=取消编辑且面板不收起；非编辑态=收起面板。

  // 见 renderer.js 的全局 keydown 监听；主进程不再无条件拦截（before-input-event 先于 DOM，

  // 渲染层拦不住，会导致编辑态按 Esc 直接收起面板且编辑态残留）。

}



/** 独立设置窗口：托盘右键「设置…」打开（已打开则前置到最前） */
function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 430,
    title: '设置 - 悬浮工作台',
    icon: windowIcon(),
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    backgroundMaterial: 'acrylic',
    webPreferences: commonWebPreferences(),
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(APP_DIR, 'settings.html'));
  settingsWin.once('ready-to-show', () => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    try { settingsWin.setBackgroundMaterial('acrylic'); } catch (err) { /* Win10 无此材质 */ }
    settingsWin.show();
    settingsWin.focus();
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function workAreaForPoint(pt) {

  return areaOf(screen.getDisplayNearestPoint(pt).workArea);

}



/** 将矩形夹取进工作区（REQ-001/002 边界：不超出屏幕） */

function clampRect(x, y, w, h, wa) {

  return {

    x: clamp(Math.round(x), wa.left, Math.max(wa.left, wa.right - w)),

    y: clamp(Math.round(y), wa.top, Math.max(wa.top, wa.bottom - h)),

  };

}



/** 打开面板时按记住的位置摆放，并夹取进当前工作区（REQ-002） */
function positionPanelFromSettings() {
  if (!panel || panel.isDestroyed()) return;
  const saved = board && isObj(board.settings.panelPosition)
    ? board.settings.panelPosition
    : defaultPanelPosition();
  const wa = workAreaForPoint({ x: saved.x + PANEL_W / 2, y: saved.y + PANEL_H / 2 });
  const p = clampRect(saved.x, saved.y, PANEL_W, PANEL_H, wa);

  // 先改尺寸再改位置：Windows 上 setSize 会把刚设好的坐标打回 (0,0)
  resetPanelDock();
  suppressPanelSync = true;
  panel.setSize(PANEL_W, PANEL_H);
  setTimeout(() => { suppressPanelSync = false; }, 300);
  panel.setBounds({ x: p.x, y: p.y, width: PANEL_W, height: PANEL_H });
}

function sendPanelState() {

  if (panel && !panel.isDestroyed()) {

    panel.webContents.send('panel:onchange', { visible: panel.isVisible() });

  }

}



/** 把面板当前位置写回 settings（吸顶/滑动动画中不记录，避免存下屏幕外的收起坐标） */
function capturePanelPosition() {
  if (!board || !panel || panel.isDestroyed() || !panel.isVisible()) return false;
  if (panelAnimating || (panelDock && panelDock.docked)) return false;
  const pb = panel.getBounds();
  const cur = board.settings.panelPosition;
  if (cur && cur.x === pb.x && cur.y === pb.y) return false;
  board.settings.panelPosition = { x: pb.x, y: pb.y };
  return true;
}

/** 面板停稳 260ms 后落盘一次（复用既有设置防抖写盘） */
function schedulePanelPositionSave() {
  clearTimeout(panelPosTimer);
  panelPosTimer = setTimeout(() => {
    panelPosTimer = null;
    if (capturePanelPosition()) persistBoardSoon();
  }, 260);
}

/** 贴顶隐藏（QQ 式）：面板推到屏幕顶端即收起，只留一条细边；鼠标移到细边上再滑出 */
function resetPanelDock() {
  clearTimeout(dockCheckTimer);
  clearTimeout(dockHideTimer);
  clearInterval(dockSlideTimer);
  panelAnimating = false;
  panelDock = null;
}

function onPanelMove() {
  if (panelAnimating || suppressPanelSync) return;
  clearTimeout(dockCheckTimer);
  dockCheckTimer = setTimeout(checkPanelDock, 260);
  schedulePanelPositionSave();
}

function checkPanelDock() {
  if (!panel || panel.isDestroyed() || !panel.isVisible()) return;
  const pb = panel.getBounds();
  const wa = workAreaForPoint({ x: Math.round(pb.x + pb.width / 2), y: Math.round(pb.y + pb.height / 2) });
  if (!panelDock || !panelDock.docked) {
    if (pb.y <= wa.top + DOCK_SNAP) tuckPanel();
    return;
  }
  if (pb.y < wa.top - 4) { tuckPanel(); return; }
  if (pb.y >= wa.top + UNDOCK_DIST) undockPanel();
}

/** 竖向滑动面板（只改 y）；动画期间忽略 move 事件，避免和跟随/吸顶互相触发 */
function slidePanelTo(y) {
  if (!panel || panel.isDestroyed()) return;
  clearInterval(dockSlideTimer);
  const pb = panel.getBounds();
  const from = pb.y;
  const steps = 8;
  let i = 0;
  panelAnimating = true;
  dockSlideTimer = setInterval(() => {
    if (!panel || panel.isDestroyed()) { clearInterval(dockSlideTimer); panelAnimating = false; return; }
    i += 1;
    panel.setBounds({ x: pb.x, y: Math.round(from + (y - from) * (i / steps)), width: PANEL_W, height: PANEL_H });
    if (i >= steps) {
      clearInterval(dockSlideTimer);
      panelAnimating = false;
    }
  }, 14);
}

function tuckPanel() {
  if (!panel || panel.isDestroyed() || !panel.isVisible()) return;
  const pb = panel.getBounds();
  const wa = workAreaForPoint({ x: Math.round(pb.x + pb.width / 2), y: Math.round(pb.y + pb.height / 2) });
  panelDock = { docked: true, revealed: false };
  slidePanelTo(wa.top - (PANEL_H - DOCK_STRIP));
}

function revealPanel() {
  if (!panel || panel.isDestroyed() || !panel.isVisible()) return;
  if (!panelDock || !panelDock.docked || panelDock.revealed) return;
  const pb = panel.getBounds();
  const wa = workAreaForPoint({ x: Math.round(pb.x + pb.width / 2), y: Math.round(pb.y + pb.height / 2) });
  panelDock.revealed = true;
  slidePanelTo(wa.top);
}

function undockPanel() {
  if (!panelDock || !panelDock.docked) return;
  panelDock = null;
  schedulePanelPositionSave();
}

ipcMain.on('panel:hover', (evt, inside) => {
  if (!panel || panel.isDestroyed()) return;
  if (evt.sender !== panel.webContents) return;
  if (inside) {
    clearTimeout(dockHideTimer);
    if (panelDock && panelDock.docked && !panelDock.revealed) revealPanel();
    return;
  }
  if (!panelDock || !panelDock.docked || !panelDock.revealed) return;
  clearTimeout(dockHideTimer);
  dockHideTimer = setTimeout(() => {
    if (panelDock && panelDock.docked && panelDock.revealed) tuckPanel();
  }, 450);
});

function showPanel(focus) {

  if (!panel || panel.isDestroyed()) return;

  // 日常点托盘不抢焦点；再次启动可抢一下前台

  if (focus) panel.show();

  else if (!panel.isVisible()) panel.showInactive();

  positionPanelFromSettings();

  panel.setSkipTaskbar(true);

  sendPanelState();

}



function hidePanel() {

  if (!panel || panel.isDestroyed()) return;

  // 收起只是隐藏，进程仍在托盘；不进任务栏

  if (panel.isVisible()) panel.hide();

  sendPanelState();

}



function togglePanel() {

  if (!panel || panel.isDestroyed()) return;

  if (panel.isVisible()) hidePanel();

  else showPanel();

}





/* ---------------------------------- 托盘 ---------------------------------- */



function trayDebug(msg) {

  try {

    fs.appendFileSync(path.join(DATA_DIR, 'tray-debug.log'), `${new Date().toISOString()} ${msg}\n`);

  } catch (err) { /* ignore */ }

  console.error('[workboard]', msg);

}



/** Windows 托盘：优先 System.Drawing 生成的 tray-win.ico（Shell 认这个） */

function pickTrayIconPath() {

  if (fs.existsSync(TRAY_ICO)) return TRAY_ICO;

  if (fs.existsSync(TRAY_PNG)) return TRAY_PNG;

  if (fs.existsSync(TRAY_ICO_FALLBACK)) return TRAY_ICO_FALLBACK;

  if (fs.existsSync(TRAY_PNG_FALLBACK)) return TRAY_PNG_FALLBACK;

  if (fs.existsSync(ICON_ICO)) return ICON_ICO;

  if (fs.existsSync(ICON_PNG)) return ICON_PNG;

  return '';

}



function pickTrayIcon() {

  try {

    const src = pickTrayIconPath();

    if (!src) {

      trayDebug('tray icon path missing');

      return nativeImage.createEmpty();

    }

    const img = nativeImage.createFromPath(src);

    if (img.isEmpty()) {

      trayDebug(`tray icon empty from ${src}`);

      return nativeImage.createEmpty();

    }

    trayDebug(`tray icon ok path=${src} size=${JSON.stringify(img.getSize())}`);

    return img;

  } catch (err) {

    trayDebug(`tray icon load fail: ${err}`);

  }

  return nativeImage.createEmpty();

}



function rebuildTrayMenu() {

  if (!tray) return;

  const menu = Menu.buildFromTemplate([

    {

      label: '打开/收起面板',

      click: () => togglePanel(),

    },


    {

      label: '开机自启',

      type: 'checkbox',

      checked: currentAutostart(),

      click: (item) => {

        applyAutostart(item.checked);

        board.settings.autostart = !!item.checked;

        persistBoardSoon(); // 与 settings:set 同走防抖落盘（P2-3）

        broadcastSettings();

        rebuildTrayMenu();

      },

    },

    {
      label: '回顾…',
      click: () => openReviewWindow(),
    },
    {
      label: '设置…',
      click: () => openSettingsWindow(),
    },
    { type: 'separator' },

    {

      label: '退出',

      click: () => {

        isQuitting = true;

        app.quit();

      },

    },

  ]);

  tray.setContextMenu(menu);

}



function killTrayHostSync() {

  try {

    const { execFileSync } = require('child_process');

    // 只杀我们的托盘脚本宿主，不动其他 powershell

    execFileSync(

      'powershell.exe',

      [

        '-NoProfile',

        '-Command',

        "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'tray-host\\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",

      ],

      { windowsHide: true, stdio: 'ignore', timeout: 8000 },

    );

  } catch (err) {

    // 没有旧进程时忽略

  }

  try {

    const { execFileSync } = require('child_process');

    execFileSync('taskkill', ['/IM', 'TrayHost.exe', '/F'], { windowsHide: true, stdio: 'ignore' });

  } catch (err) { /* ignore */ }

}



function destroyTray() {

  if (tray) {

    try { tray.destroy(); } catch (err) { /* ignore */ }

    tray = null;

  }

  trayHost = null;

  killTrayHostSync();

}



/** Win11 通知区对 Electron.Tray 经常不显示；经 wscript 拉起 STA PowerShell NotifyIcon */

function createTray() {

  if (tray) {

    try { tray.destroy(); } catch (err) { /* ignore */ }

    tray = null;

  }

  // 必须同步杀旧托盘；异步 taskkill 会误杀刚启动的新进程

  killTrayHostSync();

  trayHost = null;



  const iconPath = IS_PACKAGED

    ? ([path.join(SCRIPTS_DIR, 'tray-win.ico'), path.join(SCRIPTS_DIR, 'icon.ico')]

        .find((cand) => fs.existsSync(cand)) || ICON_ICO)

    : (pickTrayIconPath() || ICON_ICO);

  const hostVbs = path.join(SCRIPTS_DIR, 'start-tray-host.vbs');

  const hostScript = path.join(SCRIPTS_DIR, 'tray-host.ps1');

  try {

    const { spawn } = require('child_process');

    if (!fs.existsSync(hostVbs) || !fs.existsSync(hostScript)) {

      trayDebug(`tray host scripts missing under ${SCRIPTS_DIR}, fallback Electron.Tray`);

      createElectronTrayFallback(iconPath);

      return;

    }

    setTimeout(() => {

      // via wscript + explicit paths (packaged vs green-folder layout)

      const child = spawn(

        'wscript.exe',

        [

          '//B',

          '//Nologo',

          hostVbs,

          ROOT_DIR,

          process.execPath,

          IS_PACKAGED ? '' : APP_DIR,

          iconPath,

        ],

        {

          cwd: ROOT_DIR,

          windowsHide: true,

          stdio: 'ignore',

          detached: true,

        },

      );

      child.unref();

      trayDebug(`tray-host via wscript icon=${iconPath} scripts=${SCRIPTS_DIR}`);

    }, 300);

  } catch (err) {

    trayDebug(`tray-host start fail: ${err}`);

    createElectronTrayFallback(iconPath);

  }

}



function createElectronTrayFallback(iconPath) {

  try {

    const icon = pickTrayIcon();

    if (!iconPath && icon.isEmpty()) return;

    tray = iconPath ? new Tray(iconPath) : new Tray(icon);

    if (!icon.isEmpty()) tray.setImage(icon);

    tray.setToolTip('悬浮工作台');

    rebuildTrayMenu();

    tray.on('click', () => togglePanel());

    tray.on('double-click', () => showPanel(true));

    trayDebug('Electron.Tray fallback ok');

  } catch (err) {

    trayDebug(`Electron.Tray fallback fail: ${err}`);

  }

}



/* -------------------------- 数据 v2：按月分片（months/YYYY-MM.json） -------------------------- */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** 'YYYY-MM' -> { month, days: { 'YYYY-MM-DD': {plans, dones} } }，按需加载 */
const monthCache = new Map();

/** 'YYYY-MM' -> 最近一次自身写入的文本（月文件回环守卫） */
const monthOwnWrite = new Map();

function todayKeyMain(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function validDateKey(key) {
  return isStr(key) && DAY_RE.test(key);
}

function validMonth(m) {
  if (!isStr(m) || !MONTH_RE.test(m)) return false;
  const mm = Number(m.slice(5, 7));
  return mm >= 1 && mm <= 12;
}

function monthOf(dateKey) {
  return isStr(dateKey) ? dateKey.slice(0, 7) : '';
}

function monthFilePath(m) {
  return path.join(MONTHS_DIR, m + '.json');
}

function ensureMonthsDir() {
  if (!fs.existsSync(MONTHS_DIR)) fs.mkdirSync(MONTHS_DIR, { recursive: true });
}

/** 单日校验（plans/dones 共用 id 去重） */
function sanitizeDay(raw) {
  const usedIds = new Set();
  if (!isObj(raw)) return { plans: [], dones: [] };
  return {
    plans: sanitizePlans(raw.plans, usedIds),
    dones: sanitizeDones(raw.dones, usedIds),
  };
}

/** 读一个月分片：不存在返回空月；损坏则备份 .bak 后按空月重建 */
function loadMonth(m) {
  if (monthCache.has(m)) return monthCache.get(m);
  const data = { month: m, days: {} };
  monthCache.set(m, data);
  ensureMonthsDir();
  let text = null;
  try {
    text = fs.readFileSync(monthFilePath(m), 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('[workboard] 月分片读取失败：', err);
    return data;
  }
  try {
    const parsed = JSON.parse(text);
    if (isObj(parsed) && isObj(parsed.days)) {
      for (const key of Object.keys(parsed.days)) {
        if (!validDateKey(key) || monthOf(key) !== m) continue;
        data.days[key] = sanitizeDay(parsed.days[key]);
      }
    }
  } catch (err) {
    console.error('[workboard] 月分片损坏，备份后重建：', err);
    try { fs.renameSync(monthFilePath(m), monthFilePath(m) + '.bak'); } catch (e) { /* ignore */ }
  }
  return data;
}

/** 原子写一个月分片 */
function writeMonth(m) {
  const data = monthCache.get(m);
  if (!data) return;
  ensureMonthsDir();
  const file = monthFilePath(m);
  const text = JSON.stringify(data, null, 2) + '\n';
  try {
    fs.writeFileSync(file + '.tmp', text, 'utf8');
    fs.renameSync(file + '.tmp', file);
  } catch (err) {
    console.error('[workboard] 月分片原子写失败，降级直写：', err);
    try {
      fs.writeFileSync(file, text, 'utf8');
    } catch (err2) {
      console.error('[workboard] 月分片直写失败：', err2);
      return;
    }
  }
  monthOwnWrite.set(m, text);
}

/** 读某天（面板只加载当天） */
function readDay(dateKey) {
  if (!validDateKey(dateKey)) return { plans: [], dones: [] };
  const day = loadMonth(monthOf(dateKey)).days[dateKey];
  return day ? { plans: day.plans.slice(), dones: day.dones.slice() } : { plans: [], dones: [] };
}

/** 写某天：只落盘所在月份分片 */
function writeDay(dateKey, rawDay) {
  const m = monthOf(dateKey);
  const data = loadMonth(m);
  data.days[dateKey] = sanitizeDay(rawDay);
  writeMonth(m);
  return data.days[dateKey];
}

/** v1 → v2：把旧单文件的天按月份拆分（已有月分片中的同一天优先保留，不覆盖） */
function migrateLegacyDays(days) {
  const grouped = new Map();
  for (const key of Object.keys(days)) {
    if (!validDateKey(key)) continue;
    const m = monthOf(key);
    if (!grouped.has(m)) grouped.set(m, []);
    grouped.get(m).push(key);
  }
  for (const [m, keys] of grouped) {
    const data = loadMonth(m);
    let changed = false;
    for (const key of keys) {
      if (data.days[key]) continue;
      data.days[key] = sanitizeDay(days[key]);
      changed = true;
    }
    if (changed) writeMonth(m);
  }
}

/** 覆盖 from..to 的月份键（含首尾） */
function monthKeysBetween(from, to) {
  const out = [];
  if (!validDateKey(from) || !validDateKey(to)) return out;
  let y = Number(from.slice(0, 4));
  let mo = Number(from.slice(5, 7));
  const end = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7));
  while (y * 12 + mo <= end) {
    out.push(`${y}-${String(mo).padStart(2, '0')}`);
    mo += 1;
    if (mo > 12) { mo = 1; y += 1; }
  }
  return out;
}

/** 历史查询：按范围 + 关键字（空关键字返回全部有记录的天） */
function queryHistory(from, to, keyword) {
  const kw = isStr(keyword) ? keyword.trim().toLowerCase() : '';
  const out = [];
  for (const m of monthKeysBetween(from, to)) {
    const data = loadMonth(m);
    for (const key of Object.keys(data.days).sort()) {
      if (key < from || key > to) continue;
      const day = data.days[key];
      const plans = kw ? day.plans.filter((p) => p.text.toLowerCase().includes(kw)) : day.plans;
      const dones = kw ? day.dones.filter((d) => d.text.toLowerCase().includes(kw)) : day.dones;
      if (kw && plans.length === 0 && dones.length === 0) continue;
      out.push({ dateKey: key, plans, dones });
    }
  }
  return out;
}

function exportTimeValue(t) {
  const m = isStr(t) ? t.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : 9999;
}

/** 导出文本：Markdown（按天分组）或 CSV（UTF-8 BOM，Excel 直接打开） */
function buildExportText(days, format) {
  if (format === 'csv') {
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = ['日期,类型,时间段,内容'];
    for (const d of days) {
      for (const p of d.plans) lines.push([d.dateKey, '待办', p.time, p.text].map(esc).join(','));
      for (const x of d.dones) lines.push([d.dateKey, '已办', x.time, x.text].map(esc).join(','));
    }
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }
  const out = [];
  for (const d of days) {
    const rows = [
      ...d.plans.map((p) => ({ time: p.time, text: p.text, type: '待办' })),
      ...d.dones.map((x) => ({ time: x.time, text: x.text, type: '已办' })),
    ].map((r, i) => ({ ...r, i }))
      .sort((a, b) => exportTimeValue(a.time) - exportTimeValue(b.time) || a.i - b.i);
    out.push(`## ${d.dateKey}`);
    if (rows.length === 0) out.push('（无记录）');
    for (const r of rows) out.push(`- ${r.time ? r.time + '　' : ''}[${r.type}] ${r.text}`);
    out.push('');
  }
  return out.join('\n');
}

function broadcastReview(month) {
  if (reviewWin && !reviewWin.isDestroyed()) {
    reviewWin.webContents.send('review:onchange', { month });
  }
}

/** 月分片被外部修改：清缓存 → 面板（当天）与回顾窗口重读 */
function scheduleMonthReload(m) {
  setTimeout(() => {
    let text = null;
    try {
      text = fs.readFileSync(monthFilePath(m), 'utf8');
    } catch (err) {
      return;
    }
    if (monthOwnWrite.get(m) === text) return; // 自身写入，忽略
    monthCache.delete(m);
    const tk = todayKeyMain();
    if (monthOf(tk) === m) {
      broadcastData({ dateKey: tk, day: readDay(tk) });
    }
    broadcastReview(m);
  }, RELOAD_DEBOUNCE_MS);
}

function startMonthWatcher() {
  if (monthWatcher) {
    try { monthWatcher.close(); } catch (e) { /* ignore */ }
    monthWatcher = null;
  }
  ensureMonthsDir();
  try {
    monthWatcher = fs.watch(MONTHS_DIR, { persistent: true }, (evt, fname) => {
      if (!fname || !/^\d{4}-\d{2}\.json$/.test(fname)) return;
      scheduleMonthReload(fname.slice(0, 7));
    });
    monthWatcher.on('error', () => {
      try { monthWatcher.close(); } catch (e) { /* ignore */ }
      monthWatcher = null;
    });
  } catch (err) {
    console.error('[workboard] 月分片监听启动失败：', err);
  }
}

/** 独立回顾窗口（托盘右键「回顾…」）：日/周/月切换 + 搜索 + 导出 */
function openReviewWindow() {
  if (reviewWin && !reviewWin.isDestroyed()) {
    reviewWin.show();
    reviewWin.focus();
    return;
  }
  reviewWin = new BrowserWindow({
    width: 940,
    height: 700,
    minWidth: 720,
    minHeight: 520,
    title: '回顾 - 悬浮工作台',
    icon: windowIcon(),
    show: false,
    resizable: true,
    maximizable: true,
    autoHideMenuBar: true,
    backgroundMaterial: 'acrylic',
    webPreferences: commonWebPreferences(),
  });
  reviewWin.setMenuBarVisibility(false);
  reviewWin.loadFile(path.join(APP_DIR, 'review.html'));
  reviewWin.once('ready-to-show', () => {
    if (!reviewWin || reviewWin.isDestroyed()) return;
    try { reviewWin.setBackgroundMaterial('acrylic'); } catch (err) { /* Win10 无此材质 */ }
    reviewWin.show();
    reviewWin.focus();
  });
  reviewWin.on('closed', () => {
    reviewWin = null;
  });
}

/* ---------------------------------- IPC 白名单 ---------------------------------- */

function registerIpc() {

  ipcMain.handle('data:load', () => {
    const tk = todayKeyMain();
    return { settings: board.settings, dateKey: tk, day: readDay(tk) };
  });



  ipcMain.handle('day:save', (event, payload) => {

    try {

      if (!isObj(payload) || !validDateKey(payload.dateKey)) {

        return { ok: false, error: 'invalid payload' };

      }

      writeDay(payload.dateKey, { plans: payload.plans, dones: payload.dones });

      broadcastReview(monthOf(payload.dateKey));

      return { ok: true };

    } catch (err) {

      console.error('[workboard] day:save 失败：', err);

      return { ok: false, error: String(err) };

    }

  });



  ipcMain.handle('settings:get', () => ({ settings: board.settings }));



  ipcMain.handle('settings:set', (event, patch) => {

    try {

      if (isObj(patch)) {

        if (typeof patch.opacity === 'number' && isFinite(patch.opacity)) {

          board.settings.opacity = clamp(patch.opacity, 0.2, 1);

        }

        if (patch.theme === 'auto' || patch.theme === 'dark' || patch.theme === 'light') {

          board.settings.theme = patch.theme;

        }

        if (typeof patch.autostart === 'boolean' && patch.autostart !== currentAutostart()) {

          applyAutostart(patch.autostart);

          board.settings.autostart = patch.autostart;

          rebuildTrayMenu();

        }

      }

      persistBoardSoon(); // 防抖落盘（P2-3）：内存已更新，广播立即发出

      broadcastSettings();

      return { ok: true, settings: board.settings };

    } catch (err) {

      console.error('[workboard] settings:set 失败：', err);

      return { ok: false, error: String(err) };

    }

  });



  ipcMain.handle('month:load', (event, month) => {
    if (!validMonth(month)) return { ok: false, error: 'invalid month' };
    return { ok: true, month, days: loadMonth(month).days };
  });

  ipcMain.handle('history:query', (event, query) => {
    const q = isObj(query) ? query : {};
    if (!validDateKey(q.from) || !validDateKey(q.to) || q.from > q.to) {
      return { ok: false, error: 'invalid range' };
    }
    return { ok: true, days: queryHistory(q.from, q.to, q.keyword) };
  });

  ipcMain.handle('history:export', async (event, query) => {
    try {
      const q = isObj(query) ? query : {};
      if (!validDateKey(q.from) || !validDateKey(q.to) || q.from > q.to) {
        return { ok: false, error: 'invalid range' };
      }
      const format = q.format === 'csv' ? 'csv' : 'md';
      const days = queryHistory(q.from, q.to, q.keyword);
      const text = buildExportText(days, format);
      const owner = event && event.sender ? BrowserWindow.fromWebContents(event.sender) : null;
      const opts = {
        title: '导出工作记录',
        defaultPath: path.join(app.getPath('documents'), `悬浮工作台-${q.from}_${q.to}.${format}`),
        filters: format === 'csv'
          ? [{ name: 'CSV', extensions: ['csv'] }]
          : [{ name: 'Markdown', extensions: ['md'] }],
      };
      const r = owner ? await dialog.showSaveDialog(owner, opts) : await dialog.showSaveDialog(opts);
      if (!r || r.canceled || !r.filePath) return { ok: true, canceled: true };
      fs.writeFileSync(r.filePath, text, 'utf8');
      return { ok: true, path: r.filePath, dayCount: days.length };
    } catch (err) {
      console.error('[workboard] history:export 失败：', err);
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('review:open', () => {
    openReviewWindow();
    return { ok: true };
  });

  ipcMain.handle('panel:toggle', () => {

    togglePanel();

    return { visible: panel.isVisible() };

  });

  ipcMain.handle('panel:show', () => {

    showPanel();

    return { visible: panel.isVisible() };

  });

  ipcMain.handle('panel:hide', () => {

    hidePanel();

    return { visible: panel.isVisible() };

  });




}



/* ---------------------------------- 生命周期 ---------------------------------- */



const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {

  app.quit();

} else {

  app.on('second-instance', (event, argv) => {
    // 托盘「设置…」是用 --open-settings 唤起已运行实例
    if (Array.isArray(argv) && argv.includes('--open-settings')) {
      openSettingsWindow();
      return;
    }

    // 重复启动：把已在跑的面板拉回任务栏前台，而不是静默退出

    showPanel(true);

  });



  app.whenReady().then(() => {

    // 独立 AppId + 中文名，方便 Win11 通知区按「悬浮工作台」识别，而不是 Electron

    app.setAppUserModelId('com.desktop-planner.workboard');

    try { app.setName('悬浮工作台'); } catch (err) { /* ignore */ }

    ensureDataFile();

    ensureMonthsDir();

    loadBoardFromDisk(); // 首次载入并校验（v1 数据自动迁移到 months/）

    startWatcher();

    startMonthWatcher();

    registerIpc();




    createPanel();
    // 首个实例带 --open-settings（托盘「设置…」且应用未运行）时直接打开设置窗口
    if (process.argv.includes('--open-settings')) openSettingsWindow();

    // Win11：窗口尚未就绪时建托盘，偶发「Electron 认为成功但通知区不显示」

    setTimeout(() => createTray(), 400);

  });

}



app.on('before-quit', () => {

  isQuitting = true;

  destroyTray();

  // 退出前兜底：冲刷未落盘的设置（P2-3 防抖收尾）与面板位置
  try {
    let changed = settingsDirty;

    if (settingsFlushTimer) {
      clearTimeout(settingsFlushTimer);
      settingsFlushTimer = null;
    }
    settingsDirty = false;

    if (capturePanelPosition()) changed = true;

    if (changed) writeBoard(board);

  } catch (err) {
    console.error('[workboard] 退出保存位置失败：', err);
  }

});



app.on('will-quit', () => {

  try {

    if (watcher) watcher.close();

  } catch (err) { /* ignore */ }

});



app.on('window-all-closed', () => {

  app.quit(); // 窗口都关闭（退出流程）时结束进程

});



app.on('activate', () => {

  // Windows 下无意义，保留空实现

});

