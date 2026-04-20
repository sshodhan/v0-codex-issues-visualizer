import pytest


@pytest.mark.asyncio
async def test_list_root_causes(client):
    resp = await client.get("/api/v1/root-causes")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 9
    ids = {r["id"] for r in body}
    assert {"rc-compact-rs", "rc-memory-alloc", "rc-token-count"} <= ids


@pytest.mark.asyncio
async def test_compact_rs_root_cause_values(client):
    resp = await client.get("/api/v1/root-causes")
    body = resp.json()
    compact = next(r for r in body if r["id"] == "rc-compact-rs")
    assert compact["estimated_users_impacted_percentage"] == 12.0
    assert compact["component"] == "codex-rs/core/src/codex/compact.rs"
    assert compact["severity"] == "critical"
    assert compact["affected_issue_count"] >= 3


@pytest.mark.asyncio
async def test_root_cause_detail_returns_affected_issues(client):
    resp = await client.get("/api/v1/root-causes/rc-compact-rs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["root_cause"]["id"] == "rc-compact-rs"
    assert len(body["affected_issues"]) >= 3
    for issue in body["affected_issues"]:
        assert issue["root_cause_id"] == "rc-compact-rs"


@pytest.mark.asyncio
async def test_root_cause_404(client):
    resp = await client.get("/api/v1/root-causes/nope")
    assert resp.status_code == 404
