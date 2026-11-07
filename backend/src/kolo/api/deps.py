# src/kolo/api/deps.py

from typing import Annotated

from fastapi import Depends, Request

from kolo.container import Container


def get_container(request: Request) -> Container:
    return request.app.state.container

ContainerDep = Annotated[Container, Depends(get_container)]

def client_ip(request: Request) -> str:
    # don't trust X-Forwarded-For, anyone can fake it.
    # behind a proxy, uvicorn --forwarded-allow-ips puts the real ip into request.client
    return request.client.host if request.client else "127.0.0.1"