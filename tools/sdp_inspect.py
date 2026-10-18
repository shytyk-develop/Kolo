# tools/sdp_inspect.py

"""Parses SDP and displays media, codecs, and ICE candidates."""
import sys
from dataclasses import dataclass

DIRECTIONS = {"sendrecv", "sendonly", "recvonly", "inactive"}

@dataclass
class Candidate:
    foundation: str
    component: int
    protocol: str
    priority: int
    ip: str
    port: int
    type: str

def parse_candidate(line: str) -> Candidate:
    # a=candidate:1 1 udp 2122260223 192.168.1.10 54321 typ host
    parts = line.split(":", 1)[1].split()
    return Candidate(
        foundation=parts[0],
        component=int(parts[1]),
        protocol=parts[2].lower(),
        priority=int(parts[3]),
        ip=parts[4],
        port=int(parts[5]),
        type=parts[7],  # parts[6] is the word "typ"
    )

def decode_priority(priority: int) -> tuple[int, int, int]:
    """Decodes priority back into three parts (RFC 8445, section 5.1.2)."""
    type_pref = priority >> 24
    local_pref = (priority >> 8) & 0xFFFF
    component = 256 - (priority & 0xFF)
    return type_pref, local_pref, component

def parse_sdp(text: str) -> tuple[dict, list[dict]]:
    session: dict = {"fingerprint": None}
    media: list[dict] = []
    current: dict | None = None
    
    for raw in text.splitlines():
        line = raw.strip()
        
        if line.startswith("m="):
            kind, _port, proto, *_formats = line[2:].split()
            current = {
                "kind": kind, 
                "proto": proto, 
                "codecs": {},
                "candidates": [], 
                "direction": None
            }
            media.append(current)
            
        elif line.startswith("a=fingerprint:"):
            session["fingerprint"] = line.split(":", 1)[1]
            
        elif current is None:
            continue
            
        elif line.startswith("a=rtpmap:"):
            payload_type, codec = line[len("a=rtpmap:"):].split(" ", 1)
            current["codecs"][int(payload_type)] = codec
            
        elif line.startswith("a=candidate:"):
            current["candidates"].append(parse_candidate(line))
            
        elif line[2:] in DIRECTIONS:
            current["direction"] = line[2:]
            
    return session, media

if __name__ == "__main__":
    text = open(sys.argv[1], encoding="utf-8").read()
    session, media = parse_sdp(text)
    
    print("DTLS fingerprint:", session["fingerprint"])
    for m in media:
        print(f"\n[{m['kind']}] {m['proto']} direction={m['direction']}")
        for pt, codec in m["codecs"].items():
            print(f" codec {pt:>3}: {codec}")
        for c in m["candidates"]:
            tp, lp, comp = decode_priority(c.priority)
            print(f" candidate {c.type:<6} {c.ip}:{c.port} "
                  f"priority={c.priority} -> type_pref={tp} local_pref={lp} component={comp}")