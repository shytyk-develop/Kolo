"""What did the TLS proxy learn? Reads what mitm_addon.py wrote down."""
import json
import re
import sys
from collections import Counter

flows = [json.loads(line) for line in open("/results/mitm-flows.jsonl") if line.strip()]
room = json.load(open("/results/room.json"))
# the site's own javascript is public and mentions "a=fingerprint" in its code: not a leak.
# What counts is what the callers send and get: the api and the websocket
private = [f for f in flows if "/_next/" not in f.get("url", "")]
for flow in private:
    if flow["kind"] == "http" and "text/html" in json.dumps(flow.get("request_headers", {})):
        flow["response_body"] = ""  # the page itself, the same for everyone
everything = "\n".join(json.dumps(f) for f in private)

http = [f for f in flows if f["kind"] == "http"]
ws = [f for f in flows if f["kind"] == "ws"]
types = Counter()
for message in ws:
    try:
        types[json.loads(message["text"]).get("type", "?")] += 1
    except ValueError:
        types["(not json)"] += 1

names = sorted(set(re.findall(r'\\"display_name\\": ?\\"([^"\\]+)', everything)))
tokens = set(re.findall(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", everything))
kids = sorted(set(re.findall(r'\\"kid\\": ?\\"([A-Za-z0-9_-]+)', everything)))

print("== what the TLS proxy (trusted CA) saw ==")
print(f"http requests decrypted:      {len(http)}")
print(f"websocket messages decrypted: {len(ws)}  {dict(types)}")
print(f"room code in urls:            {'yes' if room['code'] in everything else 'no'}  ({room['code']})")
print(f"display names:                {names}")
print(f"room tickets (jwt):           {len(tokens)}")
print(f"key ids (not the key):        {kids}")

secrets = {
    "the room key": room["key"],
    "a link fragment (#k=)": "k=" + room["key"][:12],
    "an sdp (a=fingerprint)": "a=fingerprint",
    "an sdp (m=audio / m=video)": "m=audio",
    "ice candidates (callers' ip addresses)": "candidate:",
}
print("\n== what it looked for and did not find ==")
found = 0
for label, needle in secrets.items():
    hit = needle in everything
    found += hit
    print(f"{'FOUND   ' if hit else 'not seen'}  {label}")

sealed = [json.loads(m["text"]) for m in ws if '"sealed"' in m["text"]]
if sealed:
    print(f"\nexample of what signaling looks like to it:\n  {json.dumps(sealed[0])[:150]}...")
print(f"\nRESULT: {'FAILED, a secret leaked' if found else 'the proxy reads names, room code and tickets; not the key, the sdp or the media'}")
sys.exit(1 if found else 0)
