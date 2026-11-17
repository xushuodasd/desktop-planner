'use strict';
/**
 * 悬浮工作台（desktop-planner）主进程
 * - 悬浮球窗口（56px，可拖动、点击展开面板）+ 主面板窗口（360×560，showInactive 不抢焦点）
 * - 托盘（显示/隐藏悬浮球、开机自启、退出）+ 单实例锁
 * - 数据：data/workboard.json（UTF-8，原子写 tmp+rename），fs.watch 监听外部修改（自身写入守卫防回环）
 * - 安全：渲染层 contextIsolation + sandbox，全部走白名单 IPC，主进程之外不触盘
 * 对应 REQ-001/002/004/006/007/008；设计见 docs/ai-team/design.md
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname; // <绿色文件夹>\app
const ROOT_DIR = path.dirname(APP_DIR); // 绿色文件夹根
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'workboard.json');
const BAK_FILE = DATA_FILE + '.bak';
const ICON_ICO = path.join(APP_DIR, 'assets', 'icon.ico');
const ICON_PNG = path.join(APP_DIR, 'assets', 'icon.png');

const BALL_SIZE = 56;
const PANEL_W = 360;
const PANEL_H = 560;
const PANEL_GAP = 12;
const DRAG_THRESHOLD = 6; // 像素：小于该位移视为点击
const RELOAD_DEBOUNCE_MS = 250;

// 可移植性（REQ-008）：Chromium 用户数据（GPU 缓存/崩溃转储等）全部限制在绿色文件夹内，
// 不依赖 %APPDATA%；必须在单实例锁之前设置（锁文件也在 userData 中）。
app.setPath('userData', path.join(DATA_DIR, 'appdata'));

let ball = null;
let panel = null;
let tray = null;
let isQuitting = false;
let board = null; // 内存中的合法数据（已校验）
let lastOwnWrite = null; // { text } 自身最近一次写入内容，用于外部修改守卫
let reloadTimer = null;
let drag = null; // { startX, startY, orig:{x,y}, moved }
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
      opacity: 0.85,
      theme: 'auto',
      autostart: false,
      ballPosition: ballPos || null,
    },
  };
}

/** 悬浮球默认位置：主屏工作区右上角偏下 */
function defaultBallPosition() {
  const wa = screen.getPrimaryDisplay().workArea;
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
      b.settings.opacity = clamp(s.opacity, 0.6, 1);
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
  return { path: process.execPath, args: [APP_DIR] };
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

function createBall(pos) {
  ball = new BrowserWindow({
    width: BALL_SIZE,
    height: BALL_SIZE,
    x: pos.x,
    y: pos.y,
    useContentSize: true,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: commonWebPreferences(),
  });
  ball.setMenuBarVisibility(false);
  ball.loadFile(path.join(APP_DIR, 'ball.html'));
  applyAcrylic(ball);
  ball.on('close', guardHide);
}

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: commonWebPreferences(),
  });
  panel.setMenuBarVisibility(false);
  panel.loadFile(path.join(APP_DIR, 'index.html'));
  applyAcrylic(panel);
  panel.on('close', guardHide);
  // Esc 语义由渲染层裁决（P2-1）：编辑态=取消编辑且面板不收起；非编辑态=收起面板。
  // 见 renderer.js 的全局 keydown 监听；主进程不再无条件拦截（before-input-event 先于 DOM，
  // 渲染层拦不住，会导致编辑态按 Esc 直接收起面板且编辑态残留）。
}

function workAreaForPoint(pt) {
  return screen.getDisplayNearestPoint(pt).workArea;
}

/** 将矩形夹取进工作区（REQ-001/002 边界：不超出屏幕） */
function clampRect(x, y, w, h, wa) {
  return {
    x: clamp(Math.round(x), wa.left, Math.max(wa.left, wa.right - w)),
    y: clamp(Math.round(y), wa.top, Math.max(wa.top, wa.bottom - h)),
  };
}

/** 面板贴着悬浮球展开，并夹取在屏幕工作区内（REQ-002） */
function positionPanelNearBall() {
  const b = ball.getBounds();
  const center = { x: b.x + BALL_SIZE / 2, y: b.y + BALL_SIZE / 2 };
  const wa = workAreaForPoint(center);
  let px = b.x + BALL_SIZE + PANEL_GAP;
  if (px + PANEL_W > wa.right) px = b.x - PANEL_W - PANEL_GAP; // 右边放不下放左边
  const p = clampRect(px, b.y, PANEL_W, PANEL_H, wa);
  panel.setBounds({ x: p.x, y: p.y, width: PANEL_W, height: PANEL_H });
}

function sendPanelState() {
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send('panel:onchange', { visible: panel.isVisible() });
  }
}

function showPanel() {
  if (!panel) return;
  positionPanelNearBall();
  panel.showInactive(); // 不抢当前窗口焦点（REQ-002）
  sendPanelState();
}

function hidePanel() {
  if (!panel) return;
  if (panel.isVisible()) panel.hide();
  sendPanelState();
}

function togglePanel() {
  if (!panel) return;
  if (panel.isVisible()) hidePanel();
  else showPanel();
}

function toggleBall() {
  if (!ball) return;
  if (ball.isVisible()) {
    ball.hide();
  } else {
    const b = ball.getBounds();
    const wa = workAreaForPoint({ x: b.x + BALL_SIZE / 2, y: b.y + BALL_SIZE / 2 });
    const p = clampRect(b.x, b.y, BALL_SIZE, BALL_SIZE, wa);
    ball.setPosition(p.x, p.y);
    ball.show();
  }
}

/* ---------------------------------- 托盘 ---------------------------------- */

function pickTrayIcon() {
  try {
    if (fs.existsSync(ICON_ICO)) return nativeImage.createFromPath(ICON_ICO);
    if (fs.existsSync(ICON_PNG)) return nativeImage.createFromPath(ICON_PNG);
  } catch (err) {
    console.error('[workboard] 托盘图标读取失败：', err);
  }
  return nativeImage.createEmpty();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
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

function createTray() {
  try {
    tray = new Tray(pickTrayIcon());
    tray.setToolTip('悬浮工作台');
    rebuildTrayMenu();
    tray.on('click', () => togglePanel()); // 点托盘图标快速开合面板
  } catch (err) {
    console.error('[workboard] 托盘创建失败：', err);
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
          board.settings.opacity = clamp(patch.opacity, 0.6, 1);
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

  // 悬浮球拖动：渲染层只上报屏幕坐标，判定与落盘都在主进程
  ipcMain.handle('ball:drag-start', (event, pt) => {
    if (!ball) return { ok: false };
    drag = {
      startX: pt && isFinite(pt.x) ? pt.x : 0,
      startY: pt && isFinite(pt.y) ? pt.y : 0,
      orig: ball.getBounds(),
      moved: false,
    };
    return { ok: true };
  });

  ipcMain.handle('ball:drag-move', (event, pt) => {
    if (!drag || !ball) return { ok: false };
    const dx = (pt && isFinite(pt.x) ? pt.x : drag.startX) - drag.startX;
    const dy = (pt && isFinite(pt.y) ? pt.y : drag.startY) - drag.startY;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) drag.moved = true;
    if (drag.moved) {
      const wa = screen.getDisplayNearestPoint({
        x: drag.orig.x + BALL_SIZE / 2,
        y: drag.orig.y + BALL_SIZE / 2,
      }).workArea;
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
      togglePanel(); // 松开即点击：开/收面板
      return { clicked: true };
    }
    const b = ball.getBounds(); // 位置记忆（REQ-001）
    board.settings.ballPosition = { x: b.x, y: b.y };
    writeBoard(board);
    return { clicked: false };
  });
}

/* ---------------------------------- 生命周期 ---------------------------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 重复启动：确保悬浮球可见即可，不自动开面板
    if (ball && !ball.isVisible()) toggleBall();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.desktop-planner.workboard');
    ensureDataFile();
    loadBoardFromDisk(); // 首次载入并校验
    startWatcher();
    registerIpc();

    // 恢复悬浮球位置（缺失/非法则用默认值），并夹取进工作区
    const rawPos = board.settings.ballPosition || defaultBallPosition();
    const wa = screen.getPrimaryDisplay().workArea;
    const pos = clampRect(rawPos.x, rawPos.y, BALL_SIZE, BALL_SIZE, wa);

    createBall(pos);
    createPanel();
    createTray();
    ball.show(); // 启动即出现悬浮球（REQ-001）
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  // 退出前兜底：冲刷未落盘的设置（P2-3 防抖收尾）与悬浮球位置
  try {
    let changed = settingsDirty;
    if (settingsFlushTimer) {
      clearTimeout(settingsFlushTimer);
      settingsFlushTimer = null;
    }
    settingsDirty = false;
    if (ball && !ball.isDestroyed() && board) {
      const b = ball.getBounds();
      if (
        !board.settings.ballPosition ||
        board.settings.ballPosition.x !== b.x ||
        board.settings.ballPosition.y !== b.y
      ) {
        board.settings.ballPosition = { x: b.x, y: b.y };
        changed = true;
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
