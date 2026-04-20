from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import repo
from ..cache import cached
from ..schemas import (
    Category,
    CategoryTimeseriesPoint,
    CategoryTimeseriesResponse,
)

router = APIRouter(prefix="/api/v1/categories", tags=["categories"])


@router.get("", response_model=list[Category])
@cached("categories:list", ttl=1800)
async def list_categories() -> list[dict]:
    rows = await repo.list_categories()
    return [Category.model_validate(r).model_dump(mode="json") for r in rows]


@router.get("/{slug}/timeseries", response_model=CategoryTimeseriesResponse)
async def category_timeseries(slug: str) -> dict:
    cat = await repo.get_category(slug)
    if not cat:
        raise HTTPException(status_code=404, detail=f"Category '{slug}' not found")
    rows = await repo.list_category_timeseries(cat["id"])
    points = [CategoryTimeseriesPoint.model_validate(r) for r in rows]
    peak = min(points, key=lambda p: p.sentiment)
    recovery = max(points, key=lambda p: p.sentiment)
    return CategoryTimeseriesResponse(
        category=Category.model_validate(cat),
        points=points,
        peak=peak,
        recovery=recovery,
    ).model_dump(mode="json")
