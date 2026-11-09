"""Webhook receiver for another project.

    KOLO_WEBHOOK_SECRET=... uvicorn webhook_receiver:app --port 9000
"""
import os

from fastapi import FastAPI, Header, HTTPException, Request

from kolo_client import verify_webhook

app = FastAPI()
WEBHOOK_SECRET = os.environ["KOLO_WEBHOOK_SECRET"]


@app.post("/kolo-webhook")
async def kolo_webhook(request: Request, x_kolo_signature: str = Header()):
    # raw bytes! after json.loads/dumps the signature won't match
    body = await request.body()
    if not verify_webhook(WEBHOOK_SECRET, x_kolo_signature, body):
        raise HTTPException(401, "bad signature")

    event = await request.json()
    if event["event"] == "participant.joined":
        print(f"{event['data']['name']} joined {event['data']['room']}")
    else:
        print("event:", event["event"])
    return {"ok": True}
