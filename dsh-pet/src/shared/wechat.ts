// 微信联动（src/shared，浏览器 bundle 与桌面 shared-core 共用）：
//  - 纯逻辑：监控范围/白名单判定、会话筛选、草稿提示词、今日概览聚合、表情包呼应选图、
//    气泡文案整形 —— 全部无 DOM / 无 React，桌面端（runtime/electron-helper）经
//    window.PetShared 调用；微信数据由常驻 sidecar（wechat-mcp-server/wechat_cli_mcp/bridge.py）
//    提供，Node 侧只管进程与 HTTP 路由。
//  - 只读约束：本模块只描述「读什么、怎么展示、怎么起草」；发送永远止于剪贴板
//    （不做注入式自动发送——上游 wechat-cli-mcp 本身也只读）。
//  - 隐私：主动预生成草稿会把该会话最近若干条消息交给用户自己配置的 LLM，
//    因此默认关闭（autoDraft.mode === 'none'），由用户在设置里显式圈范围。
// 「行为落在这里 + 两端薄壳」的项目约定见 src/shared/index.ts 头部注释。

/** 监控范围：all=全部（受 skip* 约束）/ whitelist=仅名单内 / none=关闭 */
export type WechatScopeMode = 'all' | 'whitelist' | 'none';

export interface WechatScopeConfig {
  mode: WechatScopeMode;
  /** mode==='whitelist' 时的名单：匹配 username 或备注名（大小写不敏感，支持首/尾 * 通配） */
  list: string[];
}

export interface WechatConfig {
  /** 总开关：关掉后完全不轮询、不弹气泡、不进右键菜单面板 */
  enabled: boolean;
  /** 私聊范围（气泡提醒 / 托盘通知 / 概览都按它筛） */
  individuals: WechatScopeConfig;
  /** 群聊范围 */
  groups: WechatScopeConfig;
  /** 主动预生成草稿的范围（默认 none：不把聊天内容交给 LLM） */
  autoDraft: WechatScopeConfig;
  /** 跳过公众号/服务号（username 以 gh_ 开头） */
  skipSubscriptions: boolean;
  /** 跳过已折叠会话 */
  skipFolded: boolean;
  /** 已折叠会话的 username 列表（微信不对外暴露该状态，由用户维护或面板一键折叠） */
  folded: string[];
  /** 新消息气泡提醒（谁 + 摘要） */
  bubbleNewMessage: boolean;
  /** 今日概览气泡 */
  bubbleOverview: boolean;
  /** 系统托盘通知 + 任务栏闪烁 */
  desktopNotify: boolean;
  /** 表情包呼应：按对方内容挑一张表情包随气泡展示 */
  stickerEcho: boolean;
  /** 轮询新消息的周期（秒） */
  pollIntervalSec: number;
  /** 群消息是否仅在 @我 时才起草回复 */
  groupRequireAt: boolean;
  /** 起草完成后是否自动模拟发送到微信 */
  autoReply: boolean;
  /** 同一会话两次主动预生成的最小间隔（秒） */
  draftCooldownSec: number;
  /** 每小时主动预生成上限（跨会话，0 = 不限） */
  draftMaxPerHour: number;
  /** 起草时喂给模型的历史条数 */
  historyLimit: number;
  /** 今日概览里列出的会话数 */
  overviewCount: number;
  /** 起草用的系统提示词模板，支持 {name} / {count} 占位 */
  draftPrompt: string;
}

export const DEFAULT_WECHAT_CONFIG: WechatConfig = {
  enabled: false,
  individuals: { mode: 'all', list: [] },
  groups: { mode: 'all', list: [] },
  // 默认不把聊天内容交给 LLM：用户显式改成 all / whitelist 才会主动起草
  autoDraft: { mode: 'none', list: [] },
  skipSubscriptions: true,
  skipFolded: true,
  folded: [],
  bubbleNewMessage: true,
  bubbleOverview: true,
  desktopNotify: false,
  stickerEcho: false,
  pollIntervalSec: 20,
  groupRequireAt: false,
  autoReply: false,
  draftCooldownSec: 300,
  draftMaxPerHour: 12,
  historyLimit: 12,
  overviewCount: 5,
  draftPrompt: [
    '你在替主人起草一条微信回复。要求：',
    '1. 用主人的口吻，像本人随手打字，不要客套开场、不要解释你在做什么；',
    '2. 只输出这一条消息本身，不要引号、不要前缀（如「回复：」）、不要多段排版；',
    '3. 长度贴近主人平时的习惯，通常一到两句话；',
    '4. 对方是 {name}，历史消息里主人自己说的话（me / 主人）就是口吻样本；',
    '5. 若对方发来了图片，结合图片画面中的视觉细节与当下语境自然回复。',
  ].join('\n'),
};

const SCOPE_MODES: readonly WechatScopeMode[] = ['all', 'whitelist', 'none'];

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const asBool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

/** 名单去重 + 去空白 + 截断（防御手写配置里的空串与重复项） */
export function normalizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out.slice(0, 200);
}

function normalizeScope(raw: unknown, fallback: WechatScopeConfig): WechatScopeConfig {
  if (typeof raw === 'boolean') {
    return { mode: raw ? 'all' : 'none', list: [] };
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = SCOPE_MODES.includes(o.mode as WechatScopeMode) ? (o.mode as WechatScopeMode) : fallback.mode;
  const list = o.list === undefined ? fallback.list.slice() : normalizeList(o.list);
  return { mode, list };
}

/** 把用户配置/默认配置的任意输入收敛成完整、可安全消费的 WechatConfig。
 *  桌面侧 getMergedConfig 已做字段级白名单，这里再做一次类型/范围收敛（设置页可直接保存脏值）。 */
export function normalizeWechatConfig(raw: unknown): WechatConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_WECHAT_CONFIG;
  const rawPrompt = typeof o.draftPrompt === 'string' ? o.draftPrompt : '';
  return {
    enabled: asBool(o.enabled, d.enabled),
    individuals: normalizeScope(o.individuals, d.individuals),
    groups: normalizeScope(o.groups, d.groups),
    autoDraft: normalizeScope(o.autoDraft, d.autoDraft),
    skipSubscriptions: asBool(o.skipSubscriptions, d.skipSubscriptions),
    skipFolded: asBool(o.skipFolded, d.skipFolded),
    folded: normalizeList(o.folded),
    bubbleNewMessage: asBool(o.bubbleNewMessage, d.bubbleNewMessage),
    bubbleOverview: asBool(o.bubbleOverview, d.bubbleOverview),
    desktopNotify: asBool(o.desktopNotify, d.desktopNotify),
    stickerEcho: asBool(o.stickerEcho, d.stickerEcho),
    pollIntervalSec: clampInt(o.pollIntervalSec, 2, 600, d.pollIntervalSec),
    groupRequireAt: asBool(o.groupRequireAt, d.groupRequireAt),
    autoReply: asBool(o.autoReply, d.autoReply),
    draftCooldownSec: clampInt(o.draftCooldownSec, 0, 86_400, d.draftCooldownSec),
    draftMaxPerHour: clampInt(o.draftMaxPerHour, 0, 600, d.draftMaxPerHour),
    historyLimit: clampInt(o.historyLimit, 2, 2000, d.historyLimit),
    overviewCount: clampInt(o.overviewCount, 1, 20, d.overviewCount),
    draftPrompt: rawPrompt.trim() ? rawPrompt : d.draftPrompt,
  };
}

/** 会话语义（与 bridge.py `sessions` 命令字段一一对应，camelCase） */
export interface WechatChatRef {
  /** 主键：wxid_xxx 或 xxx@chatroom（bridge 侧 resolve 用） */
  username: string;
  /** 展示名：备注 > 昵称 > username */
  chat: string;
  isGroup: boolean;
}

export interface WechatSession extends WechatChatRef {
  /** 未读数 */
  unread: number;
  /** 该会话最后一条消息的摘要（群聊为「发送者: 内容」形态） */
  lastMessage: string;
  /**
   * 最后一条消息的类型。
   * bridge 的 sessions 里 `msgType` 是中文标签（如 `'文本'`/`'链接/文件'`），`msgTypeRaw` 才是 int；
   * 这里两者都接受，消费方若需要判定类型请优先取 `msgTypeRaw`。
   */
  msgType: string | number;
  /** 最后一条消息的原始类型 int（1 文本 / 3 图片 / 47 表情 …，见 core/messages.py format_msg_type） */
  msgTypeRaw?: number;
  /** 群聊里最后一条消息的发送者 */
  sender: string;
  /** Unix 秒 */
  timestamp: number;
}

export interface WechatMediaItem {
  type: 'image' | 'file' | 'video';
  decodedPath?: string;
  url?: string;
  exists?: boolean;
}

export interface WechatMessage {
  /** `YYYY-MM-DD HH:MM`（bridge 已格式化） */
  time: string;
  /** 发送者展示名；主人自己是 `me` 或 selfLabel */
  label: string;
  text: string;
  isSelf: boolean;
  media?: WechatMediaItem;
}

export type MultimodalPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url?: string; path?: string } };

export interface DraftChatMessage {
  role: 'user' | 'assistant';
  content: string | MultimodalPart[];
}

export interface BuildDraftMessagesOptions {
  /** 允许注入真实多模态图片的最大张数（优先取最新图片，默认 2） */
  maxImages?: number;
}

/** 公众号 / 服务号：username 以 gh_ 开头（core/contacts.py 的 is_subscription 同语义） */
export const isSubscriptionChat = (username: string): boolean => username.startsWith('gh_');

/**
 * 微信内部的「占位会话」：真实 SessionTable 里存在这一类不是真人/真群的行，弹出来毫无意义。
 * - `brandservicesessionholder` / `brandsessionholder`：品牌服务占位会话（真机会出现在列表里）
 * - 会话名为空或纯空白：脏数据行（有备注/昵称时至少会回落到 username，不会为空）
 */
export function isInternalChat(chat: WechatChatRef): boolean {
  const u = String(chat.username || '').toLowerCase();
  const n = String(chat.chat || '')
    .trim()
    .toLowerCase();
  if (u === 'brandservicesessionholder' || u === 'brandsessionholder') return true;
  if (n === 'brandservicesessionholder' || n === 'brandsessionholder') return true;
  return !String(chat.chat || '').trim();
}

/** 单条白名单是否命中该会话：username / 备注名精确匹配（不敏感），支持首尾 * 通配。 */
export function matchChatRule(rule: string, chat: WechatChatRef): boolean {
  const r = rule.trim().toLowerCase();
  if (!r) return false;
  const targets = [chat.username.toLowerCase(), chat.chat.toLowerCase()];
  const wild = r.startsWith('*') || r.endsWith('*');
  if (!wild) return targets.includes(r);
  const body = r.replace(/^\*+/, '').replace(/\*+$/, '');
  if (!body) return true; // 单个 '*'：命中全部
  return targets.some((t) => t.includes(body));
}

/** 范围判定：none → 恒 false；all → 恒 true；whitelist → 名单任一命中。 */
export function scopeAllows(scope: WechatScopeConfig, chat: WechatChatRef): boolean {
  if (scope.mode === 'none') return false;
  if (scope.mode === 'all') return true;
  return scope.list.some((rule) => matchChatRule(rule, chat));
}

/** 该会话是否处于监控范围（总开关 + 私聊/群聊范围 + 占位会话/公众号/折叠过滤）。 */
export function isMonitoredChat(chat: WechatChatRef, cfg: WechatConfig): boolean {
  if (!cfg.enabled) return false;
  if (isInternalChat(chat)) return false;
  if (cfg.skipSubscriptions && isSubscriptionChat(chat.username)) return false;
  if (cfg.skipFolded && cfg.folded.some((u) => u.toLowerCase() === chat.username.toLowerCase())) return false;
  return scopeAllows(chat.isGroup ? cfg.groups : cfg.individuals, chat);
}

/** 单行摘要整形：折叠换行、去多余空白、超长截断（气泡/通知都不该被长文本撑爆）。 */
export function summarizeLine(text: string, max = 60): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(1, max - 1)) + '…';
}

/** 新消息气泡文案：群聊带发送者，私聊直接给名字。 */
export function formatNewMessageBubble(session: WechatSession): { title: string; text: string } {
  const title = session.isGroup
    ? summarizeLine(session.chat, 14) + (session.sender ? ' · ' + summarizeLine(session.sender, 10) : '')
    : summarizeLine(session.chat, 14);
  return { title, text: summarizeLine(session.lastMessage, 80) || '（新消息）' };
}

/** 会话列表按「未读优先、其次最近」排序（面板与概览共用同一序）。 */
export function sortSessions(sessions: readonly WechatSession[]): WechatSession[] {
  return sessions.slice().sort((a, b) => {
    if ((b.unread > 0 ? 1 : 0) !== (a.unread > 0 ? 1 : 0)) return (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0);
    if (b.unread !== a.unread) return b.unread - a.unread;
    return b.timestamp - a.timestamp;
  });
}

export interface WechatOverview {
  /** 未读会话数 */
  unreadChats: number;
  /** 未读消息总数 */
  unreadTotal: number;
  /** 谁找你最多（未读降序，取 overviewCount 条） */
  top: Array<{ name: string; unread: number; isGroup: boolean }>;
  /** 概览气泡的多行文案（已整形，直接喂气泡） */
  lines: string[];
}

/** 今日微信概览：谁找你最多 + 未读总数。sessions 应为**已筛过监控范围**的列表。 */
export function buildOverview(sessions: readonly WechatSession[], cfg: WechatConfig): WechatOverview {
  const sorted = sortSessions(sessions.filter((s) => s.unread > 0));
  const unreadTotal = sorted.reduce((sum, s) => sum + Math.max(0, s.unread), 0);
  const top = sorted.slice(0, cfg.overviewCount).map((s) => ({
    name: summarizeLine(s.chat, 16),
    unread: Math.max(0, s.unread),
    isGroup: s.isGroup,
  }));
  const lines: string[] = [];
  if (!sorted.length) {
    lines.push('微信没有未读消息，清清静静~');
  } else {
    lines.push(`微信未读 ${unreadTotal} 条 · ${sorted.length} 个会话`);
    for (const t of top) lines.push(`· ${t.name}${t.isGroup ? '（群）' : ''} ${t.unread} 条`);
    if (sorted.length > top.length) lines.push(`…还有 ${sorted.length - top.length} 个会话`);
  }
  return { unreadChats: sorted.length, unreadTotal, top, lines };
}

/** 主动预生成的节流闸门（由调用方按会话持久化；纯函数便于测试）。 */
export interface WechatDraftGate {
  /** username → 上次起草时间（Unix 秒） */
  lastDraftAt: Record<string, number>;
  /** 最近若干次起草的时间戳（用于每小时上限） */
  recentDrafts: number[];
  /** username → 上次起草/检查时见过的最新消息时间戳（Unix 秒） */
  lastDraftMsgTs?: Record<string, number>;
}

export const EMPTY_DRAFT_GATE: WechatDraftGate = { lastDraftAt: {}, recentDrafts: [], lastDraftMsgTs: {} };

/**
 * 判定群聊消息文本中是否 @ 了主人或所有人：
 * - 包含微信官方提示的 `[有人@我]`
 * - 包含 `@所有人` / `@all` / `@All`
 * - 如果提供了 selfLabel（且不是占位 'me'），包含 `@${selfLabel}`
 * - 如果未提供 selfLabel 或为 'me'，包含 `@` 符号
 */
export function isGroupMentioned(messageText: string, selfLabel?: string): boolean {
  const t = String(messageText ?? '').trim();
  if (!t) return false;
  if (t.includes('[有人@我]')) return true;
  if (/@所有人/i.test(t) || /@all/i.test(t)) return true;
  const label = String(selfLabel ?? '').trim();
  if (label && label.toLowerCase() !== 'me') {
    return t.includes(`@${label}`);
  }
  return t.includes('@');
}

/** 挑一个「值得主动起草」的会话：有新消息或未读、且过了冷却与小时配额，且不早于桌宠启动时间。 */
export function pickDraftTarget(
  sessions: readonly WechatSession[],
  cfg: WechatConfig,
  gate: WechatDraftGate,
  nowSec: number,
  startupSec?: number,
): WechatSession | null {
  if (!cfg.enabled) return null;
  const isAutoDraftOn = cfg.autoDraft.mode !== 'none' || Boolean(cfg.autoReply);
  if (!isAutoDraftOn) return null;
  const effectiveAutoDraft: WechatScopeConfig =
    cfg.autoDraft.mode === 'none' && cfg.autoReply ? { mode: 'all', list: [] } : cfg.autoDraft;

  if (cfg.draftMaxPerHour > 0) {
    const since = nowSec - 3600;
    const used = gate.recentDrafts.filter((t) => t > since).length;
    if (used >= cfg.draftMaxPerHour) return null;
  }
  const lastMsgTsMap = gate.lastDraftMsgTs || {};
  const candidates = sessions.filter((s) => {
    if (!isMonitoredChat(s, cfg)) return false;
    if (!scopeAllows(effectiveAutoDraft, s)) return false;
    // 启动时间过滤：桌宠启动时刻之前的旧消息一律不起草（避免开机或启动时把几小时前的未读全部起草）
    if (typeof startupSec === 'number' && startupSec > 0) {
      if ((s.timestamp || 0) < startupSec) return false;
    }
    // 群聊 @ 过滤：如果开启了仅 @ 我才起草，并且最后一条消息是文本/摘要但完全不包含 @，则跳过
    if (s.isGroup && cfg.groupRequireAt) {
      if (s.lastMessage && !isGroupMentioned(s.lastMessage)) return false;
    }
    // 只要有未读，或者最新消息时间戳比上次见到的新，就符合触发候选
    const prevMsgTs = lastMsgTsMap[s.username] ?? 0;
    const isNewer = (s.timestamp || 0) > prevMsgTs;
    if (!isNewer && !(s.unread > 0)) return false;
    const last = gate.lastDraftAt[s.username] ?? 0;
    return nowSec - last >= cfg.draftCooldownSec;
  });
  if (!candidates.length) return null;
  return sortSessions(candidates)[0];
}

/** 把 bridge 的历史行转成 LLM 消息：主人自己 → assistant，对方 → user（群聊保留发送者前缀），支持图片消息多模态注入。 */
export function buildDraftMessages(
  chat: WechatChatRef,
  history: readonly WechatMessage[],
  selfLabel = 'me',
  options: BuildDraftMessagesOptions = {},
): DraftChatMessage[] {
  const tail = history.slice(-2000);
  const out: DraftChatMessage[] = [];
  const maxImages = Number.isFinite(Number(options.maxImages)) ? Math.max(0, Number(options.maxImages)) : 2;

  // 预扫描倒数最近的具备有效图片路径的消息索引，仅将这些索引标记为视觉多模态注入
  const activeImageIndices = new Set<number>();
  if (maxImages > 0) {
    let count = 0;
    for (let i = tail.length - 1; i >= 0; i--) {
      const m = tail[i];
      if (m.media?.type === 'image' && (m.media.decodedPath || m.media.url)) {
        activeImageIndices.add(i);
        count++;
        if (count >= maxImages) break;
      }
    }
  }

  for (let i = 0; i < tail.length; i++) {
    const m = tail[i];
    const text = String(m.text ?? '').trim();
    const hasMedia = activeImageIndices.has(i);
    if (!text && !hasMedia) continue;

    const isSelf = m.isSelf || m.label === selfLabel;
    const role: 'user' | 'assistant' = isSelf ? 'assistant' : 'user';

    const textContent =
      !isSelf && chat.isGroup && m.label ? `${m.label}: ${text || '[图片]'}` : text || '[图片]';

    if (hasMedia) {
      const imgPath = m.media?.decodedPath;
      const imgUrl = m.media?.url;
      const parts: MultimodalPart[] = [{ type: 'text', text: textContent }];
      if (imgPath) {
        parts.push({ type: 'image_url', image_url: { path: imgPath } });
      } else if (imgUrl) {
        parts.push({ type: 'image_url', image_url: { url: imgUrl } });
      }
      out.push({ role, content: parts });
    } else {
      out.push({ role, content: textContent });
    }
  }
  // 最后一条必须是 user 才能让模型「接着回」：主人刚说完话时补一句提示
  if (out.length && out[out.length - 1].role === 'assistant') {
    out.push({ role: 'user', content: '（我刚说完，你看看对方会怎么接，或者帮我补一句更合适的。）' });
  }
  return out;
}

/** 起草用的系统提示词：模板里的 {name} / {count} 替换为会话名与历史条数。 */
export function buildDraftSystemPrompt(cfg: WechatConfig, chat: WechatChatRef, messageCount: number): string {
  return cfg.draftPrompt
    .replace(/\{name\}/g, chat.isGroup ? `${chat.chat}（群聊）` : chat.chat)
    .replace(/\{count\}/g, String(messageCount));
}

/** 模型输出清洗：去掉引号/前缀/换行排版，只留一条可直接粘贴的消息。 */
export function cleanDraft(text: string, max = 300): string {
  let out = String(text ?? '').trim();
  out = out.replace(/^(回复|答复|回复内容|消息)\s*[:：]\s*/i, '');
  out = out.replace(/^["'“”『「]+/, '').replace(/["'“”』」]+$/, '');
  out = out.replace(/\s*\n+\s*/g, ' ').trim();
  if (out.length > max) out = out.slice(0, max).trimEnd() + '…';
  return out;
}

/** 表情包呼应：按对方消息文本，从「表情包名 → 描述」池里挑一张最贴的。
 *  打分 = 文本与描述的关键词重合（CJK 按 2 字滑窗、ASCII 按词），命中则返回名字。 */
export function pickStickerEcho(
  text: string,
  memes: Record<string, string>,
  recent: readonly string[] = [],
): string | null {
  const body = String(text ?? '').toLowerCase();
  if (!body.trim()) return null;
  const tokens = new Set<string>();
  for (const word of body.match(/[a-z0-9]+/g) ?? []) if (word.length >= 2) tokens.add(word);
  const cjk = body.replace(/[^\u4e00-\u9fff]/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= run.length; i++) tokens.add(run.slice(i, i + 2));
  }
  if (!tokens.size) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const [name, desc] of Object.entries(memes)) {
    if (!name || !desc) continue;
    if (recent.includes(name)) continue;
    const d = String(desc).toLowerCase();
    let score = 0;
    for (const token of tokens) if (d.includes(token)) score += token.length >= 2 ? 1 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return bestScore >= 1 ? best : null;
}

/** 面板里单条会话的一行摘要（未读徽标 + 最后一条消息）。 */
export function formatSessionRow(session: WechatSession): { title: string; sub: string; badge: string } {
  const b = formatNewMessageBubble(session);
  return { title: b.title, sub: b.text, badge: session.unread > 0 ? String(session.unread) : '' };
}
