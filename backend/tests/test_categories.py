import pytest


@pytest.mark.asyncio
async def test_list_categories_with_tier(client):
    resp = await client.get("/api/v1/categories")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 7

    by_slug = {c["slug"]: c for c in body}

    # TIER 1
    assert by_slug["session-memory"]["tier"] == 1
    assert by_slug["session-memory"]["share_pct"] == 29.0
    assert by_slug["session-memory"]["users_affected_pct"] == 12.0
    assert by_slug["token-counting"]["tier"] == 1
    assert by_slug["token-counting"]["share_pct"] == 27.0
    assert by_slug["token-counting"]["users_affected_pct"] == 8.0
    assert "cat-context-overflow" in by_slug["token-counting"]["cascades_to"]
    assert by_slug["context-overflow"]["tier"] == 1
    assert by_slug["context-overflow"]["share_pct"] == 25.0

    # TIER 2
    assert by_slug["code-review-incomplete"]["tier"] == 2
    assert by_slug["regression-quality"]["tier"] == 2

    # TIER 3
    assert by_slug["unexpected-behavior"]["tier"] == 3
    assert by_slug["api-rate-limiting"]["tier"] == 3


@pytest.mark.asyncio
async def test_category_timeseries_session_memory_peaks_match_brief(client):
    resp = await client.get("/api/v1/categories/session-memory/timeseries")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["points"]) == 16

    # Brief: Session/Memory peaks Oct 2025 with 16 issues, sentiment 30;
    # recovers Apr 2026 to 4 issues, sentiment 82.
    oct_point = next(p for p in body["points"] if p["month"].startswith("2025-10"))
    apr_point = next(p for p in body["points"] if p["month"].startswith("2026-04"))
    assert oct_point["issue_count"] == 16
    assert oct_point["sentiment"] == 30.0
    assert apr_point["issue_count"] == 4
    assert apr_point["sentiment"] == 82.0

    # Convenience fields
    assert body["peak"]["sentiment"] == 30.0
    assert body["recovery"]["sentiment"] == 82.0


@pytest.mark.asyncio
async def test_category_timeseries_token_counting(client):
    resp = await client.get("/api/v1/categories/token-counting/timeseries")
    body = resp.json()
    oct_point = next(p for p in body["points"] if p["month"].startswith("2025-10"))
    apr_point = next(p for p in body["points"] if p["month"].startswith("2026-04"))
    assert oct_point["issue_count"] == 15
    assert oct_point["sentiment"] == 29.0
    assert apr_point["issue_count"] == 3
    assert apr_point["sentiment"] == 80.0


@pytest.mark.asyncio
async def test_category_timeseries_unknown_returns_404(client):
    resp = await client.get("/api/v1/categories/does-not-exist/timeseries")
    assert resp.status_code == 404
