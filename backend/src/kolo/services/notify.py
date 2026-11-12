"""HTTP client for the notify service (notify/README.md). Errors come out as friendly domain errors."""

import httpx

from kolo.core.logging import log
from kolo.domain.errors import InviteRateLimited, LinkNotFound, TelegramNotLinked, TelegramUnavailable


class NotifyClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = 5.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"X-Api-Key": api_key},
            timeout=timeout,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _call(
        self, method: str, path: str, json: dict | None = None, ok: tuple[int, ...] = ()
    ) -> dict:
        """JSON body of a 2xx (or a status in `ok`); anything else is a domain error."""
        try:
            response = await self._http.request(method, path, json=json)
        except httpx.HTTPError as exc:
            # no str(exc): it can hold the url
            log.warning("notify_unreachable", path=path, error=type(exc).__name__)
            raise TelegramUnavailable() from None
        status = response.status_code
        if status == 429:
            raise InviteRateLimited(int(response.json().get("retry_after") or 60))
        if status == 404 and 404 not in ok and path.startswith("/v1/link/"):
            raise LinkNotFound()
        if status == 422 and path == "/v1/invite":
            # the only 422 left after our own checks: notify doesn't know the caller anymore (/stop)
            raise TelegramNotLinked("Your Telegram link is gone. Connect Telegram again.")
        if status >= 400 and status not in ok:
            log.warning("notify_failed", path=path.split("/")[2], status=status)
            raise TelegramUnavailable()
        return response.json() if response.content and status < 300 else {}

    async def create_link(self) -> dict:
        return await self._call("POST", "/v1/link")

    async def link_status(self, token: str) -> dict:
        return await self._call("GET", f"/v1/link/{token}")

    async def invite(self, *, caller: str, caller_name: str, target: str, room: str) -> dict:
        body = {"caller": caller, "caller_name": caller_name, "target": target, "room": room}
        return await self._call("POST", "/v1/invite", body)

    async def invite_ended(self, invite_id: str) -> None:
        await self._call("POST", f"/v1/invite/{invite_id}/ended", ok=(404,))

    async def calls_completed(self, a: str, b: str) -> None:
        await self._call("POST", "/v1/calls/completed", {"a": a, "b": b})

    async def delete_user(self, handle: str) -> None:
        await self._call("DELETE", f"/v1/users/{handle}")
