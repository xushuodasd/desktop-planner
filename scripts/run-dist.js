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
const r = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-builder', ...args],
  { cwd: root, env, stdio: 'inherit', shell: true },
);
process.exit(r.status == null ? 1 : r.status);
