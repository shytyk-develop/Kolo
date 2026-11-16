"""Guessing rooms, secrets and tickets from the outside. Everything should end in 404 / 401 / 429."""
import asyncio
import base64
import json
import random
import ssl
import string
import sys
import time
import urllib.error
import urllib.request
from collections import Counter

import jwt
import websockets

WEB = "https://kolo.lab"  # the way a browser goes: through the frontend's /api proxy
API = "https://api.kolo.lab"  # straight at the backend, around the proxy
TLS = ssl.create_default_context(cafile="/certs/lab-ca.crt")
failed: list[str] = []


def call(method: str, url: str, body: dict | None = None, headers: dict | None = None) -> tuple[int, str]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, context=TLS, timeout=10) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def random_code() -> str:
    letters = "".join(random.choice(string.ascii_lowercase) for _ in range(10))
    return f"{letters[:3]}-{letters[3:7]}-{letters[7:]}"


def report(title: str, statuses: list[int], seconds: float, expect_none_of: tuple[int, ...] = (200, 201)) -> None:
    counts = dict(sorted(Counter(statuses).items()))
    bad = [s for s in statuses if s in expect_none_of]
    print(f"{title}\n    {len(statuses)} tries in {seconds:.1f}s -> {counts}{'   <-- GOT IN' if bad else ''}")
    if bad:
        failed.append(title)


status, body = call("POST", f"{WEB}/api/v1/rooms", {})
room = json.loads(body)
print(f"a real room to aim at: {room['code']} (status {status})\n")

start = time.time()
statuses = [call("GET", f"{WEB}/api/v1/rooms/{random_code()}")[0] for _ in range(300)]
report("1. guess room codes through the site", statuses, time.time() - start)
passed = sum(1 for s in statuses if s != 429)
print(f"    {passed} guesses got an answer before the limit; the code space is 26^10 = 1.4e14,")
print(f"    at 60 a minute one address needs ~{26**10 / 60 / 60 / 24 / 365:,.0f} years to try them all")

start = time.time()
statuses = [
    call("GET", f"{API}/api/v1/rooms/{random_code()}", headers={"X-Forwarded-For": f"203.0.113.{i % 250}"})[0]
    for i in range(200)
]
report("2. around the proxy, a made-up X-Forwarded-For per request", statuses, time.time() - start)

start = time.time()
statuses = [
    call("GET", f"{API}/api/v1/rooms/{random_code()}", headers={"X-Forwarded-For": f"198.51.100.{i}", "X-Kolo-Proxy": "guess"})[0]
    for i in range(50)
]
report("3. ...and pretending to be the proxy", statuses, time.time() - start)

start = time.time()
statuses = [call("POST", f"{API}/api/v1/rooms/{random_code()}/join", {"display_name": "Eve"})[0] for _ in range(100)]
report("4. join rooms by guessed code", statuses, time.time() - start)

time.sleep(61)  # a fresh minute, so the next ones test the secrets and not the limiter
start = time.time()
statuses = [
    call("PATCH", f"{API}/api/v1/rooms/{room['code']}", {"host_secret": base64.urlsafe_b64encode(random.randbytes(32)).decode(), "lobby_enabled": True})[0]
    for _ in range(40)
]
report("5. guess the host secret of the real room", statuses, time.time() - start)

now = int(time.time())
claims = {"sub": "p_0000000000000000", "room": room["code"], "name": "Eve", "role": "host", "iat": now, "exp": now + 3600}
forged = {
    "signed with a guessed secret": jwt.encode(claims, "your-secret-here", algorithm="HS256"),
    "signed with the dev default": jwt.encode(claims, "dev-only-secret-change-me-in-production-0123456789", algorithm="HS256"),
    "alg none": base64.urlsafe_b64encode(b'{"alg":"none","typ":"JWT"}').decode().rstrip("=")
    + "."
    + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    + ".",
    "garbage": "not.a.token",
}
print("6. forged tickets")
for label, token in forged.items():
    status, _ = call("POST", f"{API}/api/v1/rooms/{room['code']}/ice", headers={"Authorization": f"Bearer {token}"})

    async def socket(token: str = token) -> str:
        try:
            async with websockets.connect(
                f"wss://api.kolo.lab/ws/rooms/{room['code']}?token={token}", ssl=TLS, origin="https://kolo.lab"
            ) as ws:
                message = await asyncio.wait_for(ws.recv(), 5)
                return f"GOT IN: {message[:60]}"
        except websockets.ConnectionClosed as closed:
            return f"closed {closed.rcvd.code if closed.rcvd else '?'}"
        except Exception as error:  # noqa: BLE001
            return type(error).__name__

    ws_result = asyncio.run(socket())
    print(f"    {label:32} turn logins: {status}   socket: {ws_result}")
    if status == 200 or "GOT IN" in ws_result:
        failed.append(f"forged ticket: {label}")

print("7. a socket from another site (Origin: https://evil.example)")


async def foreign() -> str:
    try:
        async with websockets.connect(f"wss://api.kolo.lab/ws/rooms/{room['code']}?token=x", ssl=TLS, origin="https://evil.example"):
            return "GOT IN"
    except websockets.InvalidStatus as error:
        return f"refused, http {error.response.status_code}"
    except websockets.ConnectionClosed as closed:
        return f"closed {closed.rcvd.code if closed.rcvd else '?'}"
    except Exception as error:  # noqa: BLE001
        return type(error).__name__


result = asyncio.run(foreign())
print(f"    {result}")
if "GOT IN" in result:
    failed.append("foreign origin socket")

print("8. broken input: does an error tell anything about the inside?")
probes = [
    ("POST", f"{API}/api/v1/rooms", "{not json"),
    ("POST", f"{API}/api/v1/rooms/{room['code']}/join", json.dumps({"display_name": "x" * 5000})),
    ("POST", f"{API}/api/v1/rooms/{room['code']}/join", json.dumps({"display_name": {"$ne": None}})),
    ("GET", f"{API}/api/v1/rooms/..%2f..%2fetc%2fpasswd", None),
    ("GET", f"{API}/docs", None),
    ("GET", f"{API}/openapi.json", None),
]
for method, url, raw in probes:
    request = urllib.request.Request(url, data=raw.encode() if raw else None, method=method)
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, context=TLS, timeout=10) as response:
            status, text = response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        status, text = error.code, error.read().decode()
    leaks = [word for word in ("Traceback", 'File "', "site-packages", "sqlalchemy", "x" * 100) if word in text]
    print(f"    {method} {url.replace(API, '')[:44]:44} -> {status} {'LEAKS ' + str(leaks) if leaks else 'nothing inside'}")
    if leaks or (status == 200 and "docs" in url) or (status == 200 and "openapi" in url):
        failed.append(f"probe {url}")

time.sleep(61)
start = time.time()
statuses = [call("POST", f"{WEB}/api/v1/rooms", {})[0] for _ in range(40)]
made = statuses.count(201)
print(f"9. flood room creation\n    40 tries in {time.time() - start:.1f}s -> {dict(Counter(statuses))}")
if made > 10:
    failed.append("room creation flood")

print(f"\nRESULT: {'FAILED: ' + '; '.join(failed) if failed else 'nothing guessed, nothing leaked, the limits held'}")
sys.exit(1 if failed else 0)
