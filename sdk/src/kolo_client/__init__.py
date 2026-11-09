"""Mini SDK for Kolo.

    from kolo_client import KoloClient

    async with KoloClient("https://api.kolo.app", api_key="...") as kolo:
        room = await kolo.create_room(name="Call about order #42")
        print(room.join_url)
"""
import hashlib
import hmac
import time
from dataclasses import dataclass

import httpx

__all__ = ["KoloClient", "KoloError", "Room", "verify_webhook"]


class KoloError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message = status, code, message


@dataclass(frozen=True)
class Room:
    code: str
    name: str
    join_url: str
    host_secret: str
    max_participants: int
    lobby_enabled: bool


class KoloClient:
    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,  # for tests
    ) -> None:
        headers = {"X-API-Key": api_key} if api_key else {}
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"), headers=headers, timeout=timeout, transport=transport
        )

    async def __aenter__(self) -> "KoloClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, **kwargs) -> dict:
        response = await self._http.request(method, f"/api/v1{path}", **kwargs)
        if response.is_error:
            is_json = response.headers.get("content-type", "").startswith("application/json")
            error = response.json().get("error", {}) if is_json else {}
            raise KoloError(
                response.status_code,
                error.get("code", "http_error"),
                error.get("message", response.text),
            )
        return response.json()

    async def create_room(
        self, name: str | None = None, max_participants: int | None = None, lobby_enabled: bool = False
    ) -> Room:
        body = {"name": name, "max_participants": max_participants, "lobby_enabled": lobby_enabled}
        data = await self._request("POST", "/rooms", json={k: v for k, v in body.items() if v is not None})
        return Room(**{field: data[field] for field in Room.__dataclass_fields__})

    async def get_room(self, code: str) -> dict:
        return await self._request("GET", f"/rooms/{code}")


def verify_webhook(secret: str, signature_header: str, body: bytes, tolerance: int = 300) -> bool:
    """Checks the X-Kolo-Signature header: 't=<time>,v1=<hex>'."""
    try:
        parts = dict(item.split("=", 1) for item in signature_header.split(","))
        timestamp, received = int(parts["t"]), parts["v1"]
    except (KeyError, ValueError):
        return False

    # old request replayed
    if abs(time.time() - timestamp) > tolerance:
        return False

    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    # bytes, compare_digest throws TypeError on non-ascii str
    return hmac.compare_digest(expected.encode(), received.encode())
