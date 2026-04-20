from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import repo
from ..cache import cached
from ..schemas import Issue, RootCauseBase, RootCauseDetail, RootCauseWithCount

router = APIRouter(prefix="/api/v1/root-causes", tags=["root-causes"])


@router.get("", response_model=list[RootCauseWithCount])
@cached("root_causes:list", ttl=1800)
async def list_root_causes() -> list[dict]:
    rows = await repo.list_root_causes()
    return [RootCauseWithCount.model_validate(r).model_dump(mode="json") for r in rows]


@router.get("/{rc_id}", response_model=RootCauseDetail)
async def get_root_cause(rc_id: str) -> dict:
    rc = await repo.get_root_cause(rc_id)
    if not rc:
        raise HTTPException(status_code=404, detail=f"Root cause '{rc_id}' not found")
    affected = await repo.issues_by_root_cause(rc_id)
    return RootCauseDetail(
        root_cause=RootCauseBase.model_validate(rc),
        affected_issues=[Issue.model_validate(i) for i in affected],
    ).model_dump(mode="json")
