import pytest


@pytest.mark.asyncio
async def test_tier_breakdown(client):
    resp = await client.get("/api/v1/analytics/tiers")
    assert resp.status_code == 200
    body = resp.json()
    assert [t["tier"] for t in body] == [1, 2, 3]

    t1, t2, t3 = body
    # TIER 1 contains 3 cascading-critical categories.
    assert t1["category_count"] == 3
    t1_slugs = {c["slug"] for c in t1["categories"]}
    assert t1_slugs == {"session-memory", "token-counting", "context-overflow"}

    # TIER 2 contains code review + regression quality.
    assert t2["category_count"] == 2
    t2_slugs = {c["slug"] for c in t2["categories"]}
    assert t2_slugs == {"code-review-incomplete", "regression-quality"}

    # TIER 3 contains unexpected behavior + api rate limiting.
    assert t3["category_count"] == 2


@pytest.mark.asyncio
async def test_pain_points_ranks_tier1_first(client):
    resp = await client.get("/api/v1/analytics/pain-points?limit=7")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) <= 7
    assert body[0]["rank"] == 1

    # Top pain point must be TIER 1 (weighted 3x on users_affected_pct).
    assert body[0]["category"]["tier"] == 1

    # Ranks are dense and in descending pain_score order.
    for earlier, later in zip(body, body[1:]):
        assert earlier["pain_score"] >= later["pain_score"]
        assert later["rank"] == earlier["rank"] + 1


@pytest.mark.asyncio
async def test_pain_points_default_limit(client):
    resp = await client.get("/api/v1/analytics/pain-points")
    body = resp.json()
    assert len(body) == 5


@pytest.mark.asyncio
async def test_enterprise_recovery_speed_is_45(client):
    # Per-brief update to Week 2 data: Enterprise recovery 45% (was 25%).
    resp = await client.get("/api/v1/user-segments")
    body = resp.json()
    enterprise = next(s for s in body if s["slug"] == "enterprise")
    assert enterprise["recovery_speed_percentage"] == 45.0
