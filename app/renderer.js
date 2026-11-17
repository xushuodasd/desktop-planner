'use strict';
/**
 * 悬浮工作台面板渲染层（纯 vanilla，无框架、无网络请求）
 * 上半区"今日计划"：逐行 时间段+事项，增/改/删，勾选完成 → 自动移入"已办"并记录 completedAt
 * 下半区"已办"：手动补记、删除、撤销回计划区
 * 设置：透明度 60–100%、主题 跟随系统/深/浅
 * 全部持久化走 preload 白名单 IPC（主进程写盘，渲染层不触盘）
 */

const api = window.workboard;

/* ---------------------------------- 状态 ---------------------------------- */

const state = {
  dateKey: '',
  plans: [],
  dones: [],
  settings: { opacity: 0.85, theme: 'auto', autostart: false, ballPosition: null },
};

let saveTimer = null;
let idCounter = 0;
let toastTimer = null;
let editingPlanId = null; // 当前编辑中的计划行 id

/* ---------------------------------- 小工具 ---------------------------------- */

function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 本地时区 ISO 时间（如 2026-11-17T10:00:00+08:00，对齐 requirements §5 示例） */
function localIsoNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

function uid(kind) {
  idCounter = (idCounter + 1) % 100;
  return `${kind}-${Date.now()}${String(idCounter).padStart(2, '0')}`;
}

/** 解析时间段起始分钟用于排序（"9:00-10:00" / "9点" / 留空排最后） */
function timeStartMinutes(t) {
  if (!t) return Infinity;
  let m = t.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = t.match(/(\d{1,2})\s*(?:点|时)/);
  if (m) return Number(m[1]) * 60;
  m = t.match(/(\d{1,2})/);
  if (m) return Number(m[1]) * 60;
  return Infinity;
}

/** 从 completedAt ISO 提取 HH:MM 用于展示 */
function hhmm(iso) {
  const m = isStr(iso) && iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}
function isStr(v) { return typeof v === 'string'; }

function showToast(text) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}

/* ---------------------------------- 持久化 ---------------------------------- */

function queueSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const r = await api.dataSave({ dateKey: state.dateKey, plans: state.plans, dones: state.dones });
      if (!r || !r.ok) showToast('保存失败，请重试');
    } catch (err) {
      showToast('保存失败：' + err);
    }
  }, 120);
}

function saveSettings(patch) {
  api.settingsSet(patch).then((r) => {
    if (r && r.ok && r.settings) {
      state.settings = r.settings;
      applySettings();
    }
  }).catch(() => showToast('设置保存失败'));
}

/* ---------------------------------- 渲染 ---------------------------------- */

const el = (id) => document.getElementById(id);

function renderDateHeader() {
  const d = new Date();
  const week = '日一二三四五六'[d.getDay()];
  el('dateTitle').textContent =
    `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
  el('dateSub').textContent = '今日工作计划 · 数据本地存储';
}

function sortedPlans() {
  // 显示按时间排序（REQ-003），存储保持录入顺序
  return state.plans
    .map((p, i) => ({ p, i }))
    .sort((a, b) => timeStartMinutes(a.p.time) - timeStartMinutes(b.p.time) || a.i - b.i)
    .map((x) => x.p);
}

function makeIconButton(title, glyph, className, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mini-btn' + (className ? ' ' + className : '');
  btn.title = title;
  btn.textContent = glyph;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderPlans() {
  const list = el('planList');
  list.textContent = '';
  const plans = sortedPlans();
  el('plansEmpty').hidden = plans.length > 0;
  el('planCount').textContent = `${plans.length} 项`;

  for (const plan of plans) {
    const li = document.createElement('li');
    li.className = 'row' + (plan.id === editingPlanId ? ' editing' : '');

    if (plan.id === editingPlanId) {
      // 行内编辑态：时间段 + 事项 + 保存/取消
      const box = document.createElement('div');
      box.className = 'edit-box';
      const timeInput = document.createElement('input');
      timeInput.className = 'input input-time';
      timeInput.value = plan.time;
      timeInput.maxLength = 40;
      timeInput.placeholder = '时间段，可留空';
      const textInput = document.createElement('input');
      textInput.className = 'input input-text';
      textInput.value = plan.text;
      textInput.maxLength = 200;
      textInput.placeholder = '事项';
      box.append(timeInput, textInput);
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const commit = () => {
        plan.time = timeInput.value.trim();
        plan.text = textInput.value.trim() || plan.text;
        editingPlanId = null;
        renderPlans();
        queueSave();
      };
      const cancel = () => {
        editingPlanId = null;
        renderPlans();
      };
      actions.append(
        makeIconButton('保存', '✓', '', commit),
        makeIconButton('取消', '✕', 'danger', cancel),
      );
      li.append(box, actions);
      const onEnter = (ev) => { if (ev.key === 'Enter') commit(); };
      const onEsc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); cancel(); } };
      timeInput.addEventListener('keydown', onEsc);
      textInput.addEventListener('keydown', onEnter);
      // 注意：编辑态按 Esc 不收起面板（stopPropagation 拦截于渲染层，主进程兜底不受影响）
      setTimeout(() => textInput.focus(), 0);
    } else {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'check';
      check.title = '标记完成';
      check.addEventListener('change', () => completePlan(plan.id));

      const time = document.createElement('span');
      time.className = 'time' + (plan.time ? '' : ' blank');
      time.textContent = plan.time || '—';
      time.title = plan.time || '未填时间段';

      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = plan.text;

      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.append(
        makeIconButton('编辑', '✎', '', () => { editingPlanId = plan.id; renderPlans(); }),
        makeIconButton('删除', '✕', 'danger', () => removePlan(plan.id)),
      );
      li.append(check, time, text, actions);
    }
    list.appendChild(li);
  }
}

function renderDones() {
  const list = el('doneList');
  list.textContent = '';
  const dones = state.dones;
  el('donesEmpty').hidden = dones.length > 0;
  el('doneCount').textContent = `${dones.length} 项`;

  for (const done of dones) {
    const li = document.createElement('li');
    li.className = 'row';

    const time = document.createElement('span');
    time.className = 'time' + (done.time ? '' : ' blank');
    time.textContent = done.time || '—';

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = done.text;

    const meta = document.createElement('span');
    meta.className = 'meta';
    const t = hhmm(done.completedAt);
    meta.textContent = t ? `${t} 完成` : (done.source === 'from-plan' ? '计划完成' : '手动补记');

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(
      makeIconButton('撤销回计划', '↩', '', () => undoDone(done.id)),
      makeIconButton('删除', '✕', 'danger', () => removeDone(done.id)),
    );
    li.append(time, text, meta, actions);
    list.appendChild(li);
  }
}

function renderAll() {
  renderDateHeader();
  renderPlans();
  renderDones();
}

/* ---------------------------------- 行为（REQ-003/004/005） ---------------------------------- */

function completePlan(id) {
  const idx = state.plans.findIndex((p) => p.id === id);
  if (idx < 0) return;
  const [plan] = state.plans.splice(idx, 1);
  state.dones.push({
    id: uid('d'),
    time: plan.time,
    text: plan.text,
    source: 'from-plan',
    completedAt: localIsoNow(),
  });
  if (editingPlanId === id) editingPlanId = null;
  renderAll();
  queueSave();
}

function removePlan(id) {
  state.plans = state.plans.filter((p) => p.id !== id);
  if (editingPlanId === id) editingPlanId = null;
  renderPlans();
  queueSave();
}

function removeDone(id) {
  state.dones = state.dones.filter((d) => d.id !== id);
  renderDones();
  queueSave();
}

function undoDone(id) {
  const idx = state.dones.findIndex((d) => d.id === id);
  if (idx < 0) return;
  const [done] = state.dones.splice(idx, 1);
  state.plans.push({
    id: uid('p'),
    time: done.time,
    text: done.text,
    createdAt: done.completedAt || localIsoNow(),
  });
  renderAll();
  queueSave();
}

function addPlan(time, text) {
  if (!text) return;
  state.plans.push({ id: uid('p'), time, text, createdAt: localIsoNow() });
  renderPlans();
  queueSave();
}

function addManualDone(time, text) {
  if (!text) return;
  state.dones.push({
    id: uid('d'),
    time,
    text,
    source: 'manual',
    completedAt: localIsoNow(),
  });
  renderDones();
  queueSave();
}

/* ---------------------------------- 设置（透明度 / 主题） ---------------------------------- */

function resolvedTheme() {
  if (state.settings.theme === 'dark') return 'dark';
  if (state.settings.theme === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applySettings() {
  const opacity = typeof state.settings.opacity === 'number' ? state.settings.opacity : 0.85;
  document.documentElement.style.setProperty('--panel-alpha', String(opacity));
  const slider = el('opacitySlider');
  if (document.activeElement !== slider) slider.value = String(Math.round(opacity * 100));
  el('opacityValue').textContent = `${Math.round(opacity * 100)}%`;
  const select = el('themeSelect');
  if (document.activeElement !== select) select.value = state.settings.theme || 'auto';
  document.body.dataset.theme = resolvedTheme();
}

const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
darkMq.addEventListener('change', () => {
  if ((state.settings.theme || 'auto') === 'auto') document.body.dataset.theme = resolvedTheme();
});

/* ---------------------------------- 事件绑定 ---------------------------------- */

function bindEvents() {
  // 底部主输入行（回车新增计划）
  const addFromComposer = () => {
    const time = el('planTimeInput').value.trim();
    const text = el('planTextInput').value.trim();
    if (!text) return;
    addPlan(time, text);
    el('planTimeInput').value = '';
    el('planTextInput').value = '';
    el('planTextInput').focus();
  };
  el('planTextInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') addFromComposer();
  });
  el('planTimeInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') el('planTextInput').focus();
  });

  // 已办手动补记（REQ-005）
  const addFromDoneInput = () => {
    const time = el('doneTimeInput').value.trim();
    const text = el('doneTextInput').value.trim();
    if (!text) return;
    addManualDone(time, text);
    el('doneTimeInput').value = '';
    el('doneTextInput').value = '';
    el('doneTextInput').focus();
  };
  el('doneTextInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') addFromDoneInput();
  });
  el('doneTimeInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') el('doneTextInput').focus();
  });

  // 收起按钮（Esc 由主进程 before-input-event 兜底）
  el('btnCollapse').addEventListener('click', () => api.panelHide());

  // 设置行
  el('opacitySlider').addEventListener('input', () => {
    const v = Number(el('opacitySlider').value) / 100;
    document.documentElement.style.setProperty('--panel-alpha', String(v));
    el('opacityValue').textContent = `${el('opacitySlider').value}%`;
    saveSettings({ opacity: v });
  });
  el('themeSelect').addEventListener('change', () => {
    saveSettings({ theme: el('themeSelect').value });
  });

  // 主进程推送：外部修改 / 损坏重建 → 重载界面
  api.onDataChanged((payload) => {
    if (payload && payload.board) {
      const day = payload.board.days[state.dateKey];
      state.plans = (day && Array.isArray(day.plans)) ? day.plans : [];
      state.dones = (day && Array.isArray(day.dones)) ? day.dones : [];
      if (payload.board.settings) state.settings = payload.board.settings;
      editingPlanId = null;
      applySettings();
      renderAll();
    }
    if (payload && payload.notice) showToast(payload.notice);
  });

  api.onSettingsChanged((payload) => {
    if (payload && payload.settings) {
      state.settings = payload.settings;
      applySettings();
    }
  });
}

/* ---------------------------------- 启动 ---------------------------------- */

async function init() {
  state.dateKey = todayKey();
  try {
    const r = await api.dataLoad();
    const boardData = (r && r.board) || {};
    const day = boardData.days && boardData.days[state.dateKey];
    state.plans = (day && Array.isArray(day.plans)) ? day.plans : [];
    state.dones = (day && Array.isArray(day.dones)) ? day.dones : [];
    if (boardData.settings) state.settings = boardData.settings;
  } catch (err) {
    showToast('数据加载失败：' + err);
  }
  applySettings();
  bindEvents();
  renderAll();
  el('planTextInput').focus();
}

init();
