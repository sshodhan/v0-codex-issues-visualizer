import pytest


@pytest.mark.asyncio
async def test_competitive_four_products(client):
    resp = await client.get("/api/v1/analytics/competitive")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 4
    products = {p["product"] for p in body}
    assert products == {"codex", "claude_code", "copilot", "gemini"}

    codex = next(p for p in body if p["product"] == "codex")
    claude = next(p for p in body if p["product"] == "claude_code")
    assert codex["context_window_tokens"] == 200000
    assert claude["agent_autonomy_score"] == 92.0
    assert claude["cost_per_task_usd"] == 155.0


@pytest.mark.asyncio
async def test_sentiment_analytics_shape(client):
    resp = await client.get("/api/v1/analytics/sentiment")
    assert resp.status_code == 200
    body = resp.json()
    buckets = {b["bucket"] for b in body["distribution"]}
    assert buckets == {"very_negative", "negative", "neutral", "positive", "very_positive"}
    assert body["stats"]["count"] == 16
    assert len(body["trend"]) == 16


@pytest.mark.asyncio
async def test_categories_analytics(client):
    resp = await client.get("/api/v1/analytics/categories")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 16
    assert len(body["by_category"]) == 7
    slugs = {row["category"]["slug"] for row in body["by_category"]}
    assert "code-review-incomplete" in slugs
    assert "context-overflow" in slugs
