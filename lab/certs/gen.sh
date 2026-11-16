#!/bin/sh
# Makes the lab's certificates once: a CA the callers trust, the servers' certificate,
# and a second CA for the attacker's TLS proxy (the "company certificate" on an office laptop).
set -eu
cd /certs
[ -f done ] && exit 0

openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=kolo lab CA" \
  -keyout lab-ca.key -out lab-ca.crt 2>/dev/null

openssl req -newkey rsa:2048 -nodes -subj "/CN=kolo.lab" -keyout server.key -out server.csr 2>/dev/null
printf "subjectAltName=DNS:kolo.lab,DNS:api.kolo.lab,DNS:turn.kolo.lab\nextendedKeyUsage=serverAuth\n" > san.ext
openssl x509 -req -in server.csr -CA lab-ca.crt -CAkey lab-ca.key -CAcreateserial -days 30 \
  -extfile san.ext -out server.crt 2>/dev/null

# mitmproxy wants key + certificate in one file
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Corp TLS Inspection CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout corp-ca.key -out corp-ca.crt 2>/dev/null
mkdir -p mitm
cat corp-ca.key corp-ca.crt > mitm/mitmproxy-ca.pem

chmod 644 ./*.key ./*.crt mitm/*
touch done
echo "lab certificates ready"
