import pytest


@pytest.mark.asyncio
async def test_list_issues_default(client):
    resp = await client.get("/api/v1/issues")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 16
    assert len(body["data"]) == 16
    # Sorted by created_at desc — newest first.
    created_list = [i["created_at"] for i in body["data"]]
    assert created_list == sorted(created_list, reverse=True)


@pytest.mark.asyncio
async def test_filter_by_severity(client):
    resp = await client.get("/api/v1/issues?severity=critical")
    body = resp.json()
    assert body["total"] > 0
    for issue in body["data"]:
        assert issue["severity"] == "critical"


@pytest.mark.asyncio
async def test_filter_by_category_slug(client):
    resp = await client.get("/api/v1/issues?category=context-overflow")
    body = resp.json()
    assert body["total"] >= 3
    for issue in body["data"]:
        assert issue["category_id"] == "cat-context-overflow"


@pytest.mark.asyncio
async def test_sentiment_range_filter(client):
    resp = await client.get("/api/v1/issues?sentiment_max=-0.5")
    body = resp.json()
    assert body["total"] > 0
    for issue in body["data"]:
        assert issue["sentiment_score"] <= -0.5


@pytest.mark.asyncio
async def test_segment_filter_enterprise(client):
    resp = await client.get("/api/v1/issues?segment=enterprise")
    body = resp.json()
    assert body["total"] >= 5
    for issue in body["data"]:
        assert "enterprise" in issue["affected_segments"]


@pytest.mark.asyncio
async def test_pagination(client):
    first = (await client.get("/api/v1/issues?limit=5&offset=0")).json()
    second = (await client.get("/api/v1/issues?limit=5&offset=5")).json()
    assert len(first["data"]) == 5
    assert len(second["data"]) == 5
    first_ids = {i["id"] for i in first["data"]}
    second_ids = {i["id"] for i in second["data"]}
    assert first_ids.isdisjoint(second_ids)


@pytest.mark.asyncio
async def test_search(client):
    resp = await client.get("/api/v1/issues/search?q=compaction")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) >= 2
    for issue in body:
        text = (issue["title"] + " " + (issue["description"] or "")).lower()
        assert "compaction" in text or "compact" in text


@pytest.mark.asyncio
async def test_issue_detail_with_related(client):
    resp = await client.get("/api/v1/issues/iss-001")
    assert resp.status_code == 200
    body = resp.json()
    assert body["issue"]["id"] == "iss-001"
    assert body["root_cause"] is not None
    assert body["root_cause"]["id"] == "rc-compact-rs"
    assert len(body["related_issues"]) >= 2


@pytest.mark.asyncio
async def test_issue_404(client):
    resp = await client.get("/api/v1/issues/nope")
    assert resp.status_code == 404
