#!/usr/bin/env node
/**
 * build-exe.mjs —— 打包独立 Windows 绿色免安装版 EXE 应用
 *
 * 流程：
 * 1. 构建共享核心库 shared-core.js；
 * 2. 准备 Electron 运行时二进制文件；
 * 3. 组装 release/dsh-pet-win-x64/ 独立绿色免安装运行目录；
 * 4. 拷贝 assets/ 与 runtime/electron-helper/ 到 resources/app/；
 * 5. 将主执行文件重命名为 dsh-pet.exe；
 * 6. 输出可直接分发的免安装便携目录及测试指令。
 */

import { existsSync, cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, '..');
const RELEASE_DIR = resolve(PKG_ROOT, 'release', 'dsh-pet-win-x64');

// 1. 寻找 Electron 运行时
const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const electronSrcDir = resolve(HOME, 'electron');
const electronExe = join(electronSrcDir, 'electron.exe');

if (!existsSync(electronExe)) {
  console.log('[build-exe] Electron not found in ~/.dsh/electron, running ensure-electron.mjs...');
  execSync('node scripts/ensure-electron.mjs', { cwd: PKG_ROOT, stdio: 'inherit' });
}

if (!existsSync(electronExe)) {
  console.error('[build-exe] Error: electron.exe not found at ' + electronExe);
  process.exit(1);
}

// 2. 构建 shared-core.js
console.log('[build-exe] Building desktop core (shared-core.js)...');
execSync('node scripts/build-desktop-core.mjs', { cwd: PKG_ROOT, stdio: 'inherit' });

// 3. 准备输出目录
console.log(`[build-exe] Preparing release directory: ${RELEASE_DIR}`);
if (existsSync(RELEASE_DIR)) {
  rmSync(RELEASE_DIR, { recursive: true, force: true });
}
mkdirSync(RELEASE_DIR, { recursive: true });

// 4. 拷贝 Electron 运行时
console.log('[build-exe] Copying Electron runtime...');
cpSync(electronSrcDir, RELEASE_DIR, {
  recursive: true,
  filter: (src) => !src.includes('default_app.asar'),
});

// 重命名 electron.exe -> dsh-pet.exe
const targetExe = join(RELEASE_DIR, 'dsh-pet.exe');
const oldExe = join(RELEASE_DIR, 'electron.exe');
if (existsSync(oldExe)) {
  execSync(`cmd.exe /c move /y "${oldExe}" "${targetExe}"`);
}

// 5. 组装 resources/app
console.log('[build-exe] Assembling app bundle in resources/app...');
const appDir = join(RELEASE_DIR, 'resources', 'app');
mkdirSync(appDir, { recursive: true });

// 拷贝 assets
cpSync(join(PKG_ROOT, 'assets'), join(appDir, 'assets'), { recursive: true });

// 拷贝 runtime/electron-helper
cpSync(join(PKG_ROOT, 'runtime', 'electron-helper'), join(appDir, 'runtime', 'electron-helper'), {
  recursive: true,
});

// 写入生产 package.json
const prodPkg = {
  name: 'dsh-pet',
  version: '0.2.11',
  description: 'dsh-pet 桌面宠物独立版',
  main: 'runtime/electron-helper/main.js',
};
writeFileSync(join(appDir, 'package.json'), JSON.stringify(prodPkg, null, 2), 'utf8');

console.log('\n======================================================');
console.log('🎉 独立版 Windows EXE 构建成功！');
console.log(`📂 输出目录: ${RELEASE_DIR}`);
console.log(`🚀 主程序: ${targetExe}`);
console.log('💡 使用方式: 直接双击 dsh-pet.exe 即可运行，完全免安装、免外部环境！');
console.log('======================================================\n');
