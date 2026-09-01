"""Round-trip, tamper and cross-language checks for the payload format.

Run from the repo root:  python -m pytest desktop/tests -q
(or: python -m unittest discover -s desktop/tests)
"""

from __future__ import annotations

import base64
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from clipsync import crypto  # noqa: E402

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "tests" / "vectors.json").read_text())


class RoundTripTests(unittest.TestCase):
    def setUp(self) -> None:
        self.key = crypto.generate_key()
        self.room = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"

    def test_round_trip_preserves_unicode(self) -> None:
        for text in ["", "plain", "café — naïve 🚀 клавиатура", "a" * 10_000]:
            with self.subTest(text=text[:20]):
                payload = crypto.encrypt(self.key, text, self.room)
                self.assertEqual(crypto.decrypt(self.key, payload, self.room), text)

    def test_nonce_is_unique_per_message(self) -> None:
        first = crypto.encrypt(self.key, "same", self.room)
        second = crypto.encrypt(self.key, "same", self.room)
        self.assertNotEqual(first, second, "GCM nonce reuse would be catastrophic")

    def test_wrong_key_is_rejected(self) -> None:
        payload = crypto.encrypt(self.key, "secret", self.room)
        with self.assertRaises(crypto.DecryptionError):
            crypto.decrypt(crypto.generate_key(), payload, self.room)

    def test_other_room_cannot_open_payload(self) -> None:
        """The room id is the AAD, so a lifted ciphertext fails its tag."""
        payload = crypto.encrypt(self.key, "secret", self.room)
        with self.assertRaises(crypto.DecryptionError):
            crypto.decrypt(self.key, payload, "00000000-0000-0000-0000-000000000000")

    def test_tampering_is_detected(self) -> None:
        payload = crypto.encrypt(self.key, "secret", self.room)
        raw = bytearray(base64.b64decode(payload))
        raw[-1] ^= 0x01  # flip one bit of the auth tag
        with self.assertRaises(crypto.DecryptionError):
            crypto.decrypt(self.key, base64.b64encode(bytes(raw)).decode(), self.room)

    def test_truncated_payload_is_rejected(self) -> None:
        with self.assertRaises(crypto.DecryptionError):
            crypto.decrypt(self.key, base64.b64encode(b"short").decode(), self.room)

    def test_oversized_plaintext_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            crypto.encrypt(self.key, "x" * (crypto.MAX_PLAINTEXT_BYTES + 1), self.room)

    def test_key_length_is_enforced(self) -> None:
        with self.assertRaises(ValueError):
            crypto.encrypt(b"too short", "x", self.room)


class VectorTests(unittest.TestCase):
    """The same vectors are decrypted by the TypeScript suite."""

    def test_shared_vectors_decrypt(self) -> None:
        key = crypto.decode_key(VECTORS["key_b64"])
        for case in VECTORS["cases"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(
                    crypto.decrypt(key, case["payload"], VECTORS["room_id"]),
                    case["plaintext"],
                )

    def test_fingerprint_matches_vector(self) -> None:
        key = crypto.decode_key(VECTORS["key_b64"])
        self.assertEqual(crypto.fingerprint(key), VECTORS["fingerprint"])


if __name__ == "__main__":
    unittest.main()
