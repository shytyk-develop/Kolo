#!/bin/sh
# A caller's machine: everything goes out through the attacker's router, and it trusts
# both the lab CA and the "company" CA (as an office laptop would).
set -eu
# Docker lets nothing through in "internal" networks that isn't going to its own subnet. So a
# tunnel (vxlan) to the attacker's router: inside it looks like a normal LAN with a gateway
DEV=$(ip -o -4 addr show | awk -v net="${LAB_UNDERLAY%.*}." 'index($4, net) == 1 {print $2}')
ip link add lan0 type vxlan id "$LAB_VNI" remote "$LAB_UNDERLAY" dstport 4789 dev "$DEV"
ip addr add "$LAB_ADDRESS/24" dev lan0
ip link set lan0 up
# else UDP packets leave with a wrong checksum and get dropped
ethtool -K lan0 tx off >/dev/null
ip route replace default via "$LAB_GATEWAY"
mkdir -p "$HOME/.pki/nssdb"
certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password 2>/dev/null || true
certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n "kolo lab CA" -i /certs/lab-ca.crt
certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n "Corp TLS Inspection CA" -i /certs/corp-ca.crt
exec node /work/server.mjs
