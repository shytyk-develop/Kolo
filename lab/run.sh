#!/bin/sh
# The lab from one place. Everything runs in Docker, nothing touches the host network.
#   ./lab/run.sh up          build and start
#   ./lab/run.sh all         every network test and every attack, results in lab/results/
#   ./lab/run.sh <name>      one of: baseline netem corp switch blackout blackout_long lost_offer
#                                    passive tlsproxy tamper bruteforce third
#   ./lab/run.sh down        remove everything (containers, networks, volume, images)
set -u
cd "$(dirname "$0")/.."
DC="docker compose -f docker-compose.lab.yml"
RES=lab/results
att() { $DC exec -T attacker "$@"; }
# a scenario in the runner: NAME=value pairs (no spaces in values), then the script
scenario() {
  envs=""; script=""
  for arg in "$@"; do
    case "$arg" in *=*) envs="$envs -e $arg" ;; *) script=$arg ;; esac
  done
  # shellcheck disable=SC2086
  $DC exec -T $envs runner node "lab/$script"
}
say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
verdict() { [ "$1" -eq 0 ] && echo "PASS  $2" | tee -a $RES/summary.txt || echo "FAIL  $2" | tee -a $RES/summary.txt; }
# each scenario starts from a clean network and an api with empty rate limits
fresh() { att /lab/net.sh reset >/dev/null 2>&1; $DC restart api >/dev/null 2>&1; sleep 3; }

up() {
  mkdir -p $RES
  $DC up -d --build --wait 2>&1 | tail -3
  # wait for the site behind the edge
  for _ in $(seq 1 60); do
    att python3 -c "import ssl,urllib.request; urllib.request.urlopen('https://kolo.lab/api/v1/health', context=ssl.create_default_context(cafile='/certs/lab-ca.crt'), timeout=2)" 2>/dev/null && break
    sleep 1
  done
  echo "lab is up"
}

baseline() {
  say "baseline: a call through the router, nothing in the way"
  fresh
  scenario SCENARIO=baseline OUT=net-baseline.json call.mjs > $RES/net-baseline.log 2>&1
  verdict $? "baseline call connects, end-to-end encrypted"
}

netem() {
  for profile in "loss 5%|loss5" "loss 10% delay 80ms 20ms|loss10-delay80" "loss 20% delay 150ms 50ms|loss20-delay150" "delay 300ms 100ms loss 2%|delay300-jitter100" "rate 300kbit delay 60ms|300kbit"; do
    rule=${profile%|*}; name=${profile#*|}
    say "bad network: $rule"
    fresh
    att /lab/net.sh netem "$rule"
    scenario SCENARIO=netem-$name HOLD_MS=12000 CONNECT_MS=45000 OUT=net-$name.json call.mjs > $RES/net-$name.log 2>&1
    verdict $? "call survives: $rule"
  done
  att /lab/net.sh netem off
}

corp() {
  say "office firewall: only TCP 443 gets out"
  fresh
  att /lab/net.sh corp on
  scenario SCENARIO=corp-443-only HOLD_MS=8000 CONNECT_MS=45000 OUT=net-corp443.json call.mjs > $RES/net-corp443.log 2>&1
  code=$?
  grep -q '"path": "relay"' $RES/net-corp443.json || code=1
  verdict $code "call connects with only TCP 443 open (through TURN over TLS)"
  att /lab/net.sh corp off
}

# mid-call: wait until the runner says "connected", do something to the network, let it go on
midcall() {  # name, description, command...
  name=$1; what=$2; shift 2
  fresh
  rm -f $RES/connected.marker $RES/go
  scenario SCENARIO=$name WAIT_FILE=/results/go KOLO_DEBUG=${KOLO_DEBUG:-} OUT=net-$name.json call.mjs > $RES/net-$name.log 2>&1 &
  pid=$!
  for _ in $(seq 1 90); do [ -f $RES/connected.marker ] && break; sleep 1; done
  "$@"
  touch $RES/go
  wait $pid
  verdict $? "$what"
  rm -f $RES/connected.marker $RES/go
}

switch_network() {
  # caller A gets a new address, as when a phone goes from wifi to mobile data
  $DC exec -T client-a sh -c 'ip addr del 10.78.1.10/24 dev lan0; ip addr add 10.78.1.50/24 dev lan0; ip route replace default via 10.78.1.2'
}
restore_network() {
  $DC exec -T client-a sh -c 'ip addr del 10.78.1.50/24 dev lan0 2>/dev/null; ip addr add 10.78.1.10/24 dev lan0 2>/dev/null; ip route replace default via 10.78.1.2' 2>/dev/null
}

switch() {
  say "network change in the middle of a call (caller A gets a new address)"
  midcall switch "call comes back after a network change" switch_network
  restore_network
}

blackout() {
  say "8 seconds of nothing in the middle of a call"
  midcall blackout "call comes back after 8 s without network" att /lab/net.sh blackout 8
}

blackout_long() {
  say "18 seconds of nothing: long enough for the signaling socket to give up and reconnect"
  midcall blackout-long "call comes back after 18 s without network" att /lab/net.sh blackout 18
}

lost_offer() {
  say "the first signaling message gets lost on the way"
  fresh; att /lab/net.sh mitm lose
  scenario SCENARIO=lost-offer CONNECT_MS=45000 OUT=net-lost-offer.json call.mjs > $RES/net-lost-offer.log 2>&1
  verdict $? "call connects although the offer was lost (calls again after 12 s)"
  att /lab/net.sh mitm off
}

passive() {
  say "attack 1: listening on the wire"
  fresh
  att sh -c 'nohup tcpdump -i any -U -w /results/passive.pcap "not net 10.77.9.0/24 and not udp port 4789" >/dev/null 2>&1 &'
  sleep 1
  scenario SCENARIO=passive OUT=1-passive-call.json call.mjs > $RES/1-passive-call.log 2>&1
  call=$?
  att pkill -INT tcpdump; sleep 1
  att sh /lab/passive.sh > $RES/1-passive.txt 2>&1
  code=$?; [ $call -ne 0 ] && code=1
  tail -12 $RES/1-passive.txt
  verdict $code "attack 1 (passive capture): nothing readable on the wire"
  rm -f $RES/passive.pcap
}

tlsproxy() {
  say "attack 2: a TLS proxy whose CA the callers trust"
  fresh
  att /lab/net.sh mitm dump
  scenario SCENARIO=tlsproxy OUT=2-tlsproxy-call.json call.mjs > $RES/2-tlsproxy-call.log 2>&1
  call=$?
  att /lab/net.sh mitm off
  att python3 /lab/analyze_dump.py > $RES/2-tlsproxy.txt 2>&1
  code=$?; [ $call -ne 0 ] && code=1
  cat $RES/2-tlsproxy.txt
  verdict $code "attack 2 (TLS proxy): call works, proxy gets neither key nor sdp nor media"
}

tamper() {
  say "attack 3a: swap the DTLS fingerprint (a call without the room key)"
  fresh; att /lab/net.sh mitm fingerprint
  scenario SCENARIO=tamper-fingerprint PLAIN=1 ALLOW_PLAIN=1 EXPECT=blocked CONNECT_MS=20000 OUT=3a-fingerprint.json call.mjs > $RES/3a-fingerprint.log 2>&1
  verdict $? "attack 3a (fingerprint swap, no key): the browsers refuse the connection"

  say "attack 3b: change sealed signaling messages"
  fresh; att /lab/net.sh mitm flip
  scenario SCENARIO=tamper-flip EXPECT=blocked CONNECT_MS=20000 OUT=3b-flip.json call.mjs > $RES/3b-flip.log 2>&1
  verdict $? "attack 3b (changed sealed messages): dropped, no connection to the attacker"

  say "attack 3c: replay sealed signaling messages"
  fresh; att /lab/net.sh mitm replay
  scenario SCENARIO=tamper-replay OUT=3c-replay.json call.mjs > $RES/3c-replay.log 2>&1
  code=$?; grep -q "replayed message" $RES/3c-replay.json || code=1
  verdict $code "attack 3c (replay): replays dropped, the call goes on"

  say "attack 3d: downgrade (hide that the other side has the key)"
  fresh; att /lab/net.sh mitm downgrade
  scenario SCENARIO=tamper-downgrade EXPECT=blocked CONNECT_MS=20000 OUT=3d-downgrade.json call.mjs > $RES/3d-downgrade.log 2>&1
  code=$?; grep -q '"no-key"' $RES/3d-downgrade.json || code=1
  verdict $code "attack 3d (downgrade): no silent fallback, both sides are asked first"
  att /lab/net.sh mitm off
}

bruteforce() {
  say "attack 4: guessing rooms, secrets and tickets (takes ~3 min, it waits out the limiter twice)"
  fresh
  att python3 /lab/bruteforce.py > $RES/4-bruteforce.txt 2>&1
  code=$?
  cat $RES/4-bruteforce.txt
  verdict $code "attack 4 (brute force): rate limits hold, nothing found"
}

third() {
  say "attack 5: a third person in a room for two"
  fresh
  scenario third.mjs > $RES/5-third.log 2>&1
  verdict $? "attack 5 (third person): refused by page, api and socket; the call goes on"
}

down() {
  $DC down -v --remove-orphans
  # only our own images; caddy, coturn and the playwright base image stay, they don't belong to the lab alone
  docker rmi kolo-lab-api:local kolo-lab-web:local kolo-lab-client:local kolo-lab-attacker:local 2>/dev/null
  rm -rf $RES
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  all)
    up
    : > $RES/summary.txt
    baseline; netem; corp; switch; blackout; blackout_long; lost_offer; passive; tlsproxy; tamper; third; bruteforce
    att /lab/net.sh reset
    say "summary"; cat $RES/summary.txt
    ! grep -q FAIL $RES/summary.txt
    ;;
  baseline|netem|corp|switch|blackout|blackout_long|lost_offer|passive|tlsproxy|tamper|bruteforce|third) "$1" ;;
  *) sed -n '2,8p' "$0" ;;
esac
