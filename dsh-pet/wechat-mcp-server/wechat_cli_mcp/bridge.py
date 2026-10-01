#!/usr/bin/env python3
"""bridge.py — 桌面端（dsh-pet）常驻 sidecar：行分隔 JSON RPC

用法::

    python -m wechat_cli_mcp.bridge

设计约定
--------
1. **只读原则不变**：绝不写微信数据库；只写 ``~/.wechat-cli/config.json`` 与
   ``all_keys.json``（密钥初始化），以及 ``%TEMP%/wechat_cli_cache`` 解密缓存。
2. 协议：stdin 每行一个请求 ``{"id":N,"cmd":"..."}``，stdout 每行一个响应
   ``{"id":N,"ok":true,...}`` 或 ``{"id":N,"ok":false,"code":"...","error":"..."}``。
   没有 ``id`` 的行是主动事件（``{"event":"log"|"fatal",...}``）。
3. 单条命令失败**绝不终止进程**（只有 stdin EOF 才退出），错误统一转成 ``ok:false``。
4. stdout 是协议通道：任何被调用方（如密钥提取）的 ``print`` 必须进 :class:`_CaptureStdout`，
   否则会污染帧。
5. 本模块**不主动**依赖 MCP 工具层（只用 ``core.*`` / ``keys`` / ``context``）。注意以
   ``python -m wechat_cli_mcp.bridge`` 方式运行时仍会经过包 ``__init__``（会创建一个
   未被使用的 FastMCP 实例），这是包结构决定的，无副作用。
"""

from __future__ import annotations

import contextlib
import glob
import io
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import traceback
from datetime import date, datetime

# stdin/stdout/stderr 必须都是 UTF-8：
#   - stdout/stderr 不设，Windows 下中文会 UnicodeEncodeError 撑爆协议；
#   - stdin 不设，Windows 下管道默认按 ANSI(CP936) 解码，调用方写入的 UTF-8 中文
#     会变成乱码（表现为「未找到会话: 闇搁兘V…」），群名/备注名全部查不到。
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # pragma: no cover - 仅被重定向/已分离时可能失败
        pass
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(line_buffering=True)
    except Exception:  # pragma: no cover
        pass


PROTOCOL_VERSION = 1
DEFAULT_SESSION_LIMIT = 50
MAX_SESSION_LIMIT = 200
MAX_HISTORY_LIMIT = 2000
DEFAULT_HISTORY_LIMIT = 30
OVERVIEW_TOP_CHATS = 8
CONTACT_CACHE_TTL_SEC = 600


class BridgeError(Exception):
    """带稳定错误码的命令级失败。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# --------------------------------------------------------------------------
# 协议输出
# --------------------------------------------------------------------------

def _write(obj) -> None:
    """把一行 JSON 写到协议通道（stdout）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    try:
        sys.stdout.flush()
    except Exception:  # pragma: no cover - 管道断开时上层会结束循环
        pass


class _CaptureStdout:
    """把 ``sys.stdout`` 换成内存缓冲，供第三方 ``print`` 使用。

    用法::

        cap = _CaptureStdout()
        with cap:
            extract_keys(...)      # 它的 print 全部进缓冲
        log = cap.tail()           # 取最后若干行做诊断
    """

    def __init__(self, max_lines: int = 40):
        self._buf = io.StringIO()
        self._max_lines = max_lines
        self._old = None

    def __enter__(self):
        self._old = sys.stdout
        sys.stdout = self._buf
        return self

    def __exit__(self, *exc):
        sys.stdout = self._old
        self._old = None
        return False

    def tail(self):
        """缓冲里最后 ``max_lines`` 行非空文本。"""
        try:
            text = self._buf.getvalue()
        except Exception:  # pragma: no cover
            return []
        lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
        return lines[-self._max_lines:]


# --------------------------------------------------------------------------
# 环境探测
# --------------------------------------------------------------------------

def _default_process_name() -> str:
    try:
        from .core.config import _DEFAULT_PROCESS  # type: ignore[attr-defined]

        return _DEFAULT_PROCESS
    except Exception:
        return "Weixin.exe"


def _wechat_running() -> bool:
    """微信进程是否在运行（密钥提取的前提）。"""
    name = _default_process_name()
    try:
        if os.name == "nt":
            proc = subprocess.run(
                ["tasklist", "/FI", f"IMAGENAME eq {name}", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            return name.lower() in (proc.stdout or "").lower()
        proc = subprocess.run(
            ["pgrep", "-f", name], capture_output=True, text=True, timeout=10
        )
        return proc.returncode == 0
    except Exception:
        return False


def _newest_mtime(path: str) -> float:
    """目录"新鲜度"：优先看消息库，其次会话库，最后目录本身。"""
    for rel in (("message", "message_0.db"), ("session", "session.db"), ("message",)):
        candidate = os.path.join(path, *rel)
        if os.path.exists(candidate):
            try:
                return os.path.getmtime(candidate)
            except OSError:
                pass
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def _db_dir_candidates():
    """按优先级收集候选 db_storage 目录，返回 ``[{dir,source,mtime}]``（新→旧）。

    官方 ``auto_detect_db_dir()`` 在部分机器上失效（Windows 的 ini 里可能只有
    半截路径），所以这里补上常见安装布局作为兜底。
    """
    from .core.config import CONFIG_FILE, auto_detect_db_dir

    found = []

    def add(path, source):
        if not path:
            return
        try:
            resolved = os.path.abspath(os.path.expanduser(str(path)))
        except Exception:
            return
        if os.path.isdir(resolved):
            found.append((resolved, source))

    # ① 显式环境变量（排障/多账号手动指定）
    add(os.environ.get("WECHAT_DB_DIR"), "env")

    # ② 已写入的 config.json
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, encoding="utf-8") as handle:
                add((json.load(handle) or {}).get("db_dir"), "config")
    except Exception:
        pass

    # ③ 官方探测。注意：非 TTY 时 _choose_candidate 会静默取第一个候选；
    #    交互式（人手敲协议）时会 input() 阻塞并把提示打到 stdout 污染协议，故跳过。
    if not sys.stdin.isatty():
        try:
            add(auto_detect_db_dir(), "ini")
        except Exception:
            pass

    home = os.path.expanduser("~")
    # ④ 4.x 布局：~/Documents/xwechat_files/<账号>/db_storage
    #    （只支持微信 4.x；3.x 的 ~/Documents/WeChat Files 已停止服务，不再探测）
    for match in glob.glob(
        os.path.join(home, "Documents", "xwechat_files", "*", "db_storage")
    ):
        add(match, "xwechat_files")

    seen, unique = set(), []
    for path, source in found:
        key = os.path.normcase(os.path.normpath(path))
        if key in seen:
            continue
        seen.add(key)
        unique.append({"dir": path, "source": source, "mtime": _newest_mtime(path)})
    unique.sort(key=lambda item: item["mtime"], reverse=True)
    return unique


def _detect_db_dir(override=None):
    """返回 ``(db_dir, source, candidates)``；找不到时 db_dir 为 None。"""
    if override:
        resolved = os.path.abspath(os.path.expanduser(str(override)))
        entry = {"dir": resolved, "source": "override", "mtime": _newest_mtime(resolved)}
        if not os.path.isdir(resolved):
            return None, "none", [entry]
        return resolved, "override", [entry]
    candidates = _db_dir_candidates()
    if not candidates:
        return None, "none", []
    return candidates[0]["dir"], candidates[0]["source"], candidates


def _keys_count() -> int:
    """``all_keys.json`` 里有效密钥条数（0 表示未初始化/无效）。"""
    from .core.config import KEYS_FILE

    try:
        from .core.key_utils import strip_key_metadata

        with open(KEYS_FILE, encoding="utf-8") as handle:
            data = strip_key_metadata(json.load(handle) or {})
        return len(data) if isinstance(data, dict) else 0
    except Exception:
        return 0


def _reset_context():
    """清掉单例与联系人缓存（重新初始化 / 切换账号后必须调）。"""
    try:
        from .context import WeChatContext

        instance = WeChatContext._instance  # type: ignore[attr-defined]
        if instance is not None:
            with contextlib.suppress(Exception):
                instance.cache.cleanup()
        WeChatContext._instance = None  # type: ignore[attr-defined]
    except Exception:
        pass
    try:
        from .core import contacts as contacts_module

        contacts_module._contact_names = None
        contacts_module._contact_full = None
        contacts_module._self_username = None
    except Exception:
        pass
    _names_cache["names"] = None
    _names_cache["at"] = 0.0


_names_cache = {"names": None, "at": 0.0}


def _get_ctx():
    from .context import get_context

    return get_context()


def _contact_names(ctx):
    """带 TTL 的联系人表；到期前先清掉 core.contacts 的进程级缓存。"""
    now = time.time()
    cached = _names_cache["names"]
    if cached is not None and (now - _names_cache["at"]) <= CONTACT_CACHE_TTL_SEC:
        return cached
    try:
        from .core import contacts as contacts_module

        contacts_module._contact_names = None
        contacts_module._contact_full = None
    except Exception:
        pass
    names = ctx.get_contact_names()
    _names_cache["names"] = names
    _names_cache["at"] = now
    return names


def _clamp_int(value, low: int, high: int, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, parsed))


# --------------------------------------------------------------------------
# 会话与消息
# --------------------------------------------------------------------------

SESSION_SQL = """
    SELECT username, unread_count, summary, last_timestamp,
           last_msg_type, last_msg_sender, last_sender_display_name
    FROM SessionTable
    WHERE last_timestamp > 0
    ORDER BY last_timestamp DESC
    LIMIT ?
"""


def _fetch_sessions(ctx, limit: int):
    """结构化会话列表（字段为 camelCase，直接给 JS 用）。"""
    from contextlib import closing

    from .core.messages import decompress_content, format_msg_type

    path = ctx.cache.get(os.path.join("session", "session.db"))
    if not path:
        raise BridgeError("session_db_unavailable", "无法解密 session.db")

    names = _contact_names(ctx)
    with closing(sqlite3.connect(path)) as conn:
        rows = conn.execute(SESSION_SQL, (limit,)).fetchall()

    chats = []
    for username, unread, summary, ts, msg_type, sender, sender_name in rows:
        display = names.get(username, username)
        is_group = "@chatroom" in (username or "")
        if isinstance(summary, bytes):
            summary = decompress_content(summary, 4) or "(已压缩)"
        if isinstance(summary, str) and ":\n" in summary:
            summary = summary.split(":\n", 1)[1]
        sender_display = ""
        if is_group and sender:
            sender_display = names.get(sender, sender_name or sender)
        timestamp = int(ts or 0)
        chats.append(
            {
                "username": username,
                "chat": display,
                "isGroup": is_group,
                "unread": unread or 0,
                "lastMessage": str(summary or ""),
                "msgType": format_msg_type(msg_type),
                "msgTypeRaw": int(msg_type or 0),
                "sender": sender_display,
                "lastSenderName": sender_name or "",
                "timestamp": timestamp,
                "time": datetime.fromtimestamp(timestamp).strftime("%m-%d %H:%M")
                if timestamp
                else "",
            }
        )
    return chats


# `[2026-01-02 03:04] 张三: 正文` / `[2026-01-02 03:04] 正文`（无发送者标签）
_HISTORY_RE = re.compile(
    r"^\[(?P<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*"
    r"(?:(?P<label>[^:]{1,64}):\s*)?(?P<text>.*)$",
    re.S,
)


def parse_history_lines(lines, self_label: str = "me"):
    """把 ``collect_chat_history`` 的格式化行解析成结构化消息。

    ``isSelf`` 由 ``label == self_label`` 判定；历史上"自己"的标签固定来自
    ``display_name_for_username``（对自己返回 ``me``）。
    若检测到图片媒体标记，抽取结构化 ``media`` 字段。
    """
    parsed = []
    for raw in lines or []:
        if not isinstance(raw, str):
            continue
        match = _HISTORY_RE.match(raw)
        if not match:
            parsed.append({"time": "", "label": "", "text": raw, "isSelf": False})
            continue
        label = (match.group("label") or "").strip()
        text_content = match.group("text") or ""
        msg_obj = {
            "time": match.group("time"),
            "label": label,
            "text": text_content,
            "isSelf": bool(label) and label == self_label,
        }
        if text_content.startswith("[图片]"):
            path_part = text_content[len("[图片]"):].strip()
            m_path = re.match(r"^(.*?)(?:\s*\([^\)]*\))?$", path_part)
            clean_path = m_path.group(1).strip() if m_path else path_part
            file_missing = "不存在" in path_part or "not exist" in path_part.lower() or not os.path.isfile(clean_path)
            if clean_path and not clean_path.startswith("(local_id=") and not clean_path.lower().endswith(".dat"):
                ext = os.path.splitext(clean_path)[1].lower()
                if ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"):
                    msg_obj["media"] = {
                        "type": "image",
                        "decodedPath": clean_path,
                        "exists": os.path.isfile(clean_path),
                    }
        parsed.append(msg_obj)
    return parsed


def _resolve_chat(ctx, chat: str):
    from .core.messages import resolve_chat_context

    return resolve_chat_context(chat, ctx.msg_db_keys, ctx.cache, ctx.decrypted_dir)


# --------------------------------------------------------------------------
# 命令实现
# --------------------------------------------------------------------------

def cmd_hello(_args):
    from .core.config import CONFIG_FILE, KEYS_FILE, STATE_DIR

    return {
        "protocol": PROTOCOL_VERSION,
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "stateDir": STATE_DIR,
        "configFile": CONFIG_FILE,
        "keysFile": KEYS_FILE,
        "hasConfig": os.path.exists(CONFIG_FILE),
        "keyCount": _keys_count(),
        "wechatRunning": _wechat_running(),
        "process": _default_process_name(),
    }


def cmd_detect_db_dir(args):
    db_dir, source, candidates = _detect_db_dir(args.get("dbDir"))
    return {
        "dbDir": db_dir,
        "source": source,
        "candidates": candidates,
        "found": bool(db_dir),
        "reason": None if db_dir else "no_db_dir",
    }


def cmd_ensure_init(args):
    """把「自动抓取微信密钥」做成一条幂等命令。

    - 已初始化且非 ``force`` ⇒ 直接返回，不碰微信进程；
    - 微信没登录 ⇒ 返回 ``weixin_not_running``（调用方退避重试即可，不算错误）；
    - 提取过程 stdout 全进缓冲，绝不污染协议帧。
    """
    from .core.config import CONFIG_FILE, KEYS_FILE

    force = bool(args.get("force"))

    if not force:
        existing = _keys_count()
        if existing > 0 and os.path.exists(CONFIG_FILE):
            with contextlib.suppress(Exception):
                with open(CONFIG_FILE, encoding="utf-8") as handle:
                    cfg = json.load(handle) or {}
                return {
                    "dbDir": cfg.get("db_dir"),
                    "source": "config",
                    "keyCount": existing,
                    "configWritten": False,
                    "log": [],
                }

    db_dir, source, candidates = _detect_db_dir(args.get("dbDir"))
    if not db_dir:
        return {
            "ok": False,
            "reason": "no_db_dir",
            "message": "未找到微信数据目录（db_storage）",
            "candidates": candidates,
            "log": [],
        }

    if not _wechat_running():
        return {
            "ok": False,
            "reason": "weixin_not_running",
            "message": f"{_default_process_name()} 未运行，请先登录微信",
            "dbDir": db_dir,
            "source": source,
            "log": [],
        }

    os.makedirs(os.path.dirname(KEYS_FILE), exist_ok=True)

    cap = _CaptureStdout()
    try:
        from .keys import extract_keys

        with cap:
            key_map = extract_keys(db_dir, KEYS_FILE)
    except RuntimeError as exc:
        message = str(exc)
        reason = "weixin_not_running" if "未运行" in message else "extract_failed"
        return {
            "ok": False,
            "reason": reason,
            "message": message,
            "dbDir": db_dir,
            "source": source,
            "log": cap.tail(),
        }
    except Exception as exc:  # pragma: no cover - 依赖平台
        return {
            "ok": False,
            "reason": "extract_failed",
            "message": f"{type(exc).__name__}: {exc}",
            "dbDir": db_dir,
            "source": source,
            "log": cap.tail(),
        }

    key_count = len(key_map) if isinstance(key_map, dict) else 0
    if key_count <= 0:
        key_count = _keys_count()
    if key_count <= 0:
        return {
            "ok": False,
            "reason": "extract_failed",
            "message": "未能从微信进程中提取到密钥",
            "dbDir": db_dir,
            "source": source,
            "log": cap.tail(),
        }

    # 密钥拿到了才写 config（与 init_cmd 一致：失败不留半截状态）
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as handle:
            json.dump({"db_dir": db_dir}, handle, indent=2, ensure_ascii=False)
    except Exception as exc:
        return {
            "ok": False,
            "reason": "config_write_failed",
            "message": str(exc),
            "dbDir": db_dir,
            "source": source,
            "keyCount": key_count,
            "log": cap.tail(),
        }

    _reset_context()
    return {
        "dbDir": db_dir,
        "source": source,
        "keyCount": key_count,
        "configWritten": True,
        "log": cap.tail(),
    }


def cmd_sessions(args):
    limit = _clamp_int(args.get("limit"), 1, MAX_SESSION_LIMIT, DEFAULT_SESSION_LIMIT)
    ctx = _get_ctx()
    chats = _fetch_sessions(ctx, limit)
    return {"count": len(chats), "chats": chats}


def cmd_history(args):
    chat = str(args.get("chat") or "").strip()
    if not chat:
        raise BridgeError("bad_request", "缺少 chat 参数")
    limit = _clamp_int(args.get("limit"), 1, MAX_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT)

    ctx = _get_ctx()
    from .core.contacts import display_name_for_username, get_self_username
    from .core.messages import collect_chat_history

    chat_ctx = _resolve_chat(ctx, chat)
    if not chat_ctx:
        raise BridgeError("chat_not_found", f"未找到会话: {chat}")
    if not chat_ctx.get("db_path"):
        raise BridgeError(
            "no_messages", f"{chat_ctx.get('display_name') or chat} 没有消息记录"
        )

    names = _contact_names(ctx)
    self_username = ""
    with contextlib.suppress(Exception):
        self_username = get_self_username(ctx.db_dir, ctx.cache, ctx.decrypted_dir) or ""
    self_label = "me"
    with contextlib.suppress(Exception):
        self_label = (
            display_name_for_username(
                self_username, names, ctx.db_dir, ctx.cache, ctx.decrypted_dir
            )
            or "me"
        )

    lines, failures = collect_chat_history(
        chat_ctx,
        names,
        ctx.display_name_for_username,
        start_ts=None,
        end_ts=None,
        limit=limit,
        offset=0,
        msg_type_filter=None,
        resolve_media=True,
        db_dir=ctx.db_dir,
    )
    messages = parse_history_lines(lines, self_label)
    return {
        "chat": chat_ctx.get("display_name") or chat,
        "username": chat_ctx.get("username") or "",
        "isGroup": bool(chat_ctx.get("is_group")),
        "selfUsername": self_username,
        "selfLabel": self_label,
        "count": len(messages),
        "lines": lines,
        "messages": messages,
        "failures": failures or [],
    }


def cmd_resolve(args):
    wanted = args.get("names") or []
    if not isinstance(wanted, list):
        raise BridgeError("bad_request", "names 必须是数组")

    ctx = _get_ctx()
    from .core.contacts import resolve_username

    mapping, unresolved = {}, []
    for item in wanted:
        name = str(item or "").strip()
        if not name:
            continue
        resolved = None
        with contextlib.suppress(Exception):
            resolved = resolve_username(name, ctx.cache, ctx.decrypted_dir)
        if resolved:
            mapping[name] = resolved
        else:
            unresolved.append(name)
    return {"map": mapping, "unresolved": unresolved}


def cmd_overview(args):
    """今日概览：未读、消息最多的会话。只扫最近 ``OVERVIEW_TOP_CHATS`` 个会话。"""
    from .core.messages import collect_chat_stats, parse_time_range

    ctx = _get_ctx()

    start_time = str(args.get("startTime") or date.today().strftime("%Y-%m-%d"))
    end_time = str(args.get("endTime") or "")
    try:
        start_ts, end_ts = parse_time_range(start_time, end_time)
    except ValueError as exc:
        raise BridgeError("bad_request", str(exc)) from exc

    chats = _fetch_sessions(ctx, DEFAULT_SESSION_LIMIT)
    unread = [chat for chat in chats if chat["unread"] > 0]

    today, failures, total = [], [], 0
    for chat in chats[:OVERVIEW_TOP_CHATS]:
        try:
            chat_ctx = _resolve_chat(ctx, chat["username"])
            if not chat_ctx or not chat_ctx.get("db_path"):
                continue
            names = _contact_names(ctx)
            stats = collect_chat_stats(
                chat_ctx,
                names,
                ctx.display_name_for_username,
                start_ts=start_ts,
                end_ts=end_ts,
            )
            count = int(stats.get("total") or 0)
        except Exception as exc:
            failures.append({"chat": chat["chat"], "error": str(exc)})
            continue
        if count > 0:
            today.append(
                {
                    "chat": chat["chat"],
                    "username": chat["username"],
                    "isGroup": chat["isGroup"],
                    "count": count,
                    "lastMessage": chat["lastMessage"],
                    "ts": chat["timestamp"],
                }
            )
            total += count

    today.sort(key=lambda item: item["count"], reverse=True)
    return {
        "startTime": start_time,
        "endTime": end_time,
        "startTs": start_ts,
        "endTs": end_ts,
        "unreadTotal": sum(chat["unread"] for chat in unread),
        "unread": unread,
        "sessionCount": len(chats),
        "today": today,
        "totalToday": total,
        "scanned": min(len(chats), OVERVIEW_TOP_CHATS),
        "failures": failures,
    }


def cmd_ping(_args):
    return {"pong": True, "ts": int(time.time())}


def cmd_shutdown(_args):
    return {"bye": True}


def cmd_sample_my_messages(args):
    """跨会话提取主人（本人）的历史真实聊天消息与典型问答对，用于语言风格画像蒸馏。"""
    limit = _clamp_int(args.get("limit"), 50, 3000, 500)
    max_sessions = _clamp_int(args.get("maxSessions"), 10, 200, 80)

    ctx = _get_ctx()
    from collections import Counter
    from .core.contacts import display_name_for_username, get_self_username
    from .core.messages import collect_chat_history

    names = _contact_names(ctx)
    self_username = ""
    with contextlib.suppress(Exception):
        self_username = get_self_username(ctx.db_dir, ctx.cache, ctx.decrypted_dir) or ""
    self_label = "me"
    with contextlib.suppress(Exception):
        self_label = (
            display_name_for_username(
                self_username, names, ctx.db_dir, ctx.cache, ctx.decrypted_dir
            )
            or "me"
        )

    all_sessions = _fetch_sessions(ctx, max_sessions)
    candidate_chats = [
        s
        for s in all_sessions
        if not (s.get("username") or "").startswith("gh_")
        and (s.get("username") or "")
        not in (
            "brandsessionholder",
            "notifymessage",
            "filehelper",
            "fmessage",
            "medianote",
            "floatbottle",
            "newsapp",
        )
    ]

    bad_prefixes = (
        "[图片]",
        "[表情]",
        "[视频]",
        "[语音]",
        "[文件]",
        "[链接/文件]",
        "[名片]",
        "[通话]",
        "[转账]",
        "[微信红包]",
        "[红包]",
        "[位置]",
        "[聊天记录]",
        "[笔记]",
        "[系统]",
    )

    def _is_clean(t: str) -> bool:
        if not t or not isinstance(t, str):
            return False
        s = t.strip()
        if not s:
            return False
        if any(s.startswith(p) for p in bad_prefixes):
            return False
        if "<?xml" in s or "<msg" in s:
            return False
        if "撤回了一条消息" in s or "revokemsg" in s:
            return False
        if "收到转账" in s or "已收钱" in s:
            return False
        if "【淘宝】" in s or "e.tb.cn" in s or "jd.com" in s or "pinduoduo" in s:
            return False
        if re.fullmatch(r"\d{4,8}", s):
            return False
        if not re.search(r"[\u4e00-\u9fff\w]", s):
            return False
        return True

    my_samples = []
    qa_pairs = []
    scanned_count = 0

    for c in candidate_chats:
        if len(my_samples) >= limit:
            break
        chat_ctx = _resolve_chat(ctx, c["username"])
        if not chat_ctx or not chat_ctx.get("db_path"):
            continue
        scanned_count += 1
        needed = limit - len(my_samples)
        fetch_limit = min(200, max(50, needed + 30))
        lines, _ = collect_chat_history(
            chat_ctx,
            names,
            ctx.display_name_for_username,
            limit=fetch_limit,
            offset=0,
            resolve_media=False,
            db_dir=ctx.db_dir,
        )
        msgs = parse_history_lines(lines, self_label)
        chrono_msgs = list(reversed(msgs))
        last_other = None
        for m in chrono_msgs:
            t = m.get("text", "")
            if not _is_clean(t):
                continue
            if m.get("isSelf"):
                my_samples.append({"text": t, "chat": c.get("chat") or "", "time": m.get("time") or ""})
                if last_other:
                    qa_pairs.append({
                        "context": last_other.get("text", ""),
                        "reply": t,
                        "chat": c.get("chat") or "",
                    })
                    last_other = None
                if len(my_samples) >= limit:
                    break
            else:
                last_other = m

    total = len(my_samples)
    if total == 0:
        return {
            "ok": False,
            "reason": "no_messages",
            "message": "未能从本地会话中扫描到主人本人的有效文本发言",
        }

    lengths = [len(m["text"]) for m in my_samples]
    avg_len = sum(lengths) / total
    sorted_len = sorted(lengths)
    median_len = sorted_len[total // 2]

    # 标点符号与断句统计
    dot_count = sum(1 for m in my_samples if ("。" in m["text"] or "." in m["text"]))
    space_count = sum(1 for m in my_samples if (" " in m["text"] or "　" in m["text"]))
    q_count = sum(1 for m in my_samples if ("？" in m["text"] or "?" in m["text"]))
    excl_count = sum(1 for m in my_samples if ("！" in m["text"] or "!" in m["text"]))
    tilde_count = sum(1 for m in my_samples if ("~" in m["text"] or "～" in m["text"]))
    ellipsis_count = sum(1 for m in my_samples if ("..." in m["text"] or "。。。" in m["text"]))

    # 表情符号统计：微信表情 [xxx] + Unicode Emoji
    emoji_counter = Counter()
    for m in my_samples:
        txt = m["text"]
        wx_emojis = re.findall(r"\[[\u4e00-\u9fa5a-zA-Z0-9]{1,8}\]", txt)
        for e in wx_emojis:
            emoji_counter[e] += 1
        unicode_emojis = re.findall(
            r"[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF\U00002702-\U000027B0]",
            txt,
        )
        for e in unicode_emojis:
            emoji_counter[e] += 1

    # 高频词汇统计
    word_counter = Counter()
    stop_words = {"这个", "那个", "就是", "什么", "怎么", "可以", "一下", "没有", "不是", "还是", "现在", "感觉", "觉得"}
    for m in my_samples:
        txt = m["text"]
        words = re.findall(r"[\u4e00-\u9fa5]{2,6}", txt)
        for w in words:
            if w not in stop_words:
                word_counter[w] += 1

    # 挑选多样性好的 QA 样本对（最多 25 组）
    selected_qa = []
    seen_replies = set()
    for item in qa_pairs:
        ctx_txt = item["context"].strip()
        rep_txt = item["reply"].strip()
        if len(rep_txt) < 2 or rep_txt in seen_replies:
            continue
        seen_replies.add(rep_txt)
        selected_qa.append(item)
        if len(selected_qa) >= 25:
            break

    # 抽样 30 条纯粹发言
    sample_texts = [m["text"] for m in my_samples[:: max(1, total // 30)]][:30]

    return {
        "ok": True,
        "sampleCount": total,
        "scannedSessions": scanned_count,
        "selfUsername": self_username,
        "selfLabel": self_label,
        "stats": {
            "avgLength": round(avg_len, 1),
            "medianLength": median_len,
            "shortPct": round(sum(1 for l in lengths if l <= 5) / total * 100, 1),
            "mediumPct": round(sum(1 for l in lengths if 6 <= l <= 15) / total * 100, 1),
            "longPct": round(sum(1 for l in lengths if l > 15) / total * 100, 1),
            "dotRate": round(dot_count / total * 100, 1),
            "spaceRate": round(space_count / total * 100, 1),
            "questionRate": round(q_count / total * 100, 1),
            "exclRate": round(excl_count / total * 100, 1),
            "tildeRate": round(tilde_count / total * 100, 1),
            "ellipsisRate": round(ellipsis_count / total * 100, 1),
            "topEmojis": [e for e, _ in emoji_counter.most_common(12)],
            "topWords": [w for w, _ in word_counter.most_common(15)],
        },
        "dialoguePairs": selected_qa,
        "sampleReplies": sample_texts,
    }


HANDLERS = {
    "hello": cmd_hello,
    "detect_db_dir": cmd_detect_db_dir,
    "ensure_init": cmd_ensure_init,
    "sessions": cmd_sessions,
    "history": cmd_history,
    "resolve": cmd_resolve,
    "overview": cmd_overview,
    "ping": cmd_ping,
    "shutdown": cmd_shutdown,
    "sample_my_messages": cmd_sample_my_messages,
}


# --------------------------------------------------------------------------
# 分发与主循环
# --------------------------------------------------------------------------

def handle(request):
    """单条请求 → 单条响应 dict（永不抛出）。"""
    if not isinstance(request, dict):
        return {"id": None, "ok": False, "code": "bad_request", "error": "请求必须是 JSON 对象"}

    req_id = request.get("id")
    cmd = request.get("cmd")
    handler = HANDLERS.get(cmd)
    if handler is None:
        return {
            "id": req_id,
            "ok": False,
            "code": "unknown_command",
            "error": f"未知命令: {cmd}",
        }

    try:
        payload = handler(request) or {}
    except BridgeError as exc:
        return {"id": req_id, "ok": False, "code": exc.code, "error": exc.message}
    except FileNotFoundError as exc:
        return {
            "id": req_id,
            "ok": False,
            "code": "not_initialized",
            "error": str(exc),
        }
    except Exception as exc:
        return {
            "id": req_id,
            "ok": False,
            "code": "internal_error",
            "error": f"{type(exc).__name__}: {exc}",
            "trace": traceback.format_exc(limit=3),
        }

    response = {"id": req_id, "ok": True}
    response.update(payload)
    return response


def main() -> int:
    """从 stdin 读请求直到 EOF。"""
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            _write({"id": None, "ok": False, "code": "bad_json", "error": str(exc)})
            continue

        response = handle(request)
        _write(response)
        if request.get("cmd") == "shutdown" and response.get("ok"):
            return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
