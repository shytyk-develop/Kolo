# src/kolo/services/events.py

import asyncio
import hashlib
import hmac
import json
import time
from typing import Protocol

import httpx

from kolo.core.config import Settings
from kolo.core.logging import log


class EventSink(Protocol):
    # analytics/audit events
    def emit(self, event: str, data: dict) -> None: ...

class NullEventSink:
    # does nothing, default in dev
    def emit(self, event: str, data: dict) -> None:
        return None

class RecordingEventSink:
    """For tests: keeps a list of emitted events."""
    
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []
        
    def emit(self, event: str, data: dict) -> None:
        self.events.append((event, data))


def sign_payload(secret: str, timestamp: int, body: bytes) -> str:
    """Stripe-style signature: HMAC-SHA256 of 'timestamp.body'."""
    message = f"{timestamp}.".encode() + body
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


class WebhookSender:
    """Posts events to KOLO_WEBHOOK_URL, signed, with retries. In memory only: a restart loses them."""

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        assert settings.webhook_url and settings.webhook_secret
        self._url = settings.webhook_url
        self._secret = settings.webhook_secret.get_secret_value()
        self._client = client or httpx.AsyncClient(timeout=5.0)
        self._tasks: set[asyncio.Task] = set()

    def emit(self, event: str, data: dict) -> None:
        task = asyncio.create_task(self._deliver(event, data))
        # keep a ref, or gc can kill the task halfway
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _deliver(self, event: str, data: dict, attempts: int = 3) -> None:
        body = json.dumps({"event": event, "data": data, "sent_at": int(time.time())}).encode()
        for attempt in range(attempts):
            # fresh timestamp each attempt, receivers drop old ones
            timestamp = int(time.time())
            headers = {
                "Content-Type": "application/json",
                "X-Kolo-Event": event,
                "X-Kolo-Signature": f"t={timestamp},v1={sign_payload(self._secret, timestamp, body)}",
            }
            try:
                response = await self._client.post(self._url, content=body, headers=headers)
                # 4xx = receiver said no, retrying won't change that
                if response.status_code < 500:
                    if response.is_error:
                        log.warning("webhook_rejected", event_name=event, status=response.status_code)
                    return
                log.warning("webhook_failed", event_name=event, attempt=attempt, status=response.status_code)
            except httpx.HTTPError as exc:
                # no str(exc), it can contain the url
                log.warning("webhook_failed", event_name=event, attempt=attempt, error=type(exc).__name__)

            # 1s, 2s, ... no pause after the last one
            if attempt < attempts - 1:
                await asyncio.sleep(2**attempt)

        log.error("webhook_gave_up", event_name=event, attempts=attempts)

    async def aclose(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await self._client.aclose()
