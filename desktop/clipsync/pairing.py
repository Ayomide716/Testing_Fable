"""Phase 1 — zero-knowledge pairing.

Generates the AES-256-GCM room key locally, registers a room with Supabase
(sending only the SHA-256 digest of a single-use join code), and renders the
pairing payload as a QR code in the terminal and as a PNG.

The QR is the entire key-transport channel: it carries the raw key from screen
to camera, so the key never touches the network in any form.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import qrcode

from . import crypto
from .api import SupabaseClient
from .config import RoomConfig, config_dir, default_device_name

PAYLOAD_VERSION = 1
JOIN_CODE_BYTES = 24          # 192 bits of entropy in the single-use code
JOIN_CODE_TTL_SECONDS = 600   # the QR is dead ten minutes after it is drawn


@dataclass
class PairingPayload:
    """Exactly what the QR encodes. Nothing here is ever sent to the server."""

    version: int
    room_id: str
    key_b64: str
    join_code: str
    supabase_url: str
    supabase_anon_key: str
    device_name: str

    def to_json(self) -> str:
        return json.dumps(
            {
                "v": self.version,
                "room": self.room_id,
                "key": self.key_b64,
                "code": self.join_code,
                "url": self.supabase_url,
                "anon": self.supabase_anon_key,
                "name": self.device_name,
            },
            separators=(",", ":"),
        )


def generate_join_code() -> str:
    """URL-safe single-use pairing code. Only its digest reaches Postgres."""
    return base64.urlsafe_b64encode(secrets.token_bytes(JOIN_CODE_BYTES)).decode("ascii").rstrip("=")


def create_pairing(
    supabase_url: str,
    supabase_anon_key: str,
    device_name: Optional[str] = None,
    qr_path: Optional[Path] = None,
) -> tuple[PairingPayload, RoomConfig, Path]:
    """Create a room, persist local state, and write the QR image.

    Returns ``(payload, saved_config, qr_png_path)``.
    """
    device_name = device_name or default_device_name()

    key = crypto.generate_key()
    join_code = generate_join_code()

    client = SupabaseClient(supabase_url, supabase_anon_key)
    client.sign_in_anonymously()
    room_id = client.rpc(
        "create_room",
        {
            "p_join_code": join_code,
            "p_device_name": device_name,
            "p_ttl_seconds": JOIN_CODE_TTL_SECONDS,
        },
    )
    if not isinstance(room_id, str):
        raise RuntimeError(f"create_room returned an unexpected value: {room_id!r}")

    payload = PairingPayload(
        version=PAYLOAD_VERSION,
        room_id=room_id,
        key_b64=crypto.encode_key(key),
        join_code=join_code,
        supabase_url=supabase_url.rstrip("/"),
        supabase_anon_key=supabase_anon_key,
        device_name=device_name,
    )

    config = RoomConfig(
        room_id=room_id,
        key_b64=payload.key_b64,
        supabase_url=payload.supabase_url,
        supabase_anon_key=supabase_anon_key,
        device_name=device_name,
        refresh_token=client.refresh_token,
        user_id=client.user_id,
    )
    config.save()

    png_path = qr_path or (config_dir() / "pairing-qr.png")
    write_qr_png(payload, png_path)
    return payload, config, png_path


def build_qr(payload: PairingPayload) -> qrcode.QRCode:
    qr = qrcode.QRCode(
        version=None,
        # The payload is dense and short-lived; L keeps the modules large
        # enough for a phone camera to read off a laptop screen.
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=8,
        border=2,
    )
    qr.add_data(payload.to_json())
    qr.make(fit=True)
    return qr


def write_qr_png(payload: PairingPayload, path: Path) -> Path:
    """Write the QR to disk with owner-only permissions — it contains the key."""
    path.parent.mkdir(parents=True, exist_ok=True)
    image = build_qr(payload).make_image(fill_color="black", back_color="white")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as handle:
        image.save(handle, format="PNG")
    if os.name != "nt":
        os.chmod(path, 0o600)
    return path


def render_qr_ascii(payload: PairingPayload, light_terminal: bool = False) -> str:
    """Half-block rendering so the QR stays square in a terminal.

    A scanner needs dark modules on a light field. On a dark terminal the
    bright foreground block *is* the light field, so light modules are drawn
    as blocks and dark modules as spaces; pass ``light_terminal=True`` to swap
    that back for a light colour scheme.
    """
    matrix = build_qr(payload).get_matrix()
    width = len(matrix[0])
    # Quiet zone: without it many scanners refuse to lock on.
    quiet = [[False] * (width + 4) for _ in range(2)]
    padded = quiet + [[False, False] + row + [False, False] for row in matrix] + quiet
    if len(padded) % 2:
        padded.append([False] * (width + 4))

    lines = []
    for top, bottom in zip(padded[0::2], padded[1::2]):
        row = []
        for upper, lower in zip(top, bottom):
            # ``True`` is a dark module; ``show`` is whether we paint it bright.
            up = upper if light_terminal else not upper
            low = lower if light_terminal else not lower
            if up and low:
                row.append("\u2588")
            elif up:
                row.append("\u2580")
            elif low:
                row.append("\u2584")
            else:
                row.append(" ")
        lines.append("".join(row))
    return "\n".join(lines)
