'use strict';
/**
 * 悬浮球窗口渲染层：按下拖动 / 松开点击的判定由主进程完成（DRAG_THRESHOLD）。
 * 渲染层只负责把屏幕坐标经白名单 IPC 上报（REQ-001）。
 */
const api = window.workboard;
const root = document.getElementById('ballRoot');

let pressing = false;

root.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return; // 只响应左键
  ev.preventDefault();
  pressing = true;
  root.classList.add('dragging');
  api.ballDragStart({ x: ev.screenX, y: ev.screenY }).catch(() => {});
});

root.addEventListener('mousemove', (ev) => {
  if (!pressing) return;
  api.ballDragMove({ x: ev.screenX, y: ev.screenY }).catch(() => {});
});

function endPress(ev) {
  if (!pressing) return;
  pressing = false;
  root.classList.remove('dragging');
  api.ballDragEnd({ x: ev.screenX, y: ev.screenY }).catch(() => {});
}

root.addEventListener('mouseup', endPress);
window.addEventListener('blur', () => {
  // 焦点意外丢失时复位按压态，避免拖动状态悬挂
  pressing = false;
  root.classList.remove('dragging');
});
