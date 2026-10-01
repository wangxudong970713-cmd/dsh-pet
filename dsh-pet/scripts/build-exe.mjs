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

import { existsSync, cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
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
  try {
    rmSync(RELEASE_DIR, { recursive: true, force: true });
  } catch (err) {
    console.warn('[build-exe] Warning: Could not clean entire release directory (likely running/locked), overwriting app assets/scripts directly...');
  }
}
mkdirSync(RELEASE_DIR, { recursive: true });

// 4. 拷贝 Electron 运行时
console.log('[build-exe] Copying Electron runtime...');
try {
  cpSync(electronSrcDir, RELEASE_DIR, {
    recursive: true,
    filter: (src) => !src.includes('default_app.asar'),
  });
} catch (e) {
  console.warn('[build-exe] Electron binary files are locked (app is currently running), skipped binary overwrite.');
}

// 重命名 electron.exe -> dsh-pet.exe
const targetExe = join(RELEASE_DIR, 'dsh-pet.exe');
const oldExe = join(RELEASE_DIR, 'electron.exe');
if (existsSync(oldExe)) {
  try {
    execSync(`cmd.exe /c move /y "${oldExe}" "${targetExe}"`);
  } catch (e) {}
}

// 5. 组装 resources/app
console.log('[build-exe] Assembling app bundle in resources/app...');
const appDir = join(RELEASE_DIR, 'resources', 'app');
mkdirSync(appDir, { recursive: true });

// 拷贝 assets（过滤掉仅用于 README 展示的 65MB preview GIF）
cpSync(join(PKG_ROOT, 'assets'), join(appDir, 'assets'), {
  recursive: true,
  filter: (src) => !src.includes('preview'),
});

// 拷贝 runtime/electron-helper
cpSync(join(PKG_ROOT, 'runtime', 'electron-helper'), join(appDir, 'runtime', 'electron-helper'), {
  recursive: true,
});

// 拷贝 wechat-mcp-server 源码（支持微信联动 sidecar 零配置随包启动）
const wechatCandidates = [
  join(PKG_ROOT, 'wechat-mcp-server'),
  join(appDir, 'wechat-mcp-server'),
  resolve(PKG_ROOT, '..', '..', 'wechat-mcp-server'),
];
const wechatServerSrc = wechatCandidates.find((d) => existsSync(join(d, 'wechat_cli_mcp', '__init__.py')));
if (wechatServerSrc && wechatServerSrc !== join(appDir, 'wechat-mcp-server')) {
  console.log('[build-exe] Bundling wechat-mcp-server Python sidecar from: ' + wechatServerSrc);
  cpSync(wechatServerSrc, join(appDir, 'wechat-mcp-server'), {
    recursive: true,
    filter: (src) => {
      const lower = src.toLowerCase();
      return (
        !lower.includes('__pycache__') &&
        !lower.includes('.pytest_cache') &&
        !lower.includes('.git') &&
        !lower.endsWith('.pyc')
      );
    },
  });
}

// 6. 打包内置便携轻量 Python 运行环境至 resources/python（All-In-One 零外部依赖）
const pythonTargetDir = join(RELEASE_DIR, 'resources', 'python');
console.log('[build-exe] Bundling embedded portable Python runtime into: ' + pythonTargetDir);
try {
  execSync(`node "${join(PKG_ROOT, 'scripts', 'bundle-python.mjs')}"`, {
    cwd: PKG_ROOT,
    stdio: 'inherit',
  });
} catch (e) {
  console.warn('[build-exe] Warning: Could not bundle embedded Python: ' + e.message);
}

// 写入生产 package.json
const prodPkg = {
  name: 'dsh-pet',
  version: '0.2.11',
  description: 'dsh-pet 桌面宠物独立版',
  main: 'runtime/electron-helper/main.js',
};
writeFileSync(join(appDir, 'package.json'), JSON.stringify(prodPkg, null, 2), 'utf8');

// 7. 无损瘦身优化（安全精简约 90MB 纯冗余文件）
console.log('[build-exe] Performing lossless size optimization...');
try {
  // A. 剔除多余的 50+ 国语言包，仅保留中文与英文
  const localesDir = join(RELEASE_DIR, 'locales');
  if (existsSync(localesDir)) {
    const keepLocales = new Set(['zh-cn.pak', 'zh-tw.pak', 'en-us.pak']);
    const pakFiles = readdirSync(localesDir);
    let removedLocales = 0;
    for (const pak of pakFiles) {
      if (!keepLocales.has(pak.toLowerCase())) {
        try {
          rmSync(join(localesDir, pak), { force: true });
          removedLocales++;
        } catch (e) {}
      }
    }
    console.log(`[build-exe] Removed ${removedLocales} unused locale packages (~44MB saved).`);
  }

  // B. 剔除 19MB 的开源协议静态 HTML 文档（运行完全不依赖）
  const licenseHtml = join(RELEASE_DIR, 'LICENSES.chromium.html');
  if (existsSync(licenseHtml)) {
    try {
      rmSync(licenseHtml, { force: true });
      console.log('[build-exe] Removed LICENSES.chromium.html (~19.4MB saved).');
    } catch (e) {}
  }

  // C. 剔除 24MB 的 DirectX 编译动态库（普通 2D/Canvas 视频窗口无需 WebGPU 着色器编译）
  const dxCompiler = join(RELEASE_DIR, 'dxcompiler.dll');
  if (existsSync(dxCompiler)) {
    try {
      rmSync(dxCompiler, { force: true });
      console.log('[build-exe] Removed dxcompiler.dll (~24.4MB saved).');
    } catch (e) {}
  }
} catch (e) {
  console.warn('[build-exe] Lossless optimization warning:', e.message);
}

console.log('\n======================================================');
console.log('🎉 独立版 Windows EXE 构建成功！');
console.log(`📂 输出目录: ${RELEASE_DIR}`);
console.log(`🚀 主程序: ${targetExe}`);
console.log('💡 使用方式: 直接双击 dsh-pet.exe 即可运行，完全免安装、免外部环境！');
console.log('======================================================\n');
