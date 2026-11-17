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
  settings: { opacity: 0.5, theme: 'auto', autostart: false, panelPosition: null },
  view: 'plans', // plans | dones
  timeText: '', // 时间滚轮当前值（如 '9:30'）
};

let saveTimer = null;
let idCounter = 0;
let toastTimer = null;
let editingPlanId = null;
let lastAddedId = null;
let pendingDelete = null; // { kind, id }：等待二次确认的删除
let pendingDeleteTimer = null;
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

/* ---------- 时间滚轮（时 / 分，滑动选择） ---------- */

const TIME_ITEM_H = 34;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

let composerPicker = null;

function padTime(n) {
  return String(n).padStart(2, '0');
}

/** 默认选中：当前时间（5 分钟向上取整） */
function currentTimeText() {
  const d = new Date();
  let h = d.getHours();
  let m = Math.ceil(d.getMinutes() / 5) * 5;
  if (m === 60) {
    m = 0;
    h = (h + 1) % 24;
  }
  return `${padTime(h)}:${padTime(m)}`;
}

function buildWheel(wheel, values) {
  wheel.textContent = '';
  const makePad = () => {
    const node = document.createElement('div');
    node.className = 'wheel-pad';
    return node;
  };
  wheel.appendChild(makePad());
  for (const v of values) {
    const item = document.createElement('div');
    item.className = 'wheel-item';
    item.dataset.value = String(v);
    item.textContent = padTime(v);
    wheel.appendChild(item);
  }
  wheel.appendChild(makePad());
}

function wheelIndex(wheel) {
  const count = wheel.querySelectorAll('.wheel-item').length;
  const idx = Math.round(wheel.scrollTop / TIME_ITEM_H);
  return Math.max(0, Math.min(count - 1, idx));
}

function markWheel(wheel) {
  const idx = wheelIndex(wheel);
  wheel.querySelectorAll('.wheel-item').forEach((node, i) => {
    const d = Math.min(Math.abs(i - idx), 2);
    node.dataset.d = String(d);
    node.classList.toggle('is-active', d === 0);
  });
  return idx;
}

/** 在 host 内挂一套「小时 : 分钟」滚轮；返回控制器（可多处实例化：底部输入卡、行内编辑） */
function createWheelPair(host, onChange) {
  const hourWheel = document.createElement('div');
  hourWheel.className = 'wheel';
  hourWheel.setAttribute('aria-label', '小时');
  const colon = document.createElement('span');
  colon.className = 'wheel-colon';
  colon.textContent = ':';
  const minuteWheel = document.createElement('div');
  minuteWheel.className = 'wheel';
  minuteWheel.setAttribute('aria-label', '分钟');
  buildWheel(hourWheel, HOURS);
  buildWheel(minuteWheel, MINUTES);
  host.append(hourWheel, colon, minuteWheel);

  let raf = 0;
  const read = () =>
    `${padTime(HOURS[wheelIndex(hourWheel)])}:${padTime(MINUTES[wheelIndex(minuteWheel)])}`;
  const sync = () => {
    markWheel(hourWheel);
    markWheel(minuteWheel);
    const text = read();
    if (onChange) onChange(text);
    return text;
  };
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      sync();
    });
  };
  hourWheel.addEventListener('scroll', onScroll);
  minuteWheel.addEventListener('scroll', onScroll);

  return {
    setValue(text) {
      const [h, m] = String(text || '').split(':').map(Number);
      hourWheel.scrollTop = Math.max(0, HOURS.indexOf(h)) * TIME_ITEM_H;
      minuteWheel.scrollTop = Math.max(0, MINUTES.indexOf(m)) * TIME_ITEM_H;
      return sync();
    },
    getValue: read,
  };
}

function setTimePicker(open) {
  const composer = el('composer');
  if (!composer) return;
  composer.classList.toggle('is-picking', open);
  el('timeBtn').classList.toggle('is-open', open);
  el('timeBtn').setAttribute('aria-expanded', String(open));
  if (open && composerPicker) composerPicker.setValue(state.timeText);
}

function initTimePicker() {
  state.timeText = currentTimeText();
  el('timeBtn').textContent = state.timeText;
  composerPicker = createWheelPair(el('pickHost'), (text) => {
    state.timeText = text;
    el('timeBtn').textContent = text;
  });
  el('timeBtn').addEventListener('click', () => {
    setTimePicker(!el('composer').classList.contains('is-picking'));
  });
  el('timeBtn').setAttribute('aria-expanded', 'false');
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
  const text = el('textInput');
  if (state.view === 'plans') {
    text.placeholder = '待办事项，回车添加';
  } else {
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

/** 长文本：点击就地展开 / 收起（仅内容溢出时显示可点手型） */
function makeTextExpandable(text, row) {
  text.title = text.textContent;
  requestAnimationFrame(() => {
    if (text.scrollWidth <= text.clientWidth + 1) return;
    text.classList.add('can-expand');
    text.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const open = text.classList.toggle('is-expanded');
      row.classList.toggle('is-expanded', open);
    });
  });
}

/** 危险操作二次确认：行内就地切换为「删除这条记录？取消 / 删除」，3.5s 未确认自动还原。
 *  不使用系统 confirm / 模态框：不打断浏览，且误触成本为零。 */
function askDelete(li, kind, id) {
  if (pendingDelete) cancelDelete();
  pendingDelete = { kind, id };
  li.classList.add('is-confirming');
  li.textContent = '';

  const label = document.createElement('span');
  label.className = 'confirm-text';
  label.textContent = '删除这条记录？';

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'text-btn';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', cancelDelete);

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'text-btn danger';
  okBtn.textContent = '删除';
  okBtn.addEventListener('click', () => {
    if (!pendingDelete) return;
    const { kind: k, id: targetId } = pendingDelete;
    if (pendingDeleteTimer) clearTimeout(pendingDeleteTimer);
    pendingDelete = null;
    pendingDeleteTimer = null;
    if (k === 'plan') removePlan(targetId);
    else removeDone(targetId);
  });

  actions.append(cancelBtn, okBtn);
  li.append(label, actions);
  pendingDeleteTimer = setTimeout(cancelDelete, 3500);
}

function cancelDelete() {
  if (!pendingDelete) return;
  const kind = pendingDelete.kind;
  if (pendingDeleteTimer) clearTimeout(pendingDeleteTimer);
  pendingDelete = null;
  pendingDeleteTimer = null;
  if (kind === 'plan') renderPlans();
  else renderDones();
}

function renderPlans() {
  const list = el('planList');
  list.textContent = '';
  const plans = sortedPlans();
  el('plansEmpty').hidden = plans.length > 0;
  el('planCount').textContent = String(plans.length);

  for (const plan of plans) {
    const li = document.createElement('li');
    li.className = 'row' + (plan.id === editingPlanId ? ' editing' : '') +
      (plan.id === lastAddedId ? ' is-new' : '');

    if (plan.id === editingPlanId) {
      li.classList.add('is-editing');

      const card = document.createElement('div');
      card.className = 'edit-card';

      let editTime = plan.time || currentTimeText();
      const timeBtn = document.createElement('button');
      timeBtn.type = 'button';
      timeBtn.className = 'edit-time';
      timeBtn.title = '选择时间';
      timeBtn.textContent = editTime;

      const head = document.createElement('div');
      head.className = 'edit-head';
      head.append(timeBtn);

      const picker = document.createElement('div');
      picker.className = 'edit-picker';
      const wheelHost = document.createElement('div');
      wheelHost.className = 'wheel-wrap';
      picker.appendChild(wheelHost);

      const textArea = document.createElement('textarea');
      textArea.className = 'edit-text';
      textArea.value = plan.text;
      textArea.maxLength = 200;
      textArea.rows = 1;
      textArea.placeholder = '事项';

      const actions = document.createElement('div');
      actions.className = 'edit-actions';

      const commit = () => {
        plan.time = editTime;
        plan.text = textArea.value.trim() || plan.text;
        editingPlanId = null;
        renderPlans();
        queueSave();
      };
      const cancel = () => {
        editingPlanId = null;
        renderPlans();
      };

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'text-btn';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', cancel);

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'text-btn primary';
      saveBtn.textContent = '保存';
      saveBtn.addEventListener('click', commit);

      actions.append(cancelBtn, saveBtn);
      card.append(head, picker, textArea, actions);
      li.append(card);

      const pickerCtl = createWheelPair(wheelHost, (v) => {
        editTime = v;
        timeBtn.textContent = v;
      });
      timeBtn.addEventListener('click', () => {
        const open = !card.classList.contains('is-picking');
        card.classList.toggle('is-picking', open);
        timeBtn.classList.toggle('is-open', open);
        if (open) pickerCtl.setValue(editTime);
      });

      const grow = () => {
        textArea.style.height = 'auto';
        textArea.style.height = Math.min(textArea.scrollHeight, 116) + 'px';
      };
      textArea.addEventListener('input', grow);
      textArea.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          commit();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          cancel();
        }
      });
      setTimeout(() => {
        textArea.focus();
        textArea.setSelectionRange(textArea.value.length, textArea.value.length);
        grow();
      }, 0);
    } else {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'check';
      check.title = '标记完成';
      check.addEventListener('change', () => {
        li.classList.add('is-completing');
        setTimeout(() => completePlan(plan.id), 200);
      });

      const time = document.createElement('span');
      time.className = 'time' + (plan.time ? '' : ' blank');
      time.textContent = plan.time || '—';
      time.title = plan.time || '未选时间';

      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = plan.text;

      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.append(
        makeIconButton('编辑', 'edit', '', () => { editingPlanId = plan.id; renderPlans(); }),
        makeIconButton('删除', 'trash', 'danger', () => askDelete(li, 'plan', plan.id)),
      );
      li.append(check, time, text, actions);
      makeTextExpandable(text, li);
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
    li.className = 'row' + (done.id === lastAddedId ? ' is-new' : '');

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
      makeIconButton('删除', 'trash', 'danger', () => askDelete(li, 'done', done.id)),
    );
    li.append(time, text, meta, actions);
    makeTextExpandable(text, li);
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

function addPlan(time, text, id) {
  if (!text) return;
  state.plans.push({ id: id || uid('p'), time, text, createdAt: localIsoNow() });
  renderPlans();
  queueSave();
  setTimeout(() => { lastAddedId = null; }, 400);
}

function addManualDone(time, text, id) {
  if (!text) return;
  state.dones.push({
    id: id || uid('d'),
    time,
    text,
    source: 'manual',
    completedAt: localIsoNow(),
  });
  renderDones();
  queueSave();
  setTimeout(() => { lastAddedId = null; }, 400);
}

function resolvedTheme() {
  if (state.settings.theme === 'dark') return 'dark';
  if (state.settings.theme === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applySettings() {
  const opacity = typeof state.settings.opacity === 'number' ? state.settings.opacity : 0.5;
  document.documentElement.style.setProperty('--panel-alpha', String(opacity));
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
    const day = (r && r.day) || {};
    state.plans = Array.isArray(day.plans) ? day.plans : [];
    state.dones = Array.isArray(day.dones) ? day.dones : [];
    if (r && r.settings) state.settings = r.settings;
  } catch (err) {
    showToast('数据加载失败：' + err);
  }
  applySettings();
  renderAll();
}

function bindEvents() {
  initTimePicker();

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (pendingDelete) {
      cancelDelete();
      return;
    }
    const pickingCard = document.querySelector('.edit-card.is-picking');
    if (pickingCard) {
      pickingCard.classList.remove('is-picking');
      const btn = pickingCard.querySelector('.edit-time');
      if (btn) btn.classList.remove('is-open');
      return;
    }
    if (el('composer').classList.contains('is-picking')) {
      setTimePicker(false);
    } else if (editingPlanId) {
      editingPlanId = null;
      renderPlans();
    } else {
      api.panelHide();
    }
  });

  document.addEventListener('pointerdown', (ev) => {
    if (pendingDelete) {
      const row = document.querySelector('.row.is-confirming');
      if (!row || !row.contains(ev.target)) cancelDelete();
    }
    if (el('composer').classList.contains('is-picking') && !el('composer').contains(ev.target)) {
      setTimePicker(false);
    }
    document.querySelectorAll('.edit-card.is-picking').forEach((card) => {
      if (card.contains(ev.target)) return;
      card.classList.remove('is-picking');
      const btn = card.querySelector('.edit-time');
      if (btn) btn.classList.remove('is-open');
    });
  });

  const submitComposer = () => {
    const text = el('textInput').value.trim();
    if (!text) return;
    const time = state.timeText || currentTimeText();
    lastAddedId = uid('p');
    if (state.view === 'plans') addPlan(time, text, lastAddedId);
    else {
      lastAddedId = uid('d');
      addManualDone(time, text, lastAddedId);
    }
    setTimePicker(false);
    el('textInput').value = '';
    el('textInput').focus();
  };
  el('textInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') submitComposer();
  });

  el('tabPlans').addEventListener('click', () => setView('plans'));
  el('tabDones').addEventListener('click', () => setView('dones'));
  // 面板贴顶隐藏后，靠鼠标进出窗口滑出/收回（是否响应由主进程判断）
  document.addEventListener('mouseenter', () => api.panelHover(true));
  document.addEventListener('mouseleave', () => api.panelHover(false));


  api.onDataChanged((payload) => {
    if (!payload) return;
    if (payload.settings) {
      state.settings = payload.settings;
      applySettings();
    }
    if (payload.day && payload.dateKey === state.dateKey) {
      state.plans = Array.isArray(payload.day.plans) ? payload.day.plans : [];
      state.dones = Array.isArray(payload.day.dones) ? payload.day.dones : [];
      editingPlanId = null;
      renderAll();
    }
    if (payload.notice) showToast(payload.notice);
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
    const day = (r && r.day) || {};
    state.plans = Array.isArray(day.plans) ? day.plans : [];
    state.dones = Array.isArray(day.dones) ? day.dones : [];
    if (r && r.settings) state.settings = r.settings;
  } catch (err) {
    showToast('数据加载失败：' + err);
  }
  // 旧版本的默认透明度（0.85 / 0.72）统一切到新默认 50%，用户手动调过的值不动
  const opacity = Number(state.settings.opacity);
  if (Math.abs(opacity - 0.85) < 0.001 || Math.abs(opacity - 0.72) < 0.001) {
    state.settings.opacity = 0.5;
    saveSettings({ opacity: 0.5 });
  }
  applySettings();
  bindEvents();
  renderAll();
  setView('plans', { animate: false });
  el('textInput').focus();
}

init();
