"""Quick SDK check against a running Kolo.

    KOLO_URL=http://localhost:8000 python sdk/examples/smoke.py
"""
import asyncio
import hashlib
import hmac
import os
import time

from kolo_client import KoloClient, KoloError, verify_webhook


async def main() -> None:
    url = os.environ.get("KOLO_URL", "http://localhost:8000")
    async with KoloClient(url, api_key=os.environ.get("KOLO_API_KEY")) as kolo:
        room = await kolo.create_room(name="Order #42", lobby_enabled=True)
        print(room.join_url, room.lobby_enabled)
        print(await kolo.get_room(room.code))
        try:
            await kolo.get_room("zzz-zzzz-zzz")
        except KoloError as exc:
            print("error:", exc)

    # sign like Kolo does, then check a good and a changed body
    secret, body, t = "whsec-demo", b'{"event": "test"}', int(time.time())
    header = f"t={t},v1=" + hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    print("webhook ok:", verify_webhook(secret, header, body), verify_webhook(secret, header, body + b" "))


asyncio.run(main())
