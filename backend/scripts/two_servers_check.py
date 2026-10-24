"""Horizontal scaling check: Anya on server :8001, Borya on :8002.

Start two servers that share Postgres and Redis:
    uv run uvicorn kolo.main:create_app --factory --port 8001
    uv run uvicorn kolo.main:create_app --factory --port 8002
and then: uv run python scripts/two_servers_check.py
"""
import asyncio
import json

import httpx
import websockets

A, B = "http://localhost:8001", "http://localhost:8002"


async def main() -> None:
    async with httpx.AsyncClient() as http:
        room = (await http.post(f"{A}/api/v1/rooms", json={"name": "Два сервера"})).json()
        code = room["code"]
        anya = (
            await http.post(
                f"{A}/api/v1/rooms/{code}/join",
                json={"display_name": "Аня", "host_secret": room["host_secret"]},
            )
        ).json()
        borya = (await http.post(f"{B}/api/v1/rooms/{code}/join", json={"display_name": "Боря"})).json()

    ws_a_url = f"ws://localhost:8001{anya['ws_path']}?token={anya['token']}"
    ws_b_url = f"ws://localhost:8002{borya['ws_path']}?token={borya['token']}"

    async with websockets.connect(ws_a_url) as ws_a:
        print("Аня (:8001) <-", json.loads(await ws_a.recv())["type"])

        async with websockets.connect(ws_b_url) as ws_b:
            welcome = json.loads(await ws_b.recv())
            print("Боря (:8002) <-", welcome["type"], "peers:", [p["name"] for p in welcome["peers"]])
            print("Аня (:8001) <-", json.loads(await ws_a.recv())["type"])

            await ws_b.send(json.dumps({"type": "offer", "to": anya["participant_id"], "sdp": "v=0"}))
            offer = json.loads(await ws_a.recv())
            print("Аня (:8001) <-", offer["type"], "от", offer["from"])
            assert offer["from"] == borya["participant_id"]

    print("OK: сообщения ходят между серверами через Redis")


asyncio.run(main())
