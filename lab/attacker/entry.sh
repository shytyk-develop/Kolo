#!/bin/sh
# The attacker is the callers' router. Towards the servers it hides them behind its own
# address, like a home router or an office gateway does.
set -eu
OUT=$(ip -o -4 addr show | awk '/10\.77\.0\./ {print $2}')
# one tunnel per caller (see lab/client/entry.sh): lan-a and lan-b are their "networks"
for side in "a 1" "b 2"; do
  set -- $side
  DEV=$(ip -o -4 addr show | awk -v net="10.77.$2." 'index($4, net) == 1 {print $2}')
  ip link add "lan-$1" type vxlan id "$2" remote "10.77.$2.10" dstport 4789 dev "$DEV"
  ip addr add "10.78.$2.2/24" dev "lan-$1"
  ip link set "lan-$1" up
  ethtool -K "lan-$1" tx off >/dev/null
done
iptables -t nat -A POSTROUTING -o "$OUT" -j MASQUERADE
iptables -P FORWARD ACCEPT
echo "attacker: routing 10.78.1.0/24 and 10.78.2.0/24, outside leg $OUT"
exec sleep infinity
