# src/kolo/api/errors.py

from fastapi import Request
from fastapi.responses import JSONResponse

from kolo.core.logging import log
from kolo.domain.errors import KoloError, RateLimited
from kolo.infra.errors import is_dependency_error


async def kolo_error_handler(request: Request, exc: KoloError) -> JSONResponse:
    headers = {"Retry-After": "60"} if isinstance(exc, RateLimited) else None
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"code": exc.code, "message": exc.message}},
        headers=headers,
    )

async def dependency_error_handler(request: Request, exc: Exception) -> JSONResponse:
    if not is_dependency_error(exc):
        raise exc  # a real bug: let it become a regular 500 with a traceback in the logs

    # exception details stay in the logs, they can contain hosts and connection strings
    log.warning("dependency_unavailable", path=request.url.path, error=repr(exc))
    return JSONResponse(
        status_code=503,
        content={
            "error": {
                "code": "service_unavailable",
                "message": "Service is temporarily unavailable, please retry",
            }
        },
        headers={"Retry-After": "5"},
    )
