'use strict';
/**
 * 悬浮工作台（desktop-planner）主进程
 * - 悬浮球窗口（56px，可拖动、点击展开面板）+ 主面板窗口（360×560，启动时显示并进入任务栏）
 * - 托盘（显示/隐藏悬浮球、开机自启、退出）+ 单实例锁
 * - 数据：data/workboard.json（UTF-8，原子写 tmp+rename），fs.watch 监听外部修改（自身写入守卫防回环）
 * - 安全：渲染层 contextIsolation + sandbox，全部走白名单 IPC，主进程之外不触盘
 * 对应 REQ-001/002/004/006/007/008；设计见 docs/ai-team/design.md
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron');
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

const BALL_SIZE = 56;
const PANEL_W = 360;
const PANEL_H = 560;
const PANEL_GAP = 12;
const DRAG_THRESHOLD = 6; // 像素：小于该位移视为点击
const RELOAD_DEBOUNCE_MS = 250;
/** QQ 式边缘吸附：靠近即可吸；缩进后只露细边；悬停滑出大半个 */
const EDGE_GRAB = 28;
const DOCK_PEEK = 6;
const DOCK_REVEAL = Math.round(BALL_SIZE * 0.72); // ≈40px
const DOCK_EDGES = new Set(['left', 'right', 'top', 'bottom']);
const DOCK_TUCK_DELAY_MS = 220;

// Chromium 用户数据放在 DATA_DIR\appdata（安装包=文档下；开发=绿文件夹 data）
app.setPath('userData', path.join(DATA_DIR, 'appdata'));

let ball = null;
let panel = null;
let tray = null;
let trayHost = null; // WinForms 托盘兜底进程（Win11 上 Electron.Tray 常不进通知区）
let isQuitting = false;
let board = null; // 内存中的合法数据（已校验）
let lastOwnWrite = null; // { text } 自身最近一次写入内容，用于外部修改守卫
let reloadTimer = null;
let drag = null; // { startX, startY, orig:{x,y}, moved, fromDock }
let ballHome = null; // 启动时算好的悬浮球坐标；窗口 show 之前 getBounds 可能是 (0,0)
/** 运行时吸附态：{ edge, along, revealed }；along 为沿边坐标（左/右=y，上/下=x） */
let ballDock = null;
let dockTuckTimer = null;
let watcher = null;
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
function defaultBoard(ballPos) {
  return {
    schemaVersion: 1,
    app: 'desktop-planner',
    days: {},
    settings: {
      opacity: 0.72,
      theme: 'auto',
      autostart: false,
      ballPosition: ballPos || null,
      ballDock: null, // null | { edge, along }
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

/** 悬浮球默认位置：主屏工作区右上角偏下 */
function defaultBallPosition() {
  const wa = areaOf(screen.getPrimaryDisplay().workArea);
  return { x: wa.right - BALL_SIZE - 24, y: wa.top + 160 };
}

/** 读入校验：非法字段忽略（REQ-006 边界；不静默丢合法数据） */
function sanitizeBoard(raw, fallbackBallPos) {
  const b = defaultBoard(fallbackBallPos);
  if (!isObj(raw)) return b;
  b.schemaVersion = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 1;
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
      b.settings.opacity = clamp(s.opacity, 0.5, 1);
    }
    if (s.theme === 'auto' || s.theme === 'dark' || s.theme === 'light') {
      b.settings.theme = s.theme;
    }
    if (typeof s.autostart === 'boolean') b.settings.autostart = s.autostart;
    if (isObj(s.ballPosition) && isFinite(s.ballPosition.x) && isFinite(s.ballPosition.y)) {
      b.settings.ballPosition = {
        x: Math.round(s.ballPosition.x),
        y: Math.round(s.ballPosition.y),
      };
    }
    if (
      isObj(s.ballDock) &&
      DOCK_EDGES.has(s.ballDock.edge) &&
      typeof s.ballDock.along === 'number' &&
      isFinite(s.ballDock.along)
    ) {
      b.settings.ballDock = {
        edge: s.ballDock.edge,
        along: Math.round(s.ballDock.along),
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

/** 启动时确保 data/workboard.json 存在（含 schemaVersion:1、空 days） */
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    writeBoard(defaultBoard(defaultBallPosition()));
  }
}

/** 原子写：tmp + rename（REQ-006；Windows 下 rename 覆盖已存在文件） */
function writeBoard(next) {
  board = next;
  const text = JSON.stringify(board, null, 2) + '\n';
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
    writeBoard(defaultBoard(defaultBallPosition()));
    broadcastData({ board, notice: '数据文件损坏，已备份为 workboard.json.bak 并重建' });
    return;
  }
  board = sanitizeBoard(parsed, null);
  broadcastData({ board });
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
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send('settings:onchange', { settings: board.settings });
  }
}

/* ---------------------------------- 开机自启（用户级） ---------------------------------- */

function loginItemOptions() {
  // 安装包：exe 自带应用，无需再传 app 目录；开发态仍把 app 路径传给 electron/DesktopPlanner
  return IS_PACKAGED
    ? { path: process.execPath, args: [] }
    : { path: process.execPath, args: [APP_DIR] };
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

function createBall(pos) {
  ballHome = { x: pos.x, y: pos.y };
  ball = new BrowserWindow({
    width: BALL_SIZE,
    height: BALL_SIZE,
    x: pos.x,
    y: pos.y,
    title: '悬浮工作台',
    icon: windowIcon(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    // 悬浮球是桌面挂件；任务栏按钮留给主面板，避免两个图标
    skipTaskbar: true,
    // 同面板：resizable:false 会锁住 show 之前那个错误的占位尺寸
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: commonWebPreferences(),
  });
  ball.setMenuBarVisibility(false);
  ball.loadFile(path.join(APP_DIR, 'ball.html'));
  // 透明窗口必须等 ready-to-show 再显示，否则 Windows 上经常一直不可见
  ball.once('ready-to-show', () => {
    try {
      if (!ball || ball.isDestroyed()) return;
      ball.setSize(BALL_SIZE, BALL_SIZE);
      if (ballDock) {
        applyBallDock(ballDock, false);
      } else {
        ball.setPosition(Math.round(ballHome.x), Math.round(ballHome.y));
      }
      ball.show();
    } catch (err) {
      console.error('[workboard] 悬浮球显示失败：', err);
      try { if (ball && !ball.isDestroyed()) ball.show(); } catch (e) { /* ignore */ }
    }
  });
  ball.on('close', guardHide);
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
    transparent: false,
    // acrylic 模糊的是窗口背后的真实画面，才有苹果那种磨砂透光。
    backgroundMaterial: 'acrylic',
    roundedCorners: true,
    alwaysOnTop: true,
    // 不进任务栏；常驻右下角系统托盘（通知区域）
    skipTaskbar: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: true,
    webPreferences: commonWebPreferences(),
  });
  panel.setMenuBarVisibility(false);
  panel.loadFile(path.join(APP_DIR, 'index.html'));
  panel.once('ready-to-show', () => {
    // 等悬浮球先就位，否则 getBounds 还是 (0,0)，面板会被扔到另一块屏幕
    const open = () => {
      if (!panel || panel.isDestroyed()) return;
      showPanel(true);
      try { panel.setBackgroundMaterial('acrylic'); } catch (err) { /* Win10 无此材质则保持罩色 */ }
      const icon = windowIcon();
      if (icon) panel.setIcon(icon);
      panel.setResizable(false);
      positionPanelNearBall();
    };
    if (ball && !ball.isDestroyed() && ball.isVisible()) open();
    else if (ball && !ball.isDestroyed()) ball.once('show', open);
    else open();
  });
  panel.on('close', guardHide);
  // Esc 语义由渲染层裁决（P2-1）：编辑态=取消编辑且面板不收起；非编辑态=收起面板。
  // 见 renderer.js 的全局 keydown 监听；主进程不再无条件拦截（before-input-event 先于 DOM，
  // 渲染层拦不住，会导致编辑态按 Esc 直接收起面板且编辑态残留）。
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

function clearDockTuckTimer() {
  if (dockTuckTimer) {
    clearTimeout(dockTuckTimer);
    dockTuckTimer = null;
  }
}

/** 沿边坐标夹取，保证球在工作区内沿该边滑动 */
function clampAlong(edge, along, wa) {
  if (edge === 'left' || edge === 'right') {
    return clamp(Math.round(along), wa.top, Math.max(wa.top, wa.bottom - BALL_SIZE));
  }
  return clamp(Math.round(along), wa.left, Math.max(wa.left, wa.right - BALL_SIZE));
}

/** 吸附态下窗口坐标：tucked=只露细边；revealed=滑出大半个 */
function dockWindowPos(edge, along, revealed) {
  const wa = areaOf(screen.getPrimaryDisplay().workArea);
  const a = clampAlong(edge, along, wa);
  const visible = revealed ? DOCK_REVEAL : DOCK_PEEK;
  if (edge === 'left') return { x: wa.left - (BALL_SIZE - visible), y: a };
  if (edge === 'right') return { x: wa.right - visible, y: a };
  if (edge === 'top') return { x: a, y: wa.top - (BALL_SIZE - visible) };
  return { x: a, y: wa.bottom - visible };
}

/** 吸附边完全贴在工作区内的自由坐标（拖出/面板锚点用） */
function dockFreePos(edge, along) {
  const wa = areaOf(screen.getPrimaryDisplay().workArea);
  const a = clampAlong(edge, along, wa);
  if (edge === 'left') return { x: wa.left, y: a };
  if (edge === 'right') return { x: wa.right - BALL_SIZE, y: a };
  if (edge === 'top') return { x: a, y: wa.top };
  return { x: a, y: wa.bottom - BALL_SIZE };
}

function applyBallDock(dock, revealed) {
  if (!ball || ball.isDestroyed() || !dock) return;
  const pos = dockWindowPos(dock.edge, dock.along, !!revealed);
  ballDock = { edge: dock.edge, along: dock.along, revealed: !!revealed };
  ball.setPosition(pos.x, pos.y);
  ballHome = { x: pos.x, y: pos.y };
}

function persistBallDock(dock) {
  if (!board) return;
  board.settings.ballDock = dock
    ? { edge: dock.edge, along: Math.round(dock.along) }
    : null;
}

/** 根据当前自由位置判断是否该吸到某边 */
function detectDockEdge(bounds) {
  const center = { x: bounds.x + BALL_SIZE / 2, y: bounds.y + BALL_SIZE / 2 };
  const wa = workAreaForPoint(center);
  const distL = bounds.x - wa.left;
  const distR = wa.right - (bounds.x + BALL_SIZE);
  const distT = bounds.y - wa.top;
  const distB = wa.bottom - (bounds.y + BALL_SIZE);
  const candidates = [
    { edge: 'left', d: distL, along: bounds.y },
    { edge: 'right', d: distR, along: bounds.y },
    { edge: 'top', d: distT, along: bounds.x },
    { edge: 'bottom', d: distB, along: bounds.x },
  ].filter((c) => c.d <= EDGE_GRAB);
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.d - b.d);
  const best = candidates[0];
  return {
    edge: best.edge,
    along: clampAlong(best.edge, best.along, wa),
  };
}

/**
 * 从吸附态拉到贴边自由位（仅运行时；落盘等 drag-end 决定是吸附回去还是真正脱离）。
 * 返回拉出前的 { edge, along }，供点击时还原。
 */
function undockToFree() {
  clearDockTuckTimer();
  if (!ballDock || !ball || ball.isDestroyed()) return null;
  const snap = { edge: ballDock.edge, along: ballDock.along };
  const free = dockFreePos(snap.edge, snap.along);
  ballDock = null;
  ball.setPosition(free.x, free.y);
  ballHome = { x: free.x, y: free.y };
  return snap;
}

function setBallHoverReveal(inside) {
  if (!ballDock || drag || !ball || ball.isDestroyed()) return;
  clearDockTuckTimer();
  if (inside) {
    applyBallDock(ballDock, true);
  } else {
    dockTuckTimer = setTimeout(() => {
      dockTuckTimer = null;
      if (!ballDock || drag || !ball || ball.isDestroyed()) return;
      applyBallDock(ballDock, false);
    }, DOCK_TUCK_DELAY_MS);
  }
}

/** 面板贴着悬浮球展开，并夹取在屏幕工作区内（REQ-002） */
function ballAnchor() {
  // 吸附时用贴边自由位当锚点，避免面板跟着缩进坐标跑偏
  if (ballDock) {
    const p = dockFreePos(ballDock.edge, ballDock.along);
    return { x: p.x, y: p.y, width: BALL_SIZE, height: BALL_SIZE };
  }
  if (ball && !ball.isDestroyed()) {
    const b = ball.getBounds();
    if (b.width >= BALL_SIZE - 4 && b.height >= BALL_SIZE - 4 && (b.x !== 0 || b.y !== 0)) {
      return b;
    }
  }
  return {
    x: ballHome ? ballHome.x : 0,
    y: ballHome ? ballHome.y : 0,
    width: BALL_SIZE,
    height: BALL_SIZE,
  };
}

function positionPanelNearBall() {
  const b = ballAnchor();
  const center = { x: b.x + BALL_SIZE / 2, y: b.y + BALL_SIZE / 2 };
  const wa = workAreaForPoint(center);
  let px = b.x + BALL_SIZE + PANEL_GAP;
  if (px + PANEL_W > wa.right) px = b.x - PANEL_W - PANEL_GAP; // 右边放不下放左边
  const p = clampRect(px, b.y, PANEL_W, PANEL_H, wa);
  // 先改尺寸再改位置：Windows 上 setSize 会把刚设好的坐标打回 (0,0)
  panel.setSize(PANEL_W, PANEL_H);
  panel.setBounds({ x: p.x, y: p.y, width: PANEL_W, height: PANEL_H });
}

function sendPanelState() {
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send('panel:onchange', { visible: panel.isVisible() });
  }
}

function showPanel(focus) {
  if (!panel || panel.isDestroyed()) return;
  // 日常点悬浮球 / 托盘不抢焦点；再次启动可抢一下前台
  if (focus) panel.show();
  else if (!panel.isVisible()) panel.showInactive();
  positionPanelNearBall();
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

function toggleBall() {
  if (!ball) return;
  if (ball.isVisible()) {
    ball.hide();
  } else if (ballDock) {
    applyBallDock(ballDock, false);
    ball.show();
  } else {
    const b = ball.getBounds();
    const wa = workAreaForPoint({ x: b.x + BALL_SIZE / 2, y: b.y + BALL_SIZE / 2 });
    const p = clampRect(b.x, b.y, BALL_SIZE, BALL_SIZE, wa);
    ball.setPosition(p.x, p.y);
    ball.show();
  }
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
      label: '显示/隐藏悬浮球',
      click: () => toggleBall(),
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

/* ---------------------------------- IPC 白名单 ---------------------------------- */

function validDateKey(key) {
  return isStr(key) && /^\d{4}-\d{2}-\d{2}$/.test(key);
}

function registerIpc() {
  ipcMain.handle('data:load', () => ({ board }));

  ipcMain.handle('data:save', (event, payload) => {
    try {
      if (!isObj(payload) || !validDateKey(payload.dateKey)) {
        return { ok: false, error: 'invalid payload' };
      }
      const usedIds = new Set();
      board.days[payload.dateKey] = {
        plans: sanitizePlans(payload.plans, usedIds),
        dones: sanitizeDones(payload.dones, usedIds),
      };
      writeBoard(board);
      return { ok: true };
    } catch (err) {
      console.error('[workboard] data:save 失败：', err);
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('settings:get', () => ({ settings: board.settings }));

  ipcMain.handle('settings:set', (event, patch) => {
    try {
      if (isObj(patch)) {
        if (typeof patch.opacity === 'number' && isFinite(patch.opacity)) {
          board.settings.opacity = clamp(patch.opacity, 0.5, 1);
        }
        if (patch.theme === 'auto' || patch.theme === 'dark' || patch.theme === 'light') {
          board.settings.theme = patch.theme;
        }
        if (typeof patch.autostart === 'boolean' && patch.autostart !== currentAutostart()) {
          applyAutostart(patch.autostart);
          board.settings.autostart = patch.autostart;
          rebuildTrayMenu();
        }
        // ballPosition 由主进程拖拽逻辑维护，渲染层传入的该字段忽略
      }
      persistBoardSoon(); // 防抖落盘（P2-3）：内存已更新，广播立即发出
      broadcastSettings();
      return { ok: true, settings: board.settings };
    } catch (err) {
      console.error('[workboard] settings:set 失败：', err);
      return { ok: false, error: String(err) };
    }
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

  // 悬浮球拖动 / 悬停：渲染层只上报屏幕坐标与悬停态，判定与落盘都在主进程
  ipcMain.handle('ball:drag-start', (event, pt) => {
    if (!ball) return { ok: false };
    clearDockTuckTimer();
    // 吸附态起步：先拉到贴边自由位，再以该位为拖动原点
    const fromDock = ballDock ? undockToFree() : null;
    drag = {
      startX: pt && isFinite(pt.x) ? pt.x : 0,
      startY: pt && isFinite(pt.y) ? pt.y : 0,
      orig: ball.getBounds(),
      moved: false,
      fromDock,
    };
    return { ok: true };
  });

  ipcMain.handle('ball:drag-move', (event, pt) => {
    if (!drag || !ball) return { ok: false };
    const dx = (pt && isFinite(pt.x) ? pt.x : drag.startX) - drag.startX;
    const dy = (pt && isFinite(pt.y) ? pt.y : drag.startY) - drag.startY;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) drag.moved = true;
    if (drag.moved) {
      const wa = areaOf(screen.getDisplayNearestPoint({
        x: drag.orig.x + BALL_SIZE / 2,
        y: drag.orig.y + BALL_SIZE / 2,
      }).workArea);
      const p = clampRect(drag.orig.x + dx, drag.orig.y + dy, BALL_SIZE, BALL_SIZE, wa);
      ball.setPosition(p.x, p.y);
    }
    return { ok: true, moved: drag.moved };
  });

  ipcMain.handle('ball:drag-end', (event, pt) => {
    const d = drag;
    drag = null;
    if (!d || !ball) return { clicked: false };
    const ex = pt && isFinite(pt.x) ? pt.x : d.startX;
    const ey = pt && isFinite(pt.y) ? pt.y : d.startY;
    const dist = Math.hypot(ex - d.startX, ey - d.startY);
    if (!d.moved && dist < DRAG_THRESHOLD) {
      // 从吸附态点一下：保持吸附并滑出大半，再开合面板
      if (d.fromDock) {
        applyBallDock(d.fromDock, true);
        persistBallDock(d.fromDock);
      }
      togglePanel();
      return { clicked: true };
    }
    const b = ball.getBounds();
    const dock = detectDockEdge(b);
    if (dock) {
      applyBallDock(dock, false);
      persistBallDock(dock);
      const free = dockFreePos(dock.edge, dock.along);
      board.settings.ballPosition = { x: free.x, y: free.y };
    } else {
      ballDock = null;
      persistBallDock(null);
      board.settings.ballPosition = { x: b.x, y: b.y };
    }
    writeBoard(board);
    return { clicked: false, docked: !!dock };
  });

  ipcMain.handle('ball:hover', (event, inside) => {
    setBallHoverReveal(!!inside);
    return { ok: true, docked: !!ballDock, revealed: !!(ballDock && ballDock.revealed) };
  });
}

/* ---------------------------------- 生命周期 ---------------------------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 重复启动：把已在跑的面板拉回任务栏前台，而不是静默退出
    if (ball && !ball.isDestroyed() && !ball.isVisible()) ball.show();
    showPanel(true);
  });

  app.whenReady().then(() => {
    // 独立 AppId + 中文名，方便 Win11 通知区按「悬浮工作台」识别，而不是 Electron
    app.setAppUserModelId('com.desktop-planner.workboard');
    try { app.setName('悬浮工作台'); } catch (err) { /* ignore */ }
    ensureDataFile();
    loadBoardFromDisk(); // 首次载入并校验
    startWatcher();
    registerIpc();

    // 恢复悬浮球位置 / 吸附态（缺失/非法则用默认值）
    const savedDock = board.settings.ballDock;
    if (savedDock && DOCK_EDGES.has(savedDock.edge)) {
      const tucked = dockWindowPos(savedDock.edge, savedDock.along, false);
      ballDock = { edge: savedDock.edge, along: savedDock.along, revealed: false };
      createBall(tucked);
    } else {
      const rawPos = board.settings.ballPosition || defaultBallPosition();
      const wa = areaOf(screen.getPrimaryDisplay().workArea);
      const pos = clampRect(rawPos.x, rawPos.y, BALL_SIZE, BALL_SIZE, wa);
      createBall(pos);
    }
    createPanel();
    // Win11：窗口尚未就绪时建托盘，偶发「Electron 认为成功但通知区不显示」
    setTimeout(() => createTray(), 400);
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  destroyTray();
  // 退出前兜底：冲刷未落盘的设置（P2-3 防抖收尾）与悬浮球位置
  try {
    let changed = settingsDirty;
    if (settingsFlushTimer) {
      clearTimeout(settingsFlushTimer);
      settingsFlushTimer = null;
    }
    settingsDirty = false;
    if (ball && !ball.isDestroyed() && board) {
      if (ballDock) {
        persistBallDock(ballDock);
        const free = dockFreePos(ballDock.edge, ballDock.along);
        board.settings.ballPosition = { x: free.x, y: free.y };
        changed = true;
      } else {
        const b = ball.getBounds();
        if (
          !board.settings.ballPosition ||
          board.settings.ballPosition.x !== b.x ||
          board.settings.ballPosition.y !== b.y
        ) {
          board.settings.ballPosition = { x: b.x, y: b.y };
          changed = true;
        }
        if (board.settings.ballDock) {
          board.settings.ballDock = null;
          changed = true;
        }
      }
    }
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
