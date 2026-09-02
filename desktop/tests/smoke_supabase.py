"""Live end-to-end check against a real Supabase project.

Everything else in this repo is tested offline. This is the one script that
exercises the parts nothing else can: anonymous sign-in, the pairing RPCs, the
RLS isolation boundary, and a full encrypt → store → fetch → decrypt round trip
through the actual database.

It runs in CI (.github/workflows/smoke.yml) so the credentials live in GitHub
secrets rather than on anyone's laptop. To run it locally instead:

    export SUPABASE_URL="https://<project>.supabase.co"
    export SUPABASE_ANON_KEY="<anon public key>"
    python desktop/tests/smoke_supabase.py

It creates one room and one clipboard row, then deletes both. A failure part
way through may leave a room behind; the room id is printed so it can be
removed by hand.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from clipsync import crypto  # noqa: E402
from clipsync.api import SupabaseClient, SupabaseError  # noqa: E402
from clipsync.pairing import generate_join_code  # noqa: E402

GREEN, RED, DIM, RESET = "\033[92m", "\033[91m", "\033[2m", "\033[0m"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    mark = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"  {mark}  {name}" + (f"\n        {DIM}{detail}{RESET}" if detail else ""))
    return ok


def main() -> int:
    url = os.environ.get("SUPABASE_URL", "").strip()
    anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url or not anon:
        print("SUPABASE_URL and SUPABASE_ANON_KEY must be set.", file=sys.stderr)
        return 2

    print(f"\nClipSync live smoke test against {url}\n")

    desktop = SupabaseClient(url, anon)
    phone = SupabaseClient(url, anon)
    room_id = None
    secret = "the quick brown fox — ✅ 🔐"

    try:
        # --- 1. identities -------------------------------------------------
        try:
            desktop.sign_in_anonymously()
            ok = check("desktop gets an anonymous identity", bool(desktop.user_id))
        except SupabaseError as exc:
            check("desktop gets an anonymous identity", False, str(exc))
            print("\nAnonymous sign-in is off. Enable it under "
                  "Authentication → Providers → Anonymous sign-ins.\n")
            return 1
        if not ok:
            return 1

        phone.sign_in_anonymously()
        check("phone gets a separate anonymous identity",
              bool(phone.user_id) and phone.user_id != desktop.user_id)

        # --- 2. pairing ----------------------------------------------------
        key = crypto.generate_key()
        join_code = generate_join_code()

        room_id = desktop.rpc("create_room", {
            "p_join_code": join_code,
            "p_device_name": "ci-desktop",
            "p_ttl_seconds": 600,
        })
        if not check("create_room() returns a room id", isinstance(room_id, str),
                     f"room {room_id}"):
            return 1

        # --- 3. the desktop publishes ciphertext ---------------------------
        payload = crypto.encrypt(key, secret, room_id)
        desktop.insert("clipboard_events", {
            "room_id": room_id,
            "payload": payload,
            "sender_device": "ci-desktop",
            "content_kind": "text",
            "payload_bytes": len(payload),
        })
        check("desktop can insert into its own room", True)

        rows = desktop.select("clipboard_events", {
            "select": "id,payload", "room_id": f"eq.{room_id}",
        })
        check("desktop reads its row back", len(rows) == 1, f"{len(rows)} row(s)")

        if rows:
            check("round trip decrypts to the original text",
                  crypto.decrypt(key, rows[0]["payload"], room_id) == secret)
            check("the stored payload is not the plaintext",
                  secret not in rows[0]["payload"])

        # --- 4. the isolation boundary -------------------------------------
        # This is the check that matters most: a signed-in device that is NOT
        # a member of the room must see nothing at all.
        outsider_rows = phone.select("clipboard_events", {
            "select": "id", "room_id": f"eq.{room_id}",
        })
        check("RLS hides the room from a non-member",
              len(outsider_rows) == 0,
              f"non-member saw {len(outsider_rows)} row(s)")

        try:
            phone.insert("clipboard_events", {
                "room_id": room_id, "payload": "AAAA", "sender_device": "intruder",
            })
            check("RLS blocks a non-member from writing", False,
                  "the insert was accepted")
        except SupabaseError:
            check("RLS blocks a non-member from writing", True)

        # --- 5. joining ----------------------------------------------------
        try:
            phone.rpc("join_room", {
                "p_room_id": room_id, "p_join_code": "wrong-code-entirely",
                "p_device_name": "ci-phone", "p_platform": "android",
            })
            check("join_room() rejects a wrong pairing code", False, "it was accepted")
        except SupabaseError:
            check("join_room() rejects a wrong pairing code", True)

        phone.rpc("join_room", {
            "p_room_id": room_id, "p_join_code": join_code,
            "p_device_name": "ci-phone", "p_platform": "android",
        })
        check("join_room() accepts the real pairing code", True)

        joined_rows = phone.select("clipboard_events", {
            "select": "id,payload", "room_id": f"eq.{room_id}",
        })
        check("the paired phone now sees the row", len(joined_rows) == 1)
        if joined_rows:
            check("the phone decrypts what the desktop sent",
                  crypto.decrypt(key, joined_rows[0]["payload"], room_id) == secret)

        devices = phone.select("room_members", {
            "select": "device_name", "room_id": f"eq.{room_id}",
        })
        check("both devices appear in the room roster", len(devices) == 2,
              ", ".join(sorted(d["device_name"] for d in devices)))

        # --- 6. the append-only rule ---------------------------------------
        try:
            desktop._request(
                "PATCH", f"{desktop.url}/rest/v1/clipboard_events",
                params={"room_id": f"eq.{room_id}"},
                json={"sender_device": "rewritten"},
                headers={"Prefer": "return=representation"},
            )
            still = desktop.select("clipboard_events", {
                "select": "sender_device", "room_id": f"eq.{room_id}",
            })
            check("history is append-only (no UPDATE policy)",
                  all(r["sender_device"] != "rewritten" for r in still))
        except SupabaseError:
            check("history is append-only (no UPDATE policy)", True)

    except SupabaseError as exc:
        check("unexpected Supabase error", False, str(exc))
    except Exception as exc:  # noqa: BLE001
        check("unexpected error", False, f"{type(exc).__name__}: {exc}")
    finally:
        # --- cleanup -------------------------------------------------------
        if room_id:
            try:
                desktop.delete("clipboard_events", {"room_id": f"eq.{room_id}"})
                desktop.delete("rooms", {"id": f"eq.{room_id}"})
                print(f"\n{DIM}cleaned up room {room_id}{RESET}")
            except SupabaseError as exc:
                print(f"\n{RED}cleanup failed for room {room_id}: {exc}{RESET}")

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n{passed}/{total} checks passed\n")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
