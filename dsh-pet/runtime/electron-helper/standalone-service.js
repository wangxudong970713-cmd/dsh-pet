/**
 * standalone-service.js —— dsh-pet 独立桌面端内置服务核心
 *
 * 职责：
 * 1. 拦截接管 dsh-pet-bridge:// 协议的所有业务请求（配置、素材、余额、碎碎念、对话、记忆）；
 * 2. 独立管理用户配置（%APPDATA%/dsh-pet/config.json）与密钥（apiKey / baseUrl / model）；
 * 3. 使用标准 fetch 直接调用 DeepSeek / OpenAI 兼容接口，彻底摆脱 DSH 宿主与 @deepseek-ai/* 外部依赖；
 * 4. 读盘直接提供 webm、字体、表情包及图标等全部静态资源。
 */

let electron;
try {
  electron = require('electron');
} catch {
  electron = null;
}

const app = electron?.app || {
  isPackaged: false,
  getAppPath: () => path.resolve(__dirname, '..', '..'),
  getPath: (name) => {
    if (name === 'userData') {
      return path.join(process.env.APPDATA || process.env.USERPROFILE || process.env.HOME || '', '.config');
    }
    return process.cwd();
  },
};

const path = require('node:path');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');

const MIME = {
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** 剥除 JSONC 注释 */
function stripJsonc(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();
}

/** 获取项目素材与代码根目录 */
function getPackageRoot() {
  if (app.isPackaged) {
    const resAssets = path.join(process.resourcesPath, 'assets');
    if (fs.existsSync(resAssets)) return process.resourcesPath;
    const appAssets = path.join(app.getAppPath(), 'assets');
    if (fs.existsSync(appAssets)) return app.getAppPath();
    return app.getAppPath();
  }
  const appAssets = app.getAppPath ? path.join(app.getAppPath(), 'assets') : '';
  if (appAssets && fs.existsSync(appAssets)) return app.getAppPath();
  return path.resolve(__dirname, '..', '..');
}

/** 用户数据目录：%APPDATA%/dsh-pet */
function getUserDataDir() {
  const dir = path.join(app.getPath('userData'), 'dsh-pet');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getUserConfigFile() {
  return path.join(getUserDataDir(), 'config.json');
}

function getMemoryFile() {
  return path.join(getUserDataDir(), 'memory.json');
}

class StandaloneService {
  constructor() {
    this.packageRoot = getPackageRoot();
    this.assetsRoot = path.join(this.packageRoot, 'assets');
    this.defaultConfigFile = path.join(this.assetsRoot, 'config.jsonc');
    this.broadcastCache = new Map();
    this.cachedDefaultConfig = null;
  }

  /** 读取包内内置默认配置 assets/config.jsonc */
  getDefaultConfig() {
    if (this.cachedDefaultConfig) return this.cachedDefaultConfig;
    try {
      if (fs.existsSync(this.defaultConfigFile)) {
        const raw = fs.readFileSync(this.defaultConfigFile, 'utf8');
        this.cachedDefaultConfig = JSON.parse(stripJsonc(raw));
        return this.cachedDefaultConfig;
      }
    } catch (e) {
      console.error('[standalone-service] read default config failed:', e);
    }
    return {};
  }

  /** 读取用户配置（含 API 密钥与自定义选项） */
  getUserConfig() {
    const file = getUserConfigFile();
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch (e) {
      console.error('[standalone-service] read user config failed:', e);
    }
    return {
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    };
  }

  /** 获取与默认配置合并后的完整配置 */
  getMergedConfig() {
    const def = this.getDefaultConfig();
    const user = this.getUserConfig();

    // 深度克隆默认配置
    const merged = JSON.parse(JSON.stringify(def));

    // 合并顶层独立字段
    if (user.apiKey !== undefined) merged.apiKey = user.apiKey;
    if (user.baseUrl !== undefined) merged.baseUrl = user.baseUrl;
    if (user.model !== undefined) merged.model = user.model;
    if (user.whisperPrompt !== undefined) merged.whisperPrompt = user.whisperPrompt;
    if (user.chatMemoryRounds !== undefined) merged.chatMemoryRounds = user.chatMemoryRounds;
    if (user.whisperImageEnabled !== undefined) merged.whisperImageEnabled = user.whisperImageEnabled;
    if (user.chatImageEnabled !== undefined) merged.chatImageEnabled = user.chatImageEnabled;
    if (user.physics !== undefined) merged.physics = { ...(merged.physics || {}), ...user.physics };

    // 合并宠物列表
    if (Array.isArray(user.pets) && user.pets.length > 0) {
      merged.pets = user.pets.map((p, idx) => {
        const defPet = (merged.pets && merged.pets[idx]) || (merged.pets && merged.pets[0]) || {};
        return {
          ...defPet,
          ...p,
          display: 'desktop', // 独立模式下强制为 desktop 可见
          position: { ...(defPet.position || {}), ...(p.position || {}) },
        };
      });
    } else if (Array.isArray(merged.pets)) {
      merged.pets = merged.pets.map((p) => ({
        ...p,
        display: 'desktop',
      }));
    }

    return merged;
  }

  /** 保存用户配置到本地文件 */
  saveUserConfig(newSettings) {
    const cur = this.getUserConfig();
    const updated = { ...cur, ...newSettings };
    const file = getUserConfigFile();
    fs.writeFileSync(file, JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  }

  /** 读取表情包候选池 */
  getMemePool() {
    const def = this.getDefaultConfig();
    const memes = def.memes || {};
    const dir = path.join(this.assetsRoot, 'memes');
    const pool = [];
    for (const [name, desc] of Object.entries(memes)) {
      const text = typeof desc === 'string' ? desc.trim() : '';
      if (!name || !text) continue;
      if (fs.existsSync(path.join(dir, name + '.png'))) {
        pool.push({ name, desc: text });
      }
    }
    return pool.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  /** 从模型回复中解析表情包 [图:xxx] */
  extractChatImage(text, pool) {
    const match = /\[图[:：]\s*([^\]\n]+?)\s*\]\s*$/.exec(text);
    if (!match) return { text };
    const hitName = match[1].trim();
    const hit = pool.find((m) => m.name === hitName);
    const body = text.slice(0, match.index).trim();
    if (!hit || !body) return { text };
    return { text: body, image: hit.name };
  }

  /** 读取对话历史 */
  async readMemory() {
    const file = getMemoryFile();
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(await fsPromises.readFile(file, 'utf8'));
      }
    } catch {
      /* ignore */
    }
    return {};
  }

  /** 写入对话历史 */
  async appendMemory(petId, userText, assistantText) {
    const file = getMemoryFile();
    const mem = await this.readMemory();
    if (!mem[petId]) mem[petId] = { messages: [] };
    mem[petId].messages.push({ role: 'user', content: userText, ts: Date.now() });
    mem[petId].messages.push({ role: 'assistant', content: assistantText, ts: Date.now() });
    // 最多保留 100 条
    if (mem[petId].messages.length > 100) {
      mem[petId].messages = mem[petId].messages.slice(-100);
    }
    await fsPromises.writeFile(file, JSON.stringify(mem, null, 2), 'utf8');
  }

  /** 调用 OpenAI 兼容的 Chat Completions 接口 */
  async callLlm(messages, systemPrompt, maxTokens = 256) {
    const config = this.getMergedConfig();
    const apiKey = config.apiKey ? String(config.apiKey).trim() : '';
    if (!apiKey) {
      throw new Error('未配置 API 密钥，请在设置中配置');
    }

    let baseUrl = config.baseUrl ? String(config.baseUrl).trim() : 'https://api.deepseek.com';
    baseUrl = baseUrl.replace(/\/+$/, '');
    if (!baseUrl.endsWith('/v1') && !baseUrl.includes('/chat/completions')) {
      baseUrl = baseUrl + '/v1';
    }
    const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const model = config.model ? String(config.model).trim() : 'deepseek-chat';

    const reqMessages = [];
    if (systemPrompt) {
      reqMessages.push({ role: 'system', content: systemPrompt });
    }
    reqMessages.push(...messages);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: reqMessages,
          temperature: 0.9,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`API 响应错误 HTTP ${resp.status}: ${errText.slice(0, 150)}`);
      }

      const json = await resp.json();
      const reply = json?.choices?.[0]?.message?.content?.trim();
      if (!reply) {
        throw new Error('模型未返回内容');
      }
      return reply;
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }

  /** 生成碎碎念 */
  async generateWhisper(petId) {
    const config = this.getMergedConfig();
    const apiKey = config.apiKey ? String(config.apiKey).trim() : '';
    if (!apiKey) {
      return { ok: false, reason: 'provider-missing', message: '未配置 API 密钥' };
    }

    const pool = this.getMemePool();
    let meme = null;
    if (config.whisperImageEnabled && pool.length > 0) {
      meme = pool[Math.floor(Math.random() * pool.length)];
    }

    const pet = (config.pets || []).find((p) => p.id === petId) || config.pets?.[0] || { name: '桌宠' };
    const system = (config.whisperPrompt || '你是主人桌面上的Q版小宠物，用简短可爱温柔的口吻说话。') +
      ` 你的名字是“${pet.name || '桌宠'}”。`;

    let userPrompt = '随便说一句日常碎碎念，一句就好，20 字以内。';
    if (meme) {
      userPrompt += `\n这次会配一张表情包一起显示，图的内容是：${meme.name}（${meme.desc}）。\n请让这句话和这张图的情绪自然契合，像是配合画面说出来的；不要描述画面本身。`;
    }

    try {
      const text = await this.callLlm([{ role: 'user', content: userPrompt }], system, 64);
      return { ok: true, text, image: meme ? meme.name : undefined, ts: Date.now() };
    } catch (e) {
      return { ok: false, reason: 'generate-error', message: e.message || String(e) };
    }
  }

  /** 发起对话 */
  async chatWithPet(petId, userText) {
    const config = this.getMergedConfig();
    const apiKey = config.apiKey ? String(config.apiKey).trim() : '';
    if (!apiKey) {
      return { ok: false, reason: 'provider-missing', message: '未配置 API 密钥，请先在设置中配置' };
    }

    const pool = this.getMemePool();
    const pet = (config.pets || []).find((p) => p.id === petId) || config.pets?.[0] || { name: '桌宠' };
    let system = (config.whisperPrompt || '你是主人桌面上的Q版小宠物，用简短可爱温柔的口吻说话。') +
      ` 你的名字是“${pet.name || '桌宠'}”。`;

    if (config.chatImageEnabled && pool.length > 0) {
      const catalog = pool.map((m) => `- ${m.name}：${m.desc}`).join('\n');
      system += `\n你可以根据需要配一张表情包（可选）。候选如下：\n${catalog}\n若配图，请在回复末尾附带 [图:名称] 标记，如“好呀！[图:开心]”。不需要时不用附带。`;
    }

    // 截取最近历史轮数
    const rounds = Number(config.chatMemoryRounds || 5);
    const mem = await this.readMemory();
    const hist = ((mem[petId] && mem[petId].messages) || []).slice(-rounds * 2);

    const messages = hist.map((m) => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: userText });

    try {
      const rawReply = await this.callLlm(messages, system, 256);
      const parsed = config.chatImageEnabled ? this.extractChatImage(rawReply, pool) : { text: rawReply };
      await this.appendMemory(petId, userText, parsed.text);
      return { ok: true, reply: parsed.text, image: parsed.image, ts: Date.now() };
    } catch (e) {
      return { ok: false, reason: 'generate-error', message: e.message || String(e) };
    }
  }

  /** 查询余额 */
  async queryBalance() {
    const config = this.getUserConfig();
    const apiKey = config.apiKey ? String(config.apiKey).trim() : '';
    if (!apiKey) {
      return { ok: false, provider: 'none', reason: 'credential-missing', message: '未配置 API 密钥' };
    }

    const baseUrl = config.baseUrl || 'https://api.deepseek.com';
    if (!baseUrl.includes('deepseek.com')) {
      return {
        ok: true,
        provider: 'custom',
        kind: 'deepseek',
        data: { currency: 'CNY', total: '已连接', granted: '0', toppedUp: '0' },
      };
    }

    try {
      const resp = await fetch('https://api.deepseek.com/user/balance', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'dsh-pet-standalone',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const first = data?.balance_infos?.[0];
      if (!first) throw new Error('返回无 balance_infos');
      return {
        ok: true,
        provider: 'deepseek',
        kind: 'deepseek',
        data: {
          currency: String(first.currency || 'CNY'),
          total: String(first.total_balance || '0'),
          granted: String(first.granted_balance || '0'),
          toppedUp: String(first.topped_up_balance || '0'),
        },
      };
    } catch (e) {
      return {
        ok: false,
        provider: 'deepseek',
        reason: 'fetch-error',
        message: e.message || String(e),
      };
    }
  }

  /** 测试 API 连接连通性 */
  async testConnection({ apiKey, baseUrl, model }) {
    if (!apiKey) {
      return { ok: false, message: 'API Key 不能为空' };
    }
    let url = baseUrl ? String(baseUrl).trim() : 'https://api.deepseek.com';
    url = url.replace(/\/+$/, '');
    if (!url.endsWith('/v1') && !url.includes('/chat/completions')) {
      url = url + '/v1';
    }
    const endpoint = url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
    const targetModel = model ? String(model).trim() : 'deepseek-chat';

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        return { ok: false, message: `请求失败 HTTP ${resp.status}: ${text.slice(0, 100)}` };
      }
      return { ok: true, message: '连接成功！API 正常响应' };
    } catch (e) {
      return { ok: false, message: `连接异常: ${e.message || String(e)}` };
    }
  }

  /**
   * 路由分发器：对应原宿主 handlePetRoute
   * @param {string} rawUrl - 如 /dsh-pet-7340/config 或 /dsh-pet-7340/thumb/main/idle.webm
   * @param {string} method - GET / POST / PUT
   * @param {string} [body] - 请求体
   */
  async handleRoute(rawUrl, method, body) {
    const parsed = new URL(rawUrl, 'http://localhost');
    let pathname = decodeURIComponent(parsed.pathname);

    const PREFIX = '/dsh-pet-7340';
    if (pathname.startsWith(PREFIX)) {
      pathname = pathname.slice(PREFIX.length);
    }
    if (pathname.startsWith('/')) {
      pathname = pathname.slice(1);
    }

    // 1. 配置路由
    if (pathname === 'config') {
      if (method === 'GET') {
        const merged = this.getMergedConfig();
        return { status: 200, contentType: 'application/json', body: JSON.stringify({ main: merged }) };
      }
      if (method === 'PUT') {
        try {
          const userOverrides = JSON.parse(body || '{}');
          this.saveUserConfig(userOverrides);
          const updated = this.getMergedConfig();
          return { status: 200, contentType: 'application/json', body: JSON.stringify({ main: updated }) };
        } catch (e) {
          return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: e.message }) };
        }
      }
    }

    // 2. 余额查询
    if (pathname === 'balance') {
      const res = await this.queryBalance();
      return { status: 200, contentType: 'application/json', body: JSON.stringify(res) };
    }
    if (pathname === 'balance/trigger') {
      return { status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0 }) };
    }

    // 3. 碎碎念
    if (pathname === 'whisper') {
      const petId = parsed.searchParams.get('pet') || 'main';
      const res = await this.generateWhisper(petId);
      return { status: 200, contentType: 'application/json', body: JSON.stringify(res) };
    }
    if (pathname === 'whisper/trigger') {
      const petId = parsed.searchParams.get('pet') || 'main';
      const res = await this.generateWhisper(petId);
      return { status: 200, contentType: 'application/json', body: JSON.stringify(res) };
    }

    // 4. 对话
    if (pathname === 'chat') {
      const petId = parsed.searchParams.get('pet') || 'main';
      if (method === 'GET') {
        const mem = await this.readMemory();
        const list = (mem[petId] && mem[petId].messages) || [];
        const rounds = Number(this.getMergedConfig().chatMemoryRounds || 5);
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, messages: list.slice(-rounds * 2), rounds }),
        };
      }
      if (method === 'POST') {
        let text = '';
        try {
          const p = JSON.parse(body || '{}');
          text = typeof p.text === 'string' ? p.text.trim() : '';
        } catch {
          /* ignore */
        }
        if (!text) {
          return {
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, reason: 'bad-request', message: '消息为空' }),
          };
        }
        const res = await this.chatWithPet(petId, text);
        return { status: 200, contentType: 'application/json', body: JSON.stringify(res) };
      }
    }

    // 5. 广播 / 工作状态 / 通知
    if (pathname === 'broadcast') {
      const petId = parsed.searchParams.get('pet') || 'main';
      const hit = this.broadcastCache.get(petId) || { ok: true, text: '', ts: 0 };
      return { status: 200, contentType: 'application/json', body: JSON.stringify(hit) };
    }
    if (pathname === 'work-status') {
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ state: null, text: '', ts: 0 }),
      };
    }
    if (pathname === 'notify') {
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, seq: 0, frames: [] }),
      };
    }

    // 6. 静态资源：字体
    if (pathname.startsWith('font/')) {
      const filename = pathname.slice('font/'.length);
      const filePath = path.join(this.assetsRoot, 'fonts', filename);
      if (fs.existsSync(filePath)) {
        return { status: 200, file: filePath, contentType: 'font/ttf' };
      }
      return { status: 404, contentType: 'text/plain', body: 'Font not found' };
    }

    // 7. 静态资源：图片 (pic / memes)
    if (pathname.startsWith('pic/')) {
      const rest = pathname.slice('pic/'.length);
      const isMeme = rest.startsWith('memes/');
      const sub = isMeme ? rest.slice('memes/'.length) : rest;
      const targetDir = path.join(this.assetsRoot, isMeme ? 'memes' : 'pic');
      const filePath = path.join(targetDir, sub);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        return { status: 200, file: filePath, contentType: MIME[ext] || 'image/png' };
      }
      return { status: 404, contentType: 'text/plain', body: 'Pic not found' };
    }

    // 8. 静态资源：动画 (thumb/<petId>/<filename>)
    if (pathname.startsWith('thumb/')) {
      const parts = pathname.slice('thumb/'.length).split('/');
      // 剥除 petId，动画统一来自 assets/webm 或 assets/mov
      const filename = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
      const ext = path.extname(filename).toLowerCase();
      const subDir = ext === '.mov' ? 'mov' : 'webm';
      const filePath = path.join(this.assetsRoot, subDir, filename);

      if (fs.existsSync(filePath)) {
        return { status: 200, file: filePath, contentType: MIME[ext] || 'video/webm' };
      }
      return { status: 404, contentType: 'text/plain', body: 'Asset not found: ' + filename };
    }

    return { status: 404, contentType: 'text/plain', body: 'Not found: ' + pathname };
  }
}

module.exports = {
  StandaloneService,
  standaloneService: new StandaloneService(),
};
