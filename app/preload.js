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
  // 数据（REQ-006）
  dataLoad: () => ipcRenderer.invoke('data:load'),
  dataSave: (payload) => ipcRenderer.invoke('data:save', payload),

  // 设置（透明度/主题/自启；ballPosition 由主进程维护）
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 面板开合（REQ-002）
  panelToggle: () => ipcRenderer.invoke('panel:toggle'),
  panelShow: () => ipcRenderer.invoke('panel:show'),
  panelHide: () => ipcRenderer.invoke('panel:hide'),

  // 悬浮球拖动 / 边缘吸附悬停（只上报坐标与悬停态，判定在主进程）
  ballDragStart: (pt) => ipcRenderer.invoke('ball:drag-start', pt),
  ballDragMove: (pt) => ipcRenderer.invoke('ball:drag-move', pt),
  ballDragEnd: (pt) => ipcRenderer.invoke('ball:drag-end', pt),
  ballHover: (inside) => ipcRenderer.invoke('ball:hover', !!inside),

  // 主进程推送（白名单事件）
  onDataChanged: (cb) => subscribe('data:onchange', cb),
  onSettingsChanged: (cb) => subscribe('settings:onchange', cb),
  onPanelChanged: (cb) => subscribe('panel:onchange', cb),
});
