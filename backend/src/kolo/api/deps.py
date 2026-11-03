# src/kolo/api/deps.py

from typing import Annotated

from fastapi import Depends, Request

from kolo.container import Container


def get_container(request: Request) -> Container:
    return request.app.state.container

ContainerDep = Annotated[Container, Depends(get_container)]

def client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"