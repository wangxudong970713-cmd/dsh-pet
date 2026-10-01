/**
 * dsh-pet desktop helper —— 事件联动（余额 / 碎碎念 / 广播 / 工作状态）。
 *
 * 展示与 tick 回调经 PetSprite.prototype 挂载（运行时可解析，顺序无碍）；
 * startLoops 是全部轮询的组装入口（boot 后调用）。依赖 constants.js / sprite.js。
 */
'use strict';

// ---- 工作状态联动（DSH 会话状态，每只宠物按 workStatusEnabled 门控；容器 1s 轮询，ts 变化才递增 tick）----
// 气泡驻留语义与浏览器一致：thinking/working/result/waiting（"事情还没完"）常驻直到状态切走；
//   success/error（"这事结束了"）10s 自动收起；state=null（空闲/回合被打断）收起气泡回待机。
// 动画循环语义：进行中档位循环播（switchTo once=false），终态档位播一遍回 idle 链。
PetSprite.prototype.onWorkTick = function onWorkTick(snapshot, tick) {
  if (!this.pet.workStatusEnabled) return; // 未启用工作状态联动 -> 该宠物完全免疫（与浏览器一致）
  if (tick === 0 || tick === this.prevWorkTick) return;
  this.prevWorkTick = tick;
  const state = snapshot && snapshot.state ? snapshot.state : null;
  this.workState = state; // 当前工作状态：互动/事件动画播完恢复档位循环用（与浏览器 workStatusRef 同用途）
  const stateChanged = this.prevWorkState !== state;
  this.prevWorkState = state;
  if (!state) {
    // 空闲：收起常驻气泡（动画不处理，由常规动画链回待机）
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = null;
    this.workOn = false;
    this.workText = null;
    this.renderBubble();
    return;
  }
  const pool = this.animations.events?.workStatus;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.workStatus，无法播放工作状态动画');
    return;
  }
  const idx = S.WORK_STATUS_INDEX[state];
  const slot = pool[idx];
  if (slot === undefined) {
    console.error('[dsh-pet] work-status 档位索引越界：state=' + state + ' idx=' + idx);
    return;
  }
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' workStatus pet=' +
      this.pet.id +
      ' state=' +
      state +
      ' -> [' +
      idx +
      '] ' +
      name,
  );
  this.stopMove();
  // 气泡文本：任务详情（todo/write 提供）优先，否则从条目级 workStatusTexts[档位]（数组）随机抽一句；
  // 整字段/整档缺失 = 不弹文本，只播动画（与浏览器同一语义）。
  const textGroup = Array.isArray(this.pet.workStatusTexts) ? this.pet.workStatusTexts[idx] : undefined;
  const configuredText =
    Array.isArray(textGroup) && textGroup.length > 0
      ? textGroup[Math.floor(Math.random() * textGroup.length)]
      : undefined;
  this.workText = (snapshot && snapshot.task) || configuredText || null;
  const terminal = state === 'success' || state === 'error';
  // 气泡点亮/收起只在状态变化时动作：同状态后续 tick（todo 文案更新、其它会话事件搅动 ts）
  // 不重新点亮**已自动收起的终态气泡**——否则"任务完成"的气泡会被后续 ts 变化反复弹回（Bug 2，
  // 与浏览器 workBubbleOn 同一语义）。
  if (stateChanged) {
    this.workOn = true;
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = terminal
      ? window.setTimeout(() => {
          this.workOn = false;
          this.renderBubble();
        }, BUBBLE_DURATION_MS)
      : null; // 非终态：常驻，不设自动收起
  }
  this.renderBubble();
  // 循环语义（与浏览器 setOnce 一致）：终态播一遍回 idle；非终态多候选档位播一遍 →
  // ended 由 sprite.handleEnded 轮换到下一候选（长时间状态不单段重复）；非终态单候选档位无限循环。
  const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
  if (terminal || rotating) this.playOnce(name);
  else this.switchTo(name, false); // 进行中循环播（单动画/单候选档位）
};

// ---- 余额事件（每只宠物按 balanceEnabled 门控；档位与气泡内容来自 shared） ----
PetSprite.prototype.onBalanceTick = function onBalanceTick(state, tick) {
  if (!this.pet.balanceEnabled) return; // 未启用余额功能 -> 该宠物对余额事件完全免疫（与浏览器一致）
  if (tick === 0 || tick === this.prevTick) return;
  this.prevTick = tick;
  this.showBalanceNow(state);
};

// 余额不可用（服务商未登记 / 缺凭证 / 抓取失败）：只弹**文字说明**气泡，不播档位动画
// （非 ok 没有百分比语义，档位动画无从映射）。显隐/定时与成功路径同一套（10s 自动消失）；
// 不 stopMove——本次没有动画要抢前台，宠物没必要停下漫游。
PetSprite.prototype.showBalanceNotice = function showBalanceNotice(state) {
  if (!this.pet.balanceEnabled) return; // 门控与成功路径一致（未启用余额的宠物完全免疫）
  if (!state || state.ok) return;
  this.bubbleOn = true;
  this.balanceWrap = true; // 文字说明可能多行：renderBubble 据此套用换行变体（默认 nowrap 会顶出宠物宽度）
  this.balanceView = S.balanceBubbleView(state);
  this.renderBubble();
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
};

// ---- 碎碎念（每只宠物独立：按 eventsRefreshSec.whisper 周期轮询自己的句子，用本种类人设生成） ----
PetSprite.prototype.startWhisperLoop = function startWhisperLoop() {
  if (!this.pet.whisperEnabled || this.whisperLoopTimer !== null) return;
  const intervalMs = Math.max(1000, (this.pet.eventsRefreshSec?.whisper ?? 3600) * 1000);
  const refresh = async () => {
    try {
      const petId = encodeURIComponent(this.pet.id);
      const state = await S.fetchWhisperState(WHISPER_URL + '?pet=' + petId);
      if (!this.whisperBaseline) {
        this.whisperBaseline = true; // 首次仅记基线：避免启动/刷新时重放历史事件
        if (state.ok) {
          this.prevWhisperTs = state.ts;
          this.whisperText = state.text;
        }
        return;
      }
      if (!state.ok) {
        console.warn(
          '[dsh-pet] 碎碎念生成失败 pet=' +
            this.pet.id +
            ' reason=' +
            state.reason +
            (state.message ? ' ' + state.message : ''),
        );
        return;
      }
      if (state.ts !== this.prevWhisperTs) {
        this.prevWhisperTs = state.ts;
        this.whisperText = state.text;
        this.showWhisper(state.text, state.image);
      }
    } catch (e) {
      console.warn('[dsh-pet] 碎碎念拉取异常 pet=' + this.pet.id, e);
    }
  };
  this.whisperLoopTimer = window.setInterval(() => void refresh(), intervalMs);
  void refresh();
};

// 命令触发气泡（/chat 斜杠命令）：1s 轻量轮询 /broadcast?pet=<id>，ts 变化即弹气泡。
// 与碎碎念周期轮询独立（host 广播缓存是另一条通道）：手动触发语义不受 whisperEnabled 门控
PetSprite.prototype.startBroadcastLoop = function startBroadcastLoop() {
  if (this.broadcastLoopTimer !== null) return;
  const refresh = async () => {
    try {
      const petId = encodeURIComponent(this.pet.id);
      const res = await fetch(BASE + '/broadcast' + '?pet=' + petId, { cache: 'no-store' });
      if (!res.ok) return;
      const d = (await res.json().catch(() => null)) || {};
      const ts = typeof d.ts === 'number' ? d.ts : 0;
      if (!this.broadcastBaseline) {
        // 首拉无条件记基线（含 ts=0）：若 ts=0 提前 return 会跳过基线建立，
        // 导致第一条命令广播被当成基线吃掉（该条永不弹）
        this.broadcastBaseline = true;
        this.prevBroadcastTs = ts;
        return;
      }
      if (ts === 0 || ts === this.prevBroadcastTs) return; // 无广播 / 无变化
      this.prevBroadcastTs = ts;
      if (typeof d.text === 'string' && d.text) {
        // image：host 侧抽定/模型选定的配图名（未开配图则 undefined）——与 /whisper 同契约
        this.showWhisper(d.text, typeof d.image === 'string' ? d.image : '');
      }
    } catch (e) {
      console.warn('[dsh-pet] 广播拉取异常 pet=' + this.pet.id, e);
    }
  };
  this.broadcastLoopTimer = window.setInterval(() => void refresh(), 1000);
  void refresh();
};

// 通用「事件气泡」：碎碎念与微信提醒共用同一条展示路径（同一个 events.whisper 动画池 + 10s 文本气泡）。
// tag 只影响日志前缀，便于排障时区分来源。
// copy：可选的「点击即复制」正文（微信草稿用）。非空时气泡加一行提示、并接收指针事件（见 sprite.renderBubble）。
PetSprite.prototype.showEventBubble = function showEventBubble(text, image, tag, copy) {
  const pool = this.animations.events?.whisper;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.whisper，无法播放事件动画');
    return;
  }
  // 整池随机抽 1 槽（避开当前正播动画，避免连续重复）；槽位若为数组候选再档内随机（与浏览器一致）
  const name = S.pickSlot(S.pick(pool, this.anim), this.anim);
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' ' +
      tag +
      ' pet=' +
      this.pet.id +
      ' -> [' +
      name +
      '] 「' +
      text +
      '」' +
      (image ? ' [' + image + ']' : '') +
      (copy ? ' [可复制 ' + copy.length + ' 字]' : ''),
  );
  this.stopMove();
  this.whisperOn = true;
  this.whisperView = S.whisperBubbleView({ ok: true, text, ts: 0 });
  this.whisperImage = typeof image === 'string' ? image : '';
  // 可复制正文（无则空串）：气泡据此变可点击。开新气泡前先复位上一轮的悬停/已复制状态，
  // 否则鼠标还停在旧位置上会留下一个"能点但没内容"的穿透死角。
  this.whisperCopy = typeof copy === 'string' ? copy : '';
  this.bubbleCopyDone = false;
  if (this.bubbleCopyTimer !== null) {
    window.clearTimeout(this.bubbleCopyTimer);
    this.bubbleCopyTimer = null;
  }
  this.onBubbleCopyHover(false);
  this.renderBubble();
  // 气泡 10s 定时消失（与动画解耦，与余额同一语义；重复触发先清旧定时器）
  if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
  this.whisperTimer = window.setTimeout(() => {
    this.whisperOn = false;
    this.whisperCopy = '';
    this.bubbleCopyDone = false;
    this.onBubbleCopyHover(false);
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
  this.playOnce(name);
};

// 碎碎念展示（本宠物）：随机抽 events.whisper 动画 + 弹文本气泡（10s 消失，与余额同一语义）
// image：host 随机抽定的配图名称（未开配图/池为空则空串，与浏览器端同一契约）
PetSprite.prototype.showWhisper = function showWhisper(text, image) {
  return this.showEventBubble(text, image, 'whisper');
};

// 微信新消息/概览提醒：复用同一气泡通道，日志前缀区分来源（只读提醒，永不代表主人发送）
// copy：草稿类气泡传草稿正文 → 气泡可点击复制到剪贴板（仍只写剪贴板，没有发送路径）
PetSprite.prototype.showWechatNotice = function showWechatNotice(text, image, copy) {
  return this.showEventBubble(text, image, 'wechat', copy);
};

// 余额展示（档位动画 + 气泡）：周期轮询与菜单点播共用同一展示路径，视觉/行为严格一致
PetSprite.prototype.showBalanceNow = function showBalanceNow(state) {
  if (!state || !state.ok) return;
  const p = S.balancePercent(state);
  if (p === undefined) return; // 当前数据源没有百分比语义：不触发档位动画
  const pool = this.animations.events?.balance;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画');
    return;
  }
  const idx = S.balanceEventIndex(p);
  const slot = pool[idx];
  if (!slot) {
    console.error('[dsh-pet] balance 档位索引越界：p=' + p + ' idx=' + idx);
    return;
  }
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）
  this.stopMove();
  this.bubbleOn = true;
  this.balanceWrap = false; // 正常余额气泡是单行（nowrap），别继承上一次文字说明的换行变体
  this.balanceView = S.balanceBubbleView(state);
  this.renderBubble();
  // 气泡 10s 定时消失（与动画解耦：即使动画被点击/拖拽打断，气泡也按时收起；重复触发先清旧定时器）
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
  this.playOnce(name);
};

// ---------- 轮询组装（容器统一拉取/触发，与浏览器 PetMulti 同一套路径；boot 成功后调用） ----------

// 余额不可用 → 文字说明气泡（周期轮询与手动 /balance 触发共用这一条路径；判定在 shared，与浏览器同一份）：
// explicit=true（手动触发）一律弹——用户问了就该有答复，包括"服务商不支持"这件事；
// 自动轮询仅在原因（含服务商）变化时弹一次，避免每 30 分钟反复刷同一句话。
function applyBalanceNotice(state, explicit) {
  const notice = S.decideBalanceNotice(state, balanceNoticeKey, explicit);
  balanceNoticeKey = notice.key;
  if (notice.show) for (const s of sprites) s.showBalanceNotice(state);
  // 未登记服务商是配置事实（已由气泡说明），不再刷 console；其余原因照旧显式报错，绝不伪造余额
  if (state.reason !== 'unsupported') {
    console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
  }
}

// ---------- 微信联动（桌面端专属；支持建议草稿与自动回复） ----------
//
// 数据链路：桌宠主进程 spawn 的 Python sidecar（wechat_cli_mcp.bridge）→ 主进程路由 → 这里轮询。
// 职责划分：本文件只做「轮询 + 调共享层纯函数 + 决定弹什么」；范围判定/文案/起草拼装全在 src/shared/wechat.ts。

const WECHAT_POLL_MIN_MS = 2000;
/** 桌宠本次启动的时间戳（Unix 秒），启动前的旧未读消息一律不起草 */
const petStartupSec = Math.floor(Date.now() / 1000);

/** 起草节流闸门：跨重启持久化到 `<userData>/dsh-pet/wechat-state.json`（/wechat/state 不透明 JSON）。 */
let wechatGate = null;
let wechatGateLoading = null;
/** 最近用过的表情包名（避免连续弹同一张）。 */
let wechatStickerRecent = [];
/** 表情包池缓存：`{ 名字: 描述 }`（pickStickerEcho 需要这个形状；/wechat/memes 给的是数组）。 */
let wechatMemes = null;
/** 今日概览每次启动只主动弹一次。 */
let wechatOverviewShown = false;
/** sidecar 不可用只报一次错，避免每 20s 刷屏。 */
let wechatErrorLogged = false;

async function fetchWechatJson(url, init) {
  try {
    const res = await fetch(url, init ? { cache: 'no-store', ...init } : { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function loadWechatGate() {
  if (wechatGate) return wechatGate;
  if (!wechatGateLoading) {
    wechatGateLoading = (async () => {
      const saved = await fetchWechatJson(WECHAT_STATE_URL);
      const raw = saved && saved.draftGate && typeof saved.draftGate === 'object' ? saved.draftGate : {};
      const lastDraftAt = {};
      if (raw.lastDraftAt && typeof raw.lastDraftAt === 'object') {
        for (const [k, v] of Object.entries(raw.lastDraftAt)) if (typeof v === 'number') lastDraftAt[k] = v;
      }
      const lastDraftMsgTs = {};
      if (raw.lastDraftMsgTs && typeof raw.lastDraftMsgTs === 'object') {
        for (const [k, v] of Object.entries(raw.lastDraftMsgTs)) if (typeof v === 'number') lastDraftMsgTs[k] = v;
      }
      wechatGate = {
        lastDraftAt,
        recentDrafts: Array.isArray(raw.recentDrafts) ? raw.recentDrafts.filter((t) => typeof t === 'number') : [],
        lastDraftMsgTs,
      };
      if (saved && Array.isArray(saved.stickerRecent)) {
        wechatStickerRecent = saved.stickerRecent.filter((n) => typeof n === 'string').slice(0, 12);
      }
      return wechatGate;
    })();
  }
  return wechatGateLoading;
}

async function saveWechatGate() {
  if (!wechatGate) return;
  await fetchWechatJson(WECHAT_STATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draftGate: wechatGate, stickerRecent: wechatStickerRecent }),
  });
}

async function loadWechatMemes() {
  if (wechatMemes) return wechatMemes;
  const data = await fetchWechatJson(WECHAT_MEMES_URL);
  const list = Array.isArray(data) ? data : data && Array.isArray(data.memes) ? data.memes : [];
  wechatMemes = {};
  for (const m of list) {
    if (m && typeof m.name === 'string' && typeof m.desc === 'string') wechatMemes[m.name] = m.desc;
  }
  return wechatMemes;
}

/** 表情包呼应：按对方消息文本挑一张最贴的（挑中就记入 recent，避免连弹同一张）。 */
async function wechatStickerFor(text) {
  if (!config.wechat?.stickerEcho) return '';
  const memes = await loadWechatMemes();
  const name = S.pickStickerEcho(String(text || ''), memes, wechatStickerRecent);
  if (!name) return '';
  wechatStickerRecent = [name, ...wechatStickerRecent.filter((n) => n !== name)].slice(0, 12);
  await saveWechatGate();
  return name;
}

/** 若干会话 → 一句气泡文案（单条带发送者，多条合并成一行）。 */
function wechatBubbleText(sessions) {
  if (sessions.length === 1) {
    const b = S.formatNewMessageBubble(sessions[0]);
    return b.title + '：' + b.text;
  }
  const lines = sessions.slice(0, 3).map((s) => {
    const b = S.formatNewMessageBubble(s);
    return b.title + '：' + b.text;
  });
  return sessions.length + ' 个会话有新消息｜' + lines.join('；') + (sessions.length > 3 ? '…' : '');
}

/** 今日概览气泡：谁找你最多 + 未读总数（数据来自 /wechat/overview，只扫最近若干会话）。 */
async function showWechatOverview() {
  const data = await fetchWechatJson(WECHAT_OVERVIEW_URL);
  if (!data || !data.ok) return;
  const top = (Array.isArray(data.today) ? data.today : [])
    .slice(0, 3)
    .map((t) => t.chat + ' ' + t.count)
    .join('、');
  const text =
    '今天 ' + (data.totalToday || 0) + ' 条消息 · 未读 ' + (data.unreadTotal || 0) + (top ? '｜最热闹：' + top : '');
  for (const s of sprites) s.showWechatNotice(text, '');
}

/**
 * 主动预生成一句建议回复（受 autoDraft 范围 + 冷却 + 每小时配额门控 + 启动时间门控）。
 * 只把「被允许会话」的最近若干条历史发给主人自己配置的大模型；生成结果上气泡，若开启 autoReply 则自动发送。
 */
async function maybeAutoDraft(sessions) {
  const cfg = config.wechat;
  if (!cfg || !cfg.enabled) return;
  if (cfg.autoDraft.mode === 'none' && !cfg.autoReply) return;
  const gate = await loadWechatGate();
  const nowSec = Math.floor(Date.now() / 1000);
  const target = S.pickDraftTarget(sessions, cfg, gate, nowSec, petStartupSec);
  if (!target) return;
  // 双重保险：早于桌宠启动时刻的消息一律不起草
  if (target.timestamp && target.timestamp < petStartupSec) return;

  // 先占闸门并记录本次处理的消息时间戳，防止下一轮重复触发
  gate.lastDraftAt[target.username] = nowSec;
  gate.recentDrafts = gate.recentDrafts.filter((t) => t > nowSec - 3600).concat(nowSec);
  if (!gate.lastDraftMsgTs) gate.lastDraftMsgTs = {};
  gate.lastDraftMsgTs[target.username] = target.timestamp || nowSec;

  const hist = await fetchWechatJson(
    WECHAT_HISTORY_URL + '?chat=' + encodeURIComponent(target.username) + '&limit=' + cfg.historyLimit,
  );
  if (!hist || !hist.ok || !Array.isArray(hist.messages) || hist.messages.length === 0) {
    await saveWechatGate();
    return;
  }
  // 检查最后一条消息是否是主人自己发的：如果是自己刚发的，无需生成起草建议
  const lastMsg = hist.messages[hist.messages.length - 1];
  const isLastFromSelf = lastMsg && (lastMsg.isSelf || lastMsg.label === (hist.selfLabel || 'me'));
  if (isLastFromSelf) {
    await saveWechatGate();
    return;
  }

  // 群聊 @ 门控：如果开启了 groupRequireAt，只有在群消息 @ 了主人时才起草
  if (target.isGroup && cfg.groupRequireAt) {
    const lastOtherMsg = [...hist.messages].reverse().find((m) => !m.isSelf && m.label !== (hist.selfLabel || 'me'));
    if (lastOtherMsg && !S.isGroupMentioned(lastOtherMsg.text, hist.selfLabel)) {
      await saveWechatGate();
      return;
    }
  }

  const messages = S.buildDraftMessages(target, hist.messages, hist.selfLabel || 'me');
  const system = S.buildDraftSystemPrompt(cfg, target, hist.messages.length);
  const out = await fetchWechatJson(LLM_COMPLETE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system, messages, maxTokens: 120, temperature: 0.8 }),
  });
  await saveWechatGate();
  if (!out || !out.ok) {
    const errText = (out && out.message) || '模型调用失败';
    console.warn('[dsh-pet] 起草失败：' + errText);
    for (const s of sprites) s.showWechatNotice('起草「' + target.chat + '」失败：' + errText, '');
    return;
  }
  const draft = S.cleanDraft(out.text);
  if (!draft) return;
  const image = await wechatStickerFor(target.lastMessage);

  if (cfg.autoReply && window.petBridge && typeof petBridge.sendAutoReply === 'function') {
    try {
      const sendRes = await petBridge.sendAutoReply({ chat: target.chat, text: draft });
      if (sendRes && sendRes.ok) {
        for (const s of sprites) s.showWechatNotice('已自动回复「' + target.chat + '」：' + draft, image, draft);
      } else {
        const rawErr = (sendRes && sendRes.error) || '发送失败';
        let errMsg = rawErr;
        if (rawErr.includes('WECHAT_NOT_FOUND')) errMsg = '未找到微信窗口，请确认微信已登录并在运行中';
        else if (rawErr.includes('CLIPBOARD')) errMsg = '剪贴板操作失败';
        for (const s of sprites) s.showWechatNotice('自动回复「' + target.chat + '」失败（' + errMsg + '）：' + draft, image, draft);
      }
    } catch (e) {
      for (const s of sprites) s.showWechatNotice('自动回复异常（' + (e.message || e) + '）：' + draft, image, draft);
    }
  } else {
    // 第四参 = 可复制正文（只有草稿本身，不含「给「X」的草稿：」前缀）→ 点击气泡即复制
    for (const s of sprites) s.showWechatNotice('给「' + target.chat + '」的草稿：' + draft, image, draft);
  }
}

async function pollWechatOnce() {
  const cfg = config.wechat;
  if (!cfg || !cfg.enabled) return;
  const res = await fetchWechatJson(WECHAT_POLL_URL);
  window.__dshPetDebug.lastWechatPollAt = Date.now();
  if (!res || !res.ok) {
    window.__dshPetDebug.lastWechatChanged = 0;
    window.__dshPetDebug.wechatError = (res && (res.message || res.reason)) || 'sidecar-unavailable';
    if (!wechatErrorLogged) {
      wechatErrorLogged = true;
      console.warn('[dsh-pet] 微信数据通道不可用（在设置里点「一键抓取密钥」）：' + window.__dshPetDebug.wechatError);
    }
    return;
  }
  wechatErrorLogged = false;
  window.__dshPetDebug.wechatError = '';
  const sessions = Array.isArray(res.sessions) ? res.sessions : [];
  const changed = (Array.isArray(res.changed) ? res.changed : []).filter((c) => S.isMonitoredChat(c, cfg));
  window.__dshPetDebug.lastWechatChanged = changed.length;

  // 启动后第一次成功轮询：弹一次今日概览（开关控制），不重放历史新消息
  if (!wechatOverviewShown) {
    wechatOverviewShown = true;
    if (cfg.bubbleOverview) await showWechatOverview();
  }

  if (!res.firstRun && changed.length > 0) {
    if (cfg.bubbleNewMessage) {
      const image = await wechatStickerFor(changed[changed.length - 1].lastMessage);
      for (const s of sprites) s.showWechatNotice(wechatBubbleText(changed), image);
    }
    if (cfg.desktopNotify && window.petBridge && typeof petBridge.notify === 'function') {
      for (const c of changed.slice(0, 3)) {
        const b = S.formatNewMessageBubble(c);
        petBridge.notify({ title: b.title, body: b.text });
      }
    }
  }

  await maybeAutoDraft(sessions);
}

function startWechatLoop() {
  const cfg = config.wechat;
  if (!cfg || !cfg.enabled) return;
  const intervalMs = Math.max(WECHAT_POLL_MIN_MS, (cfg.pollIntervalSec || 20) * 1000);
  const wechatLoop = async () => {
    try {
      await pollWechatOnce();
    } catch (e) {
      console.error('[dsh-pet] 微信轮询异常', e);
    }
    setTimeout(() => void wechatLoop(), intervalMs);
  };
  void wechatLoop();
}

function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;

  // 是否存在启用余额功能的宠物：全禁用时跳过余额轮询（不拉取，避免无意义的周期请求——与浏览器一致）
  const anyBalanceEnabled = sprites.some((s) => s.pet.balanceEnabled);

  // 余额周期轮询：eventsRefreshSec.balance（秒），成功递增 balanceTick 触发事件动画
  if (anyBalanceEnabled) {
    const intervalMs = Math.max(1000, (config.refreshSec?.balance ?? 1800) * 1000);
    const balanceLoop = async () => {
      try {
        const state = await S.fetchBalanceState(BALANCE_URL);
        balance = state;
        window.__dshPetDebug.lastBalanceOk = state && state.ok === true;
        if (state.ok) {
          balanceTick++;
          for (const s of sprites) s.onBalanceTick(state, balanceTick);
        } else {
          // 不可用：按 shared 的判定决定是否弹文字说明（自动轮询仅在原因变化时弹一次）
          applyBalanceNotice(state, false);
        }
      } catch (e) {
        console.error('[dsh-pet] 余额拉取异常', e);
      }
      setTimeout(() => void balanceLoop(), intervalMs);
    };
    void balanceLoop();
  }

  // 碎碎念：每只启用宠物独立轮询（startWhisperLoop）——各自周期、各自人设、各自一句话（与浏览器一致）
  for (const s of sprites) s.startWhisperLoop();
  // 命令触发气泡：每只宠物独立 1s 轻轮询（startBroadcastLoop）——/chat 命令写入即展示
  for (const s of sprites) s.startBroadcastLoop();

  // 微信联动：全局单条轮询（新消息气泡 / 桌面通知 / 主动起草），周期由 wechat.pollIntervalSec 决定
  startWechatLoop();

  // 手动 /balance 触发：1s 轻量轮询触发计数（端点已禁止缓存），计数变化且余额启用时立即刷新余额并递增 tick
  let triggerBaseline = null;
  const triggerLoop = async () => {
    try {
      const count = await S.fetchTriggerCount(TRIGGER_URL);
      if (count < 0) return;
      if (triggerBaseline === null) {
        triggerBaseline = count; // 首次仅记基线：避免启动时重放历史触发
      } else if (count !== triggerBaseline) {
        triggerBaseline = count;
        if (anyBalanceEnabled) {
          const state = await S.fetchBalanceState(BALANCE_URL);
          balance = state;
          if (state.ok) {
            balanceTick++;
            for (const s of sprites) s.onBalanceTick(state, balanceTick);
          } else {
            // 手动 /balance：显式请求，不可用也必弹文字说明
            applyBalanceNotice(state, true);
          }
        }
      }
    } catch {
      /* 轻量轮询失败静默：下一周期再试 */
    }
    setTimeout(() => void triggerLoop(), 1000);
  };
  if (anyBalanceEnabled) void triggerLoop();

  // 工作状态联动：任一宠物启用才轮询 /work-status（1s；避免无意义的周期请求——与浏览器一致）。
  // ts 变化（含回到空闲：host 在状态变化时更新 ts，切走 = 新 ts，用于收起常驻气泡）才递增 workTick →
  // 各启用宠物播档位动画+气泡；首拉仅记基线，启动/刷新不重放历史状态。
  const anyWorkStatusEnabled = sprites.some((s) => s.pet.workStatusEnabled);
  if (anyWorkStatusEnabled) {
    let workBaseline = null;
    const workLoop = async () => {
      try {
        const snap = await S.fetchWorkStatus(WORK_STATUS_URL);
        const ts = snap && typeof snap.ts === 'number' ? snap.ts : 0;
        if (workBaseline === null) {
          workBaseline = ts; // 首拉仅记基线
        } else if (ts !== workBaseline) {
          workBaseline = ts;
          workTick++;
          for (const s of sprites) s.onWorkTick(snap, workTick);
        }
      } catch {
        /* 轻量轮询失败静默：下一周期再试 */
      }
      setTimeout(() => void workLoop(), 1000);
    };
    void workLoop();
  }
}
