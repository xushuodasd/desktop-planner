'use strict';
/**
 * 设置窗口渲染层（托盘右键「设置…」打开）
 * 只通过 preload 白名单 IPC 改设置；改动由主进程落盘并广播回面板/设置窗口。
 */
const api = window.workboard;

let settings = { opacity: 0.5, theme: 'auto', autostart: false };

function el(id) {
  return document.getElementById(id);
}

function resolvedTheme() {
  if (settings.theme === 'dark') return 'dark';
  if (settings.theme === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply() {
  const opacity = typeof settings.opacity === 'number' ? settings.opacity : 0.5;
  document.documentElement.style.setProperty('--panel-alpha', String(opacity));

  const slider = el('opacitySlider');
  if (document.activeElement !== slider) slider.value = String(Math.round(opacity * 100));
  el('opacityValue').textContent = `${Math.round(opacity * 100)}%`;

  const select = el('themeSelect');
  if (document.activeElement !== select) select.value = settings.theme || 'auto';

  el('autostartToggle').checked = !!settings.autostart;
  document.body.dataset.theme = resolvedTheme();
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((settings.theme || 'auto') === 'auto') document.body.dataset.theme = resolvedTheme();
});

function bindEvents() {
  el('opacitySlider').addEventListener('input', () => {
    const slider = el('opacitySlider');
    const v = Number(slider.value) / 100;
    document.documentElement.style.setProperty('--panel-alpha', String(v));
    el('opacityValue').textContent = `${slider.value}%`;
    api.settingsSet({ opacity: v });
  });

  el('themeSelect').addEventListener('change', () => {
    api.settingsSet({ theme: el('themeSelect').value });
  });

  el('autostartToggle').addEventListener('change', () => {
    api.settingsSet({ autostart: el('autostartToggle').checked });
  });

  api.onSettingsChanged((payload) => {
    if (payload && payload.settings) {
      settings = payload.settings;
      apply();
    }
  });
}

async function init() {
  try {
    const r = await api.settingsGet();
    if (r && r.settings) settings = r.settings;
  } catch (err) { /* 读取失败就按默认值渲染 */ }
  apply();
  bindEvents();
}

init();
