#!/bin/sh
# What does someone who only listens on the wire see? Reads the capture the attacker made.
PCAP=/results/passive.pcap
KEY=$(python3 -c "import json; print(json.load(open('/results/room.json'))['key'])")
CODE=$(python3 -c "import json; print(json.load(open('/results/room.json'))['code'])")

echo "== packets captured on the callers' router =="
tshark -r $PCAP -q -z io,phs 2>/dev/null | sed -n '1,40p'

echo
echo "== who talked to whom (visible: addresses, ports, sizes, times) =="
echo "-- tcp --"
tshark -r $PCAP -q -z conv,tcp 2>/dev/null | sed -n '5,14p'
echo "-- udp --"
tshark -r $PCAP -q -z conv,udp 2>/dev/null | sed -n '5,14p'

echo
echo "== server names in TLS handshakes (visible) =="
tshark -r $PCAP -Y tls.handshake.extensions_server_name -T fields -e ip.src -e ip.dst -e tls.handshake.extensions_server_name 2>/dev/null | sort | uniq -c

echo
echo "== media: DTLS handshake, then encrypted packets =="
echo "dtls handshake messages (visible, as in any WebRTC call): $(tshark -r $PCAP -Y dtls.handshake -T fields -e frame.number 2>/dev/null | wc -l | tr -d ' ')"
echo "stun/ice checks (visible):                                 $(tshark -r $PCAP -Y stun -T fields -e frame.number 2>/dev/null | wc -l | tr -d ' ')"
echo "udp packets between the two callers, size stats (bytes):"
tshark -r $PCAP -Y "udp && ip.addr==10.78.1.10 && ip.addr==10.78.2.10 && !stun && !dtls" -T fields -e frame.len 2>/dev/null |
  awk '{n++; s+=$1; if(min==""||$1<min)min=$1; if($1>max)max=$1} END {if(n) printf "  packets %d, total %d, min %d, avg %d, max %d\n", n, s, min, s/n, max; else print "  none"}'

echo
echo "== searched the raw capture for things that must not be readable =="
FOUND=0
for needle in "$KEY" "a=fingerprint" "candidate:" "display_name" "Anya" "$CODE" "eyJhbGciOiJIUzI1NiI" '"sealed"'; do
  count=$(grep -a -c -F -- "$needle" $PCAP)
  [ "$count" -gt 0 ] && FOUND=1
  printf '%-10s %s\n' "$([ "$count" -gt 0 ] && echo "FOUND x$count" || echo "not seen")" "$needle"
done
echo
[ $FOUND -eq 0 ] && echo "RESULT: a listener sees who talks to whom, when and how much; nothing of the content" || echo "RESULT: FAILED, readable content on the wire"
exit $FOUND
