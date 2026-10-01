"""测试 image_decoder 异或解密、V2 解密与防假阳性保护"""

import os
import shutil
import struct
import tempfile
import unittest

from wechat_cli_mcp.core.image_decoder import (
    decode_dat_bytes,
    decode_dat_file,
    decode_v2_bytes,
    detect_image_format,
    detect_xor_key,
    is_v2_dat,
    V2_MAGIC,
)


class TestImageDecoder(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_detect_and_decode_jpeg(self):
        # 构造真实的 JPEG 头部 (FF D8 FF E0 ...)
        raw_jpeg = b"\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x01\x00`\x00`\x00\x00"
        xor_key = 0x5A
        dat_data = bytes([b ^ xor_key for b in raw_jpeg])

        key, ext = detect_xor_key(dat_data[:4])
        self.assertEqual(key, xor_key)
        self.assertEqual(ext, ".jpg")

        decoded, dec_ext = decode_dat_bytes(dat_data)
        self.assertEqual(dec_ext, ".jpg")
        self.assertEqual(decoded, raw_jpeg)

    def test_detect_and_decode_png(self):
        raw_png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52])
        xor_key = 0xA3
        dat_data = bytes([b ^ xor_key for b in raw_png])

        key, ext = detect_xor_key(dat_data[:4])
        self.assertEqual(key, xor_key)
        self.assertEqual(ext, ".png")

        decoded, dec_ext = decode_dat_bytes(dat_data)
        self.assertEqual(dec_ext, ".png")
        self.assertEqual(decoded, raw_png)

    def test_v2_header_never_treated_as_bmp(self):
        # 微信 4.0 V2 头部为 07 08 56 32 08 07
        # 0x07 ^ 0x08 == 0x0F，绝不能被误判为 BMP (0x42 ^ 0x4D == 0x0F)
        v2_data = V2_MAGIC + b"\x00\x00\x00\x10\x00\x00\x00\x04\x00" + b"X" * 100
        self.assertTrue(is_v2_dat(v2_data))
        key, ext = detect_xor_key(v2_data[:4])
        self.assertIsNone(key)
        self.assertIsNone(ext)

        # 无 AES key 时，decode_dat_bytes 必须返回 None
        decoded, dec_ext = decode_dat_bytes(v2_data)
        self.assertIsNone(decoded)
        self.assertIsNone(dec_ext)

    def test_v2_decrypt_roundtrip(self):
        # 构造一个符合 V2 格式规范的数据包
        from Crypto.Cipher import AES

        aes_key = b"0123456789abcdef"
        xor_key = 0x65

        # 准备原始合法 JPEG
        raw_head = b"\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x01\x00`\x00`"  # 16 字节
        raw_body = b"TestMiddleRawData1234567890"
        raw_tail = b"\xFF\xD9"  # JPEG 结束符

        # AES 加密 head (带标准 PKCS7 padding)
        pad_len = 16 - (len(raw_head) % 16)
        padded_head = raw_head + bytes([pad_len]) * pad_len
        cipher = AES.new(aes_key, AES.MODE_ECB)
        enc_head = cipher.encrypt(padded_head)

        aes_size = len(raw_head)
        xor_size = len(raw_tail)
        enc_tail = bytes([b ^ xor_key for b in raw_tail])

        v2_data = (
            V2_MAGIC
            + struct.pack("<LL", aes_size, xor_size)
            + b"\x00"  # padding
            + enc_head
            + raw_body
            + enc_tail
        )

        self.assertTrue(is_v2_dat(v2_data))
        res_bytes, ext = decode_v2_bytes(v2_data, aes_key, xor_key)
        self.assertIsNotNone(res_bytes)
        self.assertEqual(ext, ".jpg")
        self.assertEqual(res_bytes, raw_head + raw_body + raw_tail)

    def test_detect_invalid(self):
        invalid_data = b"\x12\x34\x56\x78"
        key, ext = detect_xor_key(invalid_data[:4])
        self.assertIsNone(key)
        self.assertIsNone(ext)

        decoded, dec_ext = decode_dat_bytes(invalid_data)
        self.assertIsNone(decoded)
        self.assertIsNone(dec_ext)


if __name__ == "__main__":
    unittest.main()
