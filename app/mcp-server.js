'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { version } = require('./package.json');
const { validDateKey, monthOf, completionDate, localDateKey, storedMonths } = require('./workboard-files');

const protocols = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const dateField = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const inputSchema = {
  type: 'object',
  properties: {
    from: { ...dateField, description: '起始日期（含当天）' },
    to: { ...dateField, description: '结束日期（含当天）' },
    keyword: { type: 'string', maxLength: 200, description: '按事项文本搜索' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
  additionalProperties: false,
};
const tools = [
  { name: 'list_pending_tasks', description: '读取未完成待办。日期按原添加日筛选，默认包含截至今天的所有未完成待办。' },
  { name: 'list_completed_tasks', description: '读取已办，按实际完成日筛选。未传日期时只查今天，只传一个日期时只查该日。' },
].map((tool) => ({
  ...tool, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function readJson(file) {
  try {
    return object(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function parseFilters(input, pending, today) {
  if (input !== object(input) || Object.keys(input).some((key) => !Object.hasOwn(inputSchema.properties, key))) {
    throw new Error('查询参数无效');
  }
  const { from, to, keyword = '', limit = 50, offset = 0 } = input;
  for (const date of [from, to]) {
    if (date === undefined) continue;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!validDateKey(date) || !Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error('日期必须为有效的 YYYY-MM-DD');
    }
  }
  if (typeof keyword !== 'string' || keyword.length > 200 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0) throw new Error('搜索或分页参数无效');
  const start = pending ? from : from ?? to ?? today;
  const end = pending ? to ?? today : to ?? from ?? today;
  if (start && start > end) throw new Error('起始日期晚于结束日期');
  return { start, end, keyword: keyword.trim().toLowerCase(), limit, offset };
}

function query(dataDir, pending, input) {
  const today = localDateKey();
  const { start, end, keyword, limit, offset } = parseFilters(input, pending, today);
  const legacy = object(readJson(path.join(dataDir, 'workboard.json')).days);
  const monthDir = path.join(dataDir, 'months');
  const matches = [];
  for (const month of storedMonths(monthDir, legacy)) {
    if (pending && ((start && month < monthOf(start)) || month > monthOf(end))) continue;
    const days = {
      ...Object.fromEntries(Object.entries(legacy).filter(([key]) => monthOf(key) === month)),
      ...object(readJson(path.join(monthDir, `${month}.json`)).days),
    };
    for (const [originDate, day] of Object.entries(days)) {
      if (!validDateKey(originDate) || monthOf(originDate) !== month) continue;
      const items = day?.[pending ? 'plans' : 'dones'];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (typeof item?.text !== 'string' || !item.text.trim()) continue;
        const date = pending ? originDate : completionDate(item, originDate);
        const text = item.text.slice(0, 200);
        if ((start && date < start) || date > end || (pending && date > today) ||
            !text.toLowerCase().includes(keyword)) continue;
        matches.push({
          date, originDate, text, time: typeof item.time === 'string' ? item.time.slice(0, 40) : '',
          ...(!pending && typeof item.completedAt === 'string' && { completedAt: item.completedAt.slice(0, 40) }),
        });
      }
    }
  }
  matches.sort((a, b) => (pending ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)) ||
    a.time.localeCompare(b.time, 'en', { numeric: true }));
  return {
    items: matches.slice(offset, offset + limit),
    total: matches.length,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
  };
}

function main(dataDir) {
  if (!dataDir || !path.isAbsolute(dataDir) || !fs.existsSync(dataDir)) {
    console.error('请传入存在的悬浮工作台数据目录。');
    process.exitCode = 1;
    return;
  }
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (id, payload) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n');
  const toolResult = (value, isError = false) => ({
    content: [{ type: 'text', text: isError ? value : JSON.stringify(value) }],
    ...(isError ? { isError } : { structuredContent: value }),
  });
  input.on('line', (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send(null, { error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      send(null, { error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const { id, method, params } = request;
    if (id === undefined) return;
    switch (method) {
      case 'initialize':
        send(id, { result: {
          protocolVersion: protocols.includes(params?.protocolVersion) ? params.protocolVersion : protocols[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'desktop-planner', version },
        } });
        break;
      case 'ping': send(id, { result: {} }); break;
      case 'tools/list': send(id, { result: { tools } }); break;
      case 'tools/call': {
        const tool = tools.find((item) => item.name === params?.name);
        if (!tool) {
          send(id, { error: { code: -32602, message: 'Unknown tool' } });
          break;
        }
        try {
          const result = query(dataDir, tool === tools[0], params.arguments === undefined ? {} : params.arguments);
          send(id, { result: toolResult(result) });
        } catch (err) {
          const message = err.code || err instanceof SyntaxError ? '读取工作台数据失败，请检查 JSON 文件。' : err.message;
          send(id, { result: toolResult(message, true) });
        }
        break;
      }
      default:
        send(id, { error: { code: -32601, message: 'Method not found' } });
    }
  });
}

main(process.argv[2]);
