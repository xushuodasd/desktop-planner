'use strict';
/**
 * electron-mock：在 DSH 沙箱等无 GUI/受约束环境中，对 app/main.js 做运行时验证用的
 * Electron API 桩。仅用于 scripts/test/smoke-datastore.js（Node 直跑，无窗口、无网络）。
 * 说明：DSH 沙箱 Job 禁止 CREATE_BREAKAWAY_FROM_JOB，Chromium 多进程引导必崩
 * （0x80000003），真实 GUI 冒烟须在沙箱外执行；本桩只覆盖数据层与 IPC 逻辑验证。
 */
const path = require('path');

const webContentsSendLog = []; // 记录所有主进程 → 渲染层广播（供断言）

class FakeWebContents {
  constructor() {
    this.handlers = {};
    this.lastPayloads = {};
  }
  on(ev, cb) {
    (this.handlers[ev] = this.handlers[ev] || []).push(cb);
  }
  send(ev, payload) {
    this.lastPayloads[ev] = payload;
    webContentsSendLog.push({ ev, payload });
  }
  isDestroyed() { return false; }
}

class FakeBrowserWindow {
  constructor(opts) {
    opts = opts || {};
    this.opts = opts;
    this.bounds = {
      x: opts.x || 0,
      y: opts.y || 0,
      width: opts.width || 0,
      height: opts.height || 0,
    };
    this.visible = !!opts.show;
    this.webContents = new FakeWebContents();
    this.handlers = {};
    FakeBrowserWindow.all.push(this);
  }
  static fromWebContents(wc) {
    return FakeBrowserWindow.all.find((w) => w.webContents === wc) || null;
  }
  loadFile() { return Promise.resolve(); }
  setMenuBarVisibility() {}
  setBounds(b) { Object.assign(this.bounds, b); }
  getBounds() { return { ...this.bounds }; }
  setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }
  show() { this.visible = true; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  isVisible() { return this.visible; }
  on(ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb); }
  setAlwaysOnTop() {}
  setBackgroundMaterial() {}
  isDestroyed() { return false; }
}
FakeBrowserWindow.all = [];

class FakeTray {
  constructor() { FakeTray.instance = this; }
  setContextMenu(m) { this.menu = m; }
  setToolTip() {}
  on() {}
  destroy() {}
}

const ipcHandlers = new Map();
const ipcMain = {
  handle: (channel, fn) => { ipcHandlers.set(channel, fn); },
};

const WORK_AREA = { left: 0, top: 0, right: 1920, bottom: 1040 };
const screen = {
  getPrimaryDisplay: () => ({ workArea: { ...WORK_AREA } }),
  getDisplayNearestPoint: () => ({ workArea: { ...WORK_AREA } }),
};

const app = {
  _login: null,
  setPath() {},
  requestSingleInstanceLock() { return true; },
  whenReady() { return Promise.resolve(); },
  on() {},
  setAppUserModelId() {},
  setLoginItemSettings(opts) { app._login = { ...opts, openAtLogin: !!(opts && opts.openAtLogin) }; },
  getLoginItemSettings() { return { openAtLogin: !!(app._login && app._login.openAtLogin) }; },
  quit() { app._quit = true; },
};

const Menu = { buildFromTemplate: (template) => ({ template }) };
const nativeImage = {
  createFromPath: () => ({}),
  createEmpty: () => ({}),
};

module.exports = {
  app,
  BrowserWindow: FakeBrowserWindow,
  Tray: FakeTray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
  __ipcHandlers: ipcHandlers,
  __webContentsSendLog: webContentsSendLog,
  __fakeApi: { FakeBrowserWindow, FakeTray, WORK_AREA },
};
