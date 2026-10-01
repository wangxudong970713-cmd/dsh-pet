"""bridge.py 的协议与解析单元测试。

不依赖微信、不依赖真实数据库，可在无微信环境下跑。
"""

import contextlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from wechat_cli_mcp import bridge


class ParseHistoryLinesTest(unittest.TestCase):
    def test_parses_label_and_text(self):
        messages = bridge.parse_history_lines(["[2026-01-02 03:04] 张三: 晚上一起吃饭吗"], "me")
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["time"], "2026-01-02 03:04")
        self.assertEqual(messages[0]["label"], "张三")
        self.assertEqual(messages[0]["text"], "晚上一起吃饭吗")
        self.assertFalse(messages[0]["isSelf"])

    def test_detects_self_by_label(self):
        messages = bridge.parse_history_lines(["[2026-01-02 03:04] me: 好"], "me")
        self.assertTrue(messages[0]["isSelf"])

    def test_custom_self_label(self):
        messages = bridge.parse_history_lines(["[2026-01-02 03:04] 我自己: 好"], "我自己")
        self.assertTrue(messages[0]["isSelf"])

    def test_line_without_label(self):
        messages = bridge.parse_history_lines(["[2026-01-02 03:04] 系统提示"], "me")
        self.assertEqual(messages[0]["label"], "")
        self.assertEqual(messages[0]["text"], "系统提示")
        self.assertFalse(messages[0]["isSelf"])

    def test_text_may_contain_colon_and_brackets(self):
        raw = "[2026-01-02 03:04] 张三: 你好: 吗 [2026-01-02 03:04]"
        messages = bridge.parse_history_lines([raw], "me")
        self.assertEqual(messages[0]["label"], "张三")
        self.assertEqual(messages[0]["text"], "你好: 吗 [2026-01-02 03:04]")

    def test_multiline_text_preserved(self):
        messages = bridge.parse_history_lines(["[2026-01-02 03:04] 张三: 第一行\n第二行"], "me")
        self.assertEqual(messages[0]["text"], "第一行\n第二行")

    def test_label_may_contain_fullwidth_colon(self):
        messages = bridge.parse_history_lines(["[2026-01-02 03:04] 群名：张三: 在吗"], "me")
        self.assertEqual(messages[0]["label"], "群名：张三")
        self.assertEqual(messages[0]["text"], "在吗")

    def test_unparsable_line_kept_as_text(self):
        messages = bridge.parse_history_lines(["完全不符合格式的一行"], "me")
        self.assertEqual(messages[0]["time"], "")
        self.assertEqual(messages[0]["text"], "完全不符合格式的一行")
        self.assertFalse(messages[0]["isSelf"])

    def test_empty_input(self):
        self.assertEqual(bridge.parse_history_lines([], "me"), [])
        self.assertEqual(bridge.parse_history_lines(None, "me"), [])

    def test_non_string_entries_skipped(self):
        self.assertEqual(bridge.parse_history_lines([None, 42], "me"), [])


class ClampIntTest(unittest.TestCase):
    def test_clamps_high_and_low(self):
        self.assertEqual(bridge._clamp_int(999, 1, 10, 5), 10)
        self.assertEqual(bridge._clamp_int(0, 1, 10, 5), 1)

    def test_default_on_garbage(self):
        self.assertEqual(bridge._clamp_int("abc", 1, 10, 5), 5)
        self.assertEqual(bridge._clamp_int(None, 1, 10, 5), 5)

    def test_parses_numeric_strings(self):
        self.assertEqual(bridge._clamp_int("7", 1, 10, 5), 7)


class CaptureStdoutTest(unittest.TestCase):
    def test_print_is_captured(self):
        cap = bridge._CaptureStdout()
        with cap:
            print("hello")
            print("world")
        self.assertEqual(cap.tail(), ["hello", "world"])

    def test_tail_keeps_last_lines_only(self):
        cap = bridge._CaptureStdout(max_lines=2)
        with cap:
            for index in range(5):
                print(index)
        self.assertEqual(cap.tail(), ["3", "4"])

    def test_blank_lines_ignored(self):
        cap = bridge._CaptureStdout()
        with cap:
            print("a")
            print("   ")
        self.assertEqual(cap.tail(), ["a"])

    def test_stdout_restored_even_on_error(self):
        original = sys.stdout
        cap = bridge._CaptureStdout()
        with self.assertRaises(ValueError):
            with cap:
                raise ValueError("boom")
        self.assertIs(sys.stdout, original)


class HandleDispatchTest(unittest.TestCase):
    def test_unknown_command(self):
        response = bridge.handle({"id": 7, "cmd": "nope"})
        self.assertEqual(response["id"], 7)
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "unknown_command")

    def test_non_dict_request(self):
        response = bridge.handle(["not", "a", "dict"])
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "bad_request")

    def test_ping(self):
        response = bridge.handle({"id": 1, "cmd": "ping"})
        self.assertTrue(response["ok"])
        self.assertTrue(response["pong"])
        self.assertEqual(response["id"], 1)

    def test_bridge_error_maps_to_code(self):
        def boom(_args):
            raise bridge.BridgeError("chat_not_found", "没找到")

        with mock.patch.dict(bridge.HANDLERS, {"boom": boom}):
            response = bridge.handle({"id": 2, "cmd": "boom"})
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "chat_not_found")
        self.assertEqual(response["error"], "没找到")

    def test_missing_keys_maps_to_not_initialized(self):
        def boom(_args):
            raise FileNotFoundError("Key file not found: all_keys.json")

        with mock.patch.dict(bridge.HANDLERS, {"boom": boom}):
            response = bridge.handle({"id": 3, "cmd": "boom"})
        self.assertEqual(response["code"], "not_initialized")

    def test_unexpected_error_is_contained(self):
        def boom(_args):
            raise ValueError("x")

        with mock.patch.dict(bridge.HANDLERS, {"boom": boom}):
            response = bridge.handle({"id": 4, "cmd": "boom"})
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "internal_error")
        self.assertIn("ValueError", response["error"])
        self.assertIn("trace", response)

    def test_payload_merged_into_response(self):
        with mock.patch.dict(bridge.HANDLERS, {"echo": lambda args: {"value": args.get("value")}}):
            response = bridge.handle({"id": 5, "cmd": "echo", "value": "hi"})
        self.assertTrue(response["ok"])
        self.assertEqual(response["value"], "hi")

    def test_handler_returning_none_is_ok(self):
        with mock.patch.dict(bridge.HANDLERS, {"nil": lambda _args: None}):
            response = bridge.handle({"id": 6, "cmd": "nil"})
        self.assertTrue(response["ok"])
        self.assertEqual(response["id"], 6)

    def test_shutdown_handler_is_registered(self):
        self.assertIn("shutdown", bridge.HANDLERS)

    def test_every_handler_is_callable(self):
        for name, handler in bridge.HANDLERS.items():
            self.assertTrue(callable(handler), name)


class DetectDbDirTest(unittest.TestCase):
    def test_override_accepts_existing_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_dir, source, candidates = bridge._detect_db_dir(tmp)
            self.assertEqual(source, "override")
            self.assertEqual(len(candidates), 1)
            self.assertEqual(
                os.path.normcase(db_dir), os.path.normcase(os.path.abspath(tmp))
            )

    def test_override_reports_missing_dir(self):
        missing = os.path.join(tempfile.gettempdir(), "nope-db-dir-xyz-123")
        db_dir, source, candidates = bridge._detect_db_dir(missing)
        self.assertIsNone(db_dir)
        self.assertEqual(source, "none")
        self.assertEqual(len(candidates), 1)

    def test_xwechat_candidates_sorted_newest_first(self):
        with tempfile.TemporaryDirectory() as home:
            root = os.path.join(home, "Documents", "xwechat_files")
            for name, stamp in (("acct_old", 1000), ("acct_new", 2000)):
                db_dir = os.path.join(root, name, "db_storage")
                os.makedirs(os.path.join(db_dir, "message"))
                db_file = os.path.join(db_dir, "message", "message_0.db")
                with open(db_file, "wb"):
                    pass
                os.utime(db_file, (stamp, stamp))

            with self._isolated_home(home):
                candidates = bridge._db_dir_candidates()

        dirs = [candidate["dir"] for candidate in candidates]
        new_index = next(i for i, d in enumerate(dirs) if "acct_new" in d)
        old_index = next(i for i, d in enumerate(dirs) if "acct_old" in d)
        self.assertLess(new_index, old_index)

    def test_candidate_entries_have_shape(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, "Documents", "xwechat_files", "acct", "db_storage"))
            with self._isolated_home(home):
                candidates = bridge._db_dir_candidates()
        self.assertTrue(candidates)
        for candidate in candidates:
            self.assertEqual(set(candidate), {"dir", "source", "mtime"})

    @staticmethod
    @contextlib.contextmanager
    def _isolated_home(home):
        """把 ``~`` 指到临时目录，并屏蔽真实机器的探测来源。"""
        missing_config = os.path.join(home, "__no_config__.json")
        with mock.patch.multiple(
            "wechat_cli_mcp.core.config",
            CONFIG_FILE=missing_config,
            auto_detect_db_dir=mock.Mock(return_value=None),
        ), mock.patch.dict(
            os.environ, {"USERPROFILE": home, "WECHAT_DB_DIR": ""}, clear=False
        ):
            yield


class ProtocolIntegrationTest(unittest.TestCase):
    """真起子进程验证 stdin/stdout 的行分隔 JSON 协议。"""

    def _run(self, payload):
        return subprocess.run(
            [sys.executable, "-m", "wechat_cli_mcp.bridge"],
            input=payload,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=180,
        )

    def _frames(self, payload):
        proc = self._run(payload)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [line for line in proc.stdout.splitlines() if line.strip()]
        return [json.loads(line) for line in lines]

    def test_line_protocol_mixed_input(self):
        payload = (
            "\n".join(
                [
                    json.dumps({"id": 1, "cmd": "ping"}),
                    '{"id":2,"cmd":"unknown-thing"}',
                    "not-json",
                    json.dumps({"id": 3, "cmd": "ping"}),
                ]
            )
            + "\n"
        )
        frames = self._frames(payload)
        self.assertEqual(len(frames), 4)
        self.assertTrue(frames[0]["pong"])
        self.assertEqual(frames[1]["code"], "unknown_command")
        self.assertEqual(frames[2]["code"], "bad_json")
        self.assertTrue(frames[3]["pong"])

    def test_blank_lines_are_ignored(self):
        frames = self._frames("\n\n" + json.dumps({"id": 1, "cmd": "ping"}) + "\n\n")
        self.assertEqual(len(frames), 1)

    def test_shutdown_exits_before_eof(self):
        payload = (
            json.dumps({"id": 1, "cmd": "shutdown"})
            + "\n"
            + json.dumps({"id": 2, "cmd": "ping"})
            + "\n"
        )
        frames = self._frames(payload)
        self.assertEqual(len(frames), 1)
        self.assertTrue(frames[0]["bye"])

    def test_chinese_is_not_escaped(self):
        proc = self._run(json.dumps({"id": 1, "cmd": "未知命令"}) + "\n")
        self.assertIn("未知命令", proc.stdout)
        self.assertNotIn("\\u", proc.stdout)

    def test_eof_without_requests_exits_cleanly(self):
        proc = self._run("")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()
