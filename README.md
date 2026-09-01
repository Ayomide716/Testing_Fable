# ClipSync — a zero-knowledge cross-platform clipboard

Copy on your computer, paste on your phone. The server never sees a byte of
plaintext: every clipboard value is sealed with AES-256-GCM under a key that is
generated on the desktop and handed to the phone through a QR code.

```
  ┌───────────────────┐        ciphertext        ┌───────────────────┐
  │  Python agent     │  ───────────────────▶    │  Supabase         │
  │  pyperclip poll   │                          │  Postgres + RLS   │
  │  AES-256-GCM      │  ◀───────────────────    │  Realtime         │
  └───────────────────┘                          └─────────┬─────────┘
            ▲                                              │ realtime INSERT
            │  QR: room id + AES key + single-use code     ▼
            │                                    ┌───────────────────┐
            └─────────── camera ──────────────── │  Expo app         │
                                                 │  SecureStore key  │
                                                 │  tap → clipboard  │
                                                 └───────────────────┘
```

## What lives where

| Path | What it is |
| --- | --- |
| `supabase/schema.sql` | Tables, RLS policies, pairing RPCs, retention job |
| `desktop/clipsync/crypto.py` | AES-256-GCM seal/open, key generation, fingerprint |
| `desktop/clipsync/pairing.py` | Key + room creation, QR rendering (terminal + PNG) |
| `desktop/clipsync/listener.py` | The bidirectional clipboard sync loop |
| `desktop/clipsync/api.py` | Small Supabase REST client (auth + PostgREST) |
| `mobile/src/lib/crypto.ts` | The byte-for-byte TypeScript twin of `crypto.py` |
| `mobile/src/lib/secureStore.ts` | Keychain / Keystore custody of the room key |
| `mobile/src/state/ClipSyncProvider.tsx` | Realtime, notifications, clipboard writes |
| `mobile/src/screens/` | Pairing scanner and the glass dashboard |
| `tests/vectors.json` | Shared vectors both test suites decrypt |

## Setup

### 1. Database

```bash
supabase db push            # or: psql "$DATABASE_URL" -f supabase/schema.sql
```

Then, in the Supabase dashboard, enable **Authentication → Providers → Anonymous
sign-ins**. Devices authenticate anonymously; the identity exists only so RLS
has an `auth.uid()` to scope rows to.

### 2. Desktop agent

```bash
cd desktop
pip install -r requirements.txt

export SUPABASE_URL="https://<project>.supabase.co"
export SUPABASE_ANON_KEY="<anon key>"

python -m clipsync pair     # prints the QR and a key checksum
python -m clipsync run      # starts syncing
```

On Linux `pyperclip` needs a backend: `xclip` or `xsel` on X11, `wl-clipboard`
on Wayland.

Other commands: `python -m clipsync status` (paired devices),
`python -m clipsync send "text"` (publish one value), `python -m clipsync unpair`.

### 3. Mobile app

```bash
cd mobile
npm install
npx expo run:android      # or: npx expo run:ios
```

A development build is required rather than Expo Go, because
`expo-notifications` and `expo-secure-store` need native code. Scan the QR from
step 2 and check that the key checksum on the phone matches the one the CLI
printed — matching checksums are what prove both devices hold the same key.

## How the pairing stays zero-knowledge

1. The desktop generates 32 random bytes (`os.urandom`) and a 192-bit
   single-use join code.
2. It sends **only** `SHA-256(join code)` to `create_room`. The AES key is never
   transmitted, in any form, to anything.
3. The QR carries the room id, the raw key, the join code, and the project URL.
   The only channel it crosses is the phone's camera.
4. The phone redeems the code through `join_room`, which is single-use and
   expires after ten minutes, and writes the key into the Keychain / Keystore.
5. From then on, both sides encrypt with that key. `clipboard_events.payload` is
   `base64(nonce || ciphertext || tag)` and nothing else.

The room id is the GCM additional authenticated data, so a ciphertext copied
into a different room fails its tag check before any plaintext exists.

## Mobile background behaviour — the honest version

Android 10+ refuses clipboard *reads* to background apps, and iOS gives no
background pasteboard access at all. So the app never tries to write the
clipboard from the background. Instead:

1. The Realtime socket delivers the ciphertext.
2. The app raises a **local** notification: *"New copied text received. Tap to
   copy."* The body is that fixed string — the decrypted text never appears on a
   lock screen, and the server has no plaintext to put in a push payload even if
   it wanted to.
3. Tapping brings the app to the foreground, where it decrypts with the
   Keychain key and calls `expo-clipboard`. The write happens on an explicit
   user action, which both platforms allow.

The remaining limit is the socket itself: neither OS keeps a websocket alive
indefinitely behind the app. Events that arrive while the socket is asleep are
picked up on the next foreground, and the feed is fetched fresh on launch. A
true always-on path needs Expo push notifications carrying the ciphertext,
dispatched by a Supabase Edge Function on insert — that keeps the
zero-knowledge property, since the function would forward opaque bytes.

## Distribution

`web/index.html` is the download page — one self-contained file, no build step.
It reads the repository's latest GitHub Release at page load, so the download
links fill themselves in the moment a release exists and degrade to
run-from-source instructions when it doesn't.

Deploy it under **Settings → Pages → Source: GitHub Actions**; the
`Deploy download page` workflow publishes `web/` on every push to `main`.

### Cutting a release

```bash
git tag v1.0.0 && git push origin v1.0.0
```

`.github/workflows/release.yml` then freezes the desktop agent with PyInstaller
on each OS runner (native binaries cannot be cross-compiled), smoke-tests each
one, checksums them into `SHA256SUMS.txt`, and attaches everything to the
release as:

| Asset | Built on |
| --- | --- |
| `clipsync-macos-arm64.tar.gz` | macos-14 |
| `clipsync-macos-x86_64.tar.gz` | macos-13 |
| `clipsync-windows-x86_64.zip` | windows-2022 |
| `clipsync-linux-x86_64.tar.gz` | ubuntu-22.04 |

The download page matches assets by those names, so keep them stable.

### Phone builds

The app is not built by CI, because both stores need credentials this repo
cannot hold. With an Expo account:

```bash
cd mobile
npx eas build -p android --profile preview   # produces an installable .apk
npx eas build -p ios --profile preview       # needs an Apple Developer account
```

Upload the resulting `.apk` to the same GitHub Release — the page picks up any
asset ending in `.apk` automatically. iOS has no sideload path: it needs
TestFlight, which needs the paid Apple Developer Program.

### What is not signed

The packaged desktop builds carry no code signature, so macOS Gatekeeper and
Windows SmartScreen will both warn on first launch. Signing needs a paid Apple
Developer ID and a Windows certificate. Until those exist, the honest paths are
verifying `SHA256SUMS.txt` or running from source — the download page says so
plainly rather than telling people to click through the warning.

## Tests

```bash
python3 desktop/tests/test_crypto.py       # round trip, tamper, AAD, vectors
python3 desktop/tests/test_listener.py     # sync loop, echo suppression
cd mobile && npm test                      # the same vectors, in TypeScript
```

`tests/vectors.json` holds payloads produced by the Python implementation. Both
suites decrypt them, so the two implementations cannot drift apart unnoticed.

## Security notes

- **Key storage.** Desktop: `~/.config/clipsync/room.json`, mode 600, written
  through an atomic replace and refused at load time if the mode is loose.
  Mobile: `expo-secure-store` with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, so the
  key never rides along to a new device or an iCloud backup.
- **Isolation.** Every table has RLS on. Reads and writes to `clipboard_events`
  require a `room_members` row for `auth.uid()`, and Realtime evaluates the same
  policies, so a socket only ever receives rows for its own room.
- **Append-only.** There is no UPDATE policy on `clipboard_events`.
- **Retention.** `purge_expired_clipboard_events(24)` drops old ciphertext;
  schedule it with `pg_cron` (a one-line example is in the schema).
- **Rotation.** Re-running `python -m clipsync pair --force` mints a new room and
  key. Old ciphertext becomes permanently unreadable, which is the intent.
- **Not covered.** A compromised endpoint reads the clipboard directly; no
  encryption scheme helps there. Metadata (row count, sizes, timing) is visible
  to the server, and only images/files are out of scope for this version.
