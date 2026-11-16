FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      tcpdump tshark iptables iproute2 ethtool conntrack openssl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "mitmproxy>=11,<13" "pyjwt>=2.8" "websockets>=13"
COPY entry.sh /entry.sh
ENTRYPOINT ["/bin/sh", "/entry.sh"]
