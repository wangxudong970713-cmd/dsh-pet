/**
 * wechat-panel.js —— 桌宠「微信」面板（经典 script，挂 window.PetWechatPanel）
 *
 * 加载形态：runtime/electron-helper/ 下的文件由 index.html 以 file:// 经典 script 加载，
 * 因此本文件**必须是 CommonJS 风格的普通脚本**——不能有 import/export、不能被构建，
 * 也不能 require（纯浏览器环境）。纯逻辑一律复用 window.PetShared（shared-core.js 的
 * iife 产物），本文件只负责「拉数据 + 渲染 + 交互」。
 *
 * 职责边界（重要）：本面板**只读**——生成回复草稿后只提供「复制到剪贴板」，
 * 绝不向微信发送任何内容（上游 wechat-cli-mcp 本身也只读）。
 *
 * 数据来自 standalone-service.js 的 /wechat/* 与 /llm/complete 路由，
 * 由 wechat-helper.js spawn 的 Python sidecar（wechat_cli_mcp.bridge）供数。
 */
(function () {
  'use strict';

  /** shared-core（src/shared 的构建产物）；缺失时面板退化但仍不崩 */
  const S = window.PetShared || null;

  /** bridge 前缀由 constants.js 定义（经典 script 间的全局词法绑定，非 window 属性）。
   *  用 try 取值：万一本文件被更早加载，也不至于抛 ReferenceError。 */
  function baseUrl() {
    try {
      return BASE;
    } catch {
      return 'dsh-pet-bridge://dsh-pet/dsh-pet-7340';
    }
  }

  const REQ_TIMEOUT_MS = 30_000;
  const INIT_TIMEOUT_MS = 240_000; // 抓密钥要扫微信进程内存
  const LLM_TIMEOUT_MS = 90_000;
  const SESSION_LIMIT = 50;

  // ------------------------------------------------------------------
  // 样式（与桌宠气泡/对话弹窗同一套视觉：白色圆角卡片 + 软糖体）
  // ------------------------------------------------------------------
  const CSS = [
    '.dsh-pet-wechat{position:fixed;z-index:2147483002;display:flex;flex-direction:column;',
    'background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:12px;',
    'box-shadow:0 10px 32px rgba(0,0,0,.22);color:#2b2b2b;font-size:13px;line-height:1.5;',
    "font-family:'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif;",
    'overflow:hidden;pointer-events:auto;user-select:none}',
    '.dsh-pet-wechat *{box-sizing:border-box}',
    '.dsh-pet-wx-head{display:flex;align-items:center;gap:6px;padding:8px 10px;',
    'border-bottom:1px solid rgba(0,0,0,.08);background:rgba(246,248,252,.9);flex:0 0 auto;',
    'cursor:move;touch-action:none}',
    '.dsh-pet-wechat.is-dragging{box-shadow:0 12px 36px rgba(0,0,0,.3);opacity:.96}',
    '.dsh-pet-wx-title{font-weight:700;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-pet-wx-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#c9ccd1}',
    '.dsh-pet-wx-dot.ok{background:#2e9e4f}',
    '.dsh-pet-wx-dot.warn{background:#e6a23c}',
    '.dsh-pet-wx-dot.err{background:#d94f3d}',
    '.dsh-pet-wx-btn{border:1px solid rgba(0,0,0,.14);background:#fff;color:#2b2b2b;border-radius:8px;',
    'padding:3px 8px;font-size:12px;cursor:pointer;font-family:inherit;flex:0 0 auto}',
    '.dsh-pet-wx-btn:hover{background:#f2f5fa}',
    '.dsh-pet-wx-btn[disabled]{opacity:.5;cursor:default}',
    '.dsh-pet-wx-btn.primary{background:#3f7dd8;border-color:#3f7dd8;color:#fff}',
    '.dsh-pet-wx-btn.primary:hover{background:#3569b8}',
    '.dsh-pet-wx-btn.ghost{border-color:transparent;background:transparent;font-size:14px;padding:2px 6px}',
    '.dsh-pet-wx-status{padding:7px 10px;font-size:12px;flex:0 0 auto;display:flex;gap:8px;align-items:center;',
    'border-bottom:1px solid rgba(0,0,0,.06);background:rgba(252,253,255,.9)}',
    '.dsh-pet-wx-status.err{color:#d94f3d}',
    '.dsh-pet-wx-status.warn{color:#9a6b12}',
    '.dsh-pet-wx-status .txt{flex:1 1 auto;overflow-wrap:anywhere}',
    '.dsh-pet-wx-body{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:8px 10px 10px}',
    '.dsh-pet-wx-sec{font-size:11px;color:rgba(43,43,43,.55);margin:2px 0 5px;letter-spacing:.04em}',
    '.dsh-pet-wx-ov{border:1px solid rgba(0,0,0,.08);border-radius:9px;padding:7px 9px;margin-bottom:9px;',
    'background:rgba(247,250,255,.9);font-size:12px}',
    '.dsh-pet-wx-ov-line{overflow-wrap:anywhere}',
    '.dsh-pet-wx-row{display:flex;gap:8px;align-items:flex-start;padding:7px 8px;border-radius:9px;cursor:pointer;',
    'border:1px solid transparent}',
    '.dsh-pet-wx-row:hover{background:rgba(63,125,216,.08)}',
    '.dsh-pet-wx-row.active{background:rgba(63,125,216,.12);border-color:rgba(63,125,216,.35)}',
    '.dsh-pet-wx-row-main{flex:1 1 auto;min-width:0}',
    '.dsh-pet-wx-row-t{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-pet-wx-row-s{font-size:12px;color:rgba(43,43,43,.62);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-pet-wx-badge{flex:0 0 auto;min-width:18px;height:18px;border-radius:9px;background:#d94f3d;color:#fff;',
    'font-size:11px;line-height:18px;text-align:center;padding:0 5px}',
    '.dsh-pet-wx-msg{display:flex;margin:6px 0}',
    '.dsh-pet-wx-msg.self{justify-content:flex-end}',
    '.dsh-pet-wx-bub{max-width:80%;padding:5px 9px;border-radius:9px;background:rgba(0,0,0,.055);',
    'overflow-wrap:anywhere;white-space:pre-wrap}',
    '.dsh-pet-wx-msg.self .dsh-pet-wx-bub{background:rgba(63,125,216,.16)}',
    '.dsh-pet-wx-meta{font-size:11px;color:rgba(43,43,43,.5);margin-bottom:2px}',
    '.dsh-pet-wx-draft{margin-top:10px;border-top:1px dashed rgba(0,0,0,.14);padding-top:9px}',
    '.dsh-pet-wx-draft textarea{width:100%;min-height:56px;resize:vertical;border:1px solid rgba(0,0,0,.14);',
    'border-radius:8px;padding:6px 8px;font-size:13px;line-height:1.5;font-family:inherit;color:#2b2b2b;',
    'background:#fff;outline:none}',
    '.dsh-pet-wx-acts{display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap}',
    '.dsh-pet-wx-err{color:#d94f3d;font-size:12px;margin-top:6px;overflow-wrap:anywhere}',
    '.dsh-pet-wx-empty{color:rgba(43,43,43,.5);font-size:12px;padding:10px 2px}',
  ].join('');

  let cssInjected = false;
  /** 注入面板样式（幂等；打 plugin 标记便于排障与去重） */
  function injectWechatPanelCss() {
    if (cssInjected || typeof document === 'undefined') return;
    cssInjected = true;
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = 'dsh-pet/wechat-panel';
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  // ------------------------------------------------------------------
  // 小工具
  // ------------------------------------------------------------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(label, className, onClick) {
    const b = el('button', 'dsh-pet-wx-btn' + (className ? ' ' + className : ''), label);
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  async function api(path, options) {
    const opts = options || {};
    const init = {
      method: opts.method || 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs || REQ_TIMEOUT_MS),
    };
    if (opts.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(baseUrl() + path, init);
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') throw new Error('响应非法（HTTP ' + res.status + '）');
    return data;
  }

  /** 复制到剪贴板：主进程 IPC > navigator.clipboard > execCommand 兜底。 */
  async function copyText(text) {
    if (!text) return false;
    try {
      if (window.petBridge && typeof window.petBridge.copyText === 'function') {
        await window.petBridge.copyText(text);
        return true;
      }
    } catch {
      /* 落到下一档 */
    }
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* 落到下一档 */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /** clamp 归一化：兼容 {x,y,w,h}（sprite.visibleClampRect / mountChatDialog 的契约）
   *  与 {left,top,right,bottom}；缺省 = 整个视口。 */
  function normalizeClamp(clamp) {
    if (!clamp || typeof clamp !== 'object') {
      return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    }
    if (Number.isFinite(clamp.x) && Number.isFinite(clamp.y) && Number.isFinite(clamp.w) && Number.isFinite(clamp.h)) {
      return { x: clamp.x, y: clamp.y, w: clamp.w, h: clamp.h };
    }
    if (
      Number.isFinite(clamp.left) &&
      Number.isFinite(clamp.top) &&
      Number.isFinite(clamp.right) &&
      Number.isFinite(clamp.bottom)
    ) {
      return {
        x: clamp.left,
        y: clamp.top,
        w: clamp.right - clamp.left,
        h: clamp.bottom - clamp.top,
      };
    }
    return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  }

  /** 通道状态 → 视觉提示（点色 + 文案 + 是否需要「一键抓取」） */
  function statusInfo(status) {
    const st = status || {};
    if (st.ok !== true) {
      return { tone: 'err', text: '连不上桌宠本地服务：' + (st.message || '未知错误'), canInit: false };
    }
    if (!st.enabled) {
      return { tone: 'warn', text: '微信联动未开启（右键设置 → 微信助手）', canInit: false };
    }
    if (st.ready === true) {
      return { tone: 'ok', text: '微信通道已就绪 · 密钥 ' + (st.keyCount || 0) + ' 个', canInit: false };
    }
    const helper = st.helper || {};
    if (st.reason === 'not-initialized') {
      return { tone: 'warn', text: '还没抓取微信密钥（需要微信正在运行）', canInit: true };
    }
    if (helper.state === 'error') {
      return { tone: 'err', text: '助手未启动：' + (helper.lastError || '未知原因'), canInit: true };
    }
    if (helper.state === 'starting') {
      return { tone: 'warn', text: '助手启动中…', canInit: false };
    }
    if (helper.wechatRunning === false) {
      return { tone: 'warn', text: '微信没有运行，登录后会自动抓取', canInit: true };
    }
    return { tone: 'warn', text: st.message || '微信数据暂不可用', canInit: true };
  }

  // ------------------------------------------------------------------
  // 面板
  // ------------------------------------------------------------------

  /**
   * 挂载微信面板。
   * @param {object} opts
   * @param {object} opts.config  已规范化的 wechat 配置（S.normalizeWechatConfig 的产物）
   * @param {number} opts.x       期望左上角（视口坐标）
   * @param {number} opts.y       期望左上角（视口坐标）
   * @param {{x:number,y:number,w:number,h:number}} [opts.clamp] 可见区域（超出则夹回）
   * @param {() => void} [opts.onClose]      关闭回调（点外/Escape/关闭按钮都触发）
   * @param {(info:{title:string,text:string}) => void} [opts.onMessage] 复制成功后的可选回执
   * @returns {{el: HTMLElement, close: () => void}}
   */
  function mountWechatPanel(opts) {
    injectWechatPanelCss();
    const options = opts || {};
    const cfg = options.config || (S ? S.normalizeWechatConfig({}) : {});
    const c = normalizeClamp(options.clamp);

    // 面板尺寸随可用空间收缩：桌宠窗口 = 宠物盒 + 四周外扩余量，小宠物时窗口不大。
    // maxHeight 按「期望位置到可视区底边」的剩余空间收紧，否则贴屏幕底时下半截被裁掉、点不到。
    const wantX = Number.isFinite(options.x) ? options.x : c.x + 8;
    const wantY = Number.isFinite(options.y) ? options.y : c.y + 8;
    const width = Math.max(232, Math.min(360, c.w - 8));
    const maxHeight = Math.max(160, Math.min(460, c.y + c.h - Math.max(c.y + 4, wantY) - 8, c.h - 8));

    const root = el('div', 'dsh-pet-wechat');
    root.style.width = width + 'px';
    root.style.maxHeight = maxHeight + 'px';

    // ---------------- 状态 ----------------
    const p = {
      status: null,
      overview: null,
      sessions: [],
      active: null,
      messages: [],
      selfLabel: 'me',
      draft: '',
      draftErr: '',
      listErr: '',
      initBusy: false,
      draftBusy: false,
      copied: false,
      sending: false,
      sendSuccess: false,
      loading: false,
    };

    // ---------------- 骨架 ----------------
    const head = el('div', 'dsh-pet-wx-head');
    const dot = el('span', 'dsh-pet-wx-dot');
    const title = el('span', 'dsh-pet-wx-title', '微信');
    const btnRefresh = button('刷新', '', () => void refresh(true));
    const btnClose = button('✕', 'ghost', () => close());
    head.appendChild(dot);
    head.appendChild(title);
    head.appendChild(btnRefresh);
    head.appendChild(btnClose);

    const statusBar = el('div', 'dsh-pet-wx-status');
    const statusText = el('span', 'txt', '正在读取…');
    const statusAction = el('span');
    statusBar.appendChild(statusText);
    statusBar.appendChild(statusAction);

    const body = el('div', 'dsh-pet-wx-body');

    root.appendChild(head);
    root.appendChild(statusBar);
    root.appendChild(body);

    // ---------------- 拖动 / 定位 ----------------
    // 面板挂在桌宠旁边，经常盖住宠物或压到屏幕边缘，所以标题栏按住即可拖走。
    // 左上角坐标统一由 place() 夹进可视区，避免拖出屏幕后再也点不到。
    let pos = { x: c.x + 8, y: c.y + 8 };
    let drag = null;
    head.title = '按住标题栏可拖动面板';

    function place(x, y) {
      const w = root.offsetWidth || width;
      const h = root.offsetHeight || Math.min(maxHeight, 240);
      pos = {
        x: Math.max(c.x + 4, Math.min(x, Math.max(c.x + 4, c.x + c.w - w - 4))),
        y: Math.max(c.y + 4, Math.min(y, Math.max(c.y + 4, c.y + c.h - h - 4))),
      };
      root.style.left = pos.x + 'px';
      root.style.top = pos.y + 'px';
    }

    function onHeadPointerDown(e) {
      if (e.button !== 0) return;
      // 标题栏上的按钮（刷新/关闭）不参与拖动，否则会拖不动又点不灵
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('button')) return;
      drag = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      root.classList.add('is-dragging');
      if (typeof head.setPointerCapture === 'function') head.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
    function onHeadPointerMove(e) {
      if (!drag) return;
      place(e.clientX - drag.dx, e.clientY - drag.dy);
    }
    function onHeadPointerUp(e) {
      if (!drag) return;
      drag = null;
      root.classList.remove('is-dragging');
      if (typeof head.hasPointerCapture === 'function' && head.hasPointerCapture(e.pointerId)) {
        head.releasePointerCapture(e.pointerId);
      }
    }
    head.addEventListener('pointerdown', onHeadPointerDown);
    head.addEventListener('pointermove', onHeadPointerMove);
    head.addEventListener('pointerup', onHeadPointerUp);
    head.addEventListener('pointercancel', onHeadPointerUp);

    // ---------------- 渲染 ----------------
    function renderStatus() {
      const info = statusInfo(p.status);
      dot.className = 'dsh-pet-wx-dot ' + info.tone;
      statusBar.className = 'dsh-pet-wx-status ' + (info.tone === 'ok' ? '' : info.tone);
      statusText.textContent = info.text;
      statusAction.textContent = '';
      if (info.canInit) {
        const label = p.initBusy ? '正在抓取…' : '一键抓取';
        const b = button(label, 'primary', () => void runInit());
        b.disabled = p.initBusy;
        statusAction.appendChild(b);
      }
    }

    function renderOverview() {
      const node = el('div', 'dsh-pet-wx-ov');
      const ov = p.overview;
      if (!ov || ov.ok !== true) {
        node.appendChild(el('div', 'dsh-pet-wx-ov-line', '今日概览暂不可用'));
        return node;
      }
      const lines = [];
      lines.push('未读 ' + (ov.unreadTotal || 0) + ' 条 · 今日 ' + (ov.totalToday || 0) + ' 条消息');
      if (Array.isArray(ov.today) && ov.today.length) {
        for (const t of ov.today.slice(0, 4)) {
          lines.push('· ' + (S ? S.summarizeLine(t.chat, 14) : t.chat) + ' ' + t.count + ' 条');
        }
      } else if (!ov.unreadTotal) {
        lines.push('· 没有未读消息，清清静静');
      }
      for (const line of lines) node.appendChild(el('div', 'dsh-pet-wx-ov-line', line));
      return node;
    }

    /** 面板里只展示「该看的」会话：范围/公众号/折叠过滤都在 shared 里 */
    function visibleSessions() {
      const list = Array.isArray(p.sessions) ? p.sessions : [];
      const filtered = S ? list.filter((s) => S.isMonitoredChat(s, cfg)) : list;
      return S ? S.sortSessions(filtered) : filtered;
    }

    function renderList() {
      body.textContent = '';
      if (p.listErr) {
        body.appendChild(el('div', 'dsh-pet-wx-empty', p.listErr));
      }
      body.appendChild(el('div', 'dsh-pet-wx-sec', '今日概览'));
      body.appendChild(renderOverview());

      const list = visibleSessions();
      body.appendChild(el('div', 'dsh-pet-wx-sec', '会话（' + list.length + '）'));
      if (!list.length) {
        const hint =
          p.status && p.status.ready === false ? '微信数据还没就绪，先点上面的「一键抓取」' : '范围内没有会话';
        body.appendChild(el('div', 'dsh-pet-wx-empty', hint));
        return;
      }
      for (const session of list) {
        const row = el('div', 'dsh-pet-wx-row');
        const main = el('div', 'dsh-pet-wx-row-main');
        const rowData = S ? S.formatSessionRow(session) : { title: session.chat, sub: session.lastMessage, badge: '' };
        main.appendChild(el('div', 'dsh-pet-wx-row-t', rowData.title));
        main.appendChild(el('div', 'dsh-pet-wx-row-s', rowData.sub));
        row.appendChild(main);
        if (rowData.badge) row.appendChild(el('span', 'dsh-pet-wx-badge', rowData.badge));
        row.addEventListener('click', () => void openSession(session));
        body.appendChild(row);
      }
    }

    function renderDetail() {
      body.textContent = '';
      const s = p.active;
      const back = el('div', 'dsh-pet-wx-sec');
      const backBtn = button('‹ 返回会话列表', 'ghost', () => {
        p.active = null;
        p.messages = [];
        p.draft = '';
        p.draftErr = '';
        render();
      });
      backBtn.style.fontSize = '12px';
      back.appendChild(backBtn);
      body.appendChild(back);

      const head2 = el('div', 'dsh-pet-wx-sec', (s.chat || s.username) + (s.isGroup ? '（群）' : ''));
      body.appendChild(head2);

      if (p.listErr) {
        // 读取失败不能静默：之前只写 p.listErr 却从不渲染，点进会话就是一片空白（像"进不去"）
        body.appendChild(el('div', 'dsh-pet-wx-err', '读不到历史：' + p.listErr));
      }
      if (!p.messages.length) {
        body.appendChild(el('div', 'dsh-pet-wx-empty', '没有读到消息（可能还没抓取密钥，或该会话无记录）'));
      } else {
        for (const m of p.messages) {
          const wrap = el('div', 'dsh-pet-wx-msg' + (m.isSelf ? ' self' : ''));
          const bub = el('div', 'dsh-pet-wx-bub');
          const meta = el('div', 'dsh-pet-wx-meta', (m.label || '') + (m.time ? ' · ' + m.time : ''));
          bub.appendChild(meta);

          if (m.media && m.media.type === 'image' && m.media.decodedPath) {
            const imgEl = document.createElement('img');
            imgEl.src = BASE + '/wechat/image?path=' + encodeURIComponent(m.media.decodedPath);
            imgEl.alt = '[图片]';
            imgEl.title = '点击在新窗口中查看原图';
            imgEl.style.maxWidth = '180px';
            imgEl.style.maxHeight = '180px';
            imgEl.style.borderRadius = '6px';
            imgEl.style.display = 'block';
            imgEl.style.margin = '4px 0';
            imgEl.style.cursor = 'pointer';
            imgEl.onclick = () => {
              window.open(imgEl.src, '_blank');
            };
            bub.appendChild(imgEl);
          }

          let displayText = m.text || '';
          if (m.media && m.media.type === 'image' && displayText.startsWith('[图片]')) {
            displayText = '[图片]';
          }
          bub.appendChild(el('div', null, displayText));
          wrap.appendChild(bub);
          body.appendChild(wrap);
        }
      }

      const draftBox = el('div', 'dsh-pet-wx-draft');
      const area = document.createElement('textarea');
      area.value = p.draft;
      area.placeholder = '点下面「帮我起草」生成一条回复草稿（只复制，不发送）';
      area.addEventListener('input', () => {
        p.draft = area.value;
        p.copied = false;
      });
      draftBox.appendChild(area);

      const acts = el('div', 'dsh-pet-wx-acts');
      const bDraft = button(p.draftBusy ? '正在起草…' : '🤖 帮我起草', 'primary', () => void draftReply());
      bDraft.disabled = p.draftBusy || !p.messages.length;
      const bCopy = button(p.copied ? '已复制 ✓' : '📋 复制', '', () => void doCopy());
      bCopy.disabled = !p.draft;
      const bSend = button(p.sending ? '正在发送…' : (p.sendSuccess ? '已发送 ✓' : '🚀 快捷发送'), '', () => void doSend());
      bSend.disabled = !p.draft || p.sending;
      acts.appendChild(bDraft);
      acts.appendChild(bCopy);
      acts.appendChild(bSend);
      draftBox.appendChild(acts);

      if (p.draftErr) draftBox.appendChild(el('div', 'dsh-pet-wx-err', p.draftErr));
      body.appendChild(draftBox);
    }

    function render() {
      renderStatus();
      if (p.active) renderDetail();
      else renderList();
    }

    // ---------------- 数据 ----------------
    async function loadStatus() {
      try {
        p.status = await api('/wechat/status');
      } catch (e) {
        p.status = { ok: false, message: String((e && e.message) || e) };
      }
    }

    async function loadSessions() {
      try {
        const res = await api('/wechat/sessions?limit=' + SESSION_LIMIT);
        if (res.ok === true) {
          p.sessions = Array.isArray(res.chats) ? res.chats : [];
          p.listErr = '';
        } else {
          p.sessions = [];
          p.listErr = res.message || res.reason || '会话读取失败';
        }
      } catch (e) {
        p.sessions = [];
        p.listErr = '会话读取异常：' + String((e && e.message) || e);
      }
    }

    async function loadOverview() {
      try {
        const res = await api('/wechat/overview');
        p.overview = res.ok === true ? res : null;
      } catch {
        p.overview = null;
      }
      if (!p.active) render();
    }

    async function refresh(force) {
      if (p.loading && !force) return;
      p.loading = true;
      renderStatus();
      await loadStatus();
      render();
      await loadSessions();
      render();
      void loadOverview(); // 概览要开多个消息库，慢一些：不阻塞列表
      p.loading = false;
    }

    async function runInit() {
      if (p.initBusy) return;
      p.initBusy = true;
      renderStatus();
      try {
        const res = await api('/wechat/init', { method: 'POST', body: {}, timeoutMs: INIT_TIMEOUT_MS });
        if (res.ok !== true) {
          p.status = Object.assign({}, p.status, {
            ok: true,
            enabled: true,
            ready: false,
            reason: res.reason || 'init-failed',
            message: res.message || '抓取失败',
          });
        }
      } catch (e) {
        p.status = Object.assign({}, p.status, {
          ok: true,
          enabled: true,
          ready: false,
          reason: 'init-error',
          message: '抓取异常：' + String((e && e.message) || e),
        });
      }
      p.initBusy = false;
      await refresh(true);
    }

    async function openSession(session) {
      p.active = session;
      p.messages = [];
      p.draft = '';
      p.draftErr = '';
      p.listErr = '';
      p.copied = false;
      render();
      const limit = Math.max(2, Math.min(2000, Number(cfg.historyLimit) || 12));
      // 必须用 username（群 id / wxid）查历史：bridge 的 chat 解析对「私聊显示名」会解析失败或解析错，
      // session.chat 只适合显示。
      const key = session.username;
      try {
        const res = await api('/wechat/history?chat=' + encodeURIComponent(key) + '&limit=' + limit);
        if (res.ok === true) {
          p.messages = Array.isArray(res.messages) ? res.messages : [];
          p.selfLabel = res.selfLabel || 'me';
          p.listErr = '';
        } else {
          p.draftErr = '';
          p.messages = [];
          p.listErr = res.message || res.reason || '历史读取失败';
        }
      } catch (e) {
        p.messages = [];
        p.listErr = '历史读取异常：' + String((e && e.message) || e);
      }
      render();
    }

    async function draftReply() {
      if (p.draftBusy || !p.active) return;
      p.draftBusy = true;
      p.draftErr = '';
      p.copied = false;
      render();
      try {
        const messages = S ? S.buildDraftMessages(p.active, p.messages, p.selfLabel) : [];
        if (!messages.length) {
          p.draftErr = '这个会话没有可参考的历史消息，先换个会话试试';
          return;
        }
        const system = S
          ? S.buildDraftSystemPrompt(cfg, p.active, p.messages.length)
          : '你在替主人起草一条微信回复，只输出回复正文。';
        const res = await api('/llm/complete', {
          method: 'POST',
          body: { system, messages, maxTokens: 256, temperature: 0.7 },
          timeoutMs: LLM_TIMEOUT_MS,
        });
        if (res.ok === true) {
          const text = typeof res.text === 'string' ? res.text : '';
          p.draft = S ? S.cleanDraft(text) : text;
          if (!p.draft) p.draftErr = '模型没有返回内容，再试一次？';
        } else {
          p.draftErr = res.message || res.reason || '生成失败';
        }
      } catch (e) {
        p.draftErr = '生成异常：' + String((e && e.message) || e);
      } finally {
        p.draftBusy = false;
        render();
      }
    }

    async function doCopy() {
      const text = (p.draft || '').trim();
      if (!text) return;
      const ok = await copyText(text);
      p.copied = ok;
      if (!ok) p.draftErr = '复制失败：可以手动选中草稿文本再按 Ctrl+C';
      render();
      if (ok && typeof options.onMessage === 'function') {
        options.onMessage({ title: '已复制', text: '回复已进剪贴板，去微信里粘贴吧~' });
      }
    }

    async function doSend() {
      const text = (p.draft || '').trim();
      if (!text || !p.active) return;
      p.sending = true;
      p.draftErr = '';
      render();
      try {
        if (window.petBridge && typeof window.petBridge.sendAutoReply === 'function') {
          const res = await window.petBridge.sendAutoReply({ chat: p.active.chat, text });
          if (res && res.ok) {
            p.sendSuccess = true;
            setTimeout(() => {
              p.sendSuccess = false;
              render();
            }, 2000);
          } else {
            p.draftErr = '发送失败：' + ((res && res.error) || '未知错误');
          }
        } else {
          p.draftErr = '当前环境不支持直接发送，请使用复制按钮手动粘贴发送';
        }
      } catch (e) {
        p.draftErr = '发送异常：' + String(e && e.message ? e.message : e);
      } finally {
        p.sending = false;
        render();
      }
    }

    // ---------------- 关闭 / 定位 ----------------
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('mousedown', onDocPointerDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
      root.remove();
      if (typeof options.onClose === 'function') options.onClose();
    }
    function onDocPointerDown(e) {
      if (closed) return;
      if (root.contains(e.target)) return;
      close();
    }
    function onDocKeyDown(e) {
      if (closed) return;
      if (e.key === 'Escape') close();
    }

    document.body.appendChild(root);
    place(wantX, wantY);
    document.addEventListener('mousedown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);

    render();
    void refresh(true);

    return { el: root, close };
  }

  window.PetWechatPanel = { mountWechatPanel: mountWechatPanel, injectWechatPanelCss: injectWechatPanelCss };
})();
