"""Frozen-binary entry point.

PyInstaller cannot target `python -m clipsync` directly, so this thin wrapper
gives it a script to bundle. Running it is equivalent to the module form.
"""

from __future__ import annotations

import multiprocessing
import sys

from clipsync.__main__ import main

if __name__ == "__main__":
    # Required for the frozen build on Windows and macOS: without it, any
    # accidental process spawn re-runs the whole CLI instead of the child.
    multiprocessing.freeze_support()
    sys.exit(main())
