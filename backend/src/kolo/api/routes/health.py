# src/kolo/api/routes/health.py

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from kolo.api.deps import ContainerDep

router = APIRouter(tags=["health"])

NO_STORE = {"Cache-Control": "no-store"}


# also under /api: the frontend's offline probe goes through its proxy
@router.get("/health")
@router.get("/api/v1/health")
async def liveness() -> JSONResponse:
    """Liveness: the process is up and serving."""
    return JSONResponse({"status": "ok"}, headers=NO_STORE)

@router.get("/health/ready")
async def readiness(c: ContainerDep) -> JSONResponse:
    """Readiness: db and redis are reachable."""
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
        headers=NO_STORE,
    )
