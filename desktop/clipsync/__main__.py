"""Command line entry point:  python -m clipsync <command>"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import crypto, pairing
from .api import SupabaseClient, SupabaseError
from .config import RoomConfig, config_path, default_device_name
from .listener import ClipboardListener, fetch_devices

DIM = "\033[2m"
BOLD = "\033[1m"
CYAN = "\033[96m"
GREEN = "\033[92m"
RESET = "\033[0m"


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="clipsync",
        description="Zero-knowledge clipboard sync between this computer and your phone.",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    sub = parser.add_subparsers(dest="command", required=True)

    p_pair = sub.add_parser("pair", help="generate a room key and show the pairing QR")
    p_pair.add_argument("--supabase-url", default=os.environ.get("SUPABASE_URL"))
    p_pair.add_argument("--supabase-anon-key", default=os.environ.get("SUPABASE_ANON_KEY"))
    p_pair.add_argument("--device-name", default=default_device_name())
    p_pair.add_argument("--qr-out", type=Path, default=None, help="where to write the QR PNG")
    p_pair.add_argument("--light-terminal", action="store_true",
                        help="invert the terminal QR for light colour schemes")
    p_pair.add_argument("--force", action="store_true", help="replace an existing pairing")

    p_run = sub.add_parser("run", help="run the clipboard sync agent in the foreground")
    p_run.add_argument("--no-apply", action="store_true",
                       help="publish local copies but do not overwrite this clipboard")

    sub.add_parser("status", help="show the paired room and its devices")
    sub.add_parser("unpair", help="delete the local room key and session")

    p_send = sub.add_parser("send", help="encrypt and publish one value, then exit")
    p_send.add_argument("text", nargs="?", help="text to send (default: read stdin)")

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format=f"{DIM}%(asctime)s{RESET} %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    try:
        handler = {
            "pair": cmd_pair,
            "run": cmd_run,
            "status": cmd_status,
            "unpair": cmd_unpair,
            "send": cmd_send,
        }[args.command]
        return handler(args)
    except KeyboardInterrupt:
        print("\nstopped.")
        return 130
    except (SupabaseError, RuntimeError, ValueError, FileNotFoundError, PermissionError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def cmd_pair(args) -> int:
    if not args.supabase_url or not args.supabase_anon_key:
        print(
            "error: set SUPABASE_URL and SUPABASE_ANON_KEY (or pass --supabase-url / "
            "--supabase-anon-key).",
            file=sys.stderr,
        )
        return 2
    if RoomConfig.exists() and not args.force:
        print(
            f"error: this computer is already paired ({config_path()}). "
            "Re-run with --force to generate a new room key.",
            file=sys.stderr,
        )
        return 2

    payload, config, png_path = pairing.create_pairing(
        supabase_url=args.supabase_url,
        supabase_anon_key=args.supabase_anon_key,
        device_name=args.device_name,
        qr_path=args.qr_out,
    )

    print()
    print(pairing.render_qr_ascii(payload, light_terminal=args.light_terminal))
    print()
    print(f"  {BOLD}Scan this with the ClipSync app{RESET}")
    print(f"  room          {CYAN}{payload.room_id}{RESET}")
    print(f"  key checksum  {CYAN}{crypto.fingerprint(config.key)}{RESET}"
          f"  {DIM}(must match the app){RESET}")
    print(f"  expires in    {pairing.JOIN_CODE_TTL_SECONDS // 60} minutes")
    print(f"  QR image      {png_path}")
    print(f"  key stored at {config_path()} {DIM}(mode 600, never uploaded){RESET}")
    print()
    print(f"  Then start syncing:  {BOLD}python -m clipsync run{RESET}")
    print()
    return 0


def cmd_run(args) -> int:
    config = RoomConfig.load()
    listener = ClipboardListener(config, apply_remote_to_clipboard=not args.no_apply)

    print(f"{GREEN}●{RESET} clipsync watching the clipboard for room "
          f"{CYAN}{config.room_id[:8]}…{RESET} as {BOLD}{config.device_name}{RESET}")
    print(f"  key checksum {config.fingerprint}   {DIM}ctrl-c to stop{RESET}")

    def shutdown(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, shutdown)
    try:
        listener.start(block=True)
    except KeyboardInterrupt:
        pass
    finally:
        listener.stop()
        print(f"\nsent {listener.stats.sent}, received {listener.stats.received}, "
              f"errors {listener.stats.errors}")
    return 0


def cmd_status(args) -> int:
    config = RoomConfig.load()
    client = SupabaseClient(config.supabase_url, config.supabase_anon_key)
    client.resume_or_sign_in(config.refresh_token)

    print(f"room          {config.room_id}")
    print(f"key checksum  {config.fingerprint}")
    print(f"config        {config_path()}")
    print("devices:")
    for member in fetch_devices(client, config.room_id):
        seen = _relative(str(member.get("last_seen_at")))
        marker = f"{GREEN}●{RESET}" if seen == "just now" else f"{DIM}○{RESET}"
        print(f"  {marker} {member.get('device_name')} "
              f"{DIM}[{member.get('platform')}] last seen {seen}{RESET}")
    return 0


def cmd_unpair(args) -> int:
    path = config_path()
    if not path.exists():
        print("nothing to unpair.")
        return 0
    path.unlink()
    print(f"removed {path}. The room key on this computer is gone; "
          "re-pair to sync again.")
    return 0


def cmd_send(args) -> int:
    config = RoomConfig.load()
    text = args.text if args.text is not None else sys.stdin.read()
    if not text:
        print("error: nothing to send", file=sys.stderr)
        return 2

    listener = ClipboardListener(config, apply_remote_to_clipboard=False)
    listener.authenticate()
    listener.push(text)
    print(f"sent {len(text)} characters as ciphertext.")
    return 0


def _relative(timestamp: str) -> str:
    try:
        moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return "unknown"
    seconds = (datetime.now(timezone.utc) - moment).total_seconds()
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{int(seconds // 60)}m ago"
    if seconds < 86400:
        return f"{int(seconds // 3600)}h ago"
    return f"{int(seconds // 86400)}d ago"


if __name__ == "__main__":
    raise SystemExit(main())
