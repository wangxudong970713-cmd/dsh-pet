/**
 * settings.js —— 桌宠独立设置面板前端交互
 */

'use strict';

let currentConfig = {};

const apiKeyInput = document.getElementById('apiKey');
const toggleApiKeyBtn = document.getElementById('toggleApiKey');
const baseUrlInput = document.getElementById('baseUrl');
const modelInput = document.getElementById('model');
const btnTest = document.getElementById('btnTest');
const testStatus = document.getElementById('testStatus');

const petSizeInput = document.getElementById('petSize');
const sizeVal = document.getElementById('sizeVal');
const whisperEnabledInput = document.getElementById('whisperEnabled');
const whisperIntervalInput = document.getElementById('whisperInterval');
const whisperIntervalGroup = document.getElementById('whisperIntervalGroup');
const whisperImageEnabledInput = document.getElementById('whisperImageEnabled');
const chatImageEnabledInput = document.getElementById('chatImageEnabled');
const whisperPromptInput = document.getElementById('whisperPrompt');
const autoStartEnabledInput = document.getElementById('autoStartEnabled');

const btnSave = document.getElementById('btnSave');
const btnReset = document.getElementById('btnReset');
const saveStatus = document.getElementById('saveStatus');

/* ==================== 微信联动 ==================== */
// 说明：settings:get 返回的是**用户配置原文**（main.js 的 settings:get = getUserConfig），
// 首次运行没有 wechat 字段，所以这里自带一份默认值兜底（与 assets/config.jsonc 的 wechat 块、
// 以及 src/shared/wechat.ts 的 DEFAULT_WECHAT_CONFIG 保持一致）。
const WECHAT_DEFAULTS = {
  enabled: false,
  individuals: { mode: 'all', list: [] },
  groups: { mode: 'all', list: [] },
  groupRequireAt: false,
  autoDraft: { mode: 'none', list: [] },
  autoReply: false,
  skipSubscriptions: true,
  skipFolded: true,
  folded: [],
  bubbleNewMessage: true,
  bubbleOverview: true,
  desktopNotify: false,
  stickerEcho: false,
  pollIntervalSec: 20,
  draftCooldownSec: 300,
  draftMaxPerHour: 12,
  historyLimit: 12,
  overviewCount: 5,
  draftPrompt: [
    '你在替主人起草一条微信回复。要求：',
    '1. 用主人的口吻，像本人随手打字，不要客套开场、不要解释你在做什么；',
    '2. 只输出这一条消息本身，不要引号、不要前缀（如「回复：」）、不要多段排版；',
    '3. 长度贴近主人平时的习惯，通常一到两句话；',
    '4. 对方是 {name}，历史消息里主人自己说的话（me / 主人）就是口吻样本。',
  ].join('\n'),
};

/** 设置窗口也是 file:// 页面：走已注册的自定义 scheme（与宠物页同一前缀） */
const WECHAT_BRIDGE = 'dsh-pet-bridge://dsh-pet/dsh-pet-7340/wechat';

const wechatEnabledInput = document.getElementById('wechatEnabled');
const wechatBody = document.getElementById('wechatBody');

// 私聊搜索搜选
const wechatIndividualSearch = document.getElementById('wechatIndividualSearch');
const wechatIndividualAddBtn = document.getElementById('wechatIndividualAddBtn');
const wechatIndividualClearBtn = document.getElementById('wechatIndividualClearBtn');
const wechatIndividualCandidateList = document.getElementById('wechatIndividualCandidateList');
const wechatIndividualBadges = document.getElementById('wechatIndividualBadges');
const wechatIndividualListInput = document.getElementById('wechatIndividualList');

// 群聊搜索搜选
const wechatGroupSearch = document.getElementById('wechatGroupSearch');
const wechatGroupAddBtn = document.getElementById('wechatGroupAddBtn');
const wechatGroupClearBtn = document.getElementById('wechatGroupClearBtn');
const wechatGroupCandidateList = document.getElementById('wechatGroupCandidateList');
const wechatGroupBadges = document.getElementById('wechatGroupBadges');
const wechatGroupListInput = document.getElementById('wechatGroupList');

const wechatGroupRequireAtInput = document.getElementById('wechatGroupRequireAt');
const wechatAutoDraftEnabledInput = document.getElementById('wechatAutoDraftEnabled');
const wechatAutoReplyInput = document.getElementById('wechatAutoReply');
const wechatSkipSubscriptionsInput = document.getElementById('wechatSkipSubscriptions');
const wechatSkipFoldedInput = document.getElementById('wechatSkipFolded');
const wechatFoldedListInput = document.getElementById('wechatFoldedList');
const wechatBubbleNewMessageInput = document.getElementById('wechatBubbleNewMessage');
const wechatBubbleOverviewInput = document.getElementById('wechatBubbleOverview');
const wechatDesktopNotifyInput = document.getElementById('wechatDesktopNotify');
const wechatStickerEchoInput = document.getElementById('wechatStickerEcho');
const wechatPollIntervalInput = document.getElementById('wechatPollInterval');
const wechatDraftCooldownInput = document.getElementById('wechatDraftCooldown');
const wechatDraftMaxPerHourInput = document.getElementById('wechatDraftMaxPerHour');
const wechatHistoryLimitInput = document.getElementById('wechatHistoryLimit');
const wechatOverviewCountInput = document.getElementById('wechatOverviewCount');

// 🔮 AI 风格蒸馏元素
const wechatDistillLimitInput = document.getElementById('wechatDistillLimit');
const btnWechatDistill = document.getElementById('btnWechatDistill');
const wechatDistillStatusEl = document.getElementById('wechatDistillStatus');
const wechatDistillResultEl = document.getElementById('wechatDistillResult');
const distillMetaInfoEl = document.getElementById('distillMetaInfo');
const distillTagsBarEl = document.getElementById('distillTagsBar');
const btnApplyDistillPrompt = document.getElementById('btnApplyDistillPrompt');
const wechatDistillPersonaText = document.getElementById('wechatDistillPersonaText');

let latestDistilled = null;

const wechatDraftPromptInput = document.getElementById('wechatDraftPrompt');
const btnWechatPromptReset = document.getElementById('btnWechatPromptReset');
const btnWechatStatus = document.getElementById('btnWechatStatus');
const btnWechatInit = document.getElementById('btnWechatInit');
const wechatStatusEl = document.getElementById('wechatStatus');

const WECHAT_MODES = ['all', 'whitelist', 'none'];

/** 名单文本 ⇄ 数组（换行或逗号分隔；trim、去空、去重、限长） */
function linesToList(text) {
  const out = [];
  const seen = new Set();
  for (const piece of String(text || '').split(/[\n,]/)) {
    const item = piece.trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 200) break;
  }
  return out;
}

function listToLines(list) {
  return Array.isArray(list) ? list.join('\n') : '';
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeScope(raw, fallback) {
  if (typeof raw === 'boolean') {
    return { mode: raw ? 'all' : 'none', list: [] };
  }
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: WECHAT_MODES.indexOf(o.mode) >= 0 ? o.mode : fallback.mode,
    list: Array.isArray(o.list) ? o.list.filter((x) => typeof x === 'string' && x.trim()) : fallback.list.slice(),
  };
}

/** 把任意来源的 wechat 配置收敛成表单能消费的完整对象 */
function normalizeWechat(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const d = WECHAT_DEFAULTS;
  const bool = (v, fb) => (typeof v === 'boolean' ? v : fb);
  return {
    enabled: bool(o.enabled, d.enabled),
    individuals: normalizeScope(o.individuals, d.individuals),
    groups: normalizeScope(o.groups, d.groups),
    groupRequireAt: bool(o.groupRequireAt, d.groupRequireAt),
    autoDraft: normalizeScope(o.autoDraft, d.autoDraft),
    autoReply: bool(o.autoReply, d.autoReply),
    skipSubscriptions: bool(o.skipSubscriptions, d.skipSubscriptions),
    skipFolded: bool(o.skipFolded, d.skipFolded),
    folded: Array.isArray(o.folded) ? linesToList(o.folded.join('\n')) : d.folded.slice(),
    bubbleNewMessage: bool(o.bubbleNewMessage, d.bubbleNewMessage),
    bubbleOverview: bool(o.bubbleOverview, d.bubbleOverview),
    desktopNotify: bool(o.desktopNotify, d.desktopNotify),
    stickerEcho: bool(o.stickerEcho, d.stickerEcho),
    pollIntervalSec: clampNum(o.pollIntervalSec, 2, 600, d.pollIntervalSec),
    draftCooldownSec: clampNum(o.draftCooldownSec, 0, 86400, d.draftCooldownSec),
    draftMaxPerHour: clampNum(o.draftMaxPerHour, 0, 600, d.draftMaxPerHour),
    historyLimit: clampNum(o.historyLimit, 2, 2000, d.historyLimit),
    overviewCount: clampNum(o.overviewCount, 1, 20, d.overviewCount),
    draftPrompt: typeof o.draftPrompt === 'string' && o.draftPrompt.trim() ? o.draftPrompt : d.draftPrompt,
  };
}

/** 总开关关闭时置灰全部配置项（disabled 不影响 .value 读取，保存仍带原值） */
function updateWechatEnabledState() {
  const on = wechatEnabledInput.checked;
  if (wechatBody) wechatBody.classList.toggle('is-off', !on);
  if (!wechatBody) return;
  for (const el of wechatBody.querySelectorAll('input, textarea, select, button')) {
    if (el.id !== 'btnWechatStatus' && el.id !== 'btnWechatInit') {
      el.disabled = !on;
    }
  }
}

// 选中的名单集合
const selectedIndividuals = new Set();
const selectedGroups = new Set();
let fetchedSessions = [];

function renderBadges(type) {
  const isGrp = type === 'group';
  const container = isGrp ? wechatGroupBadges : wechatIndividualBadges;
  const set = isGrp ? selectedGroups : selectedIndividuals;
  const hiddenInput = isGrp ? wechatGroupListInput : wechatIndividualListInput;

  container.innerHTML = '';
  if (set.size === 0) {
    const emptySpan = document.createElement('span');
    emptySpan.className = 'scope-desc';
    emptySpan.textContent = '暂无勾选（未勾选时不会监听）';
    container.appendChild(emptySpan);
  } else {
    for (const name of set) {
      const badge = document.createElement('span');
      badge.className = 'wechat-badge';
      badge.textContent = name;
      const close = document.createElement('span');
      close.className = 'badge-close';
      close.textContent = ' ×';
      close.title = '取消勾选';
      close.addEventListener('click', () => {
        set.delete(name);
        renderBadges(type);
        renderCandidates(type);
      });
      badge.appendChild(close);
      container.appendChild(badge);
    }
  }
  hiddenInput.value = Array.from(set).join('\n');
}

function isSystemOrOfficialAccount(username) {
  if (!username || typeof username !== 'string') return false;
  const u = username.toLowerCase().trim();
  return (
    u.startsWith('gh_') ||
    u === 'notifymessage' ||
    u === 'brandsessionholder' ||
    u === 'brandservicesessionholder' ||
    u === 'weixin' ||
    u === 'fmessage' ||
    u === 'medianote' ||
    u === 'floatbottle' ||
    u === 'filehelper' ||
    u === 'qqsafe' ||
    u === 'qqmail' ||
    u === 'qmessage' ||
    u === 'newsapp' ||
    u === 'voip' ||
    u === 'voiceinputapp'
  );
}

function getChatDisplayName(s) {
  if (!s) return '';
  const rawChat = typeof s.chat === 'string' ? s.chat.trim() : '';
  const rawRemark = typeof s.remark === 'string' ? s.remark.trim() : '';
  const rawNick = typeof s.nickname === 'string' ? s.nickname.trim() : (typeof s.nick_name === 'string' ? s.nick_name.trim() : '');
  const isGrp = Boolean(s.isGroup);

  // 微信名字优先级：优先使用 chat (已由后端解析微信群名/备注名/好友昵称) > remark > nickname
  let name = rawChat || rawRemark || rawNick;

  // 针对群聊：如果群名为空或无意义纯空格
  if (isGrp) {
    if (!name || name === s.username) {
      const shortId = (s.username || '').replace('@chatroom', '');
      return shortId ? ('群聊(' + shortId.slice(-6) + ')') : '未命名群聊';
    }
    return name;
  }

  // 针对好友私聊
  return name || s.username || '微信好友';
}

function renderCandidates(type) {
  const isGrp = type === 'group';
  const container = isGrp ? wechatGroupCandidateList : wechatIndividualCandidateList;
  const searchInput = isGrp ? wechatGroupSearch : wechatIndividualSearch;
  const set = isGrp ? selectedGroups : selectedIndividuals;
  const query = (searchInput.value || '').trim().toLowerCase();

  const map = new Map();
  for (const s of fetchedSessions) {
    if (Boolean(s.isGroup) !== isGrp) continue;

    // 好友私聊：严格过滤掉公众号和服务通知
    if (!isGrp && isSystemOrOfficialAccount(s.username)) {
      continue;
    }

    const displayName = getChatDisplayName(s);
    if (!displayName) continue;

    map.set(displayName, {
      name: displayName,
      displayName: displayName,
      username: s.username || '',
      unread: s.unread || 0,
    });
  }

  for (const savedName of set) {
    if (!isGrp && isSystemOrOfficialAccount(savedName)) {
      continue;
    }
    if (!map.has(savedName)) {
      map.set(savedName, {
        name: savedName,
        displayName: savedName,
        username: '',
        unread: 0,
      });
    }
  }

  let candidates = Array.from(map.values());
  if (query) {
    candidates = candidates.filter((c) => {
      const matchName = c.displayName.toLowerCase().includes(query);
      const matchUser = c.username ? c.username.toLowerCase().includes(query) : false;
      return matchName || matchUser;
    });
  }

  container.innerHTML = '';
  if (candidates.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'wechat-picker-empty';
    empty.textContent = query
      ? '未找到包含“' + query + '”的' + (isGrp ? '群聊' : '好友') + '，可点右侧「➕ 添加到监听」'
      : '暂无' + (isGrp ? '群聊' : '好友') + '记录，可直接在上方输入名称添加';
    container.appendChild(empty);
    return;
  }

  candidates.sort((a, b) => {
    const aChecked = set.has(a.name) ? 1 : 0;
    const bChecked = set.has(b.name) ? 1 : 0;
    if (aChecked !== bChecked) return bChecked - aChecked;
    return (b.unread || 0) - (a.unread || 0);
  });

  for (const item of candidates.slice(0, 100)) {
    const row = document.createElement('label');
    row.className = 'wechat-picker-item';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = set.has(item.name);
    chk.addEventListener('change', () => {
      if (chk.checked) {
        set.add(item.name);
      } else {
        set.delete(item.name);
      }
      renderBadges(type);
    });

    const title = document.createElement('span');
    title.className = 'item-title';
    title.textContent = item.displayName;

    // 若微信号和昵称不同，且不是以 @chatroom 结尾，显示微信号副标
    if (item.username && item.username !== item.displayName && !item.username.endsWith('@chatroom')) {
      const sub = document.createElement('span');
      sub.className = 'item-account';
      sub.textContent = ' (' + item.username + ')';
      title.appendChild(sub);
    }

    row.appendChild(chk);
    row.appendChild(title);

    if (item.unread > 0) {
      const tag = document.createElement('span');
      tag.className = 'item-tag';
      tag.textContent = item.unread + ' 条未读';
      row.appendChild(tag);
    }

    container.appendChild(row);
  }
}

function bindPickerEvents(type) {
  const isGrp = type === 'group';
  const searchInput = isGrp ? wechatGroupSearch : wechatIndividualSearch;
  const addBtn = isGrp ? wechatGroupAddBtn : wechatIndividualAddBtn;
  const clearBtn = isGrp ? wechatGroupClearBtn : wechatIndividualClearBtn;
  const set = isGrp ? selectedGroups : selectedIndividuals;

  searchInput.addEventListener('input', () => {
    renderCandidates(type);
  });

  const addItem = () => {
    const text = (searchInput.value || '').trim();
    if (!text) return;
    set.add(text);
    searchInput.value = '';
    renderBadges(type);
    renderCandidates(type);
  };

  addBtn.addEventListener('click', addItem);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addItem();
    }
  });

  clearBtn.addEventListener('click', () => {
    set.clear();
    renderBadges(type);
    renderCandidates(type);
  });
}

bindPickerEvents('individual');
bindPickerEvents('group');

function syncSelectedFromSessions() {
  function upgradeSet(set, isGrp) {
    const items = Array.from(set);
    for (const item of items) {
      if (!isGrp && isSystemOrOfficialAccount(item)) {
        set.delete(item);
        continue;
      }
      for (const s of fetchedSessions) {
        if (Boolean(s.isGroup) === isGrp && s.username === item) {
          const dName = getChatDisplayName(s);
          if (dName && dName !== item) {
            set.delete(item);
            set.add(dName);
          }
          break;
        }
      }
    }
  }
  upgradeSet(selectedIndividuals, false);
  upgradeSet(selectedGroups, true);
  renderBadges('individual');
  renderBadges('group');
  renderCandidates('individual');
  renderCandidates('group');
}

async function loadWechatSessions() {
  try {
    const data = await fetchWechatJson('/sessions?limit=500', { cache: 'no-store' });
    if (data && data.ok && Array.isArray(data.chats)) {
      fetchedSessions = data.chats;
      syncSelectedFromSessions();
    }
  } catch (e) {
    // 微信未启动或未准备好，静默忽略
  }
}

function applyWechatForm(cfg) {
  const w = normalizeWechat(cfg);
  wechatEnabledInput.checked = w.enabled;

  selectedIndividuals.clear();
  for (const item of w.individuals.list || []) {
    const t = String(item || '').trim();
    if (t && !isSystemOrOfficialAccount(t)) {
      selectedIndividuals.add(t);
    }
  }
  renderBadges('individual');
  renderCandidates('individual');

  selectedGroups.clear();
  for (const item of w.groups.list || []) {
    const t = String(item || '').trim();
    if (t) selectedGroups.add(t);
  }
  renderBadges('group');
  renderCandidates('group');

  wechatGroupRequireAtInput.checked = w.groupRequireAt;
  wechatAutoDraftEnabledInput.checked = w.autoDraft.mode !== 'none';
  wechatAutoReplyInput.checked = w.autoReply;
  wechatSkipSubscriptionsInput.checked = w.skipSubscriptions;
  wechatSkipFoldedInput.checked = w.skipFolded;
  wechatFoldedListInput.value = listToLines(w.folded);
  wechatBubbleNewMessageInput.checked = w.bubbleNewMessage;
  wechatBubbleOverviewInput.checked = w.bubbleOverview;
  wechatDesktopNotifyInput.checked = w.desktopNotify;
  wechatStickerEchoInput.checked = w.stickerEcho;
  wechatPollIntervalInput.value = w.pollIntervalSec;
  wechatDraftCooldownInput.value = w.draftCooldownSec;
  wechatDraftMaxPerHourInput.value = w.draftMaxPerHour;
  wechatHistoryLimitInput.value = w.historyLimit;
  wechatOverviewCountInput.value = w.overviewCount;
  wechatDraftPromptInput.value = w.draftPrompt;

  updateWechatEnabledState();
  loadWechatSessions();
}

/** 读取表单 → saveSettings payload 里的 wechat 字段（整块覆盖写用户配置） */
function readWechatForm() {
  const indList = Array.from(selectedIndividuals);
  const grpList = Array.from(selectedGroups);
  const draftOn = wechatAutoDraftEnabledInput.checked;

  return {
    enabled: wechatEnabledInput.checked,
    individuals: {
      mode: indList.length > 0 ? 'whitelist' : 'none',
      list: indList,
    },
    groups: {
      mode: grpList.length > 0 ? 'whitelist' : 'none',
      list: grpList,
    },
    groupRequireAt: wechatGroupRequireAtInput.checked,
    autoDraft: {
      mode: draftOn ? 'all' : 'none',
      list: [],
    },
    autoReply: wechatAutoReplyInput.checked,
    skipSubscriptions: wechatSkipSubscriptionsInput.checked,
    skipFolded: wechatSkipFoldedInput.checked,
    folded: linesToList(wechatFoldedListInput.value),
    bubbleNewMessage: wechatBubbleNewMessageInput.checked,
    bubbleOverview: wechatBubbleOverviewInput.checked,
    desktopNotify: wechatDesktopNotifyInput.checked,
    stickerEcho: wechatStickerEchoInput.checked,
    pollIntervalSec: clampNum(wechatPollIntervalInput.value, 2, 600, WECHAT_DEFAULTS.pollIntervalSec),
    draftCooldownSec: clampNum(wechatDraftCooldownInput.value, 0, 86400, WECHAT_DEFAULTS.draftCooldownSec),
    draftMaxPerHour: clampNum(wechatDraftMaxPerHourInput.value, 0, 600, WECHAT_DEFAULTS.draftMaxPerHour),
    historyLimit: clampNum(wechatHistoryLimitInput.value, 2, 2000, WECHAT_DEFAULTS.historyLimit),
    overviewCount: clampNum(wechatOverviewCountInput.value, 1, 20, WECHAT_DEFAULTS.overviewCount),
    draftPrompt: wechatDraftPromptInput.value.trim() || WECHAT_DEFAULTS.draftPrompt,
  };
}

/** 数据通道：写状态行（cls = '' | 'ok' | 'warn' | 'err'） */
function setWechatStatus(text, cls) {
  if (!wechatStatusEl) return;
  wechatStatusEl.className = 'wechat-detail' + (cls ? ' ' + cls : '');
  wechatStatusEl.textContent = text;
}

/** 把 /wechat/status 的返回说成人话 */
function describeWechatStatus(data) {
  if (!data || typeof data !== 'object') {
    return { text: '❔ 没拿到状态：数据通道还没接好（/wechat/status 无响应）。', cls: 'warn' };
  }
  const helper = data.helper && typeof data.helper === 'object' ? data.helper : {};
  const state = String(helper.state || 'unknown');
  const lines = [];

  if (helper.lastError && state === 'error') {
    lines.push('❌ 助手进程异常：' + helper.lastError);
  }
  if (state === 'stopped') {
    lines.push('💤 助手进程还没启动（开启联动并重启桌宠后会自动拉起）。');
  } else if (helper.pythonVersion) {
    const envTag = helper.isEmbedded ? '内置便携版 (免安装独立环境)' : '系统环境';
    lines.push('🐍 Python ' + helper.pythonVersion + ' (' + envTag + ') · 助手状态：' + state);
  } else if (state === 'unknown') {
    lines.push('❔ 拿不到助手进程状态：数据通道可能还没接好。');
  }

  if (data.ready && (helper.keyCount || 0) > 0) {
    lines.push('✅ 数据通道正常：已就绪 ' + helper.keyCount + ' 个数据库密钥。');
  } else if (helper.hasKeys) {
    lines.push('🔑 已经抓到 ' + (helper.keyCount || 0) + ' 个密钥，但助手还没就绪（等它启动完再检测一次）。');
  } else {
    lines.push('🔑 还没抓到数据库密钥 —— 点「一键抓取密钥」（需要微信正在运行）。');
  }
  if (helper.wechatRunning === false) {
    lines.push('⚠️ 当前没检测到微信在运行，密钥抓取会失败。');
  } else if (helper.wechatRunning === true) {
    lines.push('💬 微信正在运行。');
  }
  if (helper.stateDir) lines.push('📁 密钥目录：' + helper.stateDir);

  let cls = 'ok';
  if (state === 'error' || state === 'stopped') cls = 'err';
  else if (!helper.hasKeys || helper.wechatRunning === false) cls = 'warn';
  return { text: lines.join('\n'), cls };
}

async function fetchWechatJson(path, init) {
  const res = await fetch(WECHAT_BRIDGE + path, init);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

/** 「检测状态」 */
async function refreshWechatStatus(manual) {
  if (manual) setWechatStatus('⏳ 正在检测…', '');
  try {
    const data = await fetchWechatJson('/status', { cache: 'no-store' });
    const info = describeWechatStatus(data);
    setWechatStatus(info.text, info.cls);
    if (data && data.ok) {
      loadWechatSessions();
    }
  } catch (e) {
    // 静默探测（打开设置页时的那一次）失败不必吓人：助手进程往往是按需才启动的
    if (!manual) {
      console.warn('wechat status probe failed:', e);
      return;
    }
    setWechatStatus(
      '❌ 检测失败：' + (e && e.message ? e.message : String(e)) + '\n（数据通道尚未就绪，或桌宠助手没在运行）',
      'err',
    );
  }
}

const WECHAT_INIT_REASON = {
  no_db_dir: '没找到微信数据目录：确认微信登录过、且数据目录没被移动。',
  weixin_not_running: '微信没在运行：先登录微信，再点一次「一键抓取密钥」。',
  extract_failed:
    '没能从微信进程里拿到密钥：当前微信版本可能已加固（4.1.10 之后内存里不再驻留密钥），' +
    '需要在旧版本抓一次，或参考 README 的说明。',
  config_write_failed: '密钥拿到了但配置写入失败，检查 ~/.wechat-cli/ 是否可写。',
};

/** 「一键抓取密钥」：耗时可达数十秒，期间禁用按钮 */
async function runWechatInit() {
  btnWechatInit.disabled = true;
  const original = btnWechatInit.textContent;
  btnWechatInit.textContent = '⏳ 正在抓取…';
  setWechatStatus('⏳ 正在从微信进程提取数据库密钥…（需要微信保持登录运行，最长可能要一两分钟）', '');
  try {
    const data = await fetchWechatJson('/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (data && data.ok) {
      const lines = ['✅ 抓取成功：' + (data.keyCount || 0) + ' 个数据库密钥。'];
      if (data.dbDir) lines.push('📁 数据目录：' + data.dbDir + (data.source ? '（' + data.source + '）' : ''));
      setWechatStatus(lines.join('\n'), 'ok');
    } else {
      const reason = (data && data.reason) || 'unknown';
      const lines = ['❌ 抓取失败：' + (WECHAT_INIT_REASON[reason] || (data && data.message) || reason)];
      if (data && data.message && WECHAT_INIT_REASON[reason]) lines.push('细节：' + data.message);
      if (data && Array.isArray(data.log) && data.log.length) {
        lines.push('日志末尾：' + data.log.slice(-3).join(' / '));
      }
      setWechatStatus(lines.join('\n'), 'err');
    }
  } catch (e) {
    setWechatStatus('❌ 抓取失败：' + (e && e.message ? e.message : String(e)), 'err');
  } finally {
    btnWechatInit.disabled = false;
    btnWechatInit.textContent = original;
  }
}

wechatEnabledInput.addEventListener('change', () => {
  updateWechatEnabledState();
});

btnWechatPromptReset.addEventListener('click', () => {
  wechatDraftPromptInput.value = WECHAT_DEFAULTS.draftPrompt;
  wechatDraftPromptInput.focus();
});

btnWechatStatus.addEventListener('click', () => {
  refreshWechatStatus(true);
});

btnWechatInit.addEventListener('click', () => {
  runWechatInit();
});

/** 渲染蒸馏结果与标签 */
function renderDistilledResult(distilled) {
  if (!distilled || !distilled.stats) {
    wechatDistillResultEl.style.display = 'none';
    return;
  }
  latestDistilled = distilled;
  wechatDistillResultEl.style.display = 'block';

  const { updatedAt, sampleCount, scannedSessions, stats, personaText } = distilled;

  distillMetaInfoEl.textContent = `📅 上次蒸馏：${updatedAt || '刚刚'} · 抽取真实发言：${sampleCount || 0} 条 · 跨越会话：${scannedSessions || 0} 个`;

  // 渲染特征药丸徽章
  distillTagsBarEl.innerHTML = '';
  const tags = [];
  if (stats.avgLength) tags.push(`📏 平均每句 ${stats.avgLength} 字`);
  if (stats.dotRate !== undefined) tags.push(stats.dotRate < 5 ? `🚫 句号极罕见 (${stats.dotRate}%)` : `📝 句号率 ${stats.dotRate}%`);
  if (stats.spaceRate > 15) tags.push(`␣ 常用空格断句 (${stats.spaceRate}%)`);
  if (Array.isArray(stats.topEmojis) && stats.topEmojis.length) {
    tags.push(`🔥 常用表情: ${stats.topEmojis.slice(0, 4).join(' ')}`);
  }
  if (Array.isArray(stats.topWords) && stats.topWords.length) {
    tags.push(`💬 口语偏好: ${stats.topWords.slice(0, 4).join('、')}`);
  }

  for (const tagText of tags) {
    const span = document.createElement('span');
    span.className = 'distill-tag';
    span.textContent = tagText;
    distillTagsBarEl.appendChild(span);
  }

  wechatDistillPersonaText.value = personaText || '';
}

/** 页面加载时拉取上次蒸馏的缓存状态 */
async function loadDistilledState() {
  try {
    const res = await fetchWechatJson('/distill', { cache: 'no-store' });
    if (res && res.ok && res.distilled) {
      renderDistilledResult(res.distilled);
    }
  } catch (e) {
    console.warn('loadDistilledState error:', e);
  }
}

/** 执行一键蒸馏 */
async function runWechatDistill() {
  const limitVal = Math.max(50, Math.min(3000, Number(wechatDistillLimitInput.value) || 500));
  btnWechatDistill.disabled = true;
  const originalText = btnWechatDistill.textContent;
  btnWechatDistill.textContent = '⏳ 正在蒸馏主人打字风格…';

  wechatDistillStatusEl.style.display = 'block';
  wechatDistillStatusEl.className = 'wechat-distill-status info';
  wechatDistillStatusEl.textContent = `⏳ 正在从本地微信数据库扫描真实发言（上限 ${limitVal} 条），并调用 DeepSeek 进行风格深度画像…（通常需要 10~25 秒）`;

  try {
    const res = await fetchWechatJson('/distill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: limitVal }),
    });

    if (res && res.ok && res.distilled) {
      renderDistilledResult(res.distilled);
      wechatDistillStatusEl.className = 'wechat-distill-status ok';
      wechatDistillStatusEl.textContent = `✅ 蒸馏成功！基于 ${res.distilled.sampleCount} 条真实发言成功生成主人的语言指纹设定。点击下方「✨ 应用到下方起草 Prompt」即可生效！`;
    } else {
      wechatDistillStatusEl.className = 'wechat-distill-status err';
      const msg = res?.message || res?.reason || '未知错误';
      wechatDistillStatusEl.textContent = `❌ 蒸馏失败：${msg}`;
    }
  } catch (e) {
    wechatDistillStatusEl.className = 'wechat-distill-status err';
    wechatDistillStatusEl.textContent = `❌ 蒸馏请求异常：${e?.message || String(e)}`;
  } finally {
    btnWechatDistill.disabled = false;
    btnWechatDistill.textContent = originalText;
  }
}

btnWechatDistill.addEventListener('click', () => {
  runWechatDistill();
});

btnApplyDistillPrompt.addEventListener('click', () => {
  if (!latestDistilled || !latestDistilled.suggestedPrompt) {
    alert('暂无蒸馏生成的起草 Prompt');
    return;
  }
  wechatDraftPromptInput.value = latestDistilled.suggestedPrompt;
  wechatDraftPromptInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  wechatDraftPromptInput.focus();
  wechatDraftPromptInput.style.transition = 'box-shadow 0.3s';
  wechatDraftPromptInput.style.boxShadow = '0 0 0 3px #6366f1';
  setTimeout(() => {
    wechatDraftPromptInput.style.boxShadow = '';
  }, 1500);

  wechatDistillStatusEl.style.display = 'block';
  wechatDistillStatusEl.className = 'wechat-distill-status ok';
  wechatDistillStatusEl.textContent = '✨ 已将专属人设 Prompt 填入下方起草提示词框中，请点击底部「保存并生效」！';
});

/* ==================== 微信联动 END ==================== */

// 1. 初始化加载配置
async function loadSettings() {
  if (!window.settingsBridge) {
    console.error('settingsBridge not found');
    return;
  }
  try {
    currentConfig = await window.settingsBridge.getSettings();
    applyFormValues(currentConfig);
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
  // 静默探一次数据通道状态（只读；绝不自动触发 /wechat/init，抓密钥只由用户点击发起）
  refreshWechatStatus(false);
  // 加载已有的人设蒸馏成果
  loadDistilledState();
}

function applyFormValues(cfg) {
  apiKeyInput.value = cfg.apiKey || '';
  baseUrlInput.value = cfg.baseUrl || 'https://api.deepseek.com';
  modelInput.value = cfg.model || 'deepseek-chat';

  const firstPet = (cfg.pets && cfg.pets[0]) || {};
  const size = Number(firstPet.size) || 462;
  petSizeInput.value = size;
  sizeVal.textContent = size + ' px';

  const whisperOn = Boolean(firstPet.whisperEnabled);
  whisperEnabledInput.checked = whisperOn;
  whisperIntervalGroup.style.display = whisperOn ? 'block' : 'none';

  const interval = (firstPet.eventsRefreshSec && firstPet.eventsRefreshSec.whisper) || 300;
  whisperIntervalInput.value = interval;

  whisperImageEnabledInput.checked = Boolean(cfg.whisperImageEnabled);
  chatImageEnabledInput.checked = Boolean(cfg.chatImageEnabled);

  whisperPromptInput.value = cfg.whisperPrompt || '你是主人桌面上的Q版小女仆，用简短可爱温柔的口吻说话。20字以内。';

  autoStartEnabledInput.checked = Boolean(cfg.autoStart);

  applyWechatForm(cfg.wechat);
}

// 2. 交互事件监听
// 显示/隐藏 API Key
toggleApiKeyBtn.addEventListener('click', () => {
  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
    toggleApiKeyBtn.textContent = '🔒';
  } else {
    apiKeyInput.type = 'password';
    toggleApiKeyBtn.textContent = '👁️';
  }
});

// 快速填入模型
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    modelInput.value = chip.getAttribute('data-model');
  });
});

// 滑块数值反馈
petSizeInput.addEventListener('input', (e) => {
  sizeVal.textContent = e.target.value + ' px';
});

// 微信自动回复勾选联动：若当前起草开关为关闭，自动开启起草
if (wechatAutoReplyInput) {
  wechatAutoReplyInput.addEventListener('change', (e) => {
    if (e.target.checked && wechatAutoDraftEnabledInput && !wechatAutoDraftEnabledInput.checked) {
      wechatAutoDraftEnabledInput.checked = true;
    }
  });
}

// 碎碎念开关控制间隔选项
whisperEnabledInput.addEventListener('change', (e) => {
  whisperIntervalGroup.style.display = e.target.checked ? 'block' : 'none';
});

// 测试连接
btnTest.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  const baseUrl = baseUrlInput.value.trim();
  const model = modelInput.value.trim();

  if (!apiKey) {
    testStatus.textContent = '❌ 请先输入 API Key';
    testStatus.className = 'test-status error';
    return;
  }

  testStatus.textContent = '⏳ 测试连接中...';
  testStatus.className = 'test-status loading';
  btnTest.disabled = true;

  try {
    const res = await window.settingsBridge.testConnection({ apiKey, baseUrl, model });
    if (res.ok) {
      testStatus.textContent = '✅ ' + res.message;
      testStatus.className = 'test-status success';
    } else {
      testStatus.textContent = '❌ ' + res.message;
      testStatus.className = 'test-status error';
    }
  } catch (e) {
    testStatus.textContent = '❌ 发生异常: ' + (e.message || String(e));
    testStatus.className = 'test-status error';
  } finally {
    btnTest.disabled = false;
  }
});

// 保存设置
btnSave.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  const baseUrl = baseUrlInput.value.trim() || 'https://api.deepseek.com';
  const model = modelInput.value.trim() || 'deepseek-chat';
  const size = Number(petSizeInput.value) || 462;
  const whisperEnabled = whisperEnabledInput.checked;
  const whisperInterval = Math.max(10, Number(whisperIntervalInput.value) || 300);
  const whisperImageEnabled = whisperImageEnabledInput.checked;
  const chatImageEnabled = chatImageEnabledInput.checked;
  const whisperPrompt = whisperPromptInput.value.trim();
  const autoStart = autoStartEnabledInput.checked;

  const pets =
    currentConfig.pets && currentConfig.pets.length > 0
      ? currentConfig.pets.map((p, idx) => ({
          ...p,
          size: idx === 0 ? size : p.size,
          whisperEnabled: idx === 0 ? whisperEnabled : p.whisperEnabled,
          eventsRefreshSec: {
            ...(p.eventsRefreshSec || {}),
            whisper: idx === 0 ? whisperInterval : (p.eventsRefreshSec && p.eventsRefreshSec.whisper) || 300,
          },
        }))
      : [
          {
            id: 'main',
            size,
            whisperEnabled,
            display: 'desktop',
            eventsRefreshSec: { whisper: whisperInterval },
          },
        ];

  const payload = {
    apiKey,
    baseUrl,
    model,
    whisperPrompt,
    whisperImageEnabled,
    chatImageEnabled,
    autoStart,
    pets,
    wechat: readWechatForm(),
  };

  btnSave.disabled = true;
  saveStatus.textContent = '正在保存...';

  try {
    await window.settingsBridge.saveSettings(payload);
    currentConfig = { ...currentConfig, ...payload };
    saveStatus.textContent = '✅ 保存成功！已同步至桌宠';
    setTimeout(() => {
      saveStatus.textContent = '';
    }, 3000);
  } catch (e) {
    saveStatus.textContent = '❌ 保存失败: ' + (e.message || String(e));
  } finally {
    btnSave.disabled = false;
  }
});

// 重置默认
btnReset.addEventListener('click', () => {
  if (confirm('确定要恢复默认配置吗？（已填写的 API 密钥不会丢失）')) {
    const keepApiKey = apiKeyInput.value;
    applyFormValues({
      apiKey: keepApiKey,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      whisperImageEnabled: false,
      chatImageEnabled: false,
      autoStart: false,
      whisperPrompt: '你是主人桌面上的Q版小女仆，用简短可爱温柔的口吻说话。20字以内。',
      pets: [{ id: 'main', size: 462, whisperEnabled: false, eventsRefreshSec: { whisper: 300 } }],
      // 微信联动一并回落内置默认值（enabled=false、autoDraft=none、名单清空…）
      wechat: normalizeWechat(WECHAT_DEFAULTS),
    });
  }
});

// 启动执行
loadSettings();
