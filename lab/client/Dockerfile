FROM mcr.microsoft.com/playwright:v1.65.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools iproute2 ethtool \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.65.0
COPY entry.sh server.mjs /work/
ENTRYPOINT ["/bin/sh", "/work/entry.sh"]
