'use strict';
/**
 * 关闭 EmbeddedAsarIntegrityValidation：
 * 未签名构建里该 fuse 常导致 exe 在进入 JS 前秒退（无 early log）。
 */
const fs = require('fs');
const path = require('path');
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');

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
  console.log('[afterPack] flipFuses', exe);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: false,
  });
  console.log('[afterPack] fuses updated');
};
