'use strict';
/**
 * 悬浮球：拖动 / 点击由主进程判定；悬停用于边缘吸附时滑出大半个。
 */
const api = window.workboard;
const root = document.getElementById('ballRoot');

let pressing = false;

root.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
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
  pressing = false;
  root.classList.remove('dragging');
});

root.addEventListener('mouseenter', () => {
  if (pressing) return;
  api.ballHover(true).catch(() => {});
});
root.addEventListener('mouseleave', () => {
  if (pressing) return;
  api.ballHover(false).catch(() => {});
});
