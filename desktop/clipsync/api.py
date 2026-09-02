"""Minimal Supabase client for the desktop agent (GoTrue + PostgREST).

Deliberately dependency-light: one ``requests.Session`` with retry/backoff and
automatic access-token refresh. The agent only ever sends ciphertext.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import requests

DEFAULT_TIMEOUT = 15.0
MAX_ATTEMPTS = 4


class SupabaseError(RuntimeError):
    """Non-retryable error returned by the Supabase API."""

    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


@dataclass
class Session:
    access_token: str
    refresh_token: str
    user_id: str
    expires_at: float  # unix seconds


class SupabaseClient:
    def __init__(self, url: str, anon_key: str, timeout: float = DEFAULT_TIMEOUT):
        if not url or not anon_key:
            raise ValueError("supabase url and anon key are required")
        self.url = url.rstrip("/")
        self.anon_key = anon_key
        self.timeout = timeout
        self._session: Optional[Session] = None
        self._lock = threading.Lock()
        self._http = requests.Session()
        self._http.headers.update({"apikey": anon_key, "Accept": "application/json"})

    # -- auth ---------------------------------------------------------------

    @property
    def user_id(self) -> Optional[str]:
        return self._session.user_id if self._session else None

    @property
    def refresh_token(self) -> Optional[str]:
        return self._session.refresh_token if self._session else None

    @property
    def access_token(self) -> Optional[str]:
        return self._session.access_token if self._session else None

    def sign_in_anonymously(self) -> Session:
        """Create a throwaway identity. It owns nothing but room membership."""
        data = self._request(
            "POST",
            f"{self.url}/auth/v1/signup",
            json={"data": {"client": "clipsync-desktop"}},
            authed=False,
        )
        return self._adopt(data)

    def refresh(self, refresh_token: str) -> Session:
        data = self._request(
            "POST",
            f"{self.url}/auth/v1/token",
            params={"grant_type": "refresh_token"},
            json={"refresh_token": refresh_token},
            authed=False,
        )
        return self._adopt(data)

    def resume_or_sign_in(self, refresh_token: Optional[str]) -> Session:
        """Reuse a stored session when possible; otherwise mint a new identity."""
        if refresh_token:
            try:
                return self.refresh(refresh_token)
            except SupabaseError:
                pass
        return self.sign_in_anonymously()

    def _adopt(self, data: Dict[str, Any]) -> Session:
        access = data.get("access_token")
        refresh = data.get("refresh_token")
        user = (data.get("user") or {}).get("id")
        if not access or not refresh or not user:
            raise SupabaseError(
                "auth response did not contain a session; is anonymous sign-in "
                "enabled for this Supabase project?"
            )
        expires_in = float(data.get("expires_in") or 3600)
        with self._lock:
            self._session = Session(access, refresh, user, time.time() + expires_in)
        return self._session

    def _auth_header(self) -> str:
        with self._lock:
            session = self._session
        if session is None:
            raise SupabaseError("not signed in")
        if session.expires_at - time.time() < 60:
            session = self.refresh(session.refresh_token)
        return f"Bearer {session.access_token}"

    # -- postgrest ----------------------------------------------------------

    def rpc(self, name: str, payload: Dict[str, Any]) -> Any:
        return self._request("POST", f"{self.url}/rest/v1/rpc/{name}", json=payload)

    def insert(self, table: str, row: Dict[str, Any], returning: bool = False) -> Any:
        headers = {"Prefer": "return=representation" if returning else "return=minimal"}
        return self._request(
            "POST", f"{self.url}/rest/v1/{table}", json=row, headers=headers
        )

    def select(self, table: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        result = self._request("GET", f"{self.url}/rest/v1/{table}", params=params)
        return result or []

    def delete(self, table: str, params: Dict[str, Any]) -> None:
        """Delete rows matching PostgREST filters. RLS still applies."""
        self._request(
            "DELETE",
            f"{self.url}/rest/v1/{table}",
            params=params,
            headers={"Prefer": "return=minimal"},
        )

    # -- transport ----------------------------------------------------------

    def _request(
        self,
        method: str,
        url: str,
        *,
        json: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        authed: bool = True,
    ) -> Any:
        merged = dict(headers or {})
        merged["Authorization"] = (
            self._auth_header() if authed else f"Bearer {self.anon_key}"
        )
        if json is not None:
            merged["Content-Type"] = "application/json"

        delay = 1.0
        last_error: Optional[Exception] = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = self._http.request(
                    method, url, json=json, params=params,
                    headers=merged, timeout=self.timeout,
                )
            except requests.RequestException as exc:
                last_error = exc
            else:
                if response.status_code < 300:
                    if not response.content or response.status_code == 204:
                        return None
                    try:
                        return response.json()
                    except ValueError:
                        return None
                # 4xx (other than 429) will not get better by retrying.
                if response.status_code < 500 and response.status_code != 429:
                    raise SupabaseError(
                        _describe(response), status=response.status_code
                    )
                last_error = SupabaseError(_describe(response), response.status_code)

            if attempt < MAX_ATTEMPTS:
                time.sleep(delay)
                delay *= 2

        raise SupabaseError(f"request to {url} failed after {MAX_ATTEMPTS} attempts: {last_error}")


def _describe(response: requests.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return f"HTTP {response.status_code}: {response.text[:200]}"
    for field in ("message", "error_description", "msg", "hint", "error"):
        if isinstance(body, dict) and body.get(field):
            return f"HTTP {response.status_code}: {body[field]}"
    return f"HTTP {response.status_code}: {body}"
