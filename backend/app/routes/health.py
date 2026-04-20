from __future__ import annotations

from fastapi import APIRouter

from .. import cache, db
from ..config import get_settings
from ..schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    settings = get_settings()
    db_state = db.db_status()
    return HealthResponse(
        status="ok",
        version=settings.version,
        environment=settings.environment,
        db=db_state,
        redis=cache.redis_status(),
        seed_fallback=db_state != "connected",
    )
