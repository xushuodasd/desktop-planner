'use strict';
/**
 * 带可写缓存目录跑 electron-builder（避免 %LOCALAPPDATA% 权限/符号链接问题）。
 * 用法：node scripts/run-dist.js [--dir]
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const cache = path.join(root, '.electron-cache');
const builderCache = path.join(root, '.electron-builder-cache');
const tmp = path.join(root, '.tmp');
for (const d of [cache, builderCache, tmp]) {
  fs.mkdirSync(d, { recursive: true });
}

const env = {
  ...process.env,
  ELECTRON_CACHE: cache,
  ELECTRON_BUILDER_CACHE: builderCache,
  TEMP: tmp,
  TMP: tmp,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

const dirOnly = process.argv.includes('--dir');
const args = dirOnly ? ['--win', 'dir'] : ['--win', 'nsis'];

function setIntegrity(dir, level) {
  if (process.platform !== 'win32') return;
  const res = spawnSync('icacls', [dir, '/setintegritylevel', `(OI)(CI)${level}`, '/T', '/C', '/Q']);
  if (res.status !== 0) console.warn('[run-dist] icacls 设置完整性级别失败，忽略');
  else console.log(`[run-dist] integrity -> ${level === 'M' ? 'Medium' : 'Low'}:`, dir);
}

/**
 * 构建前把 dist 恢复为 Low：本机沙箱环境里打包工具以低完整性运行，
 * 若 dist 留着上次产物设置的 Medium 标签，会因为无写权限而报 Access is denied。
 */
const distDir = path.join(root, 'dist');
if (fs.existsSync(distDir)) setIntegrity(distDir, 'L');

const r = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-builder', ...args],
  { cwd: root, env, stdio: 'inherit', shell: true },
);

/**
 * 产物必须是 Medium：若构建目录带 Mandatory Label\Low（工作区被打过标签），
 * 产物会继承该标签；从带 Low 标签的 exe 启动时进程被降为 Low IL，
 * 无法写 %APPDATA%（Chromium ProcessSingleton 报 Error 5 秒退）和文档目录。
 */
if (r.status === 0) setIntegrity(distDir, 'M');
process.exit(r.status == null ? 1 : r.status);
