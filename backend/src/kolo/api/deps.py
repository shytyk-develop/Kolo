# src/kolo/api/deps.py

from typing import Annotated

from fastapi import Depends, Request

from kolo.container import Container


def get_container(request: Request) -> Container:
    return request.app.state.container

ContainerDep = Annotated[Container, Depends(get_container)]

def client_ip(request: Request) -> str:
    # never read X-Forwarded-For here: any client can write anything into it.
    # behind a proxy, uvicorn --proxy-headers --forwarded-allow-ips=<proxy address> puts the real
    # client address into request.client, and only when the request came from that proxy
    return request.client.host if request.client else "127.0.0.1"