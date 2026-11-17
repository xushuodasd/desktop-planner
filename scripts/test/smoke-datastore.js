'use strict';
/**
 * 数据层运行时验证（无 GUI 环境替代冒烟）：
 * 用 scripts/test/electron-mock.js 作为 require('electron') 桩，加载真实的 app/main.js，
 * 在 Node 下端到端验证 v2 存储：根文件只留设置、明细按月分片（months/YYYY-MM.json）、
 * v1 单文件自动迁移、按天读写、历史查询/导出、外部修改监听、非法字段忽略、损坏 .bak 重建。
 * 背景：DSH 沙箱 Job 禁止 CREATE_BREAKAWAY_FROM_JOB，Chromium 引导必崩（0x80000003），
 * 真实 GUI 冒烟须在沙箱外执行（见 .ai-team/evidence/TASK-03-smoke.md）。
 * 运行：node scripts/test/smoke-datastore.js（或 ELECTRON_RUN_AS_NODE=1 electron.exe 运行本脚本）
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'workboard.json');
const BAK_FILE = DATA_FILE + '.bak';
const MONTHS_DIR = path.join(DATA_DIR, 'months');

process.chdir(ROOT);

// 先清理上一轮残留，保证断言环境干净
fs.rmSync(DATA_DIR, { recursive: true, force: true });

// 把 require('electron') 重定向到沙箱可用的 mock（无需 node_modules，干净检出可复跑）
const Module = require('module');
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') {
    return require.resolve('./electron-mock.js');
  }
  return origResolveFilename.call(this, request, ...rest);
};

require(path.join(ROOT, 'app', 'main.js')); // 真实主进程代码

const electron = require(path.join(__dirname, 'electron-mock.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 app/renderer.js todayKey() 同规则的本地日期键（YYYY-MM-DD） */
function keyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let failures = 0;
let passes = 0;
function check(name, cond, extra) {
  const line = `${cond ? 'PASS' : 'FAIL'} | ${name}${extra !== undefined ? ' | ' + extra : ''}`;
  console.log(line);
  if (cond) passes += 1; else failures += 1;
}
function readRoot() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function monthPath(m) {
  return path.join(MONTHS_DIR, m + '.json');
}
function readMonth(m) {
  return JSON.parse(fs.readFileSync(monthPath(m), 'utf8'));
}
function firstOfMonth(key) {
  return key.slice(0, 7) + '-01';
}
function lastOfMonth(key) {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return key.slice(0, 7) + '-' + String(new Date(y, m, 0).getDate()).padStart(2, '0');
}

async function main() {
  await sleep(600); // 等 app.whenReady 的初始化（ensureDataFile/loadBoardFromDisk/startWatcher/registerIpc）

  /* 1. 启动：根文件 v2（只留设置）+ months/ 目录 */
  check('S1 workboard.json 已生成', fs.existsSync(DATA_FILE));
  const j0 = readRoot();
  check('S1 schemaVersion=2', j0.schemaVersion === 2);
  check('S1 根文件不再存 days', !('days' in j0) || Object.keys(j0.days).length === 0);
  check('S1 settings 默认值(0.5/auto/false)',
    j0.settings && j0.settings.opacity === 0.5 && j0.settings.theme === 'auto' && j0.settings.autostart === false);
  check('S1 months/ 目录已创建', fs.existsSync(MONTHS_DIR));
  const wa = electron.__fakeApi.WORK_AREA;
  const bp = j0.settings.panelPosition;
  check('S1 默认 panelPosition 在工作区内',
    bp && bp.x >= wa.left && bp.x + 360 <= wa.right && bp.y >= wa.top && bp.y + 560 <= wa.bottom,
    JSON.stringify(bp));

  const handlers = electron.__ipcHandlers;
  const need = ['data:load', 'day:save', 'month:load', 'history:query', 'history:export',
    'review:open', 'settings:get', 'settings:set', 'panel:toggle', 'panel:show', 'panel:hide'];
  check('S2 IPC 白名单全部注册', need.every((ch) => handlers.has(ch)),
    need.filter((ch) => !handlers.has(ch)).join(',') || 'all');
  check('S2 旧 data:save 通道已移除', !handlers.has('data:save'));
  check('S2 悬浮球通道已移除', ![...handlers.keys()].some((ch) => ch.startsWith('ball:')));

  const now = new Date();
  const key = keyOf(now);
  const month = key.slice(0, 7);
  const t0 = new Date(now.getTime() - 3600e3);

  /* 2. day:save → 只写当月分片，根文件不膨胀 */
  const r1 = await handlers.get('day:save')({}, {
    dateKey: key,
    plans: [{ id: 'p-1', time: '9:00-10:00', text: '开会', createdAt: t0.toISOString() }],
    dones: [{ id: 'd-1', time: '9:00-10:00', text: '面试', source: 'manual', completedAt: now.toISOString() }],
  });
  check('S2 day:save 返回 ok', r1 && r1.ok === true);
  check('S2 月分片已生成 months/' + month + '.json', fs.existsSync(monthPath(month)));
  const m1 = readMonth(month);
  check('S2 计划/已办已持久化到月分片',
    m1.days[key] && m1.days[key].plans.length === 1 && m1.days[key].plans[0].text === '开会'
    && m1.days[key].dones.length === 1 && m1.days[key].dones[0].text === '面试' && m1.days[key].dones[0].source === 'manual');
  check('S2 根文件仍不含 days', !('days' in readRoot()));
  check('S2 月分片原子写无残留 tmp', !fs.existsSync(monthPath(month) + '.tmp'));

  /* 3. data:load 只返回当天 + 设置（面板不再整库加载） */
  const load1 = await handlers.get('data:load')({});
  check('S3 data:load 返回当天明细', load1.dateKey === keyOf(new Date()) && load1.day && load1.day.plans.length === 1);
  check('S3 data:load 不返回整库', !('board' in load1) && !('days' in load1));

  /* 4. 自写守卫：自身写入不触发回环广播 */
  const bc1 = electron.__webContentsSendLog.filter((x) => x.ev === 'data:onchange').length;
  await sleep(700); // > fs.watch 防抖 250ms
  const bc2 = electron.__webContentsSendLog.filter((x) => x.ev === 'data:onchange').length;
  check('S4 自写守卫生效（无回环广播）', bc1 === bc2, `before=${bc1} after=${bc2}`);

  /* 5. 外部修改月分片 → fs.watch → 清缓存并广播当天 */
  m1.days[key].plans[0].text = '开会（外部已改）';
  fs.writeFileSync(monthPath(month), JSON.stringify(m1, null, 2) + '\n', 'utf8');
  await sleep(800);
  const evLog = electron.__webContentsSendLog.filter((x) => x.ev === 'data:onchange');
  const lastEv = evLog[evLog.length - 1];
  check('S5 外部修改月分片触发广播', evLog.length > bc2, `broadcasts=${evLog.length}`);
  check('S5 广播内容为外部最新值',
    !!lastEv && lastEv.payload.day && lastEv.payload.day.plans[0].text === '开会（外部已改）');

  /* 6. 读入校验：非法字段忽略，且不回写覆盖原文件 */
  const m2 = readMonth(month);
  m2.days[key].plans[0].text = 12345; // 非法：text 非字符串 → 该条忽略
  m2.days[key].plans[0].evil = 'hack';
  fs.writeFileSync(monthPath(month), JSON.stringify(m2, null, 2) + '\n', 'utf8');
  await sleep(800);
  const ev6 = electron.__webContentsSendLog.filter((x) => x.ev === 'data:onchange');
  const last6 = ev6[ev6.length - 1];
  check('S6 非法条目被忽略（text 非字符串→条目丢弃）', !!last6 && !last6.payload.day.plans[0]);
  check('S6 原月分片未被回写覆盖（保留 evil 字段）', fs.readFileSync(monthPath(month), 'utf8').includes('evil'));

  /* 7. settings:set（透明度 / 主题 / 自启；300ms 防抖写根文件） */
  const r2 = await handlers.get('settings:set')({}, { opacity: 0.7, theme: 'dark' });
  check('S7 settings:set 响应即时生效', r2 && r2.ok && r2.settings.opacity === 0.7 && r2.settings.theme === 'dark');
  await sleep(450);
  const j3 = readRoot();
  check('S7 设置防抖后持久化', j3.settings.opacity === 0.7 && j3.settings.theme === 'dark');
  const rBad = await handlers.get('settings:set')({}, { opacity: 5, theme: 'hacker' });
  check('S7 越界设置被拒绝/夹取', rBad && rBad.ok && rBad.settings.opacity === 1 && rBad.settings.theme === 'dark');
  const rAuto = await handlers.get('settings:set')({}, { autostart: true });
  check('S7 autostart 开关应用（loginItem）',
    rAuto && rAuto.ok && rAuto.settings.autostart === true && electron.app.getLoginItemSettings().openAtLogin === true);
  await sleep(450);
  const j3b = readRoot();
  check('S7 越界夹取与自启开关最终落盘', j3b.settings.opacity === 1 && j3b.settings.theme === 'dark' && j3b.settings.autostart === true);

  /* 8. panel:toggle 与面板位置落盘 */
  const r3 = await handlers.get('panel:toggle')({});
  const panel = electron.__fakeApi.FakeBrowserWindow.all[0];
  check('S8 panel:toggle 返回 visible', r3 && typeof r3.visible === 'boolean' && panel.isVisible() === r3.visible);
  if (!panel.isVisible()) await handlers.get('panel:toggle')({});
  await sleep(400); // 等 showPanel 的 suppressPanelSync（300ms）结束
  panel.setBounds({ x: 300, y: 240, width: 360, height: 560 });
  (panel.handlers.move || []).forEach((fn) => fn());
  await sleep(900);
  const j4 = readRoot();
  check('S8 面板位置落盘（panelPosition）',
    !!j4.settings.panelPosition && j4.settings.panelPosition.x === 300 && j4.settings.panelPosition.y === 240,
    JSON.stringify(j4.settings.panelPosition));

  /* 9. 跨零点 / 跨月：昨日桶完好、互不污染 */
  const yd = new Date(now.getTime() - 24 * 3600 * 1000);
  const yKey = keyOf(yd);
  const yMonth = yKey.slice(0, 7);
  const tk = keyOf(new Date());
  check('S9 前提：重算的今日键与昨日键不同', tk !== yKey, `yesterday=${yKey} today=${tk}`);
  await handlers.get('day:save')({}, {
    dateKey: yKey,
    plans: [{ id: 'p-y1', time: '8:00-9:00', text: '昨日计划', createdAt: yd.toISOString() }],
    dones: [],
  });
  check('S9 昨日明细落入对应月分片', fs.existsSync(monthPath(yMonth)) && !!readMonth(yMonth).days[yKey]);
  const loadY = await handlers.get('month:load')({}, yMonth);
  check('S9 month:load 可单独取回昨日', loadY.ok && loadY.days[yKey].plans.length === 1 && loadY.days[yKey].plans[0].text === '昨日计划');
  await handlers.get('day:save')({}, {
    dateKey: tk,
    plans: [{ id: 'p-t1', time: '9:00-10:00', text: '今日计划', createdAt: new Date().toISOString() }],
    dones: [],
  });
  const m9 = readMonth(month);
  check('S9 跨零点后新条目写入今日桶', !!m9.days[tk] && m9.days[tk].plans.some((p) => p.text === '今日计划'));
  check('S9 昨日桶未被今日条目污染',
    !!readMonth(yMonth).days[yKey] && readMonth(yMonth).days[yKey].plans.length === 1
    && readMonth(yMonth).days[yKey].plans[0].text === '昨日计划');

  /* 10. 缺 id / 空 id / 重复 id → sanitize 回填唯一 id */
  await handlers.get('day:save')({}, {
    dateKey: key,
    plans: [
      { time: '10:00-11:00', text: '无id条目A', createdAt: '' },
      { id: '', time: '11:00-12:00', text: '空id条目B', createdAt: '' },
      { id: 'p-custom-1', time: '12:00-13:00', text: '自定义id条目C', createdAt: '' },
      { id: 'p-custom-1', time: '13:00-14:00', text: '重复id条目D', createdAt: '' },
    ],
    dones: [{ time: '', text: '无id已办', source: 'manual', completedAt: '' }],
  });
  const j10 = readMonth(month);
  const ids = j10.days[key].plans.map((p) => p.id);
  check('S10 缺/空/重复 id 全部非空', ids.length === 4 && ids.every((s) => typeof s === 'string' && s.length > 0));
  check('S10 回填后 id 唯一（含自定义 id 保留）', new Set(ids).size === 4 && ids[2] === 'p-custom-1' && ids[3] !== 'p-custom-1');
  check('S10 dones 缺 id 回填',
    j10.days[key].dones.length === 1 && typeof j10.days[key].dones[0].id === 'string' && j10.days[key].dones[0].id.length > 0);

  /* 11. month:load 参数校验 */
  const badMonth = await handlers.get('month:load')({}, '2026-13');
  check('S11 非法月份被拒绝', badMonth && badMonth.ok === false);
  const missMonth = await handlers.get('month:load')({}, '1999-01');
  check('S11 不存在月份返回空天集合', missMonth.ok && Object.keys(missMonth.days).length === 0);

  /* 12. history:query：范围 + 关键字 */
  const q1 = await handlers.get('history:query')({}, { from: firstOfMonth(key), to: lastOfMonth(key), keyword: '' });
  check('S12 月度查询命中今天', q1.ok && q1.days.some((d) => d.dateKey === key));
  const q2 = await handlers.get('history:query')({}, { from: firstOfMonth(key), to: lastOfMonth(key), keyword: '条目A' });
  check('S12 关键字命中', q2.ok && q2.days.some((d) => d.dateKey === key), `days=${q2.days && q2.days.length}`);
  const q3 = await handlers.get('history:query')({}, { from: firstOfMonth(key), to: lastOfMonth(key), keyword: '不存在的词' });
  check('S12 关键字无结果返回空', q3.ok && q3.days.length === 0);
  const q4 = await handlers.get('history:query')({}, { from: yMonth + '-01', to: lastOfMonth(key), keyword: '' });
  check('S12 跨月范围可覆盖昨日与今日', q4.ok && q4.days.some((d) => d.dateKey === yKey) && q4.days.some((d) => d.dateKey === key));
  const qBad = await handlers.get('history:query')({}, { from: '2026-01-10', to: '2026-01-01' });
  check('S12 反向范围被拒绝', qBad.ok === false);

  /* 13. history:export：Markdown / CSV 落盘 */
  const exMd = await handlers.get('history:export')({}, { from: firstOfMonth(key), to: lastOfMonth(key), keyword: '', format: 'md' });
  check('S13 Markdown 导出成功', exMd.ok && !!exMd.path && fs.existsSync(exMd.path));
  if (exMd.ok) {
    const md = fs.readFileSync(exMd.path, 'utf8');
    check('S13 Markdown 含日期分节与已办标记', md.includes(`## ${key}`) && md.includes('[已办]'));
  }
  const exCsv = await handlers.get('history:export')({}, { from: firstOfMonth(key), to: lastOfMonth(key), keyword: '', format: 'csv' });
  check('S13 CSV 导出成功', exCsv.ok && !!exCsv.path && fs.existsSync(exCsv.path));
  if (exCsv.ok) {
    const csv = fs.readFileSync(exCsv.path, 'utf8');
    check('S13 CSV 带 BOM 与表头', csv.charCodeAt(0) === 0xFEFF && csv.includes('日期,类型,时间段,内容'));
  }

  /* 14. v1 → v2 自动迁移：旧单文件 days 拆到月分片，根文件清空 days */
  const legacyA = '2025-01-15';
  const legacyB = '2025-02-20';
  const settingsBefore = readRoot().settings;
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    schemaVersion: 1,
    app: 'desktop-planner',
    days: {
      [legacyA]: { plans: [{ id: 'p-l1', time: '8:00', text: '旧计划A', createdAt: '' }], dones: [] },
      [legacyB]: { plans: [], dones: [{ id: 'd-l1', time: '15:00', text: '旧已办B', source: 'manual', completedAt: '' }] },
    },
    settings: settingsBefore,
  }, null, 2) + '\n', 'utf8');
  await sleep(900);
  const root14 = readRoot();
  check('S14 迁移后 schemaVersion=2', root14.schemaVersion === 2);
  check('S14 迁移后根文件不含 days', !('days' in root14));
  check('S14 旧数据拆到 2025-01 分片', fs.existsSync(monthPath('2025-01')) && !!readMonth('2025-01').days[legacyA]);
  check('S14 旧数据拆到 2025-02 分片', fs.existsSync(monthPath('2025-02')) && !!readMonth('2025-02').days[legacyB]);
  check('S14 迁移保留原设置', root14.settings.opacity === settingsBefore.opacity);

  /* 15. 损坏恢复：根文件 .bak 重建；月分片 .bak 重建 */
  fs.writeFileSync(DATA_FILE, '{ this is broken json !!!', 'utf8');
  await sleep(800);
  const ev15 = electron.__webContentsSendLog.filter((x) => x.ev === 'data:onchange');
  const last15 = ev15[ev15.length - 1];
  check('S15 根文件损坏后广播重建+提示',
    !!last15 && typeof last15.payload.notice === 'string' && last15.payload.notice.includes('损坏'),
    last15 && last15.payload.notice);
  check('S15 根文件 .bak 备份已生成', fs.existsSync(BAK_FILE));
  check('S15 重建后为合法 v2 空数据', readRoot().schemaVersion === 2 && !('days' in readRoot()));

  fs.writeFileSync(monthPath(month), '{ broken month !!!', 'utf8');
  await sleep(800);
  check('S15 月分片损坏后 .bak 备份已生成', fs.existsSync(monthPath(month) + '.bak'));
  const r16 = await handlers.get('day:save')({}, {
    dateKey: key,
    plans: [{ id: 'p-after', time: '9:00', text: '损坏后重建', createdAt: '' }],
    dones: [],
  });
  check('S15 损坏后可继续写入', r16.ok && !!readMonth(month).days[key]);

  console.log(`\nRESULT: PASS=${passes} FAIL=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
