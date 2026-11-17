'use strict';
/**
 * 悬浮工作台面板渲染层（纯 vanilla）
 * 待办 / 已办分页切换（右上角分段控件 + 滑入动画）
 * 待办：时间段+事项，勾选完成 → 已办；已办：补记 / 撤销 / 删除
 */

const api = window.workboard;

const state = {
  dateKey: '',
  plans: [],
  dones: [],
  settings: { opacity: 0.72, theme: 'auto', autostart: false, ballPosition: null },
  view: 'plans', // plans | dones
};

let saveTimer = null;
let idCounter = 0;
let toastTimer = null;
let editingPlanId = null;
let switching = false;

function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

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

const el = (id) => document.getElementById(id);

function renderDateHeader() {
  const d = new Date();
  const week = '日一二三四五六'[d.getDay()];
  el('dateTitle').textContent =
    `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
  el('dateSub').textContent = state.view === 'plans' ? '今日待办' : '今日已办';
}

function updateComposerHint() {
  const time = el('timeInput');
  const text = el('textInput');
  if (state.view === 'plans') {
    time.placeholder = '时间段';
    text.placeholder = '待办事项，回车添加';
  } else {
    time.placeholder = '时间段';
    text.placeholder = '补记已办，回车添加';
  }
}

function sortedPlans() {
  return state.plans
    .map((p, i) => ({ p, i }))
    .sort((a, b) => timeStartMinutes(a.p.time) - timeStartMinutes(b.p.time) || a.i - b.i)
    .map((x) => x.p);
}

const ICONS = {
  edit: '<path d="M3.5 9.5l6.2-6.2a1 1 0 0 1 1.4 1.4L4.9 10.9 2.8 11.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.2 3.8l1.4 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  trash: '<path d="M3.2 4.2h7.6M5 4.2V3.4a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8v.8M4.4 4.2l.4 6.2a1 1 0 0 0 1 .9h2.4a1 1 0 0 0 1-.9l.4-6.2" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>',
  undo: '<path d="M4.2 6.2A3.6 3.6 0 1 0 5.8 3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2.6 3.2l1.8.4.4 1.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="M3.2 6.4l2.2 2.2 3.8-4.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  close: '<path d="M3.4 3.4l5.2 5.2M8.6 3.4L3.4 8.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};

function makeIconButton(title, icon, className, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mini-btn' + (className ? ' ' + className : '');
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true">${ICONS[icon] || ''}</svg>`;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderPlans() {
  const list = el('planList');
  list.textContent = '';
  const plans = sortedPlans();
  el('plansEmpty').hidden = plans.length > 0;
  el('planCount').textContent = String(plans.length);

  for (const plan of plans) {
    const li = document.createElement('li');
    li.className = 'row' + (plan.id === editingPlanId ? ' editing' : '');

    if (plan.id === editingPlanId) {
      const box = document.createElement('div');
      box.className = 'edit-box';
      const timeInput = document.createElement('input');
      timeInput.className = 'input input-time';
      timeInput.value = plan.time;
      timeInput.maxLength = 40;
      timeInput.placeholder = '时间段';
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
        makeIconButton('保存', 'check', 'ok', commit),
        makeIconButton('取消', 'close', 'danger', cancel),
      );
      li.append(box, actions);
      timeInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') textInput.focus(); });
      textInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); });
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
        makeIconButton('编辑', 'edit', '', () => { editingPlanId = plan.id; renderPlans(); }),
        makeIconButton('删除', 'trash', 'danger', () => removePlan(plan.id)),
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
  el('doneCount').textContent = String(dones.length);

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
      makeIconButton('撤销回待办', 'undo', '', () => undoDone(done.id)),
      makeIconButton('删除', 'trash', 'danger', () => removeDone(done.id)),
    );
    li.append(time, text, meta, actions);
    list.appendChild(li);
  }
}

function renderAll() {
  renderDateHeader();
  updateComposerHint();
  renderPlans();
  renderDones();
}

function setView(next, { animate = true } = {}) {
  if (next !== 'plans' && next !== 'dones') return;
  if (next === state.view) return;
  if (switching) return;

  const prev = state.view;
  const panel = el('panel');
  const fromEl = el(prev === 'plans' ? 'viewPlans' : 'viewDones');
  const toEl = el(next === 'plans' ? 'viewPlans' : 'viewDones');
  const tabPlans = el('tabPlans');
  const tabDones = el('tabDones');

  state.view = next;
  panel.dataset.view = next;
  tabPlans.classList.toggle('is-active', next === 'plans');
  tabDones.classList.toggle('is-active', next === 'dones');
  tabPlans.setAttribute('aria-selected', String(next === 'plans'));
  tabDones.setAttribute('aria-selected', String(next === 'dones'));
  renderDateHeader();
  updateComposerHint();

  if (!animate) {
    fromEl.classList.remove('is-active', 'is-leave-left', 'is-enter-from-left', 'is-enter-from-right');
    toEl.classList.remove('is-leave-left', 'is-enter-from-left', 'is-enter-from-right');
    fromEl.hidden = true;
    toEl.hidden = false;
    toEl.classList.add('is-active');
    el('textInput').focus();
    return;
  }

  switching = true;
  const goingRight = next === 'dones'; // 待办 → 已办：向左滑出，右侧进入
  fromEl.hidden = false;
  toEl.hidden = false;
  toEl.classList.remove('is-active', 'is-leave-left');
  toEl.classList.add(goingRight ? 'is-enter-from-right' : 'is-enter-from-left');

  // 强制回流，再播动画
  void toEl.offsetWidth;
  fromEl.classList.remove('is-active');
  fromEl.classList.add(goingRight ? 'is-leave-left' : 'is-enter-from-right');
  toEl.classList.remove('is-enter-from-left', 'is-enter-from-right');
  toEl.classList.add('is-active');

  window.setTimeout(() => {
    fromEl.hidden = true;
    fromEl.classList.remove('is-leave-left', 'is-enter-from-right', 'is-enter-from-left');
    switching = false;
    el('textInput').focus();
  }, 280);
}

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

function resolvedTheme() {
  if (state.settings.theme === 'dark') return 'dark';
  if (state.settings.theme === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applySettings() {
  const opacity = typeof state.settings.opacity === 'number' ? state.settings.opacity : 0.72;
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

async function refreshOnShow() {
  const tk = todayKey();
  if (tk === state.dateKey) return;
  state.dateKey = tk;
  editingPlanId = null;
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
  renderAll();
}

function bindEvents() {
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (editingPlanId) {
      editingPlanId = null;
      renderPlans();
    } else {
      api.panelHide();
    }
  });

  const submitComposer = () => {
    const time = el('timeInput').value.trim();
    const text = el('textInput').value.trim();
    if (!text) return;
    if (state.view === 'plans') addPlan(time, text);
    else addManualDone(time, text);
    el('timeInput').value = '';
    el('textInput').value = '';
    el('textInput').focus();
  };
  el('textInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') submitComposer();
  });
  el('timeInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') el('textInput').focus();
  });

  el('tabPlans').addEventListener('click', () => setView('plans'));
  el('tabDones').addEventListener('click', () => setView('dones'));
  el('btnCollapse').addEventListener('click', () => api.panelHide());

  el('opacitySlider').addEventListener('input', () => {
    const v = Number(el('opacitySlider').value) / 100;
    document.documentElement.style.setProperty('--panel-alpha', String(v));
    el('opacityValue').textContent = `${el('opacitySlider').value}%`;
    saveSettings({ opacity: v });
  });
  el('themeSelect').addEventListener('change', () => {
    saveSettings({ theme: el('themeSelect').value });
  });

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

  api.onPanelChanged((payload) => {
    if (payload && payload.visible === true) refreshOnShow();
  });

  api.onSettingsChanged((payload) => {
    if (payload && payload.settings) {
      state.settings = payload.settings;
      applySettings();
    }
  });
}

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
  // 已有用户若透明度偏实，轻轻拉高一点玻璃感（仅当仍是旧默认 0.85）
  if (Math.abs((state.settings.opacity || 0) - 0.85) < 0.001) {
    state.settings.opacity = 0.72;
    saveSettings({ opacity: 0.72 });
  }
  applySettings();
  bindEvents();
  renderAll();
  setView('plans', { animate: false });
  el('textInput').focus();
}

init();
