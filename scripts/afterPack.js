'use strict';
/**
 * 打包后处理：
 * 1) 用 rcedit 写入自定义图标（signAndEditExecutable=false 时 electron-builder 不会改 exe 图标）
 * 2) 关闭 EmbeddedAsarIntegrityValidation：未签名构建里该 fuse 常导致 exe 在进入 JS 前秒退
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');

function findRcedit() {
  const roots = [
    path.join(__dirname, '..', '.electron-builder-cache', 'winCodeSign'),
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      const p = path.join(root, dir, 'rcedit-x64.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exes = fs
    .readdirSync(context.appOutDir)
    .filter((f) => /^DesktopPlanner\.exe$/i.test(f) || (f.endsWith('.exe') && !/uninstall/i.test(f) && !/elevate/i.test(f)));
  const exeName = exes.find((f) => /DesktopPlanner/i.test(f)) || exes[0];
  if (!exeName) {
    console.warn('[afterPack] no exe found in', context.appOutDir);
    return;
  }
  const exe = path.join(context.appOutDir, exeName);

  const ico = path.join(__dirname, '..', 'app', 'assets', 'icon.ico');
  const rcedit = findRcedit();
  if (rcedit && fs.existsSync(ico)) {
    try {
      execFileSync(rcedit, [exe, '--set-icon', ico], { stdio: 'inherit' });
      console.log('[afterPack] icon applied');
    } catch (err) {
      console.warn('[afterPack] icon failed:', err.message);
    }
  } else {
    console.warn('[afterPack] rcedit or icon missing, skip icon');
  }

  console.log('[afterPack] flipFuses', exe);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: false,
  });
  console.log('[afterPack] fuses updated');
};
