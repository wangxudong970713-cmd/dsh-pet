#!/usr/bin/env node
/**
 * pack-zip.mjs —— 自动化压缩发布包为便携单 ZIP 分发包
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, '..');
const SRC_DIR = resolve(PKG_ROOT, 'release', 'dsh-pet-win-x64');
const OUT_ZIP = resolve(PKG_ROOT, 'release', 'dsh-pet-portable-win-x64.zip');

if (!existsSync(SRC_DIR)) {
  console.error('[pack-zip] Error: release directory not found. Please run "npm run build:exe" first.');
  process.exit(1);
}

if (existsSync(OUT_ZIP)) {
  try {
    rmSync(OUT_ZIP, { force: true });
  } catch (e) {}
}

console.log(`[pack-zip] Compressing release package to: ${OUT_ZIP}...`);
const psCmd = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${SRC_DIR.replace(/'/g, "''")}', '${OUT_ZIP.replace(/'/g, "''")}', [System.IO.Compression.CompressionLevel]::Optimal, $false)`;

try {
  execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`, {
    cwd: PKG_ROOT,
    stdio: 'inherit',
  });
  if (existsSync(OUT_ZIP)) {
    const sizeMB = (statSync(OUT_ZIP).size / 1024 / 1024).toFixed(2);
    console.log('\n======================================================');
    console.log('🎉 便携绿色 ZIP 压缩包制作成功！');
    console.log(`📦 文件路径: ${OUT_ZIP}`);
    console.log(`📊 压缩后体积: ${sizeMB} MB (大幅瘦身，方便秒发好友或网盘)`);
    console.log('💡 解压即玩：解压后双击 dsh-pet.exe 即可运行！');
    console.log('======================================================\n');
  }
} catch (err) {
  console.error('[pack-zip] Failed to compress:', err.message);
  process.exit(1);
}
