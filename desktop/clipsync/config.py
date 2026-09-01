"""Local, on-disk state for the desktop agent.

Holds the room id, the raw AES-256 room key and the Supabase session. The file
is written with 0600 permissions inside the user's config directory; the key
never goes anywhere else.
"""

from __future__ import annotations

import json
import os
import platform
import socket
import stat
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

from . import crypto

APP_NAME = "clipsync"


def invocation() -> str:
    """How the user actually launches this build.

    The packaged binaries are run as `clipsync ...`; only a source checkout is
    run as `python -m clipsync ...`. Messages that tell someone what to type
    next have to match the build they are holding.
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).stem
    return "python -m clipsync"


def config_dir() -> Path:
    """Per-OS config location, created on demand with owner-only access."""
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif platform.system() == "Darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    path = base / APP_NAME
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        os.chmod(path, 0o700)
    return path


def config_path() -> Path:
    return config_dir() / "room.json"


def default_device_name() -> str:
    try:
        host = socket.gethostname().split(".")[0]
    except OSError:  # pragma: no cover - hostname lookup is not critical
        host = "desktop"
    return f"{host} ({platform.system()})"


@dataclass
class RoomConfig:
    """Everything the desktop agent needs to run a paired room."""

    room_id: str
    key_b64: str
    supabase_url: str
    supabase_anon_key: str
    device_name: str
    refresh_token: Optional[str] = None
    user_id: Optional[str] = None

    @property
    def key(self) -> bytes:
        return crypto.decode_key(self.key_b64)

    @property
    def fingerprint(self) -> str:
        return crypto.fingerprint(self.key)

    def save(self, path: Optional[Path] = None) -> Path:
        target = path or config_path()
        tmp = target.with_suffix(".tmp")
        # Create the temp file already locked down, so the key is never
        # briefly world-readable between write() and chmod().
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(asdict(self), handle, indent=2)
                handle.write("\n")
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        os.replace(tmp, target)
        if os.name != "nt":
            os.chmod(target, 0o600)
        return target

    @classmethod
    def load(cls, path: Optional[Path] = None) -> "RoomConfig":
        target = path or config_path()
        if not target.exists():
            raise FileNotFoundError(
                f"no paired room found at {target}. "
                f"Run `{invocation()} pair` first."
            )
        if os.name != "nt":
            mode = stat.S_IMODE(target.stat().st_mode)
            if mode & 0o077:
                raise PermissionError(
                    f"{target} is readable by other users (mode {mode:o}); "
                    "run `chmod 600` on it before continuing."
                )
        with target.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        known = {field for field in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in known})

    @classmethod
    def exists(cls, path: Optional[Path] = None) -> bool:
        return (path or config_path()).exists()
