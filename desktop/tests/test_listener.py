"""Sync-loop behaviour, with the clipboard and the network faked out.

The properties worth pinning down here are the ones that would corrupt a user's
clipboard rather than merely fail: no echo loops, no resending of what we just
received, and a payload that is genuinely ciphertext by the time it leaves.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from clipsync import crypto, listener as listener_module  # noqa: E402
from clipsync.config import RoomConfig  # noqa: E402
from clipsync.listener import ClipboardListener  # noqa: E402

ROOM = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"


class FakeClipboard:
    """Stand-in for the pyperclip module."""

    class PyperclipException(Exception):
        pass

    def __init__(self, value: str = ""):
        self.value = value
        self.writes: List[str] = []

    def paste(self) -> str:
        return self.value

    def copy(self, text: str) -> None:
        self.value = text
        self.writes.append(text)


class FakeClient:
    def __init__(self, user_id: str = "desktop-user"):
        self.user_id = user_id
        self.refresh_token = "refresh-token"
        self.inserted: List[Dict[str, Any]] = []
        self.rows: List[Dict[str, Any]] = []
        self.rpc_calls: List[str] = []

    def resume_or_sign_in(self, _token):
        return None

    def insert(self, table: str, row: Dict[str, Any], returning: bool = False):
        self.inserted.append({"table": table, **row})

    def select(self, _table: str, _params: Dict[str, Any]):
        rows, self.rows = self.rows, []
        return rows

    def rpc(self, name: str, _payload: Dict[str, Any]):
        self.rpc_calls.append(name)


class ListenerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.key = crypto.generate_key()
        self.config = RoomConfig(
            room_id=ROOM,
            key_b64=crypto.encode_key(self.key),
            supabase_url="https://example.supabase.co",
            supabase_anon_key="anon",
            device_name="workstation",
            refresh_token="refresh-token",
        )
        self.clipboard = FakeClipboard()
        self.client = FakeClient()

        self._real_pyperclip = listener_module.pyperclip
        listener_module.pyperclip = self.clipboard  # type: ignore[assignment]

        self.listener = ClipboardListener(self.config, client=self.client)

    def tearDown(self) -> None:
        listener_module.pyperclip = self._real_pyperclip  # type: ignore[assignment]

    # -- sending ------------------------------------------------------------

    def test_new_clipboard_value_is_pushed_as_ciphertext(self) -> None:
        self.clipboard.value = "hello desktop"
        self.assertTrue(self.listener._poll_local_clipboard())

        self.assertEqual(len(self.client.inserted), 1)
        row = self.client.inserted[0]
        self.assertEqual(row["room_id"], ROOM)
        self.assertNotIn("hello desktop", row["payload"])
        self.assertEqual(
            crypto.decrypt(self.key, row["payload"], ROOM), "hello desktop"
        )

    def test_unchanged_clipboard_is_not_resent(self) -> None:
        self.clipboard.value = "steady"
        self.listener._poll_local_clipboard()
        self.assertFalse(self.listener._poll_local_clipboard())
        self.assertEqual(len(self.client.inserted), 1)

    def test_seeding_prevents_resending_what_was_already_there(self) -> None:
        self.clipboard.value = "was here before we started"
        self.listener._seed_clipboard()
        self.assertFalse(self.listener._poll_local_clipboard())
        self.assertEqual(self.client.inserted, [])

    def test_oversized_value_is_skipped(self) -> None:
        self.clipboard.value = "x" * (crypto.MAX_PLAINTEXT_BYTES + 1)
        self.assertFalse(self.listener._poll_local_clipboard())
        self.assertEqual(self.client.inserted, [])

    # -- receiving ----------------------------------------------------------

    def test_remote_event_is_decrypted_onto_the_clipboard(self) -> None:
        self.client.rows = [self._row("from the phone", sender="phone-user")]
        self.assertTrue(self.listener._poll_remote_events())
        self.assertEqual(self.clipboard.value, "from the phone")

    def test_received_value_is_not_echoed_back(self) -> None:
        """The bug that would otherwise loop a value between devices forever."""
        self.client.rows = [self._row("round trip", sender="phone-user")]
        self.listener._poll_remote_events()
        self.assertFalse(self.listener._poll_local_clipboard())
        self.assertEqual(self.client.inserted, [])

    def test_our_own_rows_are_ignored(self) -> None:
        self.client.rows = [self._row("mine", sender=self.client.user_id)]
        self.assertFalse(self.listener._poll_remote_events())
        self.assertEqual(self.clipboard.writes, [])

    def test_undecryptable_row_is_counted_not_raised(self) -> None:
        row = self._row("unreadable", sender="phone-user")
        row["payload"] = crypto.encrypt(crypto.generate_key(), "unreadable", ROOM)
        self.client.rows = [row]

        self.listener._poll_remote_events()
        self.assertEqual(self.clipboard.writes, [])
        self.assertEqual(self.listener.stats.errors, 1)

    def test_cursor_advances_so_rows_are_applied_once(self) -> None:
        self.client.rows = [self._row("first", sender="phone-user", at="2026-01-01T00:00:05Z")]
        self.listener._poll_remote_events()
        self.assertEqual(self.listener._cursor, "2026-01-01T00:00:05Z")

    def _row(self, text: str, sender: str, at: str = "2026-01-01T00:00:00Z") -> Dict[str, Any]:
        return {
            "id": f"row-{text}",
            "payload": crypto.encrypt(self.key, text, ROOM),
            "sender_device": "phone",
            "sender_id": sender,
            "created_at": at,
        }


if __name__ == "__main__":
    unittest.main()
