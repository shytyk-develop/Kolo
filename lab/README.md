# The lab

A closed copy of Kolo in Docker, with an attacker between the two callers.
Nothing here touches the host: every network is internal, no ports are published.

```
 client-a ──┐                              ┌── edge (TLS) ── web (Next.js)
 (browser)  ├── attacker (their router) ───┤              └─ api (FastAPI)
 client-b ──┘   tcpdump, mitmproxy,        └── turn (coturn: udp, tcp, tls 443)
 (browser)      iptables, tc netem
     └── runner drives both browsers over a side network the attacker isn't on
```

```bash
./lab/run.sh up          # build and start (the first time pulls ~4 GB of images)
./lab/run.sh all         # everything, ~15 min; results in lab/results/, the verdicts in summary.txt
./lab/run.sh <name>      # one of the names below
./lab/run.sh down        # remove containers, networks, the volume and the images
```

| Name | What happens | Expected |
| --- | --- | --- |
| `baseline` | a call through the router | connects, `e2ee` |
| `netem` | packet loss 5 / 10 / 20 %, delay, jitter, 300 kbit/s | the call holds |
| `corp` | the router lets only TCP 443 out | connects through TURN over TLS |
| `switch` | caller A gets a new IP mid-call | the call comes back |
| `blackout` | 8 s without any network mid-call | the call comes back |
| `blackout_long` | 18 s without network: the call gives up, goes to "Connection lost" | comes back by itself |
| `lost_offer` | the first signaling message never arrives | connects anyway, ~12 s later |
| `passive` | the attacker captures every packet | nothing readable |
| `tlsproxy` | a TLS proxy with a CA the callers trust | reads names and room code, not the key, sdp or media |
| `tamper` | the proxy rewrites the signaling: fingerprint swap, changed boxes, replays, downgrade | no connection to the attacker, no silent downgrade |
| `bruteforce` | guessing room codes, host secrets, tickets | 404 / 401 / 429 |
| `third` | a third person tries to get into a room for two | refused |

How the callers end up behind the attacker: Docker's internal networks drop anything routed, so each
caller has a small VXLAN tunnel to the attacker and uses it as its default gateway (`client/entry.sh`).
From the inside it looks like a LAN with a router.
