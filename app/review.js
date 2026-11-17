'use strict';
/**
 * 回顾窗口：日 / 周 / 月切换、关键字搜索、导出 Markdown / CSV。
 * 数据由主进程按月分片（months/YYYY-MM.json）读取，渲染层只拿查询结果。
 */

const api = window.workboard;

const state = {
  mode: 'day', // day | week | month
  anchor: startOfDay(new Date()),
  keyword: '',
  days: [],
  settings: { theme: 'auto', opacity: 0.5 },
};

let loadSeq = 0;
let searchTimer = null;
let toastTimer = null;

const el = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function mondayOf(d) {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() + 6) % 7));
}
function keyOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function rangeOf() {
  const a = startOfDay(state.anchor);
  if (state.mode === 'day') return { from: a, to: a };
  if (state.mode === 'week') {
    const s = mondayOf(a);
    return { from: s, to: addDays(s, 6) };
  }
  return { from: new Date(a.getFullYear(), a.getMonth(), 1), to: new Date(a.getFullYear(), a.getMonth() + 1, 0) };
}

function rangeLabel(from, to) {
  const wd = '日一二三四五六';
  if (state.mode === 'day') {
    return `${from.getFullYear()}年${from.getMonth() + 1}月${from.getDate()}日 星期${wd[from.getDay()]}`;
  }
  if (state.mode === 'week') {
    const head = `${from.getFullYear()}年${from.getMonth() + 1}月${from.getDate()}日`;
    const tail = `${from.getFullYear() === to.getFullYear() ? '' : to.getFullYear() + '年'}${to.getMonth() + 1}月${to.getDate()}日`;
    return `${head} – ${tail}`;
  }
  return `${from.getFullYear()}年${from.getMonth() + 1}月`;
}

function timeStart(t) {
  if (!t) return Infinity;
  let m = String(t).match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = String(t).match(/(\d{1,2})\s*(?:点|时)/);
  if (m) return Number(m[1]) * 60;
  return Infinity;
}

function showToast(text) {
  const toast = el('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}

function resolvedTheme() {
  const t = state.settings.theme || 'auto';
  if (t === 'auto') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return t;
}

function applyTheme() {
  document.body.dataset.theme = resolvedTheme();
  const alpha = Number(state.settings.opacity);
  if (isFinite(alpha) && alpha > 0) {
    document.documentElement.style.setProperty('--panel-alpha', String(alpha));
  }
}

function soup(...vals) {
  return vals.every((v) => v === undefined || v === null) ? '' : vals.filter(Boolean).join(' · ');
}

function appendHighlighted(parent, text, kw) {
  if (!kw) {
    parent.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let from = 0;
  let idx = lower.indexOf(kw, from);
  while (idx !== -1) {
    if (idx > from) parent.appendChild(document.createTextNode(text.slice(from, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + kw.length);
    parent.appendChild(mark);
    from = idx + kw.length;
    idx = lower.indexOf(kw, from);
  }
  if (from < text.length) parent.appendChild(document.createTextNode(text.slice(from)));
}

function renderRows(day) {
  const kw = state.keyword.toLowerCase();
  const rows = [
    ...day.plans.map((p) => ({ time: p.time, text: p.text, type: 'plan' })),
    ...day.dones.map((d) => ({ time: d.time, text: d.text, type: 'done' })),
  ].map((r, i) => ({ ...r, i }))
    .sort((a, b) => timeStart(a.time) - timeStart(b.time) || a.i - b.i);

  const ul = document.createElement('ul');
  ul.className = 'rv-rows';
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'rv-row';

    const time = document.createElement('span');
    time.className = 'rv-time' + (row.time ? '' : ' blank');
    time.textContent = row.time || '—';

    const tag = document.createElement('span');
    tag.className = 'rv-tag ' + (row.type === 'done' ? 'is-done' : 'is-plan');
    tag.textContent = row.type === 'done' ? '已办' : '待办';

    const text = document.createElement('span');
    text.className = 'rv-text';
    appendHighlighted(text, row.text, kw);

    li.append(time, tag, text);
    ul.appendChild(li);
  }
  return ul;
}

function renderDay(day) {
  const d = new Date(Number(day.dateKey.slice(0, 4)), Number(day.dateKey.slice(5, 7)) - 1, Number(day.dateKey.slice(8, 10)));
  const block = document.createElement('section');
  block.className = 'rv-day';

  const head = document.createElement('div');
  head.className = 'rv-day-head';

  const date = document.createElement('span');
  date.className = 'rv-day-date';
  date.textContent = `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`;

  const stats = document.createElement('span');
  stats.className = 'rv-day-stats';
  stats.textContent = soup(`完成 ${day.dones.length} 件`, `待办 ${day.plans.length} 条`);

  head.append(date, stats);
  block.append(head, renderRows(day));
  return block;
}

function render() {
  const { from, to } = rangeOf();
  el('rangeTitle').textContent = rangeLabel(from, to);

  let doneCount = 0;
  let planCount = 0;
  for (const d of state.days) {
    doneCount += d.dones.length;
    planCount += d.plans.length;
  }
  const lead = state.keyword
    ? `“${state.keyword}” 命中 ${state.days.length} 天`
    : `${state.days.length} 天有记录`;
  el('rangeSummary').textContent = soup(lead, `完成 ${doneCount} 件`, `待办 ${planCount} 条`);

  const list = el('dayList');
  list.textContent = '';
  for (const day of state.days) list.appendChild(renderDay(day));

  const empty = el('emptyState');
  empty.hidden = state.days.length > 0;
  empty.textContent = state.keyword ? '没有匹配的记录' : '这段时间还没有记录';

  document.querySelectorAll('.rv-mode').forEach((btn) => {
    const active = btn.dataset.mode === state.mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  el('reviewScroll').scrollTop = 0;
}

async function load() {
  const { from, to } = rangeOf();
  const seq = loadSeq + 1;
  loadSeq = seq;
  try {
    const r = await api.historyQuery({ from: keyOf(from), to: keyOf(to), keyword: state.keyword });
    if (seq !== loadSeq) return;
    state.days = (r && r.ok && Array.isArray(r.days)) ? r.days : [];
    if (!r || !r.ok) showToast('回顾数据加载失败');
  } catch (err) {
    if (seq !== loadSeq) return;
    state.days = [];
    showToast('回顾数据加载失败：' + err);
  }
  render();
}

function shift(delta) {
  if (state.mode === 'day') state.anchor = addDays(state.anchor, delta);
  else if (state.mode === 'week') state.anchor = addDays(state.anchor, delta * 7);
  else state.anchor = addMonths(state.anchor, delta);
  load();
}

function setMode(mode) {
  if (mode !== 'day' && mode !== 'week' && mode !== 'month') return;
  if (state.mode === mode) return;
  state.mode = mode;
  load();
}

async function exportRange() {
  const { from, to } = rangeOf();
  const btn = el('exportBtn');
  btn.disabled = true;
  try {
    const r = await api.historyExport({
      from: keyOf(from),
      to: keyOf(to),
      keyword: state.keyword,
      format: el('formatSelect').value,
    });
    if (r && r.ok && r.canceled) showToast('已取消导出');
    else if (r && r.ok) showToast(`已导出 ${r.dayCount} 天记录：${r.path}`);
    else showToast('导出失败：' + ((r && r.error) || '未知错误'));
  } catch (err) {
    showToast('导出失败：' + err);
  } finally {
    btn.disabled = false;
  }
}

function bindEvents() {
  el('prevBtn').addEventListener('click', () => shift(-1));
  el('nextBtn').addEventListener('click', () => shift(1));
  el('todayBtn').addEventListener('click', () => {
    state.anchor = startOfDay(new Date());
    load();
  });
  el('modeDay').addEventListener('click', () => setMode('day'));
  el('modeWeek').addEventListener('click', () => setMode('week'));
  el('modeMonth').addEventListener('click', () => setMode('month'));

  el('searchInput').addEventListener('input', (ev) => {
    const value = ev.target.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      state.keyword = value;
      load();
    }, 250);
  });

  el('exportBtn').addEventListener('click', exportRange);

  // 左右方向键翻页（搜索框内不拦截）
  document.addEventListener('keydown', (ev) => {
    if (ev.target === el('searchInput')) return;
    if (ev.key === 'ArrowLeft') shift(-1);
    if (ev.key === 'ArrowRight') shift(1);
  });

  api.onReviewChanged(() => load());
  api.onSettingsChanged((payload) => {
    if (payload && payload.settings) {
      state.settings = payload.settings;
      applyTheme();
    }
  });
}

async function init() {
  try {
    const r = await api.settingsGet();
    if (r && r.settings) state.settings = r.settings;
  } catch (err) { /* 主题读取失败按默认渲染 */ }
  applyTheme();
  bindEvents();
  render();
  await load();
}

init();
