from __future__ import annotations

from collections import Counter
from statistics import mean, stdev

from fastapi import APIRouter

from .. import repo
from ..cache import cached
from ..schemas import (
    Category,
    CategoryAnalytics,
    CategoryStats,
    CompetitiveRow,
    PainPoint,
    SentimentAnalytics,
    SentimentBucket,
    TierBreakdown,
    TimelinePoint,
)

router = APIRouter(prefix="/api/v1/analytics", tags=["analytics"])


def _bucket_sentiment(score: float) -> str:
    if score <= -0.5:
        return "very_negative"
    if score <= -0.2:
        return "negative"
    if score < 0.2:
        return "neutral"
    if score < 0.5:
        return "positive"
    return "very_positive"


@router.get("/sentiment", response_model=SentimentAnalytics)
@cached("analytics:sentiment", ttl=1800)
async def sentiment_analytics() -> dict:
    issues, _total = await repo.list_issues(limit=1000)
    scores = [float(i["sentiment_score"]) for i in issues]

    counts = Counter(_bucket_sentiment(s) for s in scores)
    order = ["very_negative", "negative", "neutral", "positive", "very_positive"]
    distribution = [SentimentBucket(bucket=k, count=counts.get(k, 0)) for k in order]

    trend_rows = await repo.list_timeline()
    trend = [TimelinePoint.model_validate(r) for r in trend_rows]

    stats = {
        "count": len(scores),
        "mean": round(mean(scores), 3) if scores else 0.0,
        "stddev": round(stdev(scores), 3) if len(scores) > 1 else 0.0,
        "min": round(min(scores), 3) if scores else 0.0,
        "max": round(max(scores), 3) if scores else 0.0,
    }

    return SentimentAnalytics(distribution=distribution, trend=trend, stats=stats).model_dump(mode="json")


@router.get("/categories", response_model=CategoryAnalytics)
@cached("analytics:categories", ttl=1800)
async def category_analytics() -> dict:
    categories = await repo.list_categories()
    issues, total = await repo.list_issues(limit=1000)

    by_cat: list[CategoryStats] = []
    for c in categories:
        cat_issues = [i for i in issues if i["category_id"] == c["id"]]
        if cat_issues:
            avg_sent = round(mean(float(i["sentiment_score"]) for i in cat_issues), 3)
        else:
            avg_sent = 0.0
        by_cat.append(
            CategoryStats(
                category=Category.model_validate(c),
                issue_count=len(cat_issues),
                avg_sentiment=avg_sent,
            )
        )
    by_cat.sort(key=lambda s: -s.issue_count)
    return CategoryAnalytics(by_category=by_cat, total=total).model_dump(mode="json")


@router.get("/competitive", response_model=list[CompetitiveRow])
@cached("analytics:competitive", ttl=1800)
async def competitive_analytics() -> list[dict]:
    rows = await repo.list_competitive()
    return [CompetitiveRow.model_validate(r).model_dump(mode="json") for r in rows]


@router.get("/tiers", response_model=list[TierBreakdown])
@cached("analytics:tiers", ttl=1800)
async def tier_breakdown() -> list[dict]:
    """Summarize categories by TIER classification (1/2/3) — the prioritization view."""
    cats = await repo.list_categories()
    buckets: dict[int, list[dict]] = {}
    for c in cats:
        buckets.setdefault(int(c["tier"]), []).append(c)
    out: list[TierBreakdown] = []
    for tier in sorted(buckets):
        cat_models = [Category.model_validate(c) for c in buckets[tier]]
        out.append(
            TierBreakdown(
                tier=tier,
                category_count=len(cat_models),
                total_share_pct=round(sum(c.share_pct for c in cat_models), 1),
                total_users_affected_pct=round(sum(c.users_affected_pct for c in cat_models), 1),
                categories=cat_models,
            )
        )
    return [t.model_dump(mode="json") for t in out]


@router.get("/pain-points", response_model=list[PainPoint])
@cached("analytics:pain_points", ttl=1800)
async def pain_points(limit: int = 5) -> list[dict]:
    """Ranked top pain points the Codex team should tackle next.

    Score = (users_affected_pct * tier_weight) + (critical_count * 3) + (high_count * 1.5)
    TIER weights: 1 -> 3x, 2 -> 1.5x, 3 -> 1x.
    """
    cats = await repo.list_categories()
    issues, _ = await repo.list_issues(limit=1000)

    tier_weight = {1: 3.0, 2: 1.5, 3: 1.0}
    ranked: list[dict] = []
    for c in cats:
        cat_issues = [i for i in issues if i["category_id"] == c["id"]]
        sev = [i["severity"] for i in cat_issues]
        sentiments = [float(i["sentiment_score"]) for i in cat_issues]
        critical_count = sev.count("critical")
        high_count = sev.count("high")
        pain_score = round(
            float(c["users_affected_pct"]) * tier_weight[int(c["tier"])]
            + critical_count * 3
            + high_count * 1.5,
            2,
        )
        avg_sent = round(mean(sentiments), 3) if sentiments else 0.0
        ranked.append(
            {
                "category": c,
                "issue_count": len(cat_issues),
                "avg_sentiment": avg_sent,
                "critical_count": critical_count,
                "high_count": high_count,
                "pain_score": pain_score,
            }
        )
    ranked.sort(key=lambda r: -r["pain_score"])
    ranked = ranked[:limit]
    return [
        PainPoint(
            category=Category.model_validate(r["category"]),
            issue_count=r["issue_count"],
            avg_sentiment=r["avg_sentiment"],
            critical_count=r["critical_count"],
            high_count=r["high_count"],
            pain_score=r["pain_score"],
            rank=idx + 1,
        ).model_dump(mode="json")
        for idx, r in enumerate(ranked)
    ]
