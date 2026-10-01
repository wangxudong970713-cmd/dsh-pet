"""消息查询 — 分表查找、分页、格式化"""

import hashlib
import os
import re
import sqlite3
import xml.etree.ElementTree as ET
from contextlib import closing
from datetime import datetime

import zstandard as zstd

from .key_utils import key_path_variants
from .image_decoder import decode_dat_file, detect_image_format

_zstd_dctx = zstd.ZstdDecompressor()
_XML_UNSAFE_RE = re.compile(r'<!DOCTYPE|<!ENTITY', re.IGNORECASE)
_XML_PARSE_MAX_LEN = 20000
_QUERY_LIMIT_MAX = 500
_HISTORY_QUERY_BATCH_SIZE = 500

# 消息类型过滤映射: 名称 -> (base_type,) 或 (base_type, sub_type)
MSG_TYPE_FILTERS = {
    'text': (1,),
    'image': (3,),
    'voice': (34,),
    'video': (43,),
    'sticker': (47,),
    'location': (48,),
    'link': (49,),
    'file': (49, 6),
    'call': (50,),
    'system': (10000,),
}
MSG_TYPE_NAMES = list(MSG_TYPE_FILTERS.keys())


# ---- 消息 DB 发现 ----

def find_msg_db_keys(all_keys):
    return sorted([
        k for k in all_keys
        if any(v.startswith("message/") for v in key_path_variants(k))
        and any(re.search(r"message_\d+\.db$", v) for v in key_path_variants(k))
    ])


def _is_safe_msg_table_name(table_name):
    return bool(re.fullmatch(r'Msg_[0-9a-f]{32}', table_name))


def _find_msg_tables_for_user(username, msg_db_keys, cache):
    table_hash = hashlib.md5(username.encode()).hexdigest()
    table_name = f"Msg_{table_hash}"
    if not _is_safe_msg_table_name(table_name):
        return []
    matches = []
    for rel_key in msg_db_keys:
        path = cache.get(rel_key)
        if not path:
            continue
        conn = sqlite3.connect(path)
        try:
            exists = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (table_name,)
            ).fetchone()
            if not exists:
                continue
            max_ct = conn.execute(f"SELECT MAX(create_time) FROM [{table_name}]").fetchone()[0] or 0
            matches.append({'db_path': path, 'table_name': table_name, 'max_create_time': max_ct})
        except Exception:
            pass
        finally:
            conn.close()
    matches.sort(key=lambda x: x['max_create_time'], reverse=True)
    return matches


# ---- 消息类型 ----

def _split_msg_type(t):
    try:
        t = int(t)
    except (TypeError, ValueError):
        return 0, 0
    if t > 0xFFFFFFFF:
        return t & 0xFFFFFFFF, t >> 32
    return t, 0


def format_msg_type(t):
    base_type, _ = _split_msg_type(t)
    return {
        1: '文本', 3: '图片', 34: '语音', 42: '名片',
        43: '视频', 47: '表情', 48: '位置', 49: '链接/文件',
        50: '通话', 10000: '系统', 10002: '撤回',
    }.get(base_type, f'type={t}')


# ---- 内容解压 ----

def decompress_content(content, ct):
    if ct and ct == 4 and isinstance(content, bytes):
        try:
            return _zstd_dctx.decompress(content).decode('utf-8', errors='replace')
        except Exception:
            return None
    if isinstance(content, bytes):
        try:
            return content.decode('utf-8', errors='replace')
        except Exception:
            return None
    return content


# ---- 内容解析 ----

def _parse_message_content(content, local_type, is_group):
    if content is None:
        return '', ''
    if isinstance(content, bytes):
        return '', '(二进制内容)'
    sender = ''
    text = content
    if is_group and ':\n' in content:
        sender, text = content.split(':\n', 1)
    return sender, text


def _collapse_text(text):
    if not text:
        return ''
    return re.sub(r'\s+', ' ', text).strip()


def _parse_xml_root(content):
    if not content or len(content) > _XML_PARSE_MAX_LEN or _XML_UNSAFE_RE.search(content):
        return None
    try:
        return ET.fromstring(content)
    except ET.ParseError:
        return None


def _parse_int(value, fallback=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _format_app_message_text(content, local_type, is_group, chat_username, chat_display_name, names, _display_name_fn, resolve_media=False, db_dir=None, create_time_ts=0):
    if not content or '<appmsg' not in content:
        return None
    _, sub_type = _split_msg_type(local_type)
    root = _parse_xml_root(content)
    if root is None:
        return None
    appmsg = root.find('.//appmsg')
    if appmsg is None:
        return None
    title = _collapse_text(appmsg.findtext('title') or '')
    app_type = _parse_int((appmsg.findtext('type') or '').strip(), _parse_int(sub_type, 0))

    if app_type == 57:
        ref = appmsg.find('.//refermsg')
        ref_content = ''
        ref_display_name = ''
        if ref is not None:
            ref_display_name = (ref.findtext('displayname') or '').strip()
            ref_content = _collapse_text(ref.findtext('content') or '')
        if len(ref_content) > 160:
            ref_content = ref_content[:160] + "..."
        quote_text = title or "[引用消息]"
        if ref_content:
            prefix = f"回复 {ref_display_name}: " if ref_display_name else "回复: "
            quote_text += f"\n  ↳ {prefix}{ref_content}"
        return quote_text
    if app_type == 6:
        # Try to resolve file path
        if resolve_media and db_dir:
            msg_dir = os.path.join(os.path.dirname(db_dir), "msg", "file")
            if title and os.path.isdir(msg_dir):
                from datetime import datetime as _dt
                dt = _dt.fromtimestamp(create_time_ts) if create_time_ts else None
                if dt:
                    file_dir = os.path.join(msg_dir, dt.strftime("%Y-%m"))
                    if os.path.isdir(file_dir):
                        target = os.path.join(file_dir, title)
                        if os.path.isfile(target):
                            return f"[文件] {title}\n  {target}"
                        # Fuzzy match
                        for f in os.listdir(file_dir):
                            if title in f or f in title:
                                return f"[文件] {title}\n  {os.path.join(file_dir, f)}"
        return f"[文件] {title}" if title else "[文件]"
    if app_type == 5:
        return f"[链接] {title}" if title else "[链接]"
    if app_type in (33, 36, 44):
        return f"[小程序] {title}" if title else "[小程序]"
    if title:
        return f"[链接/文件] {title}"
    return "[链接/文件]"


def _format_voip_message_text(content):
    if not content or '<voip' not in content:
        return None
    root = _parse_xml_root(content)
    if root is None:
        return "[通话]"
    raw_text = _collapse_text(root.findtext('.//msg') or '')
    if not raw_text:
        return "[通话]"
    status_map = {
        'Canceled': '已取消', 'Line busy': '对方忙线',
        'Call not answered': '未接听', "Call wasn't answered": '未接听',
    }
    if raw_text.startswith('Duration:'):
        duration = raw_text.split(':', 1)[1].strip()
        return f"[通话] 通话时长 {duration}" if duration else "[通话]"
    return f"[通话] {status_map.get(raw_text, raw_text)}"


def _extract_img_md5s(content, packed_info_data=None):
    """从消息内容 (XML 或二进制) 与 packed_info_data 中提取所有候选图片 MD5。"""
    candidates = []
    # 1. 微信 4.0 绝杀技：从 packed_info_data (BLOB) 提取 32 位 MD5
    if packed_info_data and isinstance(packed_info_data, (bytes, bytearray)):
        for m in re.findall(b'[a-fA-F0-9]{32}', packed_info_data):
            s = m.decode('ascii', errors='ignore').lower()
            if s not in candidates:
                candidates.append(s)

    # 2. 从 content (可能是 XML str, 可能是 raw bytes) 提取
    if content:
        text_content = None
        if isinstance(content, str):
            text_content = content
        elif isinstance(content, (bytes, bytearray)):
            try:
                text_content = _zstd_dctx.decompress(content).decode('utf-8', errors='replace')
            except Exception:
                try:
                    text_content = content.decode('utf-8', errors='replace')
                except Exception:
                    pass
        if text_content:
            root = _parse_xml_root(text_content)
            if root is not None:
                img_node = root.find('.//img')
                if img_node is not None:
                    md5 = (img_node.get('md5') or '').strip().lower()
                    if md5 and md5 not in candidates:
                        candidates.append(md5)
            for m in re.finditer(r'md5=["\']([a-fA-F0-9]{32})["\']', text_content):
                s = m.group(1).lower()
                if s not in candidates:
                    candidates.append(s)
    return candidates


def _extract_img_md5(content):
    md5s = _extract_img_md5s(content)
    return md5s[0] if md5s else None


def _resolve_media_path(db_dir, content, local_type, create_time_ts, chat_username=None, packed_info_data=None):
    """尝试解析媒体文件在磁盘上的路径并对图片进行自动解密。

    Args:
        db_dir: 微信 db_storage 目录
        content: 解压后的 message_content 或原始数据
        local_type: 消息类型
        create_time_ts: 消息时间戳
        chat_username: 聊天对象 username（用于定位 attach 子目录）
        packed_info_data: 附加 protobuf 数据（包含本地真实文件 MD5）

    Returns:
        (path, exists) 元组，path 为 None 表示无法解析
    """
    base_type = local_type & 0xFFFFFFFF
    wechat_base = os.path.dirname(db_dir)
    msg_dir = os.path.join(wechat_base, "msg")

    from datetime import datetime
    dt = datetime.fromtimestamp(create_time_ts) if create_time_ts else datetime.now()
    date_prefix = dt.strftime("%Y-%m")

    # 文件消息 (type 49, sub 6): msg/file/YYYY-MM/filename
    if base_type == 49 and content and os.path.isdir(msg_dir):
        root = _parse_xml_root(content) if isinstance(content, str) else None
        if root is not None:
            appmsg = root.find('.//appmsg')
            if appmsg is not None:
                app_type = _parse_int((appmsg.findtext('type') or '').strip())
                if app_type == 6:
                    title = (appmsg.findtext('title') or '').strip()
                    if title:
                        file_dir = os.path.join(msg_dir, "file", date_prefix)
                        if os.path.isdir(file_dir):
                            target = os.path.join(file_dir, title)
                            if os.path.isfile(target):
                                return target, True
                            for f in os.listdir(file_dir):
                                if title in f or f in title:
                                    return os.path.join(file_dir, f), True
        return None, False

    # 图片消息 (type 3)
    if base_type == 3:
        img_md5s = _extract_img_md5s(content, packed_info_data)

        # 0. 优先命中微信 4.0 官方本地原生明文图片缓存（无需解密，零损耗秒出）
        image_utils_dir = os.path.join(wechat_base, "temp", "ImageUtils")
        if os.path.isdir(image_utils_dir) and img_md5s:
            for md5 in img_md5s:
                for ext in ("_h.jpg", ".jpg", ".png", ".webp", "_h.png", "_t.jpg"):
                    cand = os.path.join(image_utils_dir, md5 + ext)
                    if os.path.isfile(cand) and os.path.getsize(cand) > 0:
                        fmt = detect_image_format(cand)
                        if fmt:
                            return cand, True

        candidate_dirs = []

        # 1. 微信 4.x: msg/attach/<hash>/YYYY-MM/Img/
        attach_dir = os.path.join(msg_dir, "attach")
        if os.path.isdir(attach_dir):
            target_hash = None
            if chat_username:
                h = hashlib.md5(chat_username.encode()).hexdigest()
                if os.path.isdir(os.path.join(attach_dir, h)):
                    target_hash = h
            search_dirs = [target_hash] if target_hash else [
                d for d in os.listdir(attach_dir) if os.path.isdir(os.path.join(attach_dir, d))
            ]
            for d in search_dirs:
                img_sub = os.path.join(attach_dir, d, date_prefix, "Img")
                if os.path.isdir(img_sub):
                    candidate_dirs.append(img_sub)

        # 2. 微信 3.x 兼容: FileStorage/MsgAttach/<hash>/Image/YYYY-MM/
        v3_attach_dir = os.path.join(wechat_base, "FileStorage", "MsgAttach")
        if os.path.isdir(v3_attach_dir):
            for d in os.listdir(v3_attach_dir):
                for sub_kind in ("Image", "Thumb"):
                    v3_sub = os.path.join(v3_attach_dir, d, sub_kind, date_prefix)
                    if os.path.isdir(v3_sub):
                        candidate_dirs.append(v3_sub)

        matched_dat = None
        # 优先按 MD5 精准匹配 .dat 文件（含高清原图与普通图）
        if img_md5s:
            for c_dir in candidate_dirs:
                for md5 in img_md5s:
                    for suffix in ("", "_h", "_t"):
                        exact = os.path.join(c_dir, f"{md5}{suffix}.dat")
                        if os.path.isfile(exact):
                            matched_dat = exact
                            break
                    if matched_dat:
                        break
                if matched_dat:
                    break

        # 若仍未精准匹配，且候选目录存在包含 MD5 的文件
        if not matched_dat and img_md5s:
            for c_dir in candidate_dirs:
                try:
                    for f in os.listdir(c_dir):
                        if f.endswith(".dat") and any(md5 in f.lower() for md5 in img_md5s):
                            matched_dat = os.path.join(c_dir, f)
                            break
                except OSError:
                    continue
                if matched_dat:
                    break

        # 若无 MD5 或未匹配到，则按消息时间戳寻找时间最接近的文件（不再盲目抓取第 0 个）
        if not matched_dat and candidate_dirs and create_time_ts:
            best_diff = 300.0  # 最多允许相差 5 分钟
            for c_dir in candidate_dirs:
                try:
                    for f in os.listdir(c_dir):
                        if not f.endswith(".dat"):
                            continue
                        f_path = os.path.join(c_dir, f)
                        try:
                            mtime = os.path.getmtime(f_path)
                            diff = abs(mtime - create_time_ts)
                            if diff < best_diff:
                                best_diff = diff
                                matched_dat = f_path
                        except OSError:
                            continue
                except OSError:
                    continue

        if matched_dat:
            # 自动解密 .dat 为原生图片
            decoded_path = decode_dat_file(matched_dat)
            if decoded_path and os.path.isfile(decoded_path):
                return decoded_path, True
            return None, False

        return None, False

    # 视频/语音消息 (type 34, 43)
    if base_type in (34, 43):
        attach_dir = os.path.join(msg_dir, "attach")
        if os.path.isdir(attach_dir):
            target_hash = None
            if chat_username:
                h = hashlib.md5(chat_username.encode()).hexdigest()
                if os.path.isdir(os.path.join(attach_dir, h)):
                    target_hash = h
            search_dirs = [target_hash] if target_hash else [
                d for d in os.listdir(attach_dir) if os.path.isdir(os.path.join(attach_dir, d))
            ]
            sub_dir_name = "Video" if base_type == 43 else "Voice"
            for d in search_dirs:
                sub = os.path.join(attach_dir, d, date_prefix, sub_dir_name)
                if os.path.isdir(sub):
                    files = [f for f in os.listdir(sub) if not f.endswith("_h.dat")]
                    if files:
                        return os.path.join(sub, files[0]), True

        if base_type == 43 and os.path.isdir(msg_dir):
            video_dir = os.path.join(msg_dir, "video", date_prefix)
            if os.path.isdir(video_dir):
                thumbs = [f for f in os.listdir(video_dir) if f.endswith("_thumb.jpg")]
                if thumbs:
                    return os.path.join(video_dir, thumbs[0]), True

    return None, False


def _format_message_text(local_id, local_type, content, is_group, chat_username, chat_display_name, names, display_name_fn, db_dir=None, create_time_ts=0, resolve_media=False, packed_info_data=None):
    sender, text = _parse_message_content(content, local_type, is_group)
    base_type, _ = _split_msg_type(local_type)

    media_path = None
    media_exists = False
    if resolve_media and db_dir and (content or packed_info_data):
        try:
            media_path, media_exists = _resolve_media_path(
                db_dir, content, local_type, create_time_ts, chat_username, packed_info_data=packed_info_data
            )
        except Exception:
            pass

    if base_type == 3:
        if media_path:
            tag = f"[图片] {media_path}"
            if not media_exists:
                tag += " (文件不存在)"
        else:
            tag = f"[图片] (local_id={local_id})"
        text = tag
    elif base_type == 47:
        text = "[表情]"
    elif base_type == 50:
        text = _format_voip_message_text(text) or "[通话]"
    elif base_type == 49:
        text = _format_app_message_text(
            text, local_type, is_group, chat_username, chat_display_name, names, display_name_fn,
            resolve_media=resolve_media, db_dir=db_dir, create_time_ts=create_time_ts
        ) or "[链接/文件]"
    elif base_type != 1:
        type_label = format_msg_type(local_type)
        text = f"[{type_label}] {text}" if text else f"[{type_label}]"
    return sender, text


# ---- Name2Id ----

def _load_name2id_maps(conn):
    id_to_username = {}
    try:
        rows = conn.execute("SELECT rowid, user_name FROM Name2Id").fetchall()
    except sqlite3.Error:
        return id_to_username
    for rowid, user_name in rows:
        if not user_name:
            continue
        id_to_username[rowid] = user_name
    return id_to_username


# ---- 发送者解析 ----

def _resolve_sender_label(real_sender_id, sender_from_content, is_group, chat_username, chat_display_name, names, id_to_username, display_name_fn):
    sender_username = id_to_username.get(real_sender_id, '')
    if is_group:
        if sender_username and sender_username != chat_username:
            return display_name_fn(sender_username, names)
        if sender_from_content:
            return display_name_fn(sender_from_content, names)
        return ''
    if sender_username == chat_username:
        return chat_display_name
    if sender_username:
        return display_name_fn(sender_username, names)
    return ''


# ---- SQL 查询 ----

def _build_message_filters(start_ts=None, end_ts=None, keyword='', msg_type_filter=None):
    clauses = []
    params = []
    if start_ts is not None:
        clauses.append('create_time >= ?')
        params.append(start_ts)
    if end_ts is not None:
        clauses.append('create_time <= ?')
        params.append(end_ts)
    if keyword:
        clauses.append('message_content LIKE ?')
        params.append(f'%{keyword}%')
    if msg_type_filter is not None:
        base_type = msg_type_filter[0]
        clauses.append('(local_type & 0xFFFFFFFF) = ?')
        params.append(base_type)
        if len(msg_type_filter) > 1:
            clauses.append('((local_type >> 32) & 0xFFFFFFFF) = ?')
            params.append(msg_type_filter[1])
    return clauses, params


def _has_packed_info_data_column(conn, table_name):
    try:
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info([{table_name}])").fetchall()]
        return "packed_info_data" in cols
    except Exception:
        return False


def _query_messages(conn, table_name, start_ts=None, end_ts=None, keyword='', limit=20, offset=0, msg_type_filter=None):
    if not _is_safe_msg_table_name(table_name):
        raise ValueError(f'非法消息表名: {table_name}')
    clauses, params = _build_message_filters(start_ts, end_ts, keyword, msg_type_filter)
    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ''
    pdata_col = "packed_info_data" if _has_packed_info_data_column(conn, table_name) else "NULL AS packed_info_data"
    sql = f"""
        SELECT local_id, local_type, create_time, real_sender_id, message_content,
               WCDB_CT_message_content, {pdata_col}
        FROM [{table_name}]
        {where_sql}
        ORDER BY create_time DESC
    """
    if limit is None:
        return conn.execute(sql, params).fetchall()
    sql += "\n        LIMIT ? OFFSET ?"
    return conn.execute(sql, (*params, limit, offset)).fetchall()


# ---- 时间解析 ----

def parse_time_value(value, field_name, is_end=False):
    value = (value or '').strip()
    if not value:
        return None
    formats = [
        ('%Y-%m-%d %H:%M:%S', False),
        ('%Y-%m-%d %H:%M', False),
        ('%Y-%m-%d', True),
    ]
    for fmt, date_only in formats:
        try:
            dt = datetime.strptime(value, fmt)
            if date_only and is_end:
                dt = dt.replace(hour=23, minute=59, second=59)
            return int(dt.timestamp())
        except ValueError:
            continue
    raise ValueError(f"{field_name} 格式无效: {value}。支持 YYYY-MM-DD / YYYY-MM-DD HH:MM / YYYY-MM-DD HH:MM:SS")


def parse_time_range(start_time='', end_time=''):
    start_ts = parse_time_value(start_time, 'start_time', is_end=False)
    end_ts = parse_time_value(end_time, 'end_time', is_end=True)
    if start_ts is not None and end_ts is not None and start_ts > end_ts:
        raise ValueError('start_time 不能晚于 end_time')
    return start_ts, end_ts


def validate_pagination(limit, offset=0, limit_max=_QUERY_LIMIT_MAX):
    if limit <= 0:
        raise ValueError("limit 必须大于 0")
    if limit_max is not None and limit > limit_max:
        raise ValueError(f"limit 不能大于 {limit_max}")
    if offset < 0:
        raise ValueError("offset 不能小于 0")


# ---- 聊天上下文 ----

def resolve_chat_context(chat_name, msg_db_keys, cache, decrypted_dir):
    from .contacts import resolve_username, get_contact_names
    username = resolve_username(chat_name, cache, decrypted_dir)
    if not username:
        return None
    names = get_contact_names(cache, decrypted_dir)
    display_name = names.get(username, username)
    message_tables = _find_msg_tables_for_user(username, msg_db_keys, cache)
    if not message_tables:
        return {
            'query': chat_name, 'username': username, 'display_name': display_name,
            'db_path': None, 'table_name': None, 'message_tables': [],
            'is_group': '@chatroom' in username,
        }
    primary = message_tables[0]
    return {
        'query': chat_name, 'username': username, 'display_name': display_name,
        'db_path': primary['db_path'], 'table_name': primary['table_name'],
        'message_tables': message_tables, 'is_group': '@chatroom' in username,
    }


def _iter_table_contexts(ctx):
    tables = ctx.get('message_tables') or []
    if not tables and ctx.get('db_path') and ctx.get('table_name'):
        tables = [{'db_path': ctx['db_path'], 'table_name': ctx['table_name']}]
    for table in tables:
        yield {
            'query': ctx['query'], 'username': ctx['username'], 'display_name': ctx['display_name'],
            'db_path': table['db_path'], 'table_name': table['table_name'],
            'is_group': ctx['is_group'],
        }


def _candidate_page_size(limit, offset):
    return limit + offset


def _page_ranked_entries(entries, limit, offset):
    ordered = sorted(entries, key=lambda item: item[0], reverse=True)
    paged = ordered[offset:offset + limit]
    paged.sort(key=lambda item: item[0])
    return paged


# ---- 构建行 ----

def _build_history_line(row, ctx, names, id_to_username, display_name_fn, resolve_media=False, db_dir=None):
    if len(row) >= 7:
        local_id, local_type, create_time, real_sender_id, content, ct, packed_info_data = row[:7]
    else:
        local_id, local_type, create_time, real_sender_id, content, ct = row[:6]
        packed_info_data = None
    time_str = datetime.fromtimestamp(create_time).strftime('%Y-%m-%d %H:%M')
    content = decompress_content(content, ct)
    if content is None:
        content = '(无法解压)'
    sender, text = _format_message_text(
        local_id, local_type, content, ctx['is_group'], ctx['username'], ctx['display_name'], names, display_name_fn,
        db_dir=db_dir, create_time_ts=create_time, resolve_media=resolve_media, packed_info_data=packed_info_data,
    )
    sender_label = _resolve_sender_label(
        real_sender_id, sender, ctx['is_group'], ctx['username'], ctx['display_name'], names, id_to_username, display_name_fn
    )
    if sender_label:
        return create_time, f'[{time_str}] {sender_label}: {text}'
    return create_time, f'[{time_str}] {text}'


def _build_search_entry(row, ctx, names, id_to_username, display_name_fn, resolve_media=False, db_dir=None):
    if len(row) >= 7:
        local_id, local_type, create_time, real_sender_id, content, ct, packed_info_data = row[:7]
    else:
        local_id, local_type, create_time, real_sender_id, content, ct = row[:6]
        packed_info_data = None
    content = decompress_content(content, ct)
    if content is None:
        return None
    sender, text = _format_message_text(
        local_id, local_type, content, ctx['is_group'], ctx['username'], ctx['display_name'], names, display_name_fn,
        db_dir=db_dir, create_time_ts=create_time, resolve_media=resolve_media, packed_info_data=packed_info_data,
    )
    if text and len(text) > 300:
        text = text[:300] + '...'
    sender_label = _resolve_sender_label(
        real_sender_id, sender, ctx['is_group'], ctx['username'], ctx['display_name'], names, id_to_username, display_name_fn
    )
    time_str = datetime.fromtimestamp(create_time).strftime('%Y-%m-%d %H:%M')
    entry = f"[{time_str}] [{ctx['display_name']}]"
    if sender_label:
        entry += f" {sender_label}:"
    entry += f" {text}"
    return create_time, entry


# ---- 聊天记录查询 ----

def collect_chat_history(ctx, names, display_name_fn, start_ts=None, end_ts=None, limit=20, offset=0, msg_type_filter=None, resolve_media=False, db_dir=None):
    collected = []
    failures = []
    candidate_limit = _candidate_page_size(limit, offset)
    batch_size = min(candidate_limit, _HISTORY_QUERY_BATCH_SIZE)

    for table_ctx in _iter_table_contexts(ctx):
        try:
            with closing(sqlite3.connect(table_ctx['db_path'])) as conn:
                id_to_username = _load_name2id_maps(conn)
                fetch_offset = 0
                before = len(collected)
                while len(collected) - before < candidate_limit:
                    rows = _query_messages(conn, table_ctx['table_name'], start_ts=start_ts, end_ts=end_ts, limit=batch_size, offset=fetch_offset, msg_type_filter=msg_type_filter)
                    if not rows:
                        break
                    fetch_offset += len(rows)
                    for row in rows:
                        try:
                            collected.append(_build_history_line(row, table_ctx, names, id_to_username, display_name_fn, resolve_media=resolve_media, db_dir=db_dir))
                        except Exception as e:
                            failures.append(f"local_id={row[0]}: {e}")
                        if len(collected) - before >= candidate_limit:
                            break
                    if len(rows) < batch_size:
                        break
        except Exception as e:
            failures.append(f"{table_ctx['db_path']}: {e}")

    paged = _page_ranked_entries(collected, limit, offset)
    return [line for _, line in paged], failures


# ---- 搜索查询 ----

def _collect_search_entries(conn, contexts, names, keyword, display_name_fn, start_ts=None, end_ts=None, candidate_limit=20, msg_type_filter=None):
    collected = []
    failures = []
    id_to_username = _load_name2id_maps(conn)
    batch_size = candidate_limit

    for ctx in contexts:
        try:
            fetch_offset = 0
            before = len(collected)
            while len(collected) - before < candidate_limit:
                rows = _query_messages(conn, ctx['table_name'], start_ts=start_ts, end_ts=end_ts, keyword=keyword, limit=batch_size, offset=fetch_offset, msg_type_filter=msg_type_filter)
                if not rows:
                    break
                fetch_offset += len(rows)
                for row in rows:
                    formatted = _build_search_entry(row, ctx, names, id_to_username, display_name_fn)
                    if formatted:
                        collected.append(formatted)
                        if len(collected) - before >= candidate_limit:
                            break
                if len(rows) < batch_size:
                    break
        except Exception as e:
            failures.append(f"{ctx['display_name']}: {e}")
    return collected, failures


def collect_chat_search(ctx, names, keyword, display_name_fn, start_ts=None, end_ts=None, candidate_limit=20, msg_type_filter=None):
    collected = []
    failures = []
    contexts_by_db = {}
    for table_ctx in _iter_table_contexts(ctx):
        contexts_by_db.setdefault(table_ctx['db_path'], []).append(table_ctx)

    for db_path, db_contexts in contexts_by_db.items():
        try:
            with closing(sqlite3.connect(db_path)) as conn:
                db_entries, db_failures = _collect_search_entries(
                    conn, db_contexts, names, keyword, display_name_fn,
                    start_ts=start_ts, end_ts=end_ts, candidate_limit=candidate_limit,
                    msg_type_filter=msg_type_filter,
                )
                collected.extend(db_entries)
                failures.extend(db_failures)
        except Exception as e:
            failures.extend(f"{tc['display_name']}: {e}" for tc in db_contexts)
    return collected, failures


def search_all_messages(msg_db_keys, cache, names, keyword, display_name_fn, start_ts=None, end_ts=None, candidate_limit=20, msg_type_filter=None):
    collected = []
    failures = []
    for rel_key in msg_db_keys:
        path = cache.get(rel_key)
        if not path:
            continue
        try:
            with closing(sqlite3.connect(path)) as conn:
                contexts = _load_search_contexts_from_db(conn, path, names)
                db_entries, db_failures = _collect_search_entries(
                    conn, contexts, names, keyword, display_name_fn,
                    start_ts=start_ts, end_ts=end_ts, candidate_limit=candidate_limit,
                    msg_type_filter=msg_type_filter,
                )
                collected.extend(db_entries)
                failures.extend(db_failures)
        except Exception as e:
            failures.append(f"{rel_key}: {e}")
    return collected, failures


def _load_search_contexts_from_db(conn, db_path, names):
    tables = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
    ).fetchall()
    table_to_username = {}
    try:
        for (user_name,) in conn.execute("SELECT user_name FROM Name2Id").fetchall():
            if not user_name:
                continue
            table_hash = hashlib.md5(user_name.encode()).hexdigest()
            table_to_username[f"Msg_{table_hash}"] = user_name
    except sqlite3.Error:
        pass
    contexts = []
    for (table_name,) in tables:
        username = table_to_username.get(table_name, '')
        display_name = names.get(username, username) if username else table_name
        contexts.append({
            'query': display_name, 'username': username, 'display_name': display_name,
            'db_path': db_path, 'table_name': table_name, 'is_group': '@chatroom' in username,
        })
    return contexts


# ---- 多聊天上下文解析 ----

def resolve_chat_contexts(chat_names, msg_db_keys, cache, decrypted_dir):
    resolved = []
    unresolved = []
    missing_tables = []
    seen = set()
    for chat_name in chat_names:
        name = (chat_name or '').strip()
        if not name:
            unresolved.append('(空)')
            continue
        ctx = resolve_chat_context(name, msg_db_keys, cache, decrypted_dir)
        if not ctx:
            unresolved.append(name)
            continue
        if not ctx['message_tables']:
            missing_tables.append(ctx['display_name'])
            continue
        if ctx['username'] in seen:
            continue
        seen.add(ctx['username'])
        resolved.append(ctx)
    return resolved, unresolved, missing_tables


# ---- 聊天统计 ----

def collect_chat_stats(ctx, names, display_name_fn, start_ts=None, end_ts=None):
    """聚合统计指定聊天的消息数据。

    返回: {
        total, type_breakdown: {type_name: count},
        top_senders: [{name, count}],
        hourly: {0:N, ..., 23:N}
    }
    """
    type_map = {
        1: '文本', 3: '图片', 34: '语音', 42: '名片',
        43: '视频', 47: '表情', 48: '位置', 49: '链接/文件',
        50: '通话', 10000: '系统', 10002: '撤回',
    }

    total = 0
    type_counts = {}
    sender_counts = {}
    hourly_counts = {}

    for table_ctx in _iter_table_contexts(ctx):
        try:
            with closing(sqlite3.connect(table_ctx['db_path'])) as conn:
                id_to_username = _load_name2id_maps(conn)
                tbl = table_ctx['table_name']
                if not _is_safe_msg_table_name(tbl):
                    continue

                where_parts = []
                params = []
                if start_ts is not None:
                    where_parts.append('create_time >= ?')
                    params.append(start_ts)
                if end_ts is not None:
                    where_parts.append('create_time <= ?')
                    params.append(end_ts)
                where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ''

                # 总数 + 类型分布
                for bt, cnt in conn.execute(
                    f"SELECT (local_type & 0xFFFFFFFF), COUNT(*) FROM [{tbl}] {where_sql} GROUP BY (local_type & 0xFFFFFFFF)",
                    params
                ).fetchall():
                    label = type_map.get(bt, f'type={bt}')
                    type_counts[label] = type_counts.get(label, 0) + cnt
                    total += cnt

                # 发送者排名
                for sid, cnt in conn.execute(
                    f"SELECT real_sender_id, COUNT(*) FROM [{tbl}] {where_sql} GROUP BY real_sender_id ORDER BY COUNT(*) DESC LIMIT 20",
                    params
                ).fetchall():
                    uname = id_to_username.get(sid, str(sid))
                    if uname:
                        sender_counts[uname] = sender_counts.get(uname, 0) + cnt

                # 24小时分布
                for h, cnt in conn.execute(
                    f"SELECT cast(strftime('%H', create_time, 'unixepoch', 'localtime') as integer), COUNT(*) FROM [{tbl}] {where_sql} GROUP BY cast(strftime('%H', create_time, 'unixepoch', 'localtime') as integer)",
                    params
                ).fetchall():
                    if h is not None:
                        hourly_counts[h] = hourly_counts.get(h, 0) + cnt
        except Exception:
            pass

    top_senders = sorted(sender_counts.items(), key=lambda x: x[1], reverse=True)[:10]
    top_senders = [{'name': display_name_fn(u, names), 'count': c} for u, c in top_senders]

    hourly = {h: hourly_counts.get(h, 0) for h in range(24)}

    return {
        'total': total,
        'type_breakdown': dict(sorted(type_counts.items(), key=lambda x: x[1], reverse=True)),
        'top_senders': top_senders,
        'hourly': hourly,
    }
