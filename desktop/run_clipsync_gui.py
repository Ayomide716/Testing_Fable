"""Windowed entry point for the frozen build.

Separate from run_clipsync.py because PyInstaller decides console-vs-window at
freeze time: one binary cannot be both. This one goes straight to the window.
"""

from __future__ import annotations

import multiprocessing
import sys

from clipsync.gui import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())
