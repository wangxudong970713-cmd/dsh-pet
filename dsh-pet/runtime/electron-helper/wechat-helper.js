'use strict';
// 微信 sidecar 客户端（桌面端专属，CommonJS）：
//   spawn 一个常驻 Python 进程 `python -m wechat_cli_mcp.bridge`，说行分隔 JSON RPC
//   （见 wechat-mcp-server/wechat_cli_mcp/bridge.py 头部协议说明）——桌宠与微信之间
//   唯一的通道，随桌宠启停，不需要 npm 依赖、不需要 MCP 握手。
//
// 设计要点：
//   - **懒启动**：只有用户开了「微信联动」才会 spawn（关闭联动时桌宠不背一个 Python 进程）。
//   - **崩溃自愈**：进程意外退出按指数退避重启；单条命令失败绝不重启（bridge 侧已把
//     命令级错误转成 ok:false，只有进程没了才算故障）。
//   - **协议纯净**：stdout 只认 JSON 行；非 JSON 行（Python 的告警/编码噪音）进日志不抛错。
//   - 只读：本类只做请求，不做任何写微信数据的动作（bridge 也只读）。

const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');

/** 默认模块入口（可用 DSH_PET_WECHAT_MODULE 覆盖） */
const DEFAULT_MODULE = 'wechat_cli_mcp.bridge';

/** 各命令的超时（毫秒）。ensure_init 要扫微信进程内存，overview 要开多个消息库，都给足。 */
const COMMAND_TIMEOUT_MS = {
  hello: 20_000,
  ping: 10_000,
  detect_db_dir: 30_000,
  ensure_init: 240_000,
  sessions: 90_000,
  history: 90_000,
  resolve: 30_000,
  overview: 240_000,
  shutdown: 5_000,
};
const DEFAULT_TIMEOUT_MS = 60_000;

/** 重启退避：1s → 2s → 4s … 封顶 30s */
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;

function log(...args) {
  console.log('[dsh-pet][wechat]', ...args);
}

/** 候选解释器：内置便携 Python > 显式环境变量 > PATH 上的常见名 > 本机 Python 安装目录扫描 */
function pythonCandidates() {
  const list = [];
  const push = (cmd, args) => {
    if (cmd) list.push({ cmd, args: args || [] });
  };
  const fs = require('node:fs');

  // 0. 优先检测应用程序内置的便携式绿色 Python 环境（All-In-One，无外部依赖）
  const embeddedCandidates = [
    path.join(process.resourcesPath || '', 'python', 'python.exe'),
    path.resolve(path.dirname(process.execPath || ''), 'resources', 'python', 'python.exe'),
    path.resolve(path.dirname(process.execPath || ''), 'python', 'python.exe'),
    path.resolve(__dirname, '..', '..', 'resources', 'python', 'python.exe'),
    path.resolve(process.cwd(), 'resources', 'python', 'python.exe'),
    path.resolve(process.cwd(), 'python', 'python.exe'),
  ];
  for (const p of embeddedCandidates) {
    if (p && fs.existsSync(p)) {
      push(p, []);
    }
  }

  push(process.env.DSH_PET_WECHAT_PYTHON, []);
  push('python', []);
  push('python3', []);
  push('py', ['-3']);
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const base = path.join(local, 'Programs', 'Python');
    try {
      for (const name of fs.readdirSync(base)) {
        if (!/^Python3/i.test(name)) continue;
        push(path.join(base, name, 'python.exe'), []);
      }
    } catch {
      /* 目录不存在：忽略 */
    }
  }
  return list;
}

/** 查找 wechat-mcp-server 源码所在目录（开发时或打包入 resources/app 时） */
function resolveWechatDir() {
  const fs = require('node:fs');
  const candidates = [
    process.env.DSH_PET_WECHAT_DIR,
    path.resolve(__dirname, '..', '..', '..', 'wechat-mcp-server'),
    path.resolve(__dirname, '..', '..', 'wechat-mcp-server'),
    path.resolve(process.resourcesPath || '', 'wechat-mcp-server'),
    path.resolve(process.resourcesPath || '', 'app', 'wechat-mcp-server'),
    path.resolve(process.cwd(), 'wechat-mcp-server'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'wechat_cli_mcp', '__init__.py'))) {
      return dir;
    }
  }
  return null;
}

/** 找一个能 `import wechat_cli_mcp` 的解释器；找不到返回 null。结果缓存。 */
let cachedPython = null;
let pythonProbed = false;
function resolvePython() {
  if (pythonProbed) return cachedPython;
  pythonProbed = true;
  const wechatDir = resolveWechatDir();
  const probe = wechatDir
    ? `import sys; sys.path.insert(0, ${JSON.stringify(wechatDir)}); import wechat_cli_mcp; sys.stdout.write("dsh-pet-ok")`
    : 'import sys, wechat_cli_mcp; sys.stdout.write("dsh-pet-ok")';
  for (const candidate of pythonCandidates()) {
    try {
      const out = execFileSync(candidate.cmd, [...candidate.args, '-c', probe], {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (String(out).includes('dsh-pet-ok')) {
        cachedPython = candidate;
        log('已定位 Python:', candidate.cmd, candidate.args.join(' '), wechatDir ? `(sidecar 目录: ${wechatDir})` : '');
        return cachedPython;
      }
    } catch {
      /* 换下一个候选 */
    }
  }
  log('未找到可用的 Python（wechat_cli_mcp 未安装？）');
  return null;
}

/** 测试/换机后可重新探测 */
function resetPythonProbe() {
  pythonProbed = false;
  cachedPython = null;
}

class WechatHelper extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.moduleName = opts.moduleName || process.env.DSH_PET_WECHAT_MODULE || DEFAULT_MODULE;
    this.cwd = opts.cwd || undefined;
    /** 'stopped' | 'starting' | 'ready' | 'error' */
    this.state = 'stopped';
    this.lastError = '';
    /** hello 的结果（版本/密钥数/微信是否在跑…） */
    this.hello = null;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stopping = false;
    this.restartTimer = null;
    this.restartDelay = RESTART_BASE_MS;
    this.stderrTail = [];
    this.readyWaiters = [];
  }

  /** 确保 sidecar 已启动并握手完成；返回 hello 结果。并发调用共享同一次启动。 */
  async ensure() {
    if (this.state === 'ready' && this.child) return this.hello;
    if (this.state === 'error' && !this.child) {
      // 上次启动失败：允许下一次调用重试（清掉退避计时器）
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
    }
    const waiting = new Promise((resolve) => this.readyWaiters.push(resolve));
    if (this.state !== 'starting' && !this.child) this._spawn();
    return waiting;
  }

  _setState(state, error) {
    this.state = state;
    if (error !== undefined) this.lastError = error || '';
    this.emit('status', this.status());
  }

  _spawn() {
    const python = resolvePython();
    if (!python) {
      this._setState(
        'error',
        '未找到可用的 Python 环境：请在装了 wechat-cli-mcp 的 Python 下运行，或用 DSH_PET_WECHAT_PYTHON 指定解释器',
      );
      this._flushReady(null);
      return;
    }
    this._setState('starting', '');
    log('启动 sidecar:', python.cmd, '-m', this.moduleName);
    let child;
    try {
      const wechatDir = resolveWechatDir();
      const childEnv = { ...process.env };
      if (wechatDir) {
        const curPyPath = childEnv.PYTHONPATH || '';
        childEnv.PYTHONPATH = curPyPath ? `${wechatDir}${path.delimiter}${curPyPath}` : wechatDir;
      }
      child = spawn(python.cmd, [...python.args, '-u', '-m', this.moduleName], {
        cwd: this.cwd || wechatDir || undefined,
        env: childEnv,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      this._setState('error', 'spawn 失败: ' + String((e && e.message) || e));
      this._scheduleRestart();
      this._flushReady(null);
      return;
    }
    this.child = child;
    this.buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      this.stderrTail.push(text);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      log('sidecar stderr:', text.trim().slice(0, 400));
    });
    child.on('error', (e) => {
      log('sidecar 进程错误:', e && e.message);
      this._onExit(null);
    });
    child.on('exit', (code, signal) => this._onExit(code, signal));

    // 启动握手：hello 同时验证协议与拿到环境事实
    this.request('hello', {})
      .then((res) => {
        this.hello = res;
        this.restartDelay = RESTART_BASE_MS;
        this._setState('ready', '');
        log('sidecar 就绪: python', res.python, '· 微信运行中', res.wechatRunning, '· 密钥', res.keyCount);
        this._flushReady(res);
      })
      .catch((e) => {
        this._setState('error', '握手失败: ' + String((e && e.message) || e));
        this._flushReady(null);
        // 握手失败说明这个进程不可用：杀掉让下次重试
        this._kill();
      });
  }

  _flushReady(value) {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const resolve of waiters) resolve(value);
  }

  _onExit(code, signal) {
    if (this.child) {
      log('sidecar 退出 code=', code, 'signal=', signal || '');
    }
    this.child = null;
    const err = `sidecar 已退出（code=${code === null ? '?' : code}${signal ? ', signal=' + signal : ''}）`;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(err));
    }
    this.pending.clear();
    if (this.stopping) {
      this._setState('stopped', '');
      this._flushReady(null);
      return;
    }
    this._setState('error', err);
    this._flushReady(null);
    this._scheduleRestart();
  }

  _scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(RESTART_MAX_MS, this.restartDelay * 2);
    log(`sidecar ${delay}ms 后重试`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.ensure().catch(() => {});
    }, delay);
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // 非协议行（Python 噪音）：只记日志，绝不影响请求
        log('sidecar 非协议输出:', line.slice(0, 300));
        continue;
      }
      if (msg && typeof msg === 'object' && msg.event) {
        // 主动事件（log/fatal）：只在 fatal 时记一笔
        if (msg.event === 'fatal') log('sidecar fatal:', msg.message || '');
        continue;
      }
      if (!msg || typeof msg.id !== 'number') continue;
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  }

  /** 发一条命令；resolve 的是**完整响应对象**（ok:false 也算 resolve，调用方按 code 判）。 */
  request(cmd, params = {}, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || !child.stdin || child.stdin.destroyed) {
        reject(new Error('sidecar 未运行'));
        return;
      }
      const id = this.nextId++;
      const payload = JSON.stringify({ id, cmd, ...params });
      const limit = timeoutMs || COMMAND_TIMEOUT_MS[cmd] || DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar 命令超时: ${cmd}`));
      }, limit);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(payload + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('sidecar 写入失败: ' + String((e && e.message) || e)));
      }
    });
  }

  /** 请求 + ok:false 转异常（业务代码想直接 try/catch 时用） */
  async call(cmd, params = {}) {
    await this.ensure();
    const res = await this.request(cmd, params);
    if (!res || res.ok !== true) {
      const err = new Error((res && (res.error || res.message)) || `${cmd} 失败`);
      err.code = (res && (res.code || res.reason)) || 'command_failed';
      err.raw = res;
      throw err;
    }
    return res;
  }

  _kill() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    // Windows 下 python -m 有时留子进程；兜底强杀进程树
    if (process.platform === 'win32' && child.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5000,
        });
      } catch {
        /* 已经死了 */
      }
    }
  }

  /** 优雅关停（桌宠退出时调）：先 shutdown，再杀进程树 */
  async stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child && this.state === 'ready') {
      await this.request('shutdown', {}, 3000).catch(() => {});
    }
    this._kill();
    this._setState('stopped', '');
    this._flushReady(null);
  }

  /**
   * 同步强杀：`app.on('before-quit')` 这类无法 await 的场合用。
   * 不发 shutdown（协议握手要等），直接杀进程树——bridge 是无状态只读进程，硬杀无副作用。
   */
  killSync() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this._kill();
    this._setState('stopped', '');
    this._flushReady(null);
  }

  status() {
    const hello = this.hello || {};
    const isEmbedded = Boolean(
      cachedPython &&
      (cachedPython.cmd.toLowerCase().includes('resources\\python') ||
       cachedPython.cmd.toLowerCase().includes('resources/python') ||
       cachedPython.isEmbedded)
    );
    return {
      state: this.state,
      lastError: this.lastError,
      pythonVersion: hello.python || '',
      pythonPath: cachedPython ? cachedPython.cmd : '',
      isEmbedded,
      wechatRunning: hello.wechatRunning === true,
      keyCount: typeof hello.keyCount === 'number' ? hello.keyCount : 0,
      hasKeys: (typeof hello.keyCount === 'number' ? hello.keyCount : 0) > 0,
      hasConfig: hello.hasConfig === true,
      stateDir: hello.stateDir || '',
      process: hello.process || '',
      stderr: this.stderrTail.slice(-3).join('').trim().slice(-600),
    };
  }
}

module.exports = { WechatHelper, resolvePython, pythonCandidates, resetPythonProbe, COMMAND_TIMEOUT_MS };
