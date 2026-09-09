#!/usr/bin/env python3
"""kiro_pulse — "is KiroCrew doing anything right now?" as one short text block.

Read-only. Looks at three on-disk signals the KiroCrew gateway already writes and
renders them for the Freeze Screen overlay's status.txt (or as JSON):

  <root>/sessions/<key>.jsonl       one line per message; line 1 is metadata with
                                    the chat title; every later line has role + ts.
                                    The file's mtime moves on every message, so
                                    "chat is moving" == transcript touched recently.
  <root>/kiro_session_pids.txt      "<gateway_pid>:<agent_pid>:<start>" per live
                                    Kiro CLI agent process. Alive pid == an agent is
                                    actually running a turn right now.
  <root>/usage/tokens/<day>.jsonl   one record per completed model turn (ts, slot).

Nothing here reads message content. Titles are the only user text surfaced, and
they can be suppressed with --no-titles.

usage:
  kiro_pulse.py --text            status.txt body (what the overlay shows)
  kiro_pulse.py --json            machine-readable snapshot
  kiro_pulse.py --root DIR        alternate KiroCrew root (tests)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Iterable, Optional

# A chat counts as "active" if its transcript moved inside this window.
ACTIVE_WINDOW_S = 120
# ...and "recent" (shown, but marked idle) inside this one.
RECENT_WINDOW_S = 30 * 60
MAX_CHAT_LINES = 4   # 1 headline + 4 chats + 1 overflow line = 6, the overlay cap
TITLE_MAX = 44


def default_root() -> Path:
    env = os.environ.get("KIROCREW_HOME")
    return Path(env) if env else Path.home() / ".kiro" / "crew"


@dataclass
class Chat:
    key: str
    title: str
    age_s: float                 # seconds since the transcript last moved
    last_role: Optional[str]     # role of the final line, if parseable
    active: bool

    def state(self) -> str:
        """Human phrase for what the chat is doing, from the final line's role."""
        if not self.active:
            return "idle"
        if self.last_role == "user":
            return "you just sent a message"
        if self.last_role == "assistant":
            return "Kiro is replying"
        if self.last_role == "tool":
            return "Kiro is working (running tools)"
        return "moving"


@dataclass
class Pulse:
    generated_at: float
    chats_active: int
    chats_recent: int
    agents_running: int
    turns_last_10m: int
    last_message_age_s: Optional[float]
    chats: list = field(default_factory=list)
    errors: list = field(default_factory=list)


# ----------------------------------------------------------------------------
# readers — each tolerates a missing/garbled source and reports it in errors
# ----------------------------------------------------------------------------

def _read_first_json(path: Path) -> dict:
    with path.open("rb") as fh:
        line = fh.readline()
    try:
        return json.loads(line.decode("utf-8", "replace"))
    except Exception:
        return {}


def _read_last_json(path: Path, tail_bytes: int = 65536) -> dict:
    """Last complete JSON line without reading the whole transcript."""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            fh.seek(max(0, size - tail_bytes))
            chunk = fh.read()
    except OSError:
        return {}
    for raw in reversed(chunk.splitlines()):
        raw = raw.strip()
        if not raw:
            continue
        try:
            d = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            continue
        if isinstance(d, dict) and "role" in d:
            return d
    return {}


def scan_sessions(root: Path, now: float, errors: list, *, titles: bool = True) -> list[Chat]:
    sdir = root / "sessions"
    if not sdir.is_dir():
        errors.append(f"sessions dir missing: {sdir}")
        return []
    out: list[Chat] = []
    for p in sdir.glob("*.jsonl"):
        try:
            age = now - p.stat().st_mtime
        except OSError:
            continue
        if age > RECENT_WINDOW_S:
            continue
        meta = _read_first_json(p)
        title = str(meta.get("title") or "") if titles else ""
        if not title:
            title = p.stem
        if len(title) > TITLE_MAX:
            title = title[: TITLE_MAX - 3].rstrip() + "..."   # ASCII: survives ssh -> PowerShell console decoding
        last = _read_last_json(p)
        out.append(Chat(
            key=p.stem,
            title=title,
            age_s=age,
            last_role=(str(last.get("role")) if last.get("role") else None),
            active=age <= ACTIVE_WINDOW_S,
        ))
    out.sort(key=lambda c: c.age_s)
    return out


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def count_agents(root: Path, errors: list, alive=_pid_alive) -> int:
    reg = root / "kiro_session_pids.txt"
    if not reg.exists():
        return 0
    n = 0
    try:
        for line in reg.read_text("utf-8", "replace").splitlines():
            parts = line.strip().split(":")
            if len(parts) < 2:
                continue
            try:
                pid = int(parts[1])
            except ValueError:
                continue
            if alive(pid):
                n += 1
    except OSError as e:
        errors.append(f"pid registry unreadable: {e}")
    return n


def count_turns(root: Path, now: float, errors: list, window_s: int = 600) -> int:
    udir = root / "usage" / "tokens"
    if not udir.is_dir():
        return 0
    n = 0
    # today's + yesterday's shard covers the midnight edge
    for p in sorted(udir.glob("*.jsonl"))[-2:]:
        try:
            with p.open("rb") as fh:
                fh.seek(max(0, p.stat().st_size - 262144))
                for raw in fh.read().splitlines():
                    try:
                        d = json.loads(raw.decode("utf-8", "replace"))
                    except Exception:
                        continue
                    ts = d.get("ts")
                    if not ts or d.get("phase") != "per_turn":
                        continue
                    t = _parse_iso(ts)
                    if t is not None and now - t <= window_s:
                        n += 1
        except OSError as e:
            errors.append(f"usage shard unreadable: {e}")
    return n


def _parse_iso(s: str) -> Optional[float]:
    from datetime import datetime
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


# ----------------------------------------------------------------------------
# assemble + render
# ----------------------------------------------------------------------------

def build(root: Path, now: Optional[float] = None, *, titles: bool = True, alive=_pid_alive) -> Pulse:
    now = time.time() if now is None else now
    errors: list = []
    chats = scan_sessions(root, now, errors, titles=titles)
    return Pulse(
        generated_at=now,
        chats_active=sum(1 for c in chats if c.active),
        chats_recent=len(chats),
        agents_running=count_agents(root, errors, alive=alive),
        turns_last_10m=count_turns(root, now, errors),
        last_message_age_s=(chats[0].age_s if chats else None),
        chats=chats,
        errors=errors,
    )


def fmt_age(s: Optional[float]) -> str:
    if s is None:
        return "n/a"
    s = int(s)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    return f"{s // 3600}h {(s % 3600) // 60}m"


def render_text(p: Pulse) -> str:
    """Overlay body. ASCII-only markers so the SSH -> PowerShell -> file path can't mangle it."""
    if p.chats_active or p.agents_running:
        head = "KiroCrew is working"
    elif p.chats_recent:
        head = "KiroCrew is idle"
    else:
        head = "KiroCrew: no recent activity"
    bits = [f"{p.chats_active} chat{'s' if p.chats_active != 1 else ''} active",
            f"{p.agents_running} agent{'s' if p.agents_running != 1 else ''} running"]
    if p.turns_last_10m:
        bits.append(f"{p.turns_last_10m} turns in 10m")
    if p.last_message_age_s is not None:
        bits.append(f"last message {fmt_age(p.last_message_age_s)} ago")
    lines = [f"{head}  |  " + "  |  ".join(bits)]
    for c in p.chats[:MAX_CHAT_LINES]:
        mark = ">" if c.active else "-"
        lines.append(f"{mark} {c.title}  ({c.state()}, {fmt_age(c.age_s)})")
    more = p.chats_recent - min(p.chats_recent, MAX_CHAT_LINES)
    if more > 0:
        lines.append(f"  +{more} more recent chat{'s' if more != 1 else ''}")
    if p.errors:
        lines.append("! " + "; ".join(p.errors)[:160])
    return "\n".join(lines)


def to_json(p: Pulse) -> str:
    d = asdict(p)
    for c in d["chats"]:
        c["state"] = next(x for x in p.chats if x.key == c["key"]).state()
    return json.dumps(d, ensure_ascii=False, indent=None)


def main(argv: Optional[Iterable[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", type=Path, default=None)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--text", action="store_true", help="status.txt body (default)")
    g.add_argument("--json", action="store_true")
    ap.add_argument("--no-titles", action="store_true", help="show chat keys instead of titles")
    a = ap.parse_args(list(argv) if argv is not None else None)
    root = a.root or default_root()
    p = build(root, titles=not a.no_titles)
    sys.stdout.write((to_json(p) if a.json else render_text(p)) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
