# src/kolo/api/deps.py

from typing import Annotated
from fastapi import Depends, Request
from kolo.container import Container

def get_container(request: Request) -> Container:
    return request.app.state.container

ContainerDep = Annotated[Container, Depends(get_container)]

def client_ip(request: Request) -> str: 
    return request.client.host if request.client else "unknown"