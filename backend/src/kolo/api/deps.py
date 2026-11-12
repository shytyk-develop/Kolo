# src/kolo/api/deps.py

from typing import Annotated

from fastapi import Depends, Request

from kolo.container import Container


def get_container(request: Request) -> Container:
    return request.app.state.container

ContainerDep = Annotated[Container, Depends(get_container)]

def client_ip(request: Request) -> str:
    # X-Forwarded-For can be faked: trust it only behind our proxy
    if request.app.state.container.settings.trust_proxy:
        forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        if forwarded:
            return forwarded
    # behind a proxy, uvicorn --forwarded-allow-ips puts the real ip into request.client
    return request.client.host if request.client else "127.0.0.1"


def is_https(request: Request) -> bool:
    # via the /api proxy our own hop is plain http
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or proto == "https"