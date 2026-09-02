"""Windowed desktop app for ClipSync (Tkinter).

Tkinter is in the Python standard library, so the GUI adds no dependency and
freezes cleanly with PyInstaller on all three platforms.

Structure:
  * The sync engine (ClipboardListener) runs on its own thread, exactly as it
    does headless. It never touches Tk.
  * It hands events to the UI through a queue; the UI drains that queue on a
    Tk `after` tick. Tk is not thread-safe, so this is the only safe direction.
  * Three views: setup (no credentials yet), pairing (QR on screen), and the
    dashboard (devices, history, controls).
"""

from __future__ import annotations

import queue
import threading
import tkinter as tk
import webbrowser
from dataclasses import dataclass
from tkinter import font as tkfont
from tkinter import messagebox, ttk
from typing import Optional

from . import crypto, pairing
from .api import SupabaseClient, SupabaseError
from .config import RoomConfig, config_path, default_device_name
from .listener import ClipEvent, ClipboardListener, fetch_devices

# The app's palette, matching the phone app and the download page.
VOID = "#05060B"
PANEL = "#0B0E17"
PANEL_2 = "#131826"
EDGE = "#232A3A"
INK = "#E8EDF7"
MUTED = "#7E8AA0"
DIM = "#55607A"
CYAN = "#22D3EE"
VIOLET = "#A78BFA"
AMBER = "#FCD34D"
ROSE = "#FB7185"
GREEN = "#34D399"

POLL_MS = 120
ROSTER_MS = 5000


@dataclass
class UiMessage:
    kind: str  # 'event' | 'status' | 'error' | 'paired'
    payload: object = None


class ClipSyncApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("ClipSync")
        self.configure(bg=VOID)
        self.geometry("560x680")
        self.minsize(480, 600)

        self.queue: "queue.Queue[UiMessage]" = queue.Queue()
        self.listener: Optional[ClipboardListener] = None
        self.config_data: Optional[RoomConfig] = None
        self.pair_payload: Optional[pairing.PairingPayload] = None
        self._qr_image: Optional[tk.PhotoImage] = None
        self._history: list[ClipEvent] = []
        self._roster_job: Optional[str] = None

        self._init_fonts()
        self._init_style()

        self.container = tk.Frame(self, bg=VOID)
        self.container.pack(fill="both", expand=True)

        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self.after(POLL_MS, self._drain_queue)

        try:
            self.config_data = RoomConfig.load()
        except (FileNotFoundError, PermissionError):
            self.config_data = None

        if self.config_data:
            self.show_dashboard()
            self.start_sync()
        else:
            self.show_setup()

    # -- chrome -------------------------------------------------------------

    def _init_fonts(self) -> None:
        family = "Helvetica"
        for candidate in ("Segoe UI", "SF Pro Text", "Inter", "DejaVu Sans"):
            if candidate in tkfont.families():
                family = candidate
                break
        mono = "Courier"
        for candidate in ("Cascadia Mono", "SF Mono", "DejaVu Sans Mono", "Consolas"):
            if candidate in tkfont.families():
                mono = candidate
                break
        self.f_title = tkfont.Font(family=family, size=20, weight="bold")
        self.f_body = tkfont.Font(family=family, size=11)
        self.f_small = tkfont.Font(family=family, size=9)
        self.f_mono = tkfont.Font(family=mono, size=10)
        self.f_mono_big = tkfont.Font(family=mono, size=17, weight="bold")

    def _init_style(self) -> None:
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TFrame", background=VOID)
        style.configure("Card.TFrame", background=PANEL)
        style.configure("TLabel", background=VOID, foreground=INK, font=self.f_body)
        style.configure("Muted.TLabel", background=VOID, foreground=MUTED, font=self.f_small)
        style.configure("CardMuted.TLabel", background=PANEL, foreground=MUTED, font=self.f_small)
        style.configure("Card.TLabel", background=PANEL, foreground=INK, font=self.f_body)
        style.configure(
            "Accent.TButton", background=CYAN, foreground=VOID,
            font=self.f_body, borderwidth=0, focuscolor=CYAN, padding=(16, 9),
        )
        style.map("Accent.TButton", background=[("active", "#5BE4F7"), ("disabled", DIM)])
        style.configure(
            "Ghost.TButton", background=VOID, foreground=MUTED,
            font=self.f_small, borderwidth=1, padding=(12, 7),
        )
        style.map("Ghost.TButton",
                  background=[("active", PANEL_2)], foreground=[("active", INK)])
        style.configure("TEntry", fieldbackground=PANEL_2, foreground=INK,
                        insertcolor=CYAN, borderwidth=0, padding=8)

    def _clear(self) -> tk.Frame:
        for child in self.container.winfo_children():
            child.destroy()
        frame = tk.Frame(self.container, bg=VOID)
        frame.pack(fill="both", expand=True, padx=26, pady=22)
        return frame

    def _header(self, parent: tk.Widget, subtitle: str) -> None:
        bar = tk.Frame(parent, bg=VOID)
        bar.pack(fill="x", pady=(0, 18))
        tk.Label(bar, text="●", bg=VOID, fg=CYAN, font=self.f_body).pack(side="left")
        tk.Label(bar, text="  ClipSync", bg=VOID, fg=INK,
                 font=self.f_title).pack(side="left")
        tk.Label(parent, text=subtitle, bg=VOID, fg=MUTED, font=self.f_small,
                 justify="left", wraplength=470).pack(anchor="w", pady=(0, 16))

    # -- setup view ---------------------------------------------------------

    def show_setup(self) -> None:
        frame = self._clear()
        self._header(frame, "Connect this computer to your Supabase project. "
                            "Both values are on the project's Settings → API page.")

        tk.Label(frame, text="Project URL", bg=VOID, fg=MUTED,
                 font=self.f_small).pack(anchor="w")
        self.url_var = tk.StringVar()
        ttk.Entry(frame, textvariable=self.url_var, font=self.f_mono).pack(
            fill="x", pady=(4, 14))

        tk.Label(frame, text="Anon public key", bg=VOID, fg=MUTED,
                 font=self.f_small).pack(anchor="w")
        self.key_var = tk.StringVar()
        ttk.Entry(frame, textvariable=self.key_var, font=self.f_mono, show="•").pack(
            fill="x", pady=(4, 6))
        tk.Label(frame,
                 text="Use the anon public key, never the service_role key.",
                 bg=VOID, fg=DIM, font=self.f_small).pack(anchor="w", pady=(0, 18))

        self.setup_status = tk.Label(frame, text="", bg=VOID, fg=ROSE,
                                     font=self.f_small, wraplength=470,
                                     justify="left")
        self.setup_status.pack(anchor="w", pady=(0, 10))

        self.setup_button = ttk.Button(frame, text="Create pairing code",
                                       style="Accent.TButton",
                                       command=self.on_create_pairing)
        self.setup_button.pack(anchor="w")

    def on_create_pairing(self) -> None:
        url = self.url_var.get().strip()
        key = self.key_var.get().strip()
        if not url.startswith("https://") or not key:
            self.setup_status.config(
                text="Enter the https project URL and the anon key.", fg=ROSE)
            return

        self.setup_button.config(state="disabled")
        self.setup_status.config(text="Contacting Supabase…", fg=MUTED)

        def work() -> None:
            try:
                payload, config, _png = pairing.create_pairing(
                    supabase_url=url, supabase_anon_key=key,
                    device_name=default_device_name(),
                )
                self.queue.put(UiMessage("paired", (payload, config)))
            except (SupabaseError, RuntimeError, ValueError) as exc:
                self.queue.put(UiMessage("error", str(exc)))

        threading.Thread(target=work, daemon=True).start()

    # -- pairing view -------------------------------------------------------

    def show_pairing(self, payload: pairing.PairingPayload) -> None:
        self.pair_payload = payload
        frame = self._clear()
        self._header(frame, "Open ClipSync on your phone and scan this code. "
                            "It expires in 10 minutes.")

        card = tk.Frame(frame, bg=PANEL, highlightbackground=EDGE,
                        highlightthickness=1)
        card.pack(fill="x", pady=(0, 16))

        self._qr_image = self._qr_photoimage(payload)
        tk.Label(card, image=self._qr_image, bg=PANEL, bd=0).pack(pady=18)

        tk.Label(card, text="KEY CHECKSUM", bg=PANEL, fg=DIM,
                 font=self.f_small).pack()
        tk.Label(card, text=crypto.fingerprint(payload_key(payload)), bg=PANEL,
                 fg=CYAN, font=self.f_mono_big).pack(pady=(2, 4))
        tk.Label(card, text="This must match the checksum shown on your phone.",
                 bg=PANEL, fg=MUTED, font=self.f_small).pack(pady=(0, 16))

        self.pair_status = tk.Label(frame, text="Waiting for a phone to pair…",
                                    bg=VOID, fg=AMBER, font=self.f_small)
        self.pair_status.pack(anchor="w", pady=(0, 14))

        row = tk.Frame(frame, bg=VOID)
        row.pack(anchor="w")
        ttk.Button(row, text="Start syncing", style="Accent.TButton",
                   command=self._pairing_done).pack(side="left")
        ttk.Button(row, text="Save QR as image", style="Ghost.TButton",
                   command=self._save_qr).pack(side="left", padx=8)

    def _qr_photoimage(self, payload: pairing.PairingPayload) -> tk.PhotoImage:
        """Render the QR without Pillow: Tk can build an image from pixel rows."""
        matrix = pairing.build_qr(payload).get_matrix()
        scale = max(2, 260 // len(matrix))
        size = len(matrix) * scale
        image = tk.PhotoImage(width=size, height=size)
        image.put("#FFFFFF", to=(0, 0, size, size))
        for y, row in enumerate(matrix):
            runs = []
            start = None
            for x, dark in enumerate(row + [False]):
                if dark and start is None:
                    start = x
                elif not dark and start is not None:
                    runs.append((start, x))
                    start = None
            for x0, x1 in runs:
                image.put("#000000",
                          to=(x0 * scale, y * scale, x1 * scale, (y + 1) * scale))
        return image

    def _save_qr(self) -> None:
        if not self.pair_payload:
            return
        path = pairing.write_qr_png(self.pair_payload,
                                    config_path().parent / "pairing-qr.png")
        messagebox.showinfo("QR saved", f"Written to:\n{path}")

    def _pairing_done(self) -> None:
        self.show_dashboard()
        self.start_sync()

    # -- dashboard ----------------------------------------------------------

    def show_dashboard(self) -> None:
        frame = self._clear()

        bar = tk.Frame(frame, bg=VOID)
        bar.pack(fill="x", pady=(0, 16))
        tk.Label(bar, text="●", bg=VOID, fg=CYAN, font=self.f_body).pack(side="left")
        tk.Label(bar, text="  ClipSync", bg=VOID, fg=INK,
                 font=self.f_title).pack(side="left")
        self.status_label = tk.Label(bar, text="Starting…", bg=VOID, fg=AMBER,
                                     font=self.f_small)
        self.status_label.pack(side="right")

        assert self.config_data is not None
        tk.Label(frame,
                 text=f"Room {self.config_data.room_id[:8]}…   "
                      f"key {self.config_data.fingerprint}",
                 bg=VOID, fg=DIM, font=self.f_mono).pack(anchor="w", pady=(0, 14))

        tk.Label(frame, text="DEVICES", bg=VOID, fg=DIM,
                 font=self.f_small).pack(anchor="w")
        self.devices_frame = tk.Frame(frame, bg=VOID)
        self.devices_frame.pack(fill="x", pady=(6, 18))

        tk.Label(frame, text="RECENT", bg=VOID, fg=DIM,
                 font=self.f_small).pack(anchor="w")
        list_wrap = tk.Frame(frame, bg=PANEL, highlightbackground=EDGE,
                             highlightthickness=1)
        list_wrap.pack(fill="both", expand=True, pady=(6, 16))
        self.history_box = tk.Listbox(
            list_wrap, bg=PANEL, fg=INK, font=self.f_mono, bd=0,
            highlightthickness=0, selectbackground=PANEL_2, selectforeground=CYAN,
            activestyle="none",
        )
        self.history_box.pack(fill="both", expand=True, padx=10, pady=10)
        self._render_history()

        row = tk.Frame(frame, bg=VOID)
        row.pack(fill="x")
        self.pause_button = ttk.Button(row, text="Pause syncing",
                                       style="Ghost.TButton",
                                       command=self.toggle_pause)
        self.pause_button.pack(side="left")
        ttk.Button(row, text="Unpair", style="Ghost.TButton",
                   command=self.on_unpair).pack(side="left", padx=8)
        ttk.Button(row, text="Open dashboard help", style="Ghost.TButton",
                   command=lambda: webbrowser.open(
                       "https://ayomide716.github.io/Testing_Fable/")
                   ).pack(side="right")

        self._schedule_roster()

    def _render_history(self) -> None:
        if not hasattr(self, "history_box"):
            return
        self.history_box.delete(0, tk.END)
        if not self._history:
            self.history_box.insert(tk.END, "  Nothing synced yet.")
            self.history_box.insert(tk.END, "  Copy something on either device.")
            return
        for event in self._history[:40]:
            text = event.text.replace("\n", " ⏎ ")
            if len(text) > 62:
                text = text[:62] + "…"
            self.history_box.insert(tk.END, f"  {event.sender_device}: {text}")

    def _schedule_roster(self) -> None:
        self._refresh_roster()
        self._roster_job = self.after(ROSTER_MS, self._schedule_roster)

    def _refresh_roster(self) -> None:
        if not (self.listener and self.config_data):
            return

        def work() -> None:
            try:
                rows = fetch_devices(self.listener.client, self.config_data.room_id)
                self.queue.put(UiMessage("devices", rows))
            except SupabaseError:
                pass  # a transient roster failure is not worth surfacing

        threading.Thread(target=work, daemon=True).start()

    def _render_devices(self, rows: list) -> None:
        for child in self.devices_frame.winfo_children():
            child.destroy()
        if not rows:
            tk.Label(self.devices_frame, text="No devices yet", bg=VOID, fg=DIM,
                     font=self.f_small).pack(anchor="w")
            return
        for row in rows:
            line = tk.Frame(self.devices_frame, bg=VOID)
            line.pack(fill="x", pady=2)
            tk.Label(line, text="●", bg=VOID, fg=GREEN,
                     font=self.f_small).pack(side="left")
            tk.Label(line, text=f" {row.get('device_name')}", bg=VOID, fg=INK,
                     font=self.f_body).pack(side="left")
            tk.Label(line, text=f"  {row.get('platform')}", bg=VOID, fg=DIM,
                     font=self.f_small).pack(side="left")

    # -- sync engine --------------------------------------------------------

    def start_sync(self) -> None:
        if not self.config_data:
            return

        def on_event(event: ClipEvent) -> None:
            self.queue.put(UiMessage("event", event))

        self.listener = ClipboardListener(self.config_data, on_event=on_event)

        def work() -> None:
            try:
                self.listener.start()
                self.queue.put(UiMessage("status", ("Synced", GREEN)))
            except Exception as exc:  # noqa: BLE001 - surfaced in the UI
                self.queue.put(UiMessage("error", str(exc)))

        threading.Thread(target=work, daemon=True).start()

    def toggle_pause(self) -> None:
        if not self.listener:
            return
        if self.listener.running and not self.listener._stop.is_set():
            self.listener.stop()
            self.pause_button.config(text="Resume syncing")
            self.status_label.config(text="Paused", fg=AMBER)
        else:
            self.start_sync()
            self.pause_button.config(text="Pause syncing")

    def on_unpair(self) -> None:
        if not messagebox.askyesno(
            "Unpair this computer?",
            "The room key will be deleted from this computer. "
            "Synced items become unreadable here.",
        ):
            return
        if self.listener:
            self.listener.stop()
            self.listener = None
        if self._roster_job:
            self.after_cancel(self._roster_job)
            self._roster_job = None
        path = config_path()
        if path.exists():
            path.unlink()
        self.config_data = None
        self._history.clear()
        self.show_setup()

    # -- ui pump ------------------------------------------------------------

    def _drain_queue(self) -> None:
        try:
            while True:
                message = self.queue.get_nowait()
                self._handle(message)
        except queue.Empty:
            pass
        self.after(POLL_MS, self._drain_queue)

    def _handle(self, message: UiMessage) -> None:
        if message.kind == "paired":
            payload, config = message.payload  # type: ignore[misc]
            self.config_data = config
            self.show_pairing(payload)
        elif message.kind == "event":
            self._history.insert(0, message.payload)  # type: ignore[arg-type]
            del self._history[60:]
            self._render_history()
            if hasattr(self, "pair_status"):
                self.pair_status.config(text="A device is syncing.", fg=GREEN)
        elif message.kind == "devices":
            if hasattr(self, "devices_frame"):
                self._render_devices(message.payload)  # type: ignore[arg-type]
        elif message.kind == "status":
            text, colour = message.payload  # type: ignore[misc]
            if hasattr(self, "status_label"):
                self.status_label.config(text=text, fg=colour)
        elif message.kind == "error":
            self._show_error(str(message.payload))

    def _show_error(self, text: str) -> None:
        if hasattr(self, "setup_status") and self.setup_status.winfo_exists():
            self.setup_status.config(text=text, fg=ROSE)
            self.setup_button.config(state="normal")
        elif hasattr(self, "status_label") and self.status_label.winfo_exists():
            self.status_label.config(text="Error", fg=ROSE)
            messagebox.showerror("ClipSync", text)
        else:
            messagebox.showerror("ClipSync", text)

    def on_close(self) -> None:
        if self.listener:
            self.listener.stop(timeout=2)
        self.destroy()


def payload_key(payload: pairing.PairingPayload) -> bytes:
    return crypto.decode_key(payload.key_b64)


def main() -> int:
    try:
        app = ClipSyncApp()
    except tk.TclError as exc:
        print(f"cannot open a window: {exc}\n"
              "Use the command line instead: clipsync pair")
        return 1
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
