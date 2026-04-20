from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .. import repo, seed_data
from ..cache import cached
from ..schemas import (
    Category,
    Issue,
    IssueDetail,
    IssueListResponse,
    RootCauseBase,
)

router = APIRouter(prefix="/api/v1/issues", tags=["issues"])


@router.get("", response_model=IssueListResponse)
@cached("issues:list", ttl=300)
async def list_issues(
    category: str | None = Query(None, description="Category id or slug"),
    severity: str | None = Query(None, pattern="^(critical|high|medium|low)$"),
    sentiment_min: float | None = Query(None, ge=-1, le=1),
    sentiment_max: float | None = Query(None, ge=-1, le=1),
    segment: str | None = Query(None, description="Segment slug (e.g. enterprise)"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    rows, total = await repo.list_issues(
        category=category,
        severity=severity,
        sentiment_min=sentiment_min,
        sentiment_max=sentiment_max,
        segment=segment,
        limit=limit,
        offset=offset,
    )
    return IssueListResponse(
        data=[Issue.model_validate(r) for r in rows],
        total=total,
        limit=limit,
        offset=offset,
    ).model_dump(mode="json")


@router.get("/search", response_model=list[Issue])
async def search_issues(
    q: str = Query(..., min_length=1, description="Free-text query over title + description"),
    limit: int = Query(25, ge=1, le=100),
) -> list[dict]:
    rows = await repo.search_issues(q, limit=limit)
    return [Issue.model_validate(r).model_dump(mode="json") for r in rows]


@router.get("/{issue_id}", response_model=IssueDetail)
async def get_issue(issue_id: str) -> dict:
    issue = await repo.get_issue(issue_id)
    if not issue:
        raise HTTPException(status_code=404, detail=f"Issue '{issue_id}' not found")

    category_dict = None
    if issue["category_id"]:
        category_dict = next(
            (c for c in await repo.list_categories() if c["id"] == issue["category_id"]),
            None,
        )

    root_cause_dict = None
    related_rows: list[dict] = []
    if issue["root_cause_id"]:
        root_cause_dict = await repo.get_root_cause(issue["root_cause_id"])
        related_rows = [r for r in await repo.issues_by_root_cause(issue["root_cause_id"]) if r["id"] != issue_id]

    return IssueDetail(
        issue=Issue.model_validate(issue),
        category=Category.model_validate(category_dict) if category_dict else None,
        root_cause=RootCauseBase.model_validate(root_cause_dict) if root_cause_dict else None,
        related_issues=[Issue.model_validate(r) for r in related_rows],
    ).model_dump(mode="json")
