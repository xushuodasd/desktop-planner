'use strict';
/**
 * 预加载桥（contextIsolation + sandbox）
 * 只暴露白名单 IPC；渲染层永不直接触盘、不接触 Node 能力。
 * 主进程事件：data:onchange（外部修改/损坏重建）、settings:onchange、panel:onchange。
 */
const { contextBridge, ipcRenderer } = require('electron');

/** 订阅一次主进程推送；返回取消订阅函数 */
function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('workboard', {
  // 面板加载未完成待办、当天已办与设置；明细按月分片存放
  dataLoad: () => ipcRenderer.invoke('data:load'),
  taskChange: (change) => ipcRenderer.invoke('task:change', change),

  // 回顾（日/周/月 + 关键字检索 + 导出）
  monthLoad: (month) => ipcRenderer.invoke('month:load', month),
  historyQuery: (query) => ipcRenderer.invoke('history:query', query),
  historyExport: (query) => ipcRenderer.invoke('history:export', query),
  openReview: () => ipcRenderer.invoke('review:open'),
  onReviewChanged: (cb) => subscribe('review:onchange', cb),

  // 设置（透明度/主题/自启；panelPosition 由主进程维护）
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 面板开合（REQ-002）
  panelToggle: () => ipcRenderer.invoke('panel:toggle'),
  panelShow: () => ipcRenderer.invoke('panel:show'),
  panelHide: () => ipcRenderer.invoke('panel:hide'),
  panelHover: (inside) => ipcRenderer.send('panel:hover', !!inside),

  // 主进程推送（白名单事件）
  onDataChanged: (cb) => subscribe('data:onchange', cb),
  onSettingsChanged: (cb) => subscribe('settings:onchange', cb),
  onPanelChanged: (cb) => subscribe('panel:onchange', cb),
});
