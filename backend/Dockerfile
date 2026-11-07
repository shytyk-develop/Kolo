# backend/Dockerfile
# ---- stage 1: deps (cached until uv.lock changes) ----
FROM python:3.12-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
# don't let uv download its own python, the venv must use the image one
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
COPY migrations ./migrations
# pyproject needs README
COPY alembic.ini README.md ./
RUN uv sync --frozen --no-dev

# ---- stage 2: small final image ----
FROM python:3.12-slim
RUN useradd --create-home kolo
WORKDIR /app
# root owns the code, the app can't change it
COPY --from=builder /app /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
USER kolo
EXPOSE 8000
# FORWARDED_ALLOW_IPS is 127.0.0.1 by default, set "*" only behind caddy
CMD ["uvicorn", "kolo.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--no-access-log"]
