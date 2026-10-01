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
const { WechatHelper } = require('./wechat-helper');

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

/** 微信联动的不透明 UI 状态（已读游标、折叠名单缓存、起草配额…由渲染层决定语义） */
function getWechatStateFile() {
  return path.join(getUserDataDir(), 'wechat-state.json');
}

/** 递归合并普通对象；数组与标量整体替换 */
function deepMergePlain(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (!patch || typeof patch !== 'object') return patch;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = deepMergePlain(out[k], v);
  }
  return out;
}

/** 统一的 JSON 200 响应 */
function json200(payload) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(payload) };
}

class StandaloneService {
  constructor() {
    this.packageRoot = getPackageRoot();
    this.assetsRoot = path.join(this.packageRoot, 'assets');
    this.defaultConfigFile = path.join(this.assetsRoot, 'config.jsonc');
    this.broadcastCache = new Map();
    this.cachedDefaultConfig = null;
    // 微信联动：Python sidecar + 轮询基线 + 不透明 UI 状态缓存
    this.wechat = new WechatHelper();
    this.wechatBaseline = null;
    this.wechatMaxTs = 0;
    this.wechatState = null;
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
      autoStart: false,
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
    if (user.autoStart !== undefined) merged.autoStart = user.autoStart;
    if (user.physics !== undefined) merged.physics = { ...(merged.physics || {}), ...user.physics };
    // 微信配置是嵌套结构（individuals/groups/autoDraft 各含 {mode,list}），必须深合并：
    // 浅合并会让用户只改 groups.mode 时把默认的 list 整段抹掉。
    if (user.wechat !== undefined) merged.wechat = deepMergePlain(merged.wechat, user.wechat);

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
  async callLlm(messages, systemPrompt, maxTokens = 256, opts = {}) {
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
    const timeoutMs =
      Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 45000;
    // 起草微信回复要更像本人，因此允许调用方压低随机性（默认仍是 0.9）
    const temperature = Number.isFinite(Number(opts.temperature)) ? Number(opts.temperature) : 0.9;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
          temperature,
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
    const system =
      (config.whisperPrompt || '你是主人桌面上的Q版小宠物，用简短可爱温柔的口吻说话。') +
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
    let system =
      (config.whisperPrompt || '你是主人桌面上的Q版小宠物，用简短可爱温柔的口吻说话。') +
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

  /* ==================================================================
   *  微信联动
   *
   *  Python sidecar 只负责「读微信库」，本层只负责「转发 + 极薄的状态」，
   *  所有判断（白名单、主被动、文案）都放在 src/shared/wechat.ts，
   *  这样浏览器插件形态与桌面端形态能共用同一套逻辑与同一批测试。
   * ================================================================== */

  /** 微信助手状态；probe=true 时会尝试拉起 sidecar 并握手 */
  async wechatStatus({ probe = false } = {}) {
    const cfg = this.getMergedConfig().wechat || {};
    let helper = this.wechat.status();
    if (probe) {
      try {
        await this.wechat.ensure();
        helper = this.wechat.status();
      } catch (e) {
        helper = { ...this.wechat.status(), state: 'error', lastError: e.message || String(e) };
      }
    }
    const keyCount = Number(helper.keyCount) || 0;
    return {
      ok: true,
      enabled: cfg.enabled !== false,
      helper,
      ready: keyCount > 0,
      keyCount,
      wechatRunning: Boolean(helper.wechatRunning),
      reason: keyCount > 0 ? null : helper.state === 'error' ? 'helper-error' : 'not-initialized',
    };
  }

  /** 初始化微信数据通道（自动探测目录 + 提取密钥），可能耗时数十秒 */
  async wechatInit() {
    let res;
    try {
      res = await this.wechat.request('ensure_init', {}, 240000);
    } catch (e) {
      return { ok: false, reason: 'helper-error', message: e.message || String(e) };
    }
    if (res && res.ok) {
      // 拿到新密钥后旧基线失效，避免把历史消息重放成「新消息」
      this.wechatBaseline = null;
      this.wechatMaxTs = 0;
    }
    return res;
  }

  /**
   * 轮询会话列表并算出「比上次更新」的会话。
   * 首次调用只建立基线不报新消息，否则一开桌宠就会把 50 个会话全弹一遍。
   */
  async wechatPoll(params = {}) {
    const res = await this.wechat.call('sessions', params);
    const chats = Array.isArray(res.chats) ? res.chats : [];
    const firstRun = this.wechatBaseline === null;
    const previous = this.wechatBaseline || new Map();
    const prevMax = this.wechatMaxTs || 0;

    const next = new Map();
    let nextMax = prevMax;
    const changed = [];
    for (const chat of chats) {
      const ts = Number(chat.timestamp) || 0;
      if (ts > nextMax) nextMax = ts;
      next.set(chat.username, { timestamp: ts, lastMessage: chat.lastMessage || '' });

      if (firstRun) continue;
      const before = previous.get(chat.username);
      if (!before) {
        // 基线里没有的会话：只认「比见过的最新消息更新」的，避免旧会话挤进前 50 时误报
        if (ts > prevMax) changed.push(chat);
        continue;
      }
      if (ts > before.timestamp || (ts === before.timestamp && (chat.lastMessage || '') !== before.lastMessage)) {
        changed.push(chat);
      }
    }

    this.wechatBaseline = next;
    this.wechatMaxTs = nextMax;
    return { ok: true, firstRun, changed, sessions: chats, ts: Date.now() };
  }

  /** 读取不透明 UI 状态 */
  async readWechatState() {
    if (this.wechatState) return this.wechatState;
    const file = getWechatStateFile();
    let data = {};
    try {
      if (fs.existsSync(file)) data = JSON.parse(await fsPromises.readFile(file, 'utf8'));
    } catch (e) {
      console.error('[standalone-service] read wechat state failed:', e);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    this.wechatState = data;
    return data;
  }

  /** 合并写入不透明 UI 状态 */
  async writeWechatState(patch) {
    const cur = await this.readWechatState();
    const next = patch && typeof patch === 'object' ? deepMergePlain(cur, patch) : cur;
    this.wechatState = next;
    await fsPromises.writeFile(getWechatStateFile(), JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  /**
   * 一键蒸馏主人的微信对话风格：
   * 1. 调用 sidecar 提取主人真实发言、问答对与统计特征
   * 2. 调用大模型提炼生成主人的语言指纹设定与 Few-Shot
   * 3. 构造建议的完整起草 Prompt，保存到 wechatState.distilled 并返回
   */
  async wechatDistill({ limit = 500 } = {}) {
    const config = this.getMergedConfig();
    const apiKey = config.apiKey ? String(config.apiKey).trim() : '';
    if (!apiKey) {
      return { ok: false, reason: 'api-key-missing', message: '请先在上方设置并保存 DeepSeek API 密钥' };
    }

    const lim = Math.max(50, Math.min(3000, Number(limit) || 500));
    let sampleRes;
    try {
      sampleRes = await this.wechat.call('sample_my_messages', { limit: lim }, 60000);
    } catch (e) {
      return { ok: false, reason: e.code || 'helper-error', message: '抽取微信消息失败: ' + (e.message || String(e)) };
    }
    if (!sampleRes || !sampleRes.ok) {
      return { ok: false, reason: sampleRes?.reason || 'extract-failed', message: sampleRes?.message || '未能采集到有效发言' };
    }

    const { sampleCount, scannedSessions, stats, dialoguePairs, sampleReplies } = sampleRes;
    if (!sampleCount || sampleCount < 5) {
      return { ok: false, reason: 'insufficient-samples', message: `采集到的发言过少（仅 ${sampleCount || 0} 条），无法进行有效蒸馏` };
    }

    const pairsText = (dialoguePairs || [])
      .slice(0, 18)
      .map((p, idx) => `${idx + 1}. 对方：“${p.context}” ➔ 主人：“${p.reply}”`)
      .join('\n');

    const samplesText = (sampleReplies || [])
      .slice(0, 25)
      .map((s, idx) => `- “${s}”`)
      .join('\n');

    const topEmojiStr = (stats.topEmojis || []).length > 0 ? (stats.topEmojis || []).join('、') : '无明显表情偏好';
    const topWordStr = (stats.topWords || []).length > 0 ? (stats.topWords || []).join('、') : '日常口语短句';

    const promptSystem = '你是一位世界级的数字分身构建专家与口吻克隆大师，精通从真实日常聊天记录中提炼用户的数字分身与个性指纹。请务必输出纯正地道、符合真人打字习惯的设定，绝不要机械刻板。';
    const userPrompt = [
      '请根据以下从某用户微信真实聊天中抽样提取出的统计指纹、日常打字与真实问答对，深度蒸馏并生成一份专属于该用户的「数字分身语言指纹与起草设定」。',
      '',
      '【客观统计事实】',
      `- 采样本人发言：${sampleCount} 条，跨越 ${scannedSessions} 个真实聊天会话`,
      `- 平均单句字数：约 ${stats.avgLength} 字（字数中位数：${stats.medianLength} 字）`,
      `- 句长分布：短句(<=5字)占 ${stats.shortPct}%，中句(6-15字)占 ${stats.mediumPct}%，长句(>15字)占 ${stats.longPct}%`,
      `- 标点习惯：句号使用率仅 ${stats.dotRate}%（${stats.dotRate < 5 ? '极少使用句号，通常用空格或直接断句' : '偶用句号'}），空格使用率 ${stats.spaceRate}%，问号使用率 ${stats.questionRate}%，叹号使用率 ${stats.exclRate}%，波浪号使用率 ${stats.tildeRate}%`,
      `- 最爱用表情：${topEmojiStr}`,
      `- 高频口语词汇：${topWordStr}`,
      '',
      '【典型真实问答对（上句为对方，下句为主人的真实回复）】',
      pairsText || '(无问答对)',
      '',
      '【主人真实随手打字例句】',
      samplesText || '(无例句)',
      '',
      '【输出结构与要求】',
      '请按以下结构输出，条理清晰、重点突出：',
      '### 1. 【口吻性格画像】',
      '用 2-3 句话精准概括主人的聊天性格、语气底色、社交分寸感（如：随性自然、干脆利落、不爱客套等）。',
      '',
      '### 2. 【核心打字指纹与习惯规则】',
      '- 标点与断句规则（指出是否用句号、是否用空格断句、常用标点）；',
      '- 字数与节奏习惯（严格限制回答长度，贴近主人的平均字数）；',
      '- 表情与口癖规范（列出主人最常用的微信表情，如 [旺柴]、[破涕为笑]，以及常用口头禅）；',
      '- 绝对禁忌（如严禁使用客服腔、AI腔、长篇大论、公式化套话）。',
      '',
      '### 3. 【精选 Few-Shot 经典问答范例（6~8 组）】',
      '根据上述真实样本提炼出 6~8 组最传神的对照范例（格式：- 对方：“...” ➔ 回复：“...”）。',
      '',
      '### 4. 【可直接生效的起草 Prompt 模板】',
      '请将上述画像、规则与 Few-Shot 融合成一段可直接作为微信起草提示词的文本（必须包含 {name} 占位符）。',
    ].join('\n');

    let personaText = '';
    try {
      personaText = await this.callLlm([{ role: 'user', content: userPrompt }], promptSystem, 2048, {
        temperature: 0.3,
        timeoutMs: 90000,
      });
    } catch (e) {
      return { ok: false, reason: 'llm-error', message: '大模型分析失败: ' + (e.message || String(e)) };
    }

    // 从 personaText 中尝试提取第四板块作为 suggestedPrompt，若无法精确切分则构造结构化 Prompt
    let suggestedPrompt = '';
    const part4Match = personaText.match(/(?:###\s*4\.\s*【可直接生效的起草 Prompt 模板】|【可直接生效的起草 Prompt 模板】)([\s\S]+)$/i);
    if (part4Match && part4Match[1].trim()) {
      suggestedPrompt = part4Match[1].replace(/^```[a-z]*\r?\n?/i, '').replace(/\r?\n?```$/i, '').trim();
    } else {
      suggestedPrompt = [
        '你在替主人起草一条微信回复。严格要求：',
        '1. 用主人的口吻，像本人随手打字，不要客套开场、不要解释你在做什么；',
        '2. 只输出这一条消息本身，不要引号、不要前缀、不要多段排版；',
        `3. 平均单句字数约 ${stats.avgLength} 字，${stats.dotRate < 5 ? '尽量不要在句末使用句号，多用空格断句' : ''}；`,
        `4. 可视语境自然使用常用表情（如 ${topEmojiStr}）；`,
        '5. 对方是 {name}，历史消息里主人自己说的话（me / 主人）就是口吻样本；',
        '6. 遇到邀约、决策或涉及隐私金钱的问题，使用模糊口吻缓冲（如“晚点看”、“刚在忙”），绝不替主人擅自作承诺。',
      ].join('\n');
    }

    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const distilledResult = {
      updatedAt: timeStr,
      sampleCount,
      scannedSessions,
      stats,
      personaText,
      suggestedPrompt,
    };

    await this.writeWechatState({ distilled: distilledResult });

    return {
      ok: true,
      distilled: distilledResult,
    };
  }

  /** 受控的通用补全：messages 由渲染层用共享层拼好，这里只做参数收敛 */
  async completeLlm({ system, messages, maxTokens, temperature } = {}) {
    const list = Array.isArray(messages)
      ? messages
          .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
          .map((m) => ({ role: m.role, content: m.content }))
      : [];
    if (list.length === 0) {
      return { ok: false, reason: 'bad-request', message: 'messages 为空' };
    }
    const cap = Math.min(Math.max(Number(maxTokens) || 256, 16), 4096);
    try {
      const text = await this.callLlm(list, system ? String(system) : '', cap, { temperature, timeoutMs: 60000 });
      return { ok: true, text };
    } catch (e) {
      return { ok: false, reason: 'generate-error', message: e.message || String(e) };
    }
  }

  /** 停止 sidecar（退出前调用） */
  async stopWechatHelper() {
    try {
      await this.wechat.stop();
    } catch (e) {
      console.error('[standalone-service] stop wechat helper failed:', e);
    }
  }

  /** 同步强杀 sidecar（app before-quit 这类无法 await 的场合） */
  killWechatHelperSync() {
    try {
      this.wechat.killSync();
    } catch (e) {
      console.error('[standalone-service] kill wechat helper failed:', e);
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

    // 6. 微信联动
    if (pathname === 'wechat/status') {
      const probe = parsed.searchParams.get('probe') !== '0';
      return json200(await this.wechatStatus({ probe }));
    }

    if (pathname === 'wechat/init') {
      if (method !== 'POST') {
        return json200({ ok: false, reason: 'bad-request', message: '请使用 POST' });
      }
      return json200(await this.wechatInit());
    }

    if (pathname === 'wechat/poll') {
      const limit = Number(parsed.searchParams.get('limit'));
      const params = Number.isFinite(limit) && limit > 0 ? { limit } : {};
      try {
        return json200(await this.wechatPoll(params));
      } catch (e) {
        return json200({ ok: false, reason: e.code || 'helper-error', message: e.message || String(e) });
      }
    }

    if (pathname === 'wechat/sessions') {
      const limit = Number(parsed.searchParams.get('limit'));
      const params = Number.isFinite(limit) && limit > 0 ? { limit } : {};
      try {
        return json200(await this.wechat.call('sessions', params));
      } catch (e) {
        return json200({ ok: false, reason: e.code || 'helper-error', message: e.message || String(e) });
      }
    }

    if (pathname === 'wechat/history') {
      const chat = (parsed.searchParams.get('chat') || '').trim();
      if (!chat) return json200({ ok: false, reason: 'bad-request', message: '缺少 chat 参数' });
      const limit = Number(parsed.searchParams.get('limit'));
      const params = { chat };
      if (Number.isFinite(limit) && limit > 0) params.limit = limit;
      try {
        return json200(await this.wechat.call('history', params));
      } catch (e) {
        return json200({ ok: false, reason: e.code || 'helper-error', message: e.message || String(e) });
      }
    }

    if (pathname === 'wechat/overview') {
      try {
        return json200(await this.wechat.call('overview', {}));
      } catch (e) {
        return json200({ ok: false, reason: e.code || 'helper-error', message: e.message || String(e) });
      }
    }

    if (pathname === 'wechat/memes') {
      return json200({ ok: true, memes: this.getMemePool() });
    }

    if (pathname === 'wechat/state') {
      if (method === 'GET') {
        return json200({ ok: true, state: await this.readWechatState() });
      }
      if (method === 'POST' || method === 'PUT') {
        let patch = {};
        try {
          patch = JSON.parse(body || '{}');
        } catch {
          return json200({ ok: false, reason: 'bad-request', message: 'state 必须是 JSON 对象' });
        }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return json200({ ok: false, reason: 'bad-request', message: 'state 必须是 JSON 对象' });
        }
        try {
          return json200({ ok: true, state: await this.writeWechatState(patch) });
        } catch (e) {
          return json200({ ok: false, reason: 'write-failed', message: e.message || String(e) });
        }
      }
    }

    if (pathname === 'wechat/distill') {
      if (method === 'GET') {
        const state = await this.readWechatState();
        return json200({ ok: true, distilled: state.distilled || null });
      }
      if (method === 'POST') {
        let payload = {};
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          /* ignore */
        }
        return json200(await this.wechatDistill(payload));
      }
      return json200({ ok: false, reason: 'bad-request', message: '仅支持 GET 或 POST' });
    }

    // 7. 通用补全（渲染层用共享层拼好 messages 后调用）
    if (pathname === 'llm/complete') {
      if (method !== 'POST') {
        return json200({ ok: false, reason: 'bad-request', message: '请使用 POST' });
      }
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        return json200({ ok: false, reason: 'bad-request', message: '请求体必须是 JSON' });
      }
      return json200(await this.completeLlm(payload));
    }

    // 8. 静态资源：字体
    if (pathname.startsWith('font/')) {
      const filename = pathname.slice('font/'.length);
      const filePath = path.join(this.assetsRoot, 'fonts', filename);
      if (fs.existsSync(filePath)) {
        return { status: 200, file: filePath, contentType: 'font/ttf' };
      }
      return { status: 404, contentType: 'text/plain', body: 'Font not found' };
    }

    // 9. 静态资源：图片 (pic / memes)
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

    // 10. 静态资源：动画 (thumb/<petId>/<filename>)
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
