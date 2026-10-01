#!/usr/bin/env node
/**
 * start-desktop.mjs —— 本地开发/手动启动桌面 Helper（不经 DSH 宿主拉起）。
 *
 * 用法：
 *   node scripts/start-desktop.mjs [configUrl]
 *
 * 环境变量（与宿主拉起时一致）：
 *   DSH_PET_CONFIG_URL / DSH_PET_SCALE / DSH_PET_ELECTRON_PATH
 * 其余端点（thumb/balance/trigger/notify/pic/font）由 renderer 从 configUrl 推导。
 *
 * 示例（对着一台已跑 dsh web 的机器）：
 *   node scripts/start-desktop.mjs http://127.0.0.1:3080/dsh-pet-7340/config
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const helperMain = resolve(here, '..', 'runtime', 'electron-helper', 'main.js');
const defaultConfigUrl =
  process.env.DSH_PET_CONFIG_URL || process.argv[2] || 'http://127.0.0.1:3080/dsh-pet-7340/config';

// 平台适配：Electron 可执行文件相对路径（win32=electron.exe / darwin=Electron.app / linux=electron）
const PLAT = process.platform;
const electronRel =
  PLAT === 'win32'
    ? 'electron.exe'
    : PLAT === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';

// 解析 Electron 可执行文件（不阻塞安装：提示用户先 ensure:electron）
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
  console.error(
    '[start-desktop] Electron not found. Run `npm run ensure:electron` first or set DSH_PET_ELECTRON_PATH.',
  );
  process.exit(1);
}

const env = {
  ...process.env,
  DSH_PET_CONFIG_URL: defaultConfigUrl,
  DSH_PET_SCALE: process.env.DSH_PET_SCALE || '1',
  // 开发流也跟随：本脚本退出（含被强杀）后桌宠自己走，不留一个没人管的 helper
  // （helper 侧 host-liveness.js 每 2s kill(pid, 0) 一次，ESRCH 即自行退出；见 issue #56）
  DSH_PET_HOST_PID: String(process.pid),
};

// Electron 优先识别 ELECTRON_RUN_AS_NODE：只要该变量存在（部分终端 / IDE / 集成环境
// 会预设为 1），electron.exe 就会退化成纯 Node 进程，main.js 里的 require('electron')
// 会抛 "Cannot find module 'electron'" 并立刻退出，表现为「桌宠秒退且没有窗口」。
// 这里显式剔除，保证启动的是真正的 Chromium 主进程。
delete env.ELECTRON_RUN_AS_NODE;

console.log(`[start-desktop] electron:   ${electron}`);
console.log(`[start-desktop] config url: ${env.DSH_PET_CONFIG_URL}`);

const child = spawn(electron, [helperMain], { env, stdio: 'inherit', windowsHide: false });
child.on('exit', (code, signal) => {
  console.log(`[start-desktop] helper exited (code=${String(code)}, signal=${String(signal)})`);
});
