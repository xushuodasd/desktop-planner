'use strict';
/**
 * 数据层运行时验证（无 GUI 环境替代冒烟）：
 * 用 scripts/test/electron-mock.js 作为 require('electron') 桩，加载真实的 app/main.js，
 * 在 Node 下端到端验证：数据文件创建（schemaVersion:1）、IPC 白名单保存、原子写、
 * 自写守卫防回环、外部修改监听→广播重载、非法字段忽略且保留原文件、损坏 .bak 重建。
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
let failures = 0;
let passes = 0;
function check(name, cond, extra) {
  const line = `${cond ? 'PASS' : 'FAIL'} | ${name}${extra !== undefined ? ' | ' + extra : ''}`;
  console.log(line);
  if (cond) passes += 1; else failures += 1;
}
function readBoard() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

async function main() {
  await sleep(600); // 等 app.whenReady 的初始化（ensureDataFile/loadBoardFromDisk/startWatcher/registerIpc）

  /* 1. 启动即确保数据文件存在（含 schemaVersion:1、空 days） */
  check('S1 workboard.json 已生成', fs.existsSync(DATA_FILE));
  const j0 = readBoard();
  check('S1 schemaVersion=1', j0.schemaVersion === 1);
  check('S1 days 为空对象', j0.days && typeof j0.days === 'object' && Object.keys(j0.days).length === 0);
  check('S1 settings 默认值(0.85/auto/false)',
    j0.settings && j0.settings.opacity === 0.85 && j0.settings.theme === 'auto' && j0.settings.autostart === false);
  const wa = electron.__fakeApi.WORK_AREA;
  const bp = j0.settings.ballPosition;
  check('S1 默认 ballPosition 在工作区内',
    bp && bp.x >= wa.left && bp.x + 56 <= wa.right && bp.y >= wa.top && bp.y + 56 <= wa.bottom,
    JSON.stringify(bp));

  const handlers = electron.__ipcHandlers;
  const need = ['data:load', 'data:save', 'settings:get', 'settings:set', 'panel:toggle', 'panel:show', 'panel:hide', 'ball:drag-start', 'ball:drag-move', 'ball:drag-end'];
  check('S2 IPC 白名单全部注册', need.every((ch) => handlers.has(ch)),
    need.filter((ch) => !handlers.has(ch)).join(',') || 'all');

  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const t0 = new Date(now.getTime() - 3600e3);

  /* 2. data:save（REQ-003/004/005 数据落地） */
  const r1 = await handlers.get('data:save')({}, {
    dateKey: key,
    plans: [{ id: 'p-1', time: '9:00-10:00', text: '开会', createdAt: t0.toISOString() }],
    dones: [{ id: 'd-1', time: '9:00-10:00', text: '面试', source: 'manual', completedAt: now.toISOString() }],
  });
  check('S2 data:save 返回 ok', r1 && r1.ok === true);
  const j1 = readBoard();
  check('S2 计划/已办已持久化',
    j1.days[key] && j1.days[key].plans.length === 1 && j1.days[key].plans[0].text === '开会'
    && j1.days[key].dones.length === 1 && j1.days[key].dones[0].text === '面试' && j1.days[key].dones[0].source === 'manual');
  check('S2 原子写无残留 tmp', !fs.existsSync(DATA_FILE + '.tmp'));

  /* 3. 自写守卫：自身写入不触发回环广播 */
  const bc1 = electron.__webContentsSendLog.filter((x) => x.ev === 'data:onchange').length;
  await sleep(700); // > fs.watch 防抖 250ms
  const bc2 = electron.__webContentsSendLog.filter((x) => x.ev === 'data:onchange').length;
  check('S3 自写守卫生效（无回环广播）', bc1 === bc2, `before=${bc1} after=${bc2}`);

  /* 4. 外部修改 → fs.watch → 广播重载（REQ-006） */
  j1.days[key].plans[0].text = '开会（外部已改）';
  fs.writeFileSync(DATA_FILE, JSON.stringify(j1, null, 2) + '\n', 'utf8');
  await sleep(800);
  const evLog = electron.__webContentsSendLog.filter((x) => x.ev === 'data:onchange');
  const lastEv = evLog[evLog.length - 1];
  check('S4 外部修改触发广播', evLog.length > bc2, `broadcasts=${evLog.length}`);
  check('S4 广播内容为外部最新值',
    !!lastEv && lastEv.payload.board.days[key].plans[0].text === '开会（外部已改）');

  /* 5. 读入校验：非法字段忽略，且不回写覆盖原文件（保留原文件） */
  const j2 = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  j2.days[key].plans[0].text = 12345; // 非法：text 非字符串 → 该条忽略
  j2.days[key].plans[0].evil = 'hack';
  j2.settings.opacity = 0.3; // 非法：低于 0.6 → 夹取 0.6
  fs.writeFileSync(DATA_FILE, JSON.stringify(j2, null, 2) + '\n', 'utf8');
  await sleep(800);
  const ev5 = electron.__webContentsSendLog.filter((x) => x.ev === 'data:onchange');
  const last5 = ev5[ev5.length - 1];
  const planAfter = last5 && last5.payload.board.days[key].plans[0];
  check('S5 非法条目被忽略（text 非字符串→条目丢弃）', !planAfter);
  check('S5 opacity 夹取至 0.6–1', last5 && last5.payload.board.settings.opacity === 0.6,
    String(last5 && last5.payload.board.settings.opacity));
  const rawOnDisk = fs.readFileSync(DATA_FILE, 'utf8');
  check('S5 原文件未被回写覆盖（保留 evil 字段）', rawOnDisk.includes('evil'));

  /* 6. settings:set（REQ-002 透明度 / 主题；autostart 应用 loginItem） */
  const r2 = await handlers.get('settings:set')({}, { opacity: 0.7, theme: 'dark' });
  check('S6 settings:set ok 且生效', r2 && r2.ok && r2.settings.opacity === 0.7 && r2.settings.theme === 'dark');
  const j3 = readBoard();
  check('S6 设置已持久化', j3.settings.opacity === 0.7 && j3.settings.theme === 'dark');
  const rBad = await handlers.get('settings:set')({}, { opacity: 5, theme: 'hacker' });
  check('S6 越界设置被拒绝/夹取', rBad && rBad.ok && rBad.settings.opacity === 1 && rBad.settings.theme === 'dark');
  const rAuto = await handlers.get('settings:set')({}, { autostart: true });
  check('S6 autostart 开关应用（loginItem）', rAuto && rAuto.ok && rAuto.settings.autostart === true && electron.app.getLoginItemSettings().openAtLogin === true);

  /* 7. panel:toggle 与拖动落盘（REQ-001/002） */
  const r3 = await handlers.get('panel:toggle')({});
  const panel = electron.__fakeApi.FakeBrowserWindow.all[1];
  check('S7 panel:toggle 返回 visible', r3 && typeof r3.visible === 'boolean' && panel.visible === r3.visible);
  const ball = electron.__fakeApi.FakeBrowserWindow.all[0];
  await handlers.get('ball:drag-start')({}, { x: 2000, y: 200 });
  const mv = await handlers.get('ball:drag-move')({}, { x: 2050, y: 230 });
  check('S7 drag-move 判定为拖动', mv && mv.moved === true);
  const r4 = await handlers.get('ball:drag-end')({}, { x: 2050, y: 230 });
  const j4 = readBoard();
  const b = ball.getBounds();
  check('S7 拖动结束记忆位置并夹取工作区',
    r4 && r4.clicked === false && j4.settings.ballPosition.x === b.x && j4.settings.ballPosition.y === b.y
    && b.x >= wa.left && b.x + 56 <= wa.right && b.y >= wa.top && b.y + 56 <= wa.bottom,
    JSON.stringify({ saved: j4.settings.ballPosition, bounds: { x: b.x, y: b.y } }));

  /* 8. 损坏恢复：.bak 备份 + 空数据重建 + 提示广播（design §2） */
  fs.writeFileSync(DATA_FILE, '{ this is broken json !!!', 'utf8');
  await sleep(800);
  const ev8 = electron.__webContentsSendLog.filter((x) => x.ev === 'data:onchange');
  const last8 = ev8[ev8.length - 1];
  check('S8 损坏后广播重建+提示', !!last8 && typeof last8.payload.notice === 'string' && last8.payload.notice.includes('损坏'),
    last8 && last8.payload.notice);
  check('S8 .bak 备份已生成', fs.existsSync(BAK_FILE));
  const j5 = readBoard();
  check('S8 重建后为合法空数据', j5.schemaVersion === 1 && Object.keys(j5.days).length === 0);

  console.log(`\nRESULT: PASS=${passes} FAIL=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
