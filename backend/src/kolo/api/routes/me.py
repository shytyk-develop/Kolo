# the linked Kolo ID: a signed httpOnly cookie, out of the client's reach

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel

from kolo.api.deps import ContainerDep, is_https
from kolo.container import Container
from kolo.core.tg_cookie import (
    COOKIE,
    MAX_AGE,
    PENDING_COOKIE,
    PENDING_MAX_AGE,
    Linked,
    pending_matches,
    read_linked,
    sign_linked,
    sign_pending,
)
from kolo.domain.errors import LinkElsewhere, TelegramDisabled
from kolo.services.telegram import TelegramService


def no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(tags=["me"], dependencies=[Depends(no_store)])


class MeResponse(BaseModel):
    # Telegram is set up on this server
    telegram: bool
    handle: str | None = None


class LinkResponse(BaseModel):
    token: str
    deep_link: str
    expires_in: int


class LinkStatusResponse(BaseModel):
    status: str
    handle: str | None = None


def telegram_of(c: Container) -> TelegramService:
    if c.telegram is None:
        raise TelegramDisabled()
    return c.telegram


def _secret(c: Container) -> str:
    assert c.settings.session_secret is not None
    return c.settings.session_secret.get_secret_value()


def linked_of(request: Request, c: Container) -> Linked | None:
    if c.telegram is None:
        return None
    return read_linked(_secret(c), request.cookies.get(COOKIE))


def _cookie(request: Request, c: Container) -> dict:
    # host-only (no Domain); no Secure on plain-http dev, Safari would drop it
    secure = is_https(request) or c.settings.env == "prod"
    return {"httponly": True, "secure": secure, "samesite": "lax", "path": "/"}


def forget(response: Response, request: Request, c: Container, name: str = COOKIE) -> None:
    response.delete_cookie(name, **_cookie(request, c))


@router.get("", response_model=MeResponse, response_model_exclude_none=True)
async def me(request: Request, response: Response, c: ContainerDep) -> MeResponse:
    linked = linked_of(request, c)
    if linked is None and request.cookies.get(COOKIE):
        forget(response, request, c)
    return MeResponse(telegram=c.telegram is not None, handle=linked.handle if linked else None)


@router.post("/telegram/link", response_model=LinkResponse)
async def start_link(request: Request, response: Response, c: ContainerDep) -> LinkResponse:
    link = await telegram_of(c).start_link()
    # only this browser can collect the result
    response.set_cookie(
        PENDING_COOKIE,
        sign_pending(_secret(c), link["token"]),
        max_age=PENDING_MAX_AGE,
        **_cookie(request, c),
    )
    return LinkResponse(token=link["token"], deep_link=link["deep_link"], expires_in=link["expires_in"])


@router.get("/telegram/link/{token}", response_model=LinkStatusResponse, response_model_exclude_none=True)
async def link_status(
    token: str, request: Request, response: Response, c: ContainerDep
) -> LinkStatusResponse:
    telegram = telegram_of(c)
    if not pending_matches(_secret(c), token, request.cookies.get(PENDING_COOKIE)):
        raise LinkElsewhere()
    status = await telegram.link_status(token)
    if status["status"] != "linked":
        return LinkStatusResponse(status=status["status"])
    linked = Linked(status["handle"], status.get("display_name") or "")
    response.set_cookie(COOKIE, sign_linked(_secret(c), linked), max_age=MAX_AGE, **_cookie(request, c))
    forget(response, request, c, PENDING_COOKIE)
    return LinkStatusResponse(status="linked", handle=linked.handle)


@router.delete("/telegram", status_code=204)
async def unlink(request: Request, c: ContainerDep) -> Response:
    telegram = telegram_of(c)
    linked = linked_of(request, c)
    if linked is not None:
        # notify first: on failure the cookie stays for a retry
        await telegram.unlink(linked.handle)
    response = Response(status_code=204, headers={"Cache-Control": "no-store"})
    forget(response, request, c)
    return response
