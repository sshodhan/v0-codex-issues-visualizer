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
    SentimentAnalytics,
    SentimentBucket,
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
