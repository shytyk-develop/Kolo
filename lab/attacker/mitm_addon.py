"""The attacker's TLS proxy. The callers trust its CA, so it reads and rewrites everything
inside TLS: http requests, answers, every websocket message.

MITM_MODE picks what it does with the signaling:
  dump         only write down everything it sees
  fingerprint  swap the DTLS fingerprint in plain offers/answers (pose as the other caller)
  flip         change one character in every sealed message
  replay       send every sealed message to the client a second time
  downgrade    hide that the other side has the room key, and drop sealed messages
  lose         drop the first sealed message on its way to a caller (the offer gets lost)
"""
import json
import os
import re

from mitmproxy import ctx, http

MODE = os.environ.get("MITM_MODE", "dump")
OUT = os.environ.get("MITM_OUT", "/results/mitm-flows.jsonl")
FAKE_FINGERPRINT = "a=fingerprint:sha-256 " + ":".join(["AB"] * 32)
FINGERPRINT = re.compile(r"a=fingerprint:sha-256 [0-9A-Fa-f:]+")


class Lab:
    def __init__(self) -> None:
        self.out = open(OUT, "w", buffering=1)  # noqa: SIM115
        self.changed = 0
        self.lost = False

    def _write(self, record: dict) -> None:
        self.out.write(json.dumps(record) + "\n")

    def response(self, flow: http.HTTPFlow) -> None:
        self._write(
            {
                "kind": "http",
                "method": flow.request.method,
                "url": flow.request.pretty_url,
                "request_headers": dict(flow.request.headers),
                "request_body": flow.request.get_text(strict=False) or "",
                "status": flow.response.status_code if flow.response else None,
                "response_body": (flow.response.get_text(strict=False) or "")[:20000] if flow.response else "",
            }
        )

    def websocket_start(self, flow: http.HTTPFlow) -> None:
        self._write({"kind": "ws-open", "url": flow.request.pretty_url})

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        message = flow.websocket.messages[-1]
        if message.injected:
            return
        text = message.text if message.is_text else ""
        self._write({"kind": "ws", "from": "client" if message.from_client else "server", "text": text})
        try:
            data = json.loads(text)
        except ValueError:
            return
        kind = data.get("type")
        changed = None

        if MODE == "fingerprint" and kind in ("offer", "answer") and not message.from_client:
            data["sdp"] = FINGERPRINT.sub(FAKE_FINGERPRINT, data["sdp"])
            changed = data
        elif MODE == "flip" and kind == "sealed" and not message.from_client:
            box = data["box"]
            at = len(box) // 2
            data["box"] = box[:at] + ("A" if box[at] != "A" else "B") + box[at + 1 :]
            changed = data
        elif MODE == "replay" and kind == "sealed" and not message.from_client:
            ctx.master.commands.call("inject.websocket", flow, True, text.encode(), True)
            self.changed += 1
        elif MODE == "lose" and kind == "sealed" and not message.from_client and not self.lost:
            self.lost = True
            message.drop()
            self.changed += 1
        elif MODE == "downgrade":
            if kind == "sealed":
                message.drop()
                self.changed += 1
            elif kind == "welcome" and not message.from_client:
                for peer in data.get("peers", []):
                    peer.pop("kid", None)
                changed = data
            elif kind == "peer-joined" and not message.from_client:
                data["peer"].pop("kid", None)
                changed = data

        if changed is not None:
            message.text = json.dumps(changed)
            self.changed += 1
        if self.changed:
            self._write({"kind": "tampered", "mode": MODE, "count": self.changed})


addons = [Lab()]
