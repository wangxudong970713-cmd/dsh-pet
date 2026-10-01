"""微信 .dat 图片解密器。

支持两种格式：
1. 微信 3.x 传统单字节 XOR 加密格式（JPG / PNG / GIF）。
2. 微信 4.0+ V2 混合加密格式（AES-128-ECB + 明文 + 尾部单字节 XOR）。
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import glob
import hashlib
import json
import os
import re
import struct
import tempfile
import time
from collections import Counter
from typing import Optional, Tuple

# 微信 4.0 V2 文件魔数签名 (前 6 字节: 07 08 56 32 08 07 -> 07 08 V2 08 07)
V2_MAGIC = bytes([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])

# 常用图片格式的头部真实特征 (用于旧版 XOR 识别和解密后有效性校验)
_MAGIC_CANDIDATES = [
    (b"\xFF\xD8\xFF", ".jpg"),
    (bytes([0x89, 0x50, 0x4E, 0x47]), ".png"),
    (b"\x47\x49\x46\x38", ".gif"),
]

DEFAULT_DECODED_DIR = os.path.join(tempfile.gettempdir(), "wechat_cli_cache", "decoded_images")
STATE_DIR = os.path.expanduser("~/.wechat-cli")
KEYS_FILE = os.path.join(STATE_DIR, "all_keys.json")
CONFIG_FILE = os.path.join(STATE_DIR, "config.json")


def is_v2_dat(data: bytes) -> bool:
    """判断数据是否为微信 4.0+ V2 格式 .dat 文件。"""
    return bool(data and len(data) >= 6 and data[:6] == V2_MAGIC)


def detect_image_format(data: Union[bytes, str, os.PathLike]) -> Optional[str]:
    """严格校验二进制数据或文件路径是否为合法的原生图片，并返回对应扩展名。

    注意：绝不宽泛匹配以避免假阳性导致多模态大模型 400 崩溃。
    """
    if isinstance(data, (str, os.PathLike)):
        try:
            if not os.path.isfile(data):
                return None
            with open(data, "rb") as fp:
                data = fp.read(64)
        except OSError:
            return None

    if not data or len(data) < 16:
        return None
    if data.startswith(b"\xFF\xD8\xFF"):
        return ".jpg"
    if data.startswith(bytes([0x89, 0x50, 0x4E, 0x47])):
        return ".png"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return ".gif"
    if data.startswith(b"RIFF") and len(data) >= 12 and data[8:12] == b"WEBP":
        return ".webp"
    # 严格校验 BMP：必须以 BM 开头且包含合法的 DIB Header Size
    if data.startswith(b"BM") and len(data) >= 26:
        dib_size = int.from_bytes(data[14:18], "little")
        if dib_size in (12, 40, 52, 56, 64, 108, 124):
            return ".bmp"
    return None


def detect_xor_key(header: bytes) -> Tuple[Optional[int], Optional[str]]:
    """检测微信 3.x 传统 .dat 文件的异或密钥与图片扩展名。

    微信 4.0 V2 格式前 6 字节为 07 08 56 32 08 07，绝对不能按传统单字节异或处理！
    """
    if not header or len(header) < 4:
        return None, None

    # 防呆：如果是 V2 格式直接排除，杜绝 0x07 ^ 0x08 == 0x0F 被误判为 BMP (0x42 ^ 0x4D == 0x0F)
    if is_v2_dat(header):
        return None, None

    for magic, ext in _MAGIC_CANDIDATES:
        m_len = len(magic)
        if len(header) < m_len:
            continue
        k = header[0] ^ magic[0]
        match = True
        for i in range(1, m_len):
            if (header[i] ^ magic[i]) != k:
                match = False
                break
        if match:
            return k, ext

    return None, None


def decode_v2_bytes(data: bytes, aes_key: bytes, xor_key: Optional[int] = None) -> Tuple[Optional[bytes], Optional[str]]:
    """解密微信 4.0 V2 格式二进制数据。

    文件结构:
      [6B signature: 07 08 56 32 08 07]
      [4B aes_size LE] [4B xor_size LE] [1B padding]
      [aes_size bytes AES-ECB 密文 (对齐到 16 字节)]
      [raw_data 明文数据]
      [xor_size bytes 尾部 XOR 密文]
    """
    if not is_v2_dat(data) or len(data) < 31:
        return None, None

    try:
        from Crypto.Cipher import AES
    except ImportError:
        return None, None

    try:
        aes_size, xor_size = struct.unpack_from("<LL", data, 6)
        aligned_aes_size = aes_size - ~(~aes_size % 16)
        offset = 15

        if len(data) < offset + aligned_aes_size + xor_size:
            return None, None

        # 1. AES 解密头部
        cipher = AES.new(aes_key[:16], AES.MODE_ECB)
        dec_aes = cipher.decrypt(data[offset : offset + aligned_aes_size])
        # 去除 PKCS7 padding
        pad_len = dec_aes[-1]
        if 1 <= pad_len <= 16 and dec_aes.endswith(bytes([pad_len]) * pad_len):
            dec_aes = dec_aes[:-pad_len]
        offset += aligned_aes_size

        # 2. 中间明文
        raw_end = len(data) - xor_size
        raw_data = data[offset:raw_end]

        # 3. 尾部 XOR
        xor_data = data[raw_end:]
        if xor_key is not None and xor_data:
            dec_xor = bytes(b ^ xor_key for b in xor_data)
        else:
            dec_xor = xor_data

        result = dec_aes + raw_data + dec_xor
        ext = detect_image_format(result)
        if ext:
            return result, ext
    except Exception:
        pass

    return None, None


def decode_dat_bytes(data: bytes, aes_key: Optional[bytes] = None, xor_key: Optional[int] = None) -> Tuple[Optional[bytes], Optional[str]]:
    """将 .dat 文件的字节数据解密为原生图片字节。

    自动识别传统 XOR 格式或 V2 格式。解密结果必须通过真实图片格式校验，否则返回 None。
    """
    if not data or len(data) < 4:
        return None, None

    # 如果是微信 4.0 V2 格式
    if is_v2_dat(data):
        if not aes_key:
            return None, None
        return decode_v2_bytes(data, aes_key, xor_key)

    # 否则按传统单字节异或
    key, ext = detect_xor_key(data[:4])
    if key is None or ext is None:
        return None, None

    decoded = bytearray(len(data))
    for i, b in enumerate(data):
        decoded[i] = b ^ key
    res_bytes = bytes(decoded)
    # 严格校验解密后的数据是否符合真实格式
    verified_ext = detect_image_format(res_bytes)
    if verified_ext:
        return res_bytes, verified_ext
    return None, None


def load_saved_v2_keys() -> Tuple[Optional[bytes], Optional[int]]:
    """从 all_keys.json 或 config.json 加载已保存的微信图片 AES 密钥与 XOR 密钥。"""
    for file_path in (KEYS_FILE, CONFIG_FILE):
        if not os.path.isfile(file_path):
            continue
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            # 支持顶层或者 __image_keys__
            img_keys = data.get("__image_keys__") if isinstance(data.get("__image_keys__"), dict) else data
            aes_str = img_keys.get("image_aes_key") or img_keys.get("aes_key")
            xor_val = img_keys.get("image_xor_key") or img_keys.get("xor_key")
            if aes_str and isinstance(aes_str, str) and len(aes_str) >= 16:
                aes_bytes = aes_str.encode("ascii")[:16]
                xor_int = int(xor_val) if xor_val is not None else None
                return aes_bytes, xor_int
        except Exception:
            continue
    return None, None


def save_v2_keys(aes_key_str: str, xor_key_val: Optional[int] = None) -> bool:
    """持久化微信图片密钥到 all_keys.json。"""
    try:
        data = {}
        if os.path.isfile(KEYS_FILE):
            with open(KEYS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        if not isinstance(data, dict):
            data = {}
        if "__image_keys__" not in data:
            data["__image_keys__"] = {}
        data["__image_keys__"]["image_aes_key"] = aes_key_str[:16]
        if xor_key_val is not None:
            data["__image_keys__"]["image_xor_key"] = int(xor_key_val)
        data["image_aes_key"] = aes_key_str[:16]
        if xor_key_val is not None:
            data["image_xor_key"] = int(xor_key_val)

        os.makedirs(os.path.dirname(KEYS_FILE), exist_ok=True)
        with open(KEYS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return True
    except Exception:
        return False


def find_xor_key_from_attach(attach_dir: str) -> Optional[int]:
    """通过多个 V2 *_t.dat 文件的倒数 2 字节（对应 JPEG 末尾 FF D9）反推 XOR 密钥。"""
    if not attach_dir or not os.path.isdir(attach_dir):
        return None
    pattern = os.path.join(attach_dir, "**", "*.dat")
    dat_files = sorted(glob.glob(pattern, recursive=True), key=os.path.getmtime, reverse=True)
    tails = []
    for f in dat_files[:100]:
        try:
            with open(f, "rb") as fp:
                head = fp.read(6)
                if head == V2_MAGIC:
                    fp.seek(-2, os.SEEK_END)
                    tail = fp.read(2)
                    if len(tail) == 2:
                        tails.append(tail)
        except Exception:
            pass
    if not tails:
        return None
    counts = Counter(tails)
    most_common, _ = counts.most_common(1)[0]
    k1 = most_common[0] ^ 0xFF
    k2 = most_common[1] ^ 0xD9
    if k1 == k2:
        return k1
    return k1


def try_aes_key(key_bytes: bytes, ciphertext: bytes) -> Optional[str]:
    """测试单个 16 字节 AES 密钥是否能正确解密密文块。"""
    if len(key_bytes) < 16 or len(ciphertext) < 16:
        return None
    try:
        from Crypto.Cipher import AES
        cipher = AES.new(key_bytes[:16], AES.MODE_ECB)
        plain = cipher.decrypt(ciphertext[:16])
        if plain[:3] == b"\xFF\xD8\xFF":
            return ".jpg"
        if plain[:4] == bytes([0x89, 0x50, 0x4E, 0x47]):
            return ".png"
        if plain[:4] == b"RIFF":
            return ".webp"
        if plain[:4] == b"wxgf":
            return ".hevc"
        if plain[:3] == b"GIF":
            return ".gif"
    except Exception:
        pass
    return None


def scan_wechat_memory_for_aes_key(ciphertext: bytes) -> Optional[str]:
    """在 Windows 环境下快速扫描 Weixin.exe 进程内存以提取 16 位 AES 密钥。"""
    if os.name != "nt" or not ciphertext or len(ciphertext) < 16:
        return None

    try:
        import psutil
    except ImportError:
        return None

    # 寻找 Weixin.exe 主进程
    pids = []
    for p in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            name = (p.info.get("name") or "").lower()
            if name == "weixin.exe":
                # 主进程通常没有 --type= 参数
                cmd = " ".join(p.info.get("cmdline") or [])
                if "--type=" not in cmd:
                    pids.insert(0, p.info["pid"])
                else:
                    pids.append(p.info["pid"])
        except Exception:
            continue

    if not pids:
        return None

    PROCESS_VM_READ = 0x0010
    PROCESS_QUERY_INFORMATION = 0x0400
    MEM_COMMIT = 0x1000
    PAGE_NOACCESS = 0x01
    PAGE_GUARD = 0x100
    PAGE_READWRITE = 0x04
    PAGE_WRITECOPY = 0x08
    PAGE_EXECUTE_READWRITE = 0x40
    PAGE_EXECUTE_WRITECOPY = 0x80

    class MEMORY_BASIC_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BaseAddress", ctypes.c_void_p),
            ("AllocationBase", ctypes.c_void_p),
            ("AllocationProtect", wintypes.DWORD),
            ("RegionSize", ctypes.c_size_t),
            ("State", wintypes.DWORD),
            ("Protect", wintypes.DWORD),
            ("Type", wintypes.DWORD),
        ]

    kernel32 = ctypes.windll.kernel32
    re_key32 = re.compile(rb"(?<![a-zA-Z0-9])[a-zA-Z0-9]{32}(?![a-zA-Z0-9])")
    re_key16 = re.compile(rb"(?<![a-zA-Z0-9])[a-zA-Z0-9]{16}(?![a-zA-Z0-9])")

    for pid in pids:
        h_process = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
        if not h_process:
            continue
        try:
            address = 0
            mbi = MEMORY_BASIC_INFORMATION()
            while address < 0x7FFFFFFFFFFF:
                if kernel32.VirtualQueryEx(h_process, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
                    break
                if (mbi.State == MEM_COMMIT and mbi.Protect != PAGE_NOACCESS and (mbi.Protect & PAGE_GUARD) == 0 and mbi.RegionSize <= 50 * 1024 * 1024):
                    rw_flags = (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)
                    if (mbi.Protect & rw_flags) != 0:
                        buf = ctypes.create_string_buffer(mbi.RegionSize)
                        read_bytes = ctypes.c_size_t(0)
                        if kernel32.ReadProcessMemory(h_process, ctypes.c_void_p(address), buf, mbi.RegionSize, ctypes.byref(read_bytes)):
                            raw = buf.raw[:read_bytes.value]
                            for m in re_key32.finditer(raw):
                                cand = m.group()[:16]
                                if try_aes_key(cand, ciphertext):
                                    return cand.decode("ascii", errors="ignore")
                            for m in re_key16.finditer(raw):
                                cand = m.group()
                                if try_aes_key(cand, ciphertext):
                                    return cand.decode("ascii", errors="ignore")
                next_addr = address + mbi.RegionSize
                if next_addr <= address:
                    break
                address = next_addr
        finally:
            kernel32.CloseHandle(h_process)

    return None


def decode_dat_file(dat_path: str, output_dir: Optional[str] = None) -> Optional[str]:
    """解密单个 .dat 文件并写入缓存目录。

    Args:
        dat_path: 微信本地 .dat 文件完整路径
        output_dir: 输出目录，默认为临时缓存目录

    Returns:
        解密后的原生有效图片完整路径。解密失败或图片无效严格返回 None！
    """
    if not dat_path or not os.path.isfile(dat_path):
        return None

    try:
        out_dir = output_dir or DEFAULT_DECODED_DIR
        os.makedirs(out_dir, exist_ok=True)

        stat = os.stat(dat_path)
        cache_id = hashlib.md5(f"{dat_path}:{stat.st_mtime}:{stat.st_size}".encode()).hexdigest()

        # 检查是否已有缓存且为有效非空图片
        for ext in (".jpg", ".png", ".gif", ".webp", ".bmp"):
            candidate = os.path.join(out_dir, f"{cache_id}{ext}")
            if os.path.isfile(candidate) and os.path.getsize(candidate) > 0:
                return candidate

        with open(dat_path, "rb") as f:
            data = f.read()

        if not data or len(data) < 16:
            return None

        aes_key, xor_key = load_saved_v2_keys()

        # 如果是 V2 文件但尚未拥有 AES key，尝试自动从内存提取一次
        if is_v2_dat(data) and not aes_key:
            sample_ct = data[15:31] if len(data) >= 31 else None
            if sample_ct:
                found_aes = scan_wechat_memory_for_aes_key(sample_ct)
                if found_aes:
                    # 尝试推导 xor key
                    attach_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(dat_path))))
                    found_xor = find_xor_key_from_attach(attach_dir) or 0x65
                    save_v2_keys(found_aes, found_xor)
                    aes_key = found_aes.encode("ascii")[:16]
                    xor_key = found_xor

        decoded_bytes, ext = decode_dat_bytes(data, aes_key=aes_key, xor_key=xor_key)
        if not decoded_bytes or not ext:
            return None

        out_path = os.path.join(out_dir, f"{cache_id}{ext}")
        temp_out = out_path + f".tmp.{os.getpid()}"
        with open(temp_out, "wb") as f:
            f.write(decoded_bytes)
        os.replace(temp_out, out_path)
        return out_path
    except Exception:
        return None
