# src/kolo/api/errors.py

from fastapi import Request
from fastapi.responses import JSONResponse
from kolo.domain.errors import KoloError, RateLimited

async def kolo_error_handler(request: Request, exc: KoloError) -> JSONResponse:
    headers = {"Retry-After": "60"} if isinstance(exc, RateLimited) else None
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"code": exc.code, "message": exc.message}},
        headers=headers,
    )