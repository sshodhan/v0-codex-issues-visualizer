import pytest


@pytest.mark.asyncio
async def test_list_segments(client):
    resp = await client.get("/api/v1/user-segments")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 5
    by_slug = {s["slug"]: s for s in body}

    # Brief-critical values — these MUST match verbatim.
    assert by_slug["enterprise"]["crisis_severity_percentage"] == 78.0
    assert by_slug["enterprise"]["cost_impact_percentage"] == 92.0
    assert by_slug["professional"]["crisis_severity_percentage"] == 65.0
    assert by_slug["professional"]["cost_impact_percentage"] == 78.0
    assert by_slug["smb"]["crisis_severity_percentage"] == 42.0
    assert by_slug["smb"]["cost_impact_percentage"] == 55.0
    assert by_slug["indie"]["crisis_severity_percentage"] == 15.0


@pytest.mark.asyncio
async def test_enterprise_impact_analysis(client):
    resp = await client.get("/api/v1/user-segments/enterprise/impact-analysis")
    assert resp.status_code == 200
    body = resp.json()
    assert body["segment"]["slug"] == "enterprise"
    assert body["metrics"]["crisis_severity_percentage"] == 78.0
    # Enterprise segment should have the most critical issues flagged.
    assert body["metrics"]["critical_count"] >= 3


@pytest.mark.asyncio
async def test_segment_404(client):
    resp = await client.get("/api/v1/user-segments/does-not-exist/impact-analysis")
    assert resp.status_code == 404
