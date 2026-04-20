from __future__ import annotations

from fastapi import APIRouter

from .. import repo
from ..cache import cached
from ..schemas import TimelinePoint, TimelineResponse

router = APIRouter(prefix="/api/v1/timeline", tags=["timeline"])


@router.get("", response_model=TimelineResponse)
@cached("timeline", ttl=1800)
async def get_timeline() -> dict:
    rows = await repo.list_timeline()
    points = [TimelinePoint.model_validate(r) for r in rows]
    peak_crisis = min(points, key=lambda p: p.sentiment)
    peak_recovery = max(points, key=lambda p: p.sentiment)
    return TimelineResponse(
        points=points,
        peak_crisis=peak_crisis,
        peak_recovery=peak_recovery,
    ).model_dump(mode="json")
