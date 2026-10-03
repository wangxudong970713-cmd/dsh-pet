/**
 * 微信共享契约测试 —— 钉住「只读联动」的判定语义：
 * - 范围/白名单：总开关、私聊/群聊分治、公众号与折叠会话过滤、通配名单；
 * - 文案整形：气泡标题/摘要的折叠与截断、概览聚合的排序与计数；
 * - 主动预生成：默认关闭、冷却、小时配额、候选人选择；
 * - 起草：历史 → 消息角色映射（主人=assistant）、系统提示词占位、输出清洗；
 * - 表情包呼应：CJK 滑窗与 ASCII 词打分、最近用过的排除。
 *
 * 跑法：node --experimental-strip-types --test src/shared/wechat.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WECHAT_CONFIG,
  EMPTY_DRAFT_GATE,
  buildDraftMessages,
  buildDraftSystemPrompt,
  buildOverview,
  cleanDraft,
  formatNewMessageBubble,
  formatSessionRow,
  isGroupMentioned,
  isMonitoredChat,
  isInternalChat,
  isSubscriptionChat,
  matchChatRule,
  normalizeList,
  normalizeWechatConfig,
  pickDraftTarget,
  pickStickerEcho,
  scopeAllows,
  sortSessions,
  summarizeLine,
  type WechatChatRef,
  type WechatConfig,
  type WechatDraftGate,
  type WechatSession,
} from './wechat.ts';

const chat = (username: string, name: string, isGroup = false): WechatChatRef => ({
  username,
  chat: name,
  isGroup,
});

const session = (over: Partial<WechatSession> = {}): WechatSession => ({
  username: 'wxid_a',
  chat: '小明',
  isGroup: false,
  unread: 0,
  lastMessage: '在吗',
  msgType: 1,
  sender: '',
  timestamp: 1000,
  ...over,
});

const cfg = (over: Partial<WechatConfig> = {}): WechatConfig => ({ ...DEFAULT_WECHAT_CONFIG, ...over });

describe('normalizeWechatConfig —— 配置收敛', () => {
  test('空输入落到默认值，且默认不开启联动、不主动起草', () => {
    const c = normalizeWechatConfig(undefined);
    assert.equal(c.enabled, false);
    assert.equal(c.autoDraft.mode, 'none');
    assert.equal(c.individuals.mode, 'all');
    assert.equal(c.skipSubscriptions, true);
    assert.equal(c.groupRequireAt, false);
    assert.equal(c.autoReply, false);
    assert.equal(c.pollIntervalSec, 20);
  });

  test('autoDraft 支持布尔值：true -> all, false -> none', () => {
    const c1 = normalizeWechatConfig({ autoDraft: true });
    assert.equal(c1.autoDraft.mode, 'all');
    assert.deepEqual(c1.autoDraft.list, []);
    const c2 = normalizeWechatConfig({ autoDraft: false });
    assert.equal(c2.autoDraft.mode, 'none');
  });

  test('数值越界被夹回合法区间（最小支持 2 秒轮询）', () => {
    const c = normalizeWechatConfig({ pollIntervalSec: 1, historyLimit: 9999, overviewCount: 0, draftMaxPerHour: -3 });
    assert.equal(c.pollIntervalSec, 2);
    assert.equal(c.historyLimit, 2000);
    assert.equal(c.overviewCount, 1);
    assert.equal(c.draftMaxPerHour, 0);
  });

  test('新开关字段正常透传与保留', () => {
    const c = normalizeWechatConfig({ groupRequireAt: true, autoReply: true });
    assert.equal(c.groupRequireAt, true);
    assert.equal(c.autoReply, true);
  });

  test('非法 mode 退回默认，合法 mode 保留', () => {
    const c = normalizeWechatConfig({ groups: { mode: 'nonsense' }, individuals: { mode: 'whitelist', list: ['a'] } });
    assert.equal(c.groups.mode, DEFAULT_WECHAT_CONFIG.groups.mode);
    assert.equal(c.individuals.mode, 'whitelist');
    assert.deepEqual(c.individuals.list, ['a']);
  });

  test('空白 draftPrompt 回落到默认模板（避免保存出一个空提示词）', () => {
    assert.equal(normalizeWechatConfig({ draftPrompt: '   ' }).draftPrompt, DEFAULT_WECHAT_CONFIG.draftPrompt);
    assert.equal(normalizeWechatConfig({ draftPrompt: '你是猫娘' }).draftPrompt, '你是猫娘');
  });

  test('非对象输入不抛错', () => {
    assert.doesNotThrow(() => normalizeWechatConfig('nope'));
    assert.doesNotThrow(() => normalizeWechatConfig([1, 2, 3]));
    assert.equal(normalizeWechatConfig(null).enabled, false);
  });
});

describe('normalizeList —— 名单清洗', () => {
  test('去空白、去重（大小写不敏感）、丢弃非字符串，保序', () => {
    assert.deepEqual(normalizeList([' 张三 ', '张三', 'Alice', 'alice', 42, '', null]), ['张三', 'Alice']);
  });

  test('非数组 → 空列表', () => {
    assert.deepEqual(normalizeList('张三'), []);
    assert.deepEqual(normalizeList(undefined), []);
  });
});

describe('matchChatRule / scopeAllows —— 白名单判定', () => {
  test('精确匹配 username 或备注名，大小写不敏感', () => {
    const c = chat('wxid_ABC123', '小明明', true);
    assert.equal(matchChatRule('wxid_abc123', c), true);
    assert.equal(matchChatRule('小明明', c), true);
    assert.equal(matchChatRule('小明', c), false, '不做无通配的子串匹配');
  });

  test('首尾 * 通配退化为子串匹配', () => {
    const c = chat('wxid_abc123', '项目群', true);
    assert.equal(matchChatRule('*abc*', c), true);
    assert.equal(matchChatRule('wxid_*', c), true);
    assert.equal(matchChatRule('*群', c), true);
    assert.equal(matchChatRule('*不存在*', c), false);
  });

  test("单个 '*' 命中全部，空串永不命中", () => {
    assert.equal(matchChatRule('*', chat('wxid_x', '任意')), true);
    assert.equal(matchChatRule('', chat('wxid_x', '任意')), false);
    assert.equal(matchChatRule('   ', chat('wxid_x', '任意')), false);
  });

  test('scopeAllows：none 恒 false、all 恒 true、whitelist 看名单', () => {
    const c = chat('wxid_a', '阿黄');
    assert.equal(scopeAllows({ mode: 'none', list: [] }, c), false);
    assert.equal(scopeAllows({ mode: 'all', list: [] }, c), true);
    assert.equal(scopeAllows({ mode: 'whitelist', list: ['阿黄'] }, c), true);
    assert.equal(scopeAllows({ mode: 'whitelist', list: ['别人'] }, c), false);
  });
});

describe('isMonitoredChat —— 监控范围', () => {
  test('总开关关闭时一律不监控', () => {
    assert.equal(isMonitoredChat(chat('wxid_a', '阿黄'), cfg({ enabled: false })), false);
  });

  test('私聊与群聊分别受各自范围约束', () => {
    const c = cfg({ enabled: true, individuals: { mode: 'none', list: [] }, groups: { mode: 'all', list: [] } });
    assert.equal(isMonitoredChat(chat('wxid_a', '阿黄'), c), false);
    assert.equal(isMonitoredChat(chat('123@chatroom', '项目群', true), c), true);
  });

  test('群聊白名单只放行名单内的群', () => {
    const c = cfg({ enabled: true, groups: { mode: 'whitelist', list: ['项目群'] } });
    assert.equal(isMonitoredChat(chat('1@chatroom', '项目群', true), c), true);
    assert.equal(isMonitoredChat(chat('2@chatroom', '闲聊群', true), c), false);
  });

  test('公众号/服务号（gh_）默认为跳过，可显式放开', () => {
    const sub = chat('gh_abc', '某服务号');
    assert.equal(isSubscriptionChat('gh_abc'), true);
    assert.equal(isSubscriptionChat('wxid_abc'), false);
    assert.equal(isMonitoredChat(sub, cfg({ enabled: true })), false);
    assert.equal(isMonitoredChat(sub, cfg({ enabled: true, skipSubscriptions: false })), true);
  });

  test('已折叠会话默认为跳过，且匹配大小写不敏感', () => {
    const c = chat('wxid_ABC', '阿黄');
    assert.equal(isMonitoredChat(c, cfg({ enabled: true, folded: ['wxid_abc'] })), false);
    assert.equal(isMonitoredChat(c, cfg({ enabled: true, folded: ['wxid_other'] })), true);
    assert.equal(isMonitoredChat(c, cfg({ enabled: true, folded: ['wxid_abc'], skipFolded: false })), true);
  });

  test('微信内部占位会话与空名脏行一律不监控', () => {
    assert.equal(isInternalChat(chat('brandservicesessionholder', '新际大酒店')), true);
    assert.equal(isInternalChat(chat('wxid_a', 'brandsessionholder')), true);
    assert.equal(isInternalChat(chat('wxid_b', '   ')), true);
    assert.equal(isInternalChat(chat('wxid_c', '阿黄')), false);
    // 即使范围是 all、跳过规则全关，也不该被当成可回复会话
    const c = cfg({ enabled: true, skipSubscriptions: false, skipFolded: false });
    assert.equal(isMonitoredChat(chat('brandservicesessionholder', '新际大酒店'), c), false);
    assert.equal(isMonitoredChat(chat('wxid_b', ''), c), false);
  });
});

describe('summarizeLine / formatNewMessageBubble —— 文案整形', () => {
  test('折叠换行与连续空白，超长按上限截断加省略号', () => {
    assert.equal(summarizeLine(' 在吗\n\n 有事 '), '在吗 有事');
    assert.equal(summarizeLine('a'.repeat(80), 10), 'a'.repeat(9) + '…');
    assert.equal(summarizeLine('1234567890', 10), '1234567890', '恰好等于上限不截断');
    assert.equal(summarizeLine(''), '');
  });

  test('群聊标题带发送者，私聊不带', () => {
    const g = formatNewMessageBubble(session({ isGroup: true, chat: '项目群', sender: '老王', lastMessage: '上线了' }));
    assert.equal(g.title, '项目群 · 老王');
    assert.equal(g.text, '上线了');
    const p = formatNewMessageBubble(session({ isGroup: false, chat: '小明', sender: '小明' }));
    assert.equal(p.title, '小明');
  });

  test('空摘要退化成占位文案，不产出空气泡', () => {
    assert.equal(formatNewMessageBubble(session({ lastMessage: '   ' })).text, '（新消息）');
  });

  test('formatSessionRow 把未读变成徽标，无未读为空串', () => {
    assert.equal(formatSessionRow(session({ unread: 3 })).badge, '3');
    assert.equal(formatSessionRow(session({ unread: 0 })).badge, '');
  });
});

describe('sortSessions —— 未读优先、其次最近', () => {
  test('有未读的排在前面，未读多的更前，其余按时间倒序', () => {
    const list = [
      session({ username: 'a', unread: 0, timestamp: 9000 }),
      session({ username: 'b', unread: 1, timestamp: 100 }),
      session({ username: 'c', unread: 5, timestamp: 200 }),
      session({ username: 'd', unread: 0, timestamp: 9500 }),
    ];
    assert.deepEqual(
      sortSessions(list).map((s) => s.username),
      ['c', 'b', 'd', 'a'],
    );
  });

  test('不改动入参', () => {
    const list = [session({ username: 'a', timestamp: 1 }), session({ username: 'b', timestamp: 2 })];
    sortSessions(list);
    assert.deepEqual(
      list.map((s) => s.username),
      ['a', 'b'],
    );
  });
});

describe('buildOverview —— 今日微信概览', () => {
  test('无未读时给一句安心的文案', () => {
    const o = buildOverview([session({ unread: 0 })], cfg());
    assert.equal(o.unreadTotal, 0);
    assert.equal(o.unreadChats, 0);
    assert.match(o.lines[0], /没有未读/);
  });

  test('汇总未读总数、会话数与 Top N，超出部分另行提示', () => {
    const sessions = [
      session({ username: 'a', chat: '甲', unread: 3 }),
      session({ username: 'b', chat: '乙', isGroup: true, unread: 2 }),
      session({ username: 'c', chat: '丙', unread: 1 }),
    ];
    const o = buildOverview(sessions, cfg({ overviewCount: 2 }));
    assert.equal(o.unreadTotal, 6);
    assert.equal(o.unreadChats, 3);
    assert.deepEqual(
      o.top.map((t) => t.name),
      ['甲', '乙'],
    );
    assert.equal(o.top[1].isGroup, true);
    assert.match(o.lines[0], /未读 6 条 · 3 个会话/);
    assert.match(o.lines.join('\n'), /还有 1 个会话/);
  });

  test('零未读会话不计入总数与列表', () => {
    const sessions = [session({ username: 'a', unread: 0 }), session({ username: 'b', unread: 4 })];
    const o = buildOverview(sessions, cfg());
    assert.equal(o.unreadTotal, 4);
    assert.deepEqual(
      o.top.map((t) => t.name),
      ['小明'],
    );
  });
});

describe('isGroupMentioned —— 群 @ 判定', () => {
  test('识别官方 [有人@我] 标记', () => {
    assert.equal(isGroupMentioned('[有人@我] 大家明天开会'), true);
    assert.equal(isGroupMentioned('明天开会'), false);
  });

  test('识别 @所有人 / @all', () => {
    assert.equal(isGroupMentioned('@所有人 收到请回复'), true);
    assert.equal(isGroupMentioned('@all 记得提交周报'), true);
    assert.equal(isGroupMentioned('@All 冲'), true);
  });

  test('指定 selfLabel 时精确匹配 @昵称', () => {
    assert.equal(isGroupMentioned('小明: @主人 帮我看看这个', '主人'), true);
    assert.equal(isGroupMentioned('小明: @张三 帮我看看这个', '主人'), false);
  });

  test('未指定 selfLabel 或 selfLabel 为 me 时，包含 @ 符号即视为提及', () => {
    assert.equal(isGroupMentioned('@someone hello', 'me'), true);
    assert.equal(isGroupMentioned('hello world', 'me'), false);
    assert.equal(isGroupMentioned('', 'me'), false);
  });
});

describe('pickDraftTarget —— 主动预生成的节流与选人', () => {
  const base = cfg({
    enabled: true,
    autoDraft: { mode: 'all', list: [] },
    draftCooldownSec: 300,
    draftMaxPerHour: 2,
  });

  test('启动时间过滤：启动时刻之前的旧未读消息一律不起草', () => {
    const startupSec = 10_000;
    const now = 10_050;
    // 启动前（8000）收到的旧消息，即使未读数 > 0 也不起草
    const oldSessions = [session({ username: 'wxid_old', unread: 5, timestamp: 8000 })];
    assert.equal(pickDraftTarget(oldSessions, base, EMPTY_DRAFT_GATE, now, startupSec), null);

    // 启动后（10010）收到的新消息，正常选中
    const newSessions = [session({ username: 'wxid_new', unread: 1, timestamp: 10010 })];
    assert.equal(pickDraftTarget(newSessions, base, EMPTY_DRAFT_GATE, now, startupSec)?.username, 'wxid_new');
  });

  test('群聊 groupRequireAt 规则：仅当包含 @ 时才起草', () => {
    const groupCfg = cfg({ ...base, groupRequireAt: true });
    const now = 10_000;
    const noAtGroup = [session({ username: 'group1@chatroom', isGroup: true, unread: 1, lastMessage: '张三: 大家好啊', timestamp: 9900 })];
    assert.equal(pickDraftTarget(noAtGroup, groupCfg, EMPTY_DRAFT_GATE, now), null);

    const atGroup = [session({ username: 'group2@chatroom', isGroup: true, unread: 1, lastMessage: '张三: @所有人 开会了', timestamp: 9900 })];
    assert.equal(pickDraftTarget(atGroup, groupCfg, EMPTY_DRAFT_GATE, now)?.username, 'group2@chatroom');
  });

  test('总开关关闭或 autoDraft=none 时不起草', () => {
    const s = [session({ unread: 1 })];
    assert.equal(pickDraftTarget(s, cfg({ enabled: false }), EMPTY_DRAFT_GATE, 10_000), null);
    assert.equal(pickDraftTarget(s, cfg({ enabled: true }), EMPTY_DRAFT_GATE, 10_000), null, '默认 autoDraft=none');
  });

  test('不挑无未读且无更新时间戳、不在监控范围或不在 autoDraft 范围的会话', () => {
    const now = 10_000;
    assert.equal(pickDraftTarget([session({ unread: 0, timestamp: 0 })], base, EMPTY_DRAFT_GATE, now), null);
    const notMonitored =
      base.individuals.mode === 'all' ? cfg({ ...base, individuals: { mode: 'none', list: [] } }) : base;
    assert.equal(pickDraftTarget([session({ unread: 3 })], notMonitored, EMPTY_DRAFT_GATE, now), null);
    const draftNone = cfg({ ...base, autoDraft: { mode: 'whitelist', list: ['别人'] } });
    assert.equal(pickDraftTarget([session({ unread: 3 })], draftNone, EMPTY_DRAFT_GATE, now), null);
  });

  test('即使未读为 0，只要最新消息时间戳更新，依然可选为起草目标', () => {
    const now = 10_000;
    const s = [session({ username: 'wxid_a', unread: 0, timestamp: 9500 })];
    // 上次见过的消息时间是 9000（早于 9500）
    const gateWithOldMsg: WechatDraftGate = {
      lastDraftAt: {},
      recentDrafts: [],
      lastDraftMsgTs: { wxid_a: 9000 },
    };
    assert.ok(pickDraftTarget(s, base, gateWithOldMsg, now) !== null);

    // 上次见到的消息时间是 9500（已经是最新），且 unread 为 0，则不再起草
    const gateWithSameMsg: WechatDraftGate = {
      lastDraftAt: {},
      recentDrafts: [],
      lastDraftMsgTs: { wxid_a: 9500 },
    };
    assert.equal(pickDraftTarget(s, base, gateWithSameMsg, now), null);
  });

  test('冷却期内的会话被跳过，冷却过后重新可选', () => {
    const now = 10_000;
    const s = [session({ unread: 2 })];
    assert.ok(pickDraftTarget(s, base, { lastDraftAt: { wxid_a: now - 10 }, recentDrafts: [] }, now) === null);
    assert.ok(pickDraftTarget(s, base, { lastDraftAt: { wxid_a: now - 301 }, recentDrafts: [] }, now) !== null);
  });

  test('小时配额用尽后不再起草，超出一小时的旧记录不计', () => {
    const now = 10_000;
    const s = [session({ unread: 2 })];
    assert.equal(pickDraftTarget(s, base, { lastDraftAt: {}, recentDrafts: [now - 10, now - 20] }, now), null);
    assert.ok(pickDraftTarget(s, base, { lastDraftAt: {}, recentDrafts: [now - 4000, now - 20] }, now) !== null);
  });

  test('多个候选时挑未读最多、最新的那个', () => {
    const now = 10_000;
    const s = [
      session({ username: 'a', chat: '甲', unread: 1, timestamp: 9000 }),
      session({ username: 'b', chat: '乙', unread: 7, timestamp: 100 }),
    ];
    assert.equal(pickDraftTarget(s, base, EMPTY_DRAFT_GATE, now)?.username, 'b');
  });
});

describe('buildDraftMessages —— 历史 → 模型消息', () => {
  const c = chat('wxid_a', '小明');

  test('主人自己映射成 assistant，对方映射成 user', () => {
    const msgs = buildDraftMessages(c, [
      { time: '2024-01-01 10:00', label: '小明', text: '在吗', isSelf: false },
      { time: '2024-01-01 10:01', label: 'me', text: '在的', isSelf: true },
      { time: '2024-01-01 10:02', label: '小明', text: '帮我看看这个', isSelf: false },
    ]);
    assert.deepEqual(
      msgs.map((m) => m.role),
      ['user', 'assistant', 'user'],
    );
    assert.deepEqual(
      msgs.map((m) => m.content),
      ['在吗', '在的', '帮我看看这个'],
    );
  });

  test('群聊给非本人消息加发送者前缀，避免多人混淆', () => {
    const g = chat('1@chatroom', '项目群', true);
    const msgs = buildDraftMessages(g, [
      { time: 't', label: '老王', text: '上线了', isSelf: false },
      { time: 't', label: '小李', text: '收到', isSelf: false },
    ]);
    assert.deepEqual(
      msgs.map((m) => m.content),
      ['老王: 上线了', '小李: 收到'],
    );
  });

  test('最后一条是主人说的时补一条 user 提示（保证模型有得接）', () => {
    const msgs = buildDraftMessages(c, [{ time: 't', label: 'me', text: '我先忙了', isSelf: true }]);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'assistant');
    assert.equal(msgs[1].role, 'user');
  });

  test('空白正文被丢弃；自定义 selfLabel 同样识别为自己', () => {
    const msgs = buildDraftMessages(
      c,
      [
        { time: 't', label: '自己', text: '   ', isSelf: false },
        { time: 't', label: '自己', text: '好', isSelf: false },
        { time: 't', label: '小明', text: '嗯', isSelf: false },
      ],
      '自己',
    );
    assert.deepEqual(msgs, [
      { role: 'assistant', content: '好' },
      { role: 'user', content: '嗯' },
    ]);
  });

  test('历史过长只取尾部 2000 条', () => {
    const many = Array.from({ length: 2010 }, (_, i) => ({
      time: 't',
      label: '小明',
      text: `第${i}条`,
      isSelf: false,
    }));
    const msgs = buildDraftMessages(c, many);
    assert.equal(msgs.length, 2000);
    assert.equal(msgs[0].content, '第10条');
  });

  test('空历史 → 空消息数组（调用方据此放弃起草）', () => {
    assert.deepEqual(buildDraftMessages(c, []), []);
  });

  test('包含有效图片时组装为多模态格式，且限制注入最新的图片数量', () => {
    const history = [
      {
        time: 't1',
        label: '小明',
        text: '[图片]',
        isSelf: false,
        media: { type: 'image' as const, decodedPath: 'C:\\path\\img1.jpg', exists: true },
      },
      { time: 't2', label: 'me', text: '看到了', isSelf: true },
      {
        time: 't3',
        label: '小明',
        text: '[图片] 请看最新图',
        isSelf: false,
        media: { type: 'image' as const, decodedPath: 'C:\\path\\img2.jpg', exists: true },
      },
    ];
    // 默认 maxImages = 2，两张图片都能注入
    const msgs = buildDraftMessages(c, history, 'me');
    assert.equal(msgs.length, 3);
    assert.ok(Array.isArray(msgs[0].content));
    assert.deepEqual(msgs[0].content, [
      { type: 'text', text: '[图片]' },
      { type: 'image_url', image_url: { path: 'C:\\path\\img1.jpg' } },
    ]);
    assert.equal(msgs[1].content, '看到了');
    assert.ok(Array.isArray(msgs[2].content));
    assert.deepEqual(msgs[2].content, [
      { type: 'text', text: '[图片] 请看最新图' },
      { type: 'image_url', image_url: { path: 'C:\\path\\img2.jpg' } },
    ]);

    // 若限制 maxImages = 1，则较早的 img1 降级为纯文本，仅最新的 img2 注入图片多模态
    const msgsLimited = buildDraftMessages(c, history, 'me', { maxImages: 1 });
    assert.equal(msgsLimited[0].content, '[图片]');
    assert.ok(Array.isArray(msgsLimited[2].content));
  });
});

describe('buildDraftSystemPrompt / cleanDraft —— 提示词与输出清洗', () => {
  test('占位符被替换，群聊标注在名字里', () => {
    const p = buildDraftSystemPrompt(cfg({ draftPrompt: '给{name}写一条，参考{count}条' }), chat('a', '小明'), 7);
    assert.equal(p, '给小明写一条，参考7条');
    const g = buildDraftSystemPrompt(cfg({ draftPrompt: '给{name}写' }), chat('r', '项目群', true), 1);
    assert.equal(g, '给项目群（群聊）写');
  });

  test('联系人专属口吻优先于全局口吻，未命中回退全局', () => {
    const customCfg = cfg({
      draftPrompt: '全局给{name}写',
      contactPersonas: {
        小明: '专属商务口吻给{name}，参考{count}条',
        '*部门*': '部门通知口吻给{name}',
      },
    });
    // 精确命中小明
    assert.equal(buildDraftSystemPrompt(customCfg, chat('wxid_xm', '小明'), 3), '专属商务口吻给小明，参考3条');
    // 通配符命中部门群
    assert.equal(buildDraftSystemPrompt(customCfg, chat('room1@chatroom', '技术研发部门群', true), 5), '部门通知口吻给技术研发部门群（群聊）');
    // 未命中回退全局
    assert.equal(buildDraftSystemPrompt(customCfg, chat('wxid_other', '李四'), 2), '全局给李四写');
  });

  test('清洗掉「回复：」前缀、包裹引号与换行，压成一条', () => {
    assert.equal(cleanDraft('回复：好的呀'), '好的呀');
    assert.equal(cleanDraft('“我看看”'), '我看看');
    assert.equal(cleanDraft('「收到啦」'), '收到啦');
    assert.equal(cleanDraft('第一行\n第二行'), '第一行 第二行');
    assert.equal(cleanDraft('   '), '');
  });

  test('超长输出截断', () => {
    assert.equal(cleanDraft('好'.repeat(20), 10), '好'.repeat(10) + '…');
  });
});

describe('pickStickerEcho —— 表情包呼应', () => {
  const memes = { 大肥鱼: '吃白饭的大肥鱼 摸鱼 摆烂', 可爱: '可爱 卖萌 撒娇', Ciallo: 'ciallo 打招呼 你好' };

  test('中文按 2 字滑窗命中描述', () => {
    assert.equal(pickStickerEcho('今天又在摸鱼', memes), '大肥鱼');
  });

  test('英文按词命中（大小写不敏感）', () => {
    assert.equal(pickStickerEcho('say Ciallo to me', memes), 'Ciallo');
  });

  test('最近用过的被排除，换一张', () => {
    assert.equal(pickStickerEcho('今天又在摸鱼', memes, ['大肥鱼']), null);
  });

  test('无命中 / 空输入 / 空池 → null', () => {
    assert.equal(pickStickerEcho('今天天气不错', memes), null);
    assert.equal(pickStickerEcho('', memes), null);
    assert.equal(pickStickerEcho('摸鱼', {}), null);
  });
});
