# src/kolo/api/routes/health.py

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from kolo.api.deps import ContainerDep

router = APIRouter(tags=["health"])

@router.get("/health")
async def liveness() -> dict:
    """The process is alive. Docker will restart the container if there is no response here."""
    return {"status": "ok"}

@router.get("/health/ready")
async def readiness(c: ContainerDep) -> JSONResponse:
    """Whether we can take traffic: are the database and Redis reachable."""
    results: dict[str, str] = {}
    for name, check in c.checks.items():
        try:
            await check()
            results[name] = "ok"
        except Exception as exc:  # noqa: BLE001
            results[name] = f"error: {type(exc).__name__}"

    healthy = all(value == "ok" for value in results.values())
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={"status": "ok" if healthy else "degraded", "checks": results},
    )
