#!/usr/bin/env python3
"""Tests for kiro_pulse. No network, no writes outside a temp dir, no real root."""
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kiro_pulse as kp  # noqa: E402

NOW = 1_800_000_000.0


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).isoformat()


class Root:
    """Builds a fake <root> with sessions/, kiro_session_pids.txt, usage/tokens/."""

    def __init__(self, base: Path):
        self.base = base
        (base / "sessions").mkdir()
        (base / "usage" / "tokens").mkdir(parents=True)

    def chat(self, key: str, title: str, age_s: float, last_role: str = "assistant", *, garble=False):
        p = self.base / "sessions" / f"{key}.jsonl"
        lines = [json.dumps({"_type": "metadata", "title": title})]
        lines.append(json.dumps({"role": "user", "ts": iso(NOW - age_s - 10), "content": "hi"}))
        if garble:
            lines.append("{not json at all")
        else:
            lines.append(json.dumps({"role": last_role, "ts": iso(NOW - age_s), "content": "x"}))
        p.write_text("\n".join(lines) + "\n")
        os.utime(p, (NOW - age_s, NOW - age_s))
        return p

    def pids(self, *pids: int):
        (self.base / "kiro_session_pids.txt").write_text(
            "\n".join(f"1:{p}:123" for p in pids) + "\nbroken line\n")

    def turns(self, *ages: float, day="2027-01-15"):
        p = self.base / "usage" / "tokens" / f"{day}.jsonl"
        with p.open("a") as fh:
            for a in ages:
                fh.write(json.dumps({"ts": iso(NOW - a), "slot": "s", "phase": "per_turn"}) + "\n")
            fh.write(json.dumps({"ts": iso(NOW - 5), "slot": "s", "phase": "session_start"}) + "\n")


class PulseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Root(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, **kw):
        return kp.build(self.root.base, now=NOW, alive=kw.pop("alive", lambda pid: pid % 2 == 0), **kw)

    # --- windows -------------------------------------------------------------
    def test_active_recent_and_old_are_bucketed_by_mtime(self):
        self.root.chat("a", "Active", 30)
        self.root.chat("b", "Recent", 600)
        self.root.chat("c", "Old", kp.RECENT_WINDOW_S + 60)
        p = self.build()
        self.assertEqual(p.chats_active, 1)
        self.assertEqual(p.chats_recent, 2)          # old one excluded entirely
        self.assertEqual([c.key for c in p.chats], ["a", "b"])  # newest first
        self.assertAlmostEqual(p.last_message_age_s, 30, delta=1)

    def test_boundary_of_active_window(self):
        self.root.chat("edge", "Edge", kp.ACTIVE_WINDOW_S)      # exactly at the edge -> active
        self.root.chat("past", "Past", kp.ACTIVE_WINDOW_S + 1)  # one second over -> idle
        p = self.build()
        states = {c.key: c.active for c in p.chats}
        self.assertEqual(states, {"edge": True, "past": False})

    # --- what the chat is doing ------------------------------------------------
    def test_state_phrase_follows_last_role(self):
        self.root.chat("u", "U", 5, last_role="user")
        self.root.chat("a", "A", 6, last_role="assistant")
        self.root.chat("t", "T", 7, last_role="tool")
        self.root.chat("i", "I", 900, last_role="assistant")
        st = {c.key: c.state() for c in self.build().chats}
        self.assertEqual(st["u"], "you just sent a message")
        self.assertEqual(st["a"], "Kiro is replying")
        self.assertEqual(st["t"], "Kiro is working (running tools)")
        self.assertEqual(st["i"], "idle")

    def test_garbled_last_line_does_not_crash_and_falls_back(self):
        self.root.chat("g", "Garbled", 5, garble=True)
        p = self.build()
        self.assertEqual(p.chats_active, 1)
        # the garbled tail is skipped; the previous good line (user) is used
        self.assertEqual(p.chats[0].last_role, "user")

    def test_titles_can_be_suppressed_and_long_titles_truncated(self):
        self.root.chat("k1", "x" * 200, 5)
        p = self.build()
        self.assertLessEqual(len(p.chats[0].title), kp.TITLE_MAX)
        self.assertTrue(p.chats[0].title.endswith("..."))
        p2 = self.build(titles=False)
        self.assertEqual(p2.chats[0].title, "k1")

    # --- agents --------------------------------------------------------------
    def test_agents_counts_only_alive_pids_and_ignores_broken_lines(self):
        self.root.pids(2, 3, 4, 5)                  # alive() says evens are alive
        self.assertEqual(self.build().agents_running, 2)

    def test_missing_registry_is_zero_not_error(self):
        p = self.build()
        self.assertEqual(p.agents_running, 0)
        self.assertEqual(p.errors, [])

    # --- turns ----------------------------------------------------------------
    def test_turns_counts_per_turn_records_inside_10_minutes_only(self):
        self.root.turns(30, 300, 599, 601, 5000)
        self.assertEqual(self.build().turns_last_10m, 3)

    # --- rendering -------------------------------------------------------------
    def test_render_headline_and_lines(self):
        self.root.chat("a", "Kiro Guard deep dive", 7, last_role="tool")
        self.root.chat("b", "Old bridge", 900)
        self.root.pids(2)
        txt = kp.render_text(self.build())
        lines = txt.split("\n")
        self.assertTrue(lines[0].startswith("KiroCrew is working  |  1 chat active  |  1 agent running"))
        self.assertIn("last message 7s ago", lines[0])
        self.assertEqual(lines[1], "> Kiro Guard deep dive  (Kiro is working (running tools), 7s)")
        self.assertEqual(lines[2], "- Old bridge  (idle, 15m)")
        self.assertTrue(txt.isascii(), "status text must be ASCII for the ssh->PowerShell path")

    def test_render_idle_and_empty_headlines(self):
        self.root.chat("b", "Old", 900)
        self.assertTrue(kp.render_text(self.build()).startswith("KiroCrew is idle"))
        for f in (self.root.base / "sessions").iterdir():
            f.unlink()
        self.assertTrue(kp.render_text(self.build()).startswith("KiroCrew: no recent activity"))

    def test_render_caps_chat_lines_and_reports_overflow(self):
        for i in range(kp.MAX_CHAT_LINES + 3):
            self.root.chat(f"c{i}", f"Chat {i}", 10 + i)
        lines = kp.render_text(self.build()).split("\n")
        self.assertEqual(len(lines), 1 + kp.MAX_CHAT_LINES + 1)
        self.assertEqual(lines[-1].strip(), "+3 more recent chats")

    def test_missing_sessions_dir_is_reported_not_fatal(self):
        import shutil
        shutil.rmtree(self.root.base / "sessions")
        p = self.build()
        self.assertEqual(p.chats_recent, 0)
        self.assertTrue(any("sessions dir missing" in e for e in p.errors))
        self.assertIn("! sessions dir missing", kp.render_text(p))

    def test_json_is_valid_and_carries_state(self):
        self.root.chat("a", "A", 5, last_role="assistant")
        d = json.loads(kp.to_json(self.build()))
        self.assertEqual(d["chats"][0]["state"], "Kiro is replying")
        self.assertEqual(d["chats_active"], 1)

    def test_fmt_age(self):
        self.assertEqual(kp.fmt_age(None), "n/a")
        self.assertEqual(kp.fmt_age(59), "59s")
        self.assertEqual(kp.fmt_age(61), "1m")
        self.assertEqual(kp.fmt_age(3700), "1h 1m")


if __name__ == "__main__":
    unittest.main(verbosity=1)
