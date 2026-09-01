"""Phase 2 — the desktop sync engine.

A single background thread does both halves of the sync:

  * **Send.** Poll the OS clipboard with ``pyperclip`` on an adaptive interval,
    encrypt anything new with the room key, and push the ciphertext.
  * **Receive.** Poll ``clipboard_events`` for rows written by other devices,
    decrypt, and write the plaintext back to the OS clipboard.

Why polling and not an OS hook: there is no portable, dependency-free clipboard
change notification across X11/Wayland/macOS/Windows. The cost is kept near
zero by (a) a coarse base interval, (b) exponential backoff up to one second
while the user is idle, and (c) hashing rather than diffing large payloads.
An idle agent wakes ~1x/second and does one string hash — well under 0.1% CPU.

Echo suppression: every value this agent writes to the clipboard, and every
value it sends, is remembered by digest, so a synced value is never bounced
back to the room it came from.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Deque, Dict, List, Optional
from collections import deque

import pyperclip

from . import crypto
from .api import SupabaseClient, SupabaseError
from .config import RoomConfig

log = logging.getLogger("clipsync.listener")

# Timing. Everything is a trade between latency and idle CPU.
ACTIVE_POLL_SECONDS = 0.25   # right after a change, stay responsive
IDLE_POLL_CEILING = 1.0      # never sleep less often than this when idle
IDLE_BACKOFF_AFTER = 5.0     # seconds of no change before we start backing off
IDLE_BACKOFF_FACTOR = 1.35
REMOTE_POLL_SECONDS = 2.0    # how often to look for rows from other devices
HEARTBEAT_SECONDS = 30.0
RECENT_DIGEST_MEMORY = 32    # how many values to remember for echo suppression


@dataclass
class ClipEvent:
    """A decrypted inbound clipboard event."""

    id: str
    text: str
    sender_device: str
    created_at: str


@dataclass
class ListenerStats:
    sent: int = 0
    received: int = 0
    errors: int = 0
    started_at: float = field(default_factory=time.time)


class ClipboardListener:
    """Bidirectional clipboard sync loop. Start/stop is thread-safe."""

    def __init__(
        self,
        config: RoomConfig,
        client: Optional[SupabaseClient] = None,
        on_event: Optional[Callable[[ClipEvent], None]] = None,
        apply_remote_to_clipboard: bool = True,
    ):
        self.config = config
        self.key = config.key
        self.room_id = config.room_id
        self.client = client or SupabaseClient(
            config.supabase_url, config.supabase_anon_key
        )
        self.on_event = on_event
        self.apply_remote_to_clipboard = apply_remote_to_clipboard
        self.stats = ListenerStats()

        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._recent: Deque[str] = deque(maxlen=RECENT_DIGEST_MEMORY)
        self._last_clipboard: Optional[str] = None
        self._cursor: str = _utc_now_iso()

    # -- lifecycle ----------------------------------------------------------

    def start(self, block: bool = False) -> None:
        """Sign in, seed state, and run the loop (in a thread unless blocking)."""
        self.authenticate()
        self._seed_clipboard()
        self._stop.clear()

        if block:
            self._run()
            return
        self._thread = threading.Thread(target=self._run, name="clipsync", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=timeout)

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive()) or not self._stop.is_set()

    # -- setup --------------------------------------------------------------

    def authenticate(self) -> None:
        self.client.resume_or_sign_in(self.config.refresh_token)
        # Persist the rotated refresh token so restarts keep the same identity
        # (and therefore the same room membership).
        if self.client.refresh_token != self.config.refresh_token:
            self.config.refresh_token = self.client.refresh_token
            self.config.user_id = self.client.user_id
            self.config.save()

    def _seed_clipboard(self) -> None:
        """Record what is already on the clipboard so we do not resend it."""
        try:
            current = pyperclip.paste()
        except pyperclip.PyperclipException as exc:
            raise RuntimeError(
                "no clipboard mechanism found. On Linux install xclip/xsel "
                "(X11) or wl-clipboard (Wayland)."
            ) from exc
        if isinstance(current, str) and current:
            self._last_clipboard = current
            self._remember(current)

    # -- main loop ----------------------------------------------------------

    def _run(self) -> None:
        interval = ACTIVE_POLL_SECONDS
        last_change = time.monotonic()
        next_remote_poll = 0.0
        next_heartbeat = 0.0

        while not self._stop.is_set():
            now = time.monotonic()

            try:
                if self._poll_local_clipboard():
                    last_change = now
                    interval = ACTIVE_POLL_SECONDS
            except Exception as exc:  # keep the daemon alive on transient faults
                self._record_error("clipboard poll failed", exc)

            if now >= next_remote_poll:
                next_remote_poll = now + REMOTE_POLL_SECONDS
                try:
                    if self._poll_remote_events():
                        last_change = now
                        interval = ACTIVE_POLL_SECONDS
                except Exception as exc:
                    self._record_error("remote poll failed", exc)

            if now >= next_heartbeat:
                next_heartbeat = now + HEARTBEAT_SECONDS
                try:
                    self.client.rpc("touch_membership", {"p_room_id": self.room_id})
                except Exception as exc:
                    self._record_error("heartbeat failed", exc)

            # Back off while nothing is happening; snap back on the next change.
            if now - last_change > IDLE_BACKOFF_AFTER:
                interval = min(interval * IDLE_BACKOFF_FACTOR, IDLE_POLL_CEILING)

            self._stop.wait(interval)

    # -- send ---------------------------------------------------------------

    def _poll_local_clipboard(self) -> bool:
        text = pyperclip.paste()
        if not isinstance(text, str) or not text or text == self._last_clipboard:
            return False

        self._last_clipboard = text
        digest = _digest(text)
        if digest in self._recent:
            # We just wrote this ourselves from a remote event — do not echo it.
            return False
        if len(text.encode("utf-8")) > crypto.MAX_PLAINTEXT_BYTES:
            log.debug("skipping clipboard value larger than the payload limit")
            return False

        self._remember(text)
        self.push(text)
        return True

    def push(self, text: str) -> None:
        """Encrypt and publish a clipboard value to the room."""
        payload = crypto.encrypt(self.key, text, self.room_id)
        self.client.insert(
            "clipboard_events",
            {
                "room_id": self.room_id,
                "payload": payload,
                "sender_device": self.config.device_name,
                "content_kind": _classify(text),
                "payload_bytes": len(payload),
            },
        )
        self.stats.sent += 1
        log.info("pushed %d bytes of ciphertext to room", len(payload))

    # -- receive ------------------------------------------------------------

    def _poll_remote_events(self) -> bool:
        rows = self.client.select(
            "clipboard_events",
            {
                "select": "id,payload,sender_device,created_at,sender_id",
                "room_id": f"eq.{self.room_id}",
                "created_at": f"gt.{self._cursor}",
                "order": "created_at.asc",
                "limit": 20,
            },
        )
        if not rows:
            return False

        applied = False
        for row in rows:
            self._cursor = row["created_at"]
            if row.get("sender_id") and row["sender_id"] == self.client.user_id:
                continue  # our own row coming back around
            try:
                text = crypto.decrypt(self.key, row["payload"], self.room_id)
            except crypto.DecryptionError as exc:
                self._record_error(f"could not decrypt event {row['id']}", exc)
                continue

            event = ClipEvent(
                id=row["id"],
                text=text,
                sender_device=row.get("sender_device") or "unknown device",
                created_at=row["created_at"],
            )
            self._apply(event)
            applied = True
        return applied

    def _apply(self, event: ClipEvent) -> None:
        self.stats.received += 1
        if self.apply_remote_to_clipboard:
            self._remember(event.text)      # suppress the echo before writing
            self._last_clipboard = event.text
            pyperclip.copy(event.text)
            log.info("clipboard updated from %s", event.sender_device)
        if self.on_event:
            try:
                self.on_event(event)
            except Exception as exc:  # a bad callback must not kill the loop
                self._record_error("on_event callback raised", exc)

    # -- helpers ------------------------------------------------------------

    def _remember(self, text: str) -> None:
        self._recent.append(_digest(text))

    def _record_error(self, message: str, exc: BaseException) -> None:
        self.stats.errors += 1
        level = logging.WARNING if isinstance(exc, SupabaseError) else logging.ERROR
        log.log(level, "%s: %s", message, exc)


def fetch_devices(client: SupabaseClient, room_id: str) -> List[Dict[str, object]]:
    """Roster for the dashboard: who is paired and when they were last seen."""
    return client.select(
        "room_members",
        {
            "select": "user_id,device_name,platform,last_seen_at,joined_at",
            "room_id": f"eq.{room_id}",
            "order": "joined_at.asc",
        },
    )


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _classify(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith(("http://", "https://")) and len(stripped.split()) == 1:
        return "url"
    return "text"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
