from __future__ import annotations

from statistics import mean

from fastapi import APIRouter, HTTPException

from .. import repo
from ..cache import cached
from ..schemas import Issue, SegmentImpactAnalysis, UserSegment

router = APIRouter(prefix="/api/v1/user-segments", tags=["user-segments"])


@router.get("", response_model=list[UserSegment])
@cached("segments:list", ttl=1800)
async def list_segments() -> list[dict]:
    rows = await repo.list_segments()
    return [UserSegment.model_validate(r).model_dump(mode="json") for r in rows]


@router.get("/{segment_id}/impact-analysis", response_model=SegmentImpactAnalysis)
async def impact_analysis(segment_id: str) -> dict:
    seg = await repo.get_segment(segment_id)
    if not seg:
        raise HTTPException(status_code=404, detail=f"Segment '{segment_id}' not found")
    slug = seg["slug"]
    affected = await repo.issues_by_segment(slug)

    sentiments = [float(i["sentiment_score"]) for i in affected]
    severities = [i["severity"] for i in affected]
    metrics = {
        "affected_issue_count": len(affected),
        "avg_sentiment": round(mean(sentiments), 3) if sentiments else 0.0,
        "critical_count": severities.count("critical"),
        "high_count": severities.count("high"),
        "medium_count": severities.count("medium"),
        "low_count": severities.count("low"),
        "crisis_severity_percentage": float(seg["crisis_severity_percentage"]),
        "cost_impact_percentage": float(seg["cost_impact_percentage"]),
        "recovery_speed_percentage": float(seg["recovery_speed_percentage"]),
    }
    return SegmentImpactAnalysis(
        segment=UserSegment.model_validate(seg),
        affected_issues=[Issue.model_validate(i) for i in affected],
        metrics=metrics,
    ).model_dump(mode="json")
