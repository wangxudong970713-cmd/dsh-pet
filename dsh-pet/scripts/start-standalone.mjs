#!/usr/bin/env node
/**
 * start-standalone.mjs —— 启动独立桌面端桌宠（无需 DSH 宿主）
 *
 * 用法：
 *   node scripts/start-standalone.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const helperMain = resolve(here, '..', 'runtime', 'electron-helper', 'main.js');

const PLAT = process.platform;
const electronRel =
  PLAT === 'win32'
    ? 'electron.exe'
    : PLAT === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';

const candidates = [
  process.env.DSH_PET_ELECTRON_PATH,
  process.env.ELECTRON_PATH,
  join(
    process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'),
    'electron',
    electronRel,
  ),
];

const electron = candidates.find((value) => value && existsSync(value));
if (!electron) {
  console.error('[start-standalone] Electron not found. Run `npm run ensure:electron` first.');
  process.exit(1);
}

console.log(`[start-standalone] Starting dsh-pet standalone desktop app...`);
console.log(`[start-standalone] Electron: ${electron}`);

const env = {
  ...process.env,
  DSH_PET_BRIDGE: '1',
  DSH_PET_CONFIG_URL: 'dsh-pet-bridge://dsh-pet/dsh-pet-7340/config',
};

const child = spawn(electron, [helperMain], { env, stdio: 'inherit', windowsHide: false });
child.on('exit', (code, signal) => {
  console.log(`[start-standalone] app exited (code=${code}, signal=${signal})`);
});
