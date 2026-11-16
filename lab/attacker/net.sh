#!/bin/sh
# What the attacker's router does to the callers' network.
#   net.sh netem "loss 10% delay 80ms 20ms" | netem off
#   net.sh corp on|off        only TCP 443 gets out (a strict office firewall)
#   net.sh blackout <seconds> nothing gets through for a while
#   net.sh mitm <mode>|off    TLS proxy in front of the site and the api (see mitm_addon.py)
#   net.sh reset
set -eu
CLIENT_SIDES="lan-a lan-b"

case "$1" in
  netem)
    for dev in $CLIENT_SIDES; do
      tc qdisc del dev "$dev" root 2>/dev/null || true
      # shellcheck disable=SC2086
      [ "$2" = off ] || tc qdisc add dev "$dev" root netem $2
    done
    ;;
  corp)
    iptables -F FORWARD
    if [ "$2" = on ]; then
      iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
      iptables -A FORWARD -p tcp --dport 443 -j ACCEPT
      iptables -A FORWARD -j DROP
      conntrack -F 2>/dev/null || true
    fi
    ;;
  blackout)
    iptables -I FORWARD 1 -j DROP
    sleep "$2"
    iptables -D FORWARD 1
    ;;
  mitm)
    pkill -f mitmdump 2>/dev/null || true
    iptables -t nat -F PREROUTING
    if [ "$2" != off ]; then
      iptables -t nat -A PREROUTING -p tcp -d 10.77.0.10 --dport 443 -j REDIRECT --to-port 8080
      MITM_MODE="$2" nohup mitmdump --mode transparent --listen-port 8080 --set confdir=/certs/mitm \
        --set ssl_verify_upstream_trusted_ca=/certs/lab-ca.crt --set connection_strategy=lazy \
        -q -s /lab/mitm_addon.py > /results/mitmdump.log 2>&1 &
      sleep 3
    fi
    ;;
  reset)
    "$0" netem off
    "$0" corp off
    "$0" mitm off
    ;;
esac
