'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { localDateKey } = require('../../app/workboard-files');

test('MCP exposes only read tools and uses the origin and completion dates correctly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-mcp-'));
  try {
    const today = localDateKey();
    const origin = localDateKey(new Date(2024, 11, 15));
    const month = origin.slice(0, 7);
    const root = path.join(dir, 'workboard.json');
    const shard = path.join(dir, 'months', month + '.json');
    const legacy = JSON.stringify({ schemaVersion: 1, days: {
      [origin]: { plans: [{ text: '已被月文件覆盖' }] },
      '2024-11-01': { plans: [{ text: '旧版待办' }] },
    } });
    const contents = JSON.stringify({ days: {
      [origin]: {
        plans: [{ text: '跨月待办', time: '9:00' }],
        dones: [{ text: '今天完成的旧任务', completedDateKey: today }, { text: '旧已办' }],
      },
    } });
    fs.mkdirSync(path.dirname(shard));
    fs.writeFileSync(root, legacy);
    fs.writeFileSync(shard, contents);
    const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
    const call = (id, name, args) => req(id, 'tools/call', { name, arguments: args });
    const messages = [
      req(1, 'initialize', { protocolVersion: '2025-11-25' }),
      req(undefined, 'notifications/initialized'),
      req(2, 'tools/list'),
      call(3, 'list_pending_tasks', { limit: 1 }),
      call(4, 'list_pending_tasks', { keyword: '跨月', from: origin, to: origin }),
      call(5, 'list_completed_tasks', {}),
      call(6, 'list_completed_tasks', { to: origin }),
      call(7, 'list_pending_tasks', { from: '2024-02-31' }),
      call(8, 'list_pending_tasks', { path: root }),
      call(9, 'delete_task', {}),
    ];
    const binary = process.env.WORKBOARD_MCP_TEST_EXE || process.execPath;
    const entry = process.env.WORKBOARD_MCP_TEST_ENTRY || path.resolve(__dirname, '../../app/mcp-server.js');
    const output = spawnSync(binary, [entry, dir], {
      windowsHide: true,
      timeout: 10000,
      encoding: 'utf8',
      env: { ...process.env, ...(process.env.WORKBOARD_MCP_TEST_EXE && { ELECTRON_RUN_AS_NODE: '1' }) },
      input: messages.map((message) => JSON.stringify(message)).join('\n') + '\n',
    });
    assert.equal(output.status, 0, output.stderr || output.error?.message);
    const replies = new Map(output.stdout.trim().split('\n').map((line) => {
      const { id, result, error } = JSON.parse(line);
      return [id, result ?? error];
    }));
    const result = (id) => replies.get(id).structuredContent;
    assert.equal(replies.size, 9);
    assert.equal(replies.get(1).protocolVersion, '2025-11-25');
    assert.deepEqual(replies.get(2).tools.map(({ name }) => name), ['list_pending_tasks', 'list_completed_tasks']);
    assert.ok(replies.get(2).tools.every(({ annotations }) => annotations.readOnlyHint));
    assert.equal(result(3).total, 2);
    assert.equal(result(3).nextOffset, 1);
    assert.equal(result(4).items[0].originDate, origin);
    assert.deepEqual(result(5).items.map(({ date, originDate, text }) => [date, originDate, text]),
      [[today, origin, '今天完成的旧任务']]);
    assert.deepEqual(result(6).items.map(({ text }) => text), ['旧已办']);
    assert.ok(replies.get(7).isError);
    assert.ok(replies.get(8).isError);
    assert.equal(replies.get(9).code, -32602);
    assert.equal(fs.readFileSync(root, 'utf8'), legacy);
    assert.equal(fs.readFileSync(shard, 'utf8'), contents);
  } finally {
    const resolved = fs.realpathSync(dir);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('planner-mcp-')) {
      throw new Error('Unexpected MCP test directory');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
