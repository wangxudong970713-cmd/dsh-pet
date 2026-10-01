#!/usr/bin/env node
/**
 * bundle-python.mjs —— 提取并打包零依赖内置轻量便携 Python 运行时
 *
 * 将当前系统的 Python 精简提取出运行微信侧车（wechat-mcp-server）所需的环境：
 * 包含：核心解释器 DLL、sqlite3/ctypes 动态库、标准库子集、Crypto 与 zstandard。
 * 输出到 release/dsh-pet-win-x64/resources/python 目录，体积仅约 30MB。
 */

import { existsSync, cpSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, '..');
const TARGET_DIR = resolve(PKG_ROOT, 'release', 'dsh-pet-win-x64', 'resources', 'python');

function findSourcePythonRoot() {
  // 1. 尝试显式环境变量
  if (process.env.DSH_PET_WECHAT_PYTHON && existsSync(process.env.DSH_PET_WECHAT_PYTHON)) {
    return dirname(process.env.DSH_PET_WECHAT_PYTHON);
  }
  // 2. 尝试从 which / where python 查找
  try {
    const stdout = execSync('where.exe python', { encoding: 'utf8' }).trim();
    const firstLine = stdout.split(/\r?\n/)[0];
    if (firstLine && existsSync(firstLine) && !firstLine.includes('WindowsApps')) {
      return dirname(firstLine);
    }
  } catch (e) {}

  // 3. 常见 Windows 安装位置扫描
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    join(localAppData, 'Programs', 'Python', 'Python313'),
    join(localAppData, 'Programs', 'Python', 'Python312'),
    join(localAppData, 'Programs', 'Python', 'Python311'),
    join(localAppData, 'Programs', 'Python', 'Python310'),
    'C:\\Python313',
    'C:\\Python312',
    'C:\\Python311',
    'C:\\Python310',
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'python.exe'))) {
      return c;
    }
  }
  return null;
}

function safeCopy(src, dst) {
  try {
    if (existsSync(dst)) {
      const srcStat = statSync(src);
      const dstStat = statSync(dst);
      if (srcStat.size === dstStat.size) {
        return; // 体积完全一致，跳过写入，避免锁冲突
      }
    }
    cpSync(src, dst, { recursive: true, force: true });
  } catch (e) {
    try {
      cpSync(src, dst, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[bundle-python] safeCopy note for ${dst}: ${err.message}`);
    }
  }
}

export function bundleEmbeddedPython(targetDir = TARGET_DIR) {
  console.log('[bundle-python] Starting embedded Python assembly...');
  const srcRoot = findSourcePythonRoot();
  if (!srcRoot) {
    console.warn('[bundle-python] Warning: Source Python not found. Skipped embedding Python.');
    return false;
  }
  console.log(`[bundle-python] Found source Python at: ${srcRoot}`);

  mkdirSync(targetDir, { recursive: true });
  mkdirSync(join(targetDir, 'DLLs'), { recursive: true });
  mkdirSync(join(targetDir, 'Lib', 'site-packages'), { recursive: true });

  // 1. 复制核心可执行文件与根动态链接库
  const rootFiles = readdirSync(srcRoot);
  for (const f of rootFiles) {
    const lower = f.toLowerCase();
    if (
      lower === 'python.exe' ||
      lower === 'pythonw.exe' ||
      lower.startsWith('python3') && lower.endsWith('.dll') ||
      lower.startsWith('vcruntime140') && lower.endsWith('.dll')
    ) {
      safeCopy(join(srcRoot, f), join(targetDir, f));
    }
  }

  // 2. 复制必需的 DLLs
  const srcDLLs = join(srcRoot, 'DLLs');
  if (existsSync(srcDLLs)) {
    const dllEntries = readdirSync(srcDLLs);
    for (const f of dllEntries) {
      const lower = f.toLowerCase();
      // 排除庞大的 Tkinter, Tcl 库，只保留网络/加解密/数据库所需动态库
      if (
        !lower.includes('tcl') &&
        !lower.includes('tk') &&
        !lower.includes('test')
      ) {
        safeCopy(join(srcDLLs, f), join(targetDir, 'DLLs', f));
      }
    }
  }

  // 3. 复制标准库 Lib（排除无关的测试集与 IDE 辅助）
  const srcLib = join(srcRoot, 'Lib');
  if (existsSync(srcLib)) {
    const libEntries = readdirSync(srcLib);
    for (const f of libEntries) {
      const lower = f.toLowerCase();
      if (
        lower === 'site-packages' ||
        lower === 'test' ||
        lower === 'idlelib' ||
        lower === 'tkinter' ||
        lower === 'turtledemo' ||
        lower === 'ensurepip' ||
        lower === 'venv' ||
        lower === 'pydoc_data' ||
        lower === 'unittest' ||
        lower === 'distutils' ||
        lower === '__pycache__'
      ) {
        continue;
      }
      try {
        safeCopy(join(srcLib, f), join(targetDir, 'Lib', f));
      } catch (e) {}
    }
  }

  // 4. 精准复制关键业务依赖包（Crypto 与 zstandard）
  const srcSite = join(srcRoot, 'Lib', 'site-packages');
  if (existsSync(srcSite)) {
    const siteEntries = readdirSync(srcSite);
    for (const f of siteEntries) {
      const lower = f.toLowerCase();
      if (
        lower === 'crypto' ||
        lower.startsWith('pycryptodome') ||
        lower.startsWith('zstandard')
      ) {
        try {
          safeCopy(join(srcSite, f), join(targetDir, 'Lib', 'site-packages', f));
        } catch (e) {}
      }
    }
  }

  // 5. 验证独立解释器是否正常可用
  const targetPythonExe = join(targetDir, 'python.exe');
  if (!existsSync(targetPythonExe)) {
    console.error('[bundle-python] Failed: target python.exe does not exist.');
    return false;
  }

  try {
    const testCmd = `"${targetPythonExe}" -c "import sqlite3, ctypes, json, Crypto, zstandard; print('EMBEDDED_PYTHON_VERIFIED')"`;
    const out = execSync(testCmd, { encoding: 'utf8' }).trim();
    if (out.includes('EMBEDDED_PYTHON_VERIFIED')) {
      console.log('✅ [bundle-python] Embedded Python runtime assembled & verified successfully!');
      return true;
    }
  } catch (err) {
    console.error('[bundle-python] Verification test failed:', err.message);
    return false;
  }
  return false;
}

// 允许单独直接运行
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  bundleEmbeddedPython();
}
