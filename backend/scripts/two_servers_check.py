"""Checks that two servers pass messages to each other through Redis.

Run two servers on :8001 and :8002 (same postgres + redis), then:
    uv run python scripts/two_servers_check.py
Behind caddy pass the same url twice:
    uv run python scripts/two_servers_check.py http://localhost:8000 http://localhost:8000
"""
import asyncio
import json
import sys

import httpx
import websockets

A, B = sys.argv[1:3] if len(sys.argv) == 3 else ("http://localhost:8001", "http://localhost:8002")


async def main() -> None:
    async with httpx.AsyncClient() as http:
        room = (await http.post(f"{A}/api/v1/rooms", json={"name": "Two servers"})).json()
        code = room["code"]
        anya = (
            await http.post(
                f"{A}/api/v1/rooms/{code}/join",
                json={"display_name": "Anya", "host_secret": room["host_secret"]},
            )
        ).json()
        borya = (await http.post(f"{B}/api/v1/rooms/{code}/join", json={"display_name": "Borya"})).json()

    ws_a_url = f"{A.replace('http', 'ws', 1)}{anya['ws_path']}?token={anya['token']}"
    ws_b_url = f"{B.replace('http', 'ws', 1)}{borya['ws_path']}?token={borya['token']}"

    async with websockets.connect(ws_a_url) as ws_a:
        print(f"Anya ({A}) <-", json.loads(await ws_a.recv())["type"])

        async with websockets.connect(ws_b_url) as ws_b:
            welcome = json.loads(await ws_b.recv())
            print(f"Borya ({B}) <-", welcome["type"], "peers:", [p["name"] for p in welcome["peers"]])
            print(f"Anya ({A}) <-", json.loads(await ws_a.recv())["type"])

            await ws_b.send(json.dumps({"type": "offer", "to": anya["participant_id"], "sdp": "v=0"}))
            offer = json.loads(await ws_a.recv())
            print(f"Anya ({A}) <-", offer["type"], "from", offer["from"])
            assert offer["from"] == borya["participant_id"]

    print("OK: messages travel between servers via Redis")


asyncio.run(main())
