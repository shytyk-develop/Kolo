# src/kolo/api/deps.py

import hmac
from typing import Annotated

from fastapi import Depends, Request

from kolo.container import Container
from kolo.core.config import Settings
from kolo.core.security import check_api_key
from kolo.domain.errors import RateLimited


def get_container(request: Request) -> Container:
    return request.app.state.container

ContainerDep = Annotated[Container, Depends(get_container)]

def _from_our_proxy(request: Request, settings: Settings) -> bool:
    secret = settings.proxy_secret.get_secret_value() if settings.proxy_secret else ""
    if not secret:
        return True
    given = request.headers.get("x-kolo-proxy", "")
    return hmac.compare_digest(given.encode(), secret.encode())


def client_ip(request: Request) -> str:
    settings = request.app.state.container.settings
    # X-Forwarded-For can be faked: trust it only behind our proxy
    if settings.trust_proxy and _from_our_proxy(request, settings):
        forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        if forwarded:
            return forwarded
    # behind a proxy, uvicorn --forwarded-allow-ips puts the real ip into request.client
    # wer am Proxy vorbei direkt kommt, landet hier: alle zusammen in einem Topf
    return request.client.host if request.client else "127.0.0.1"


def limit_lookups(request: Request) -> None:
    c = request.app.state.container
    if check_api_key(c.settings, request.headers.get("x-api-key")):
        return
    if not c.lookup_limiter.allow(client_ip(request)):
        raise RateLimited()


def is_https(request: Request) -> bool:
    # via the /api proxy our own hop is plain http
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or proto == "https"