# src/kolo/api/routes/health.py

from fastapi import APIRouter

router = APIRouter(tags=["health"])

@router.get("/health")
async def liveness() -> dict:
    """The process is alive. Docker will restart the container if there is no response here."""
    return {"status": "ok"}