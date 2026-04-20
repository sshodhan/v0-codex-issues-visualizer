import pytest


@pytest.mark.asyncio
async def test_timeline_has_16_monthly_points(client):
    resp = await client.get("/api/v1/timeline")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["points"]) == 16
    assert body["points"][0]["month"].startswith("2025-01")
    assert body["points"][-1]["month"].startswith("2026-04")


@pytest.mark.asyncio
async def test_timeline_crisis_peak_is_oct_2025_at_35(client):
    resp = await client.get("/api/v1/timeline")
    body = resp.json()
    peak = body["peak_crisis"]
    assert peak["month"].startswith("2025-10")
    assert peak["sentiment"] == 35.0
    assert peak["status"] == "peak_crisis"


@pytest.mark.asyncio
async def test_timeline_recovery_is_apr_2026_at_82(client):
    resp = await client.get("/api/v1/timeline")
    body = resp.json()
    recovery = body["peak_recovery"]
    assert recovery["month"].startswith("2026-04")
    assert recovery["sentiment"] == 82.0
    assert recovery["status"] == "recovered"
