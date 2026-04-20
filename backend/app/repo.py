"""Unified data access: Postgres first, fall back to in-memory seed data.

Every route calls helpers in this module instead of touching asyncpg or
seed_data directly. This keeps the frontend working even without a DB.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from . import db, seed_data


def _using_db() -> bool:
    return db.get_pool() is not None


# --- utilities ---------------------------------------------------------------


def _parse_date(val: Any) -> date | None:
    if val is None or isinstance(val, date) and not isinstance(val, datetime):
        return val if val else None
    if isinstance(val, datetime):
        return val.date()
    return date.fromisoformat(str(val)[:10])


def _parse_dt(val: Any) -> datetime:
    if isinstance(val, datetime):
        return val
    return datetime.fromisoformat(str(val).replace("Z", "+00:00"))


def _normalize_issue(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    out["created_at"] = _parse_dt(out["created_at"])
    out.setdefault("duplicate_of_id", None)
    out["affected_segments"] = list(out.get("affected_segments") or [])
    return out


def _normalize_rc(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for f in ("first_detected", "identified_date", "fixed_date"):
        out[f] = _parse_date(out.get(f))
    return out


# --- categories --------------------------------------------------------------


async def list_categories() -> list[dict[str, Any]]:
    if _using_db():
        return await db.fetch(
            "SELECT id, name, slug, color, share_pct FROM issue_categories ORDER BY share_pct DESC"
        )
    return list(seed_data.CATEGORIES)


# --- user segments -----------------------------------------------------------


async def list_segments() -> list[dict[str, Any]]:
    if _using_db():
        return await db.fetch(
            "SELECT id, name, slug, description, developer_count_range, "
            "crisis_severity_percentage, cost_impact_percentage, recovery_speed_percentage "
            "FROM user_segments ORDER BY crisis_severity_percentage DESC"
        )
    return list(seed_data.USER_SEGMENTS)


async def get_segment(slug: str) -> dict[str, Any] | None:
    if _using_db():
        return await db.fetchrow(
            "SELECT id, name, slug, description, developer_count_range, "
            "crisis_severity_percentage, cost_impact_percentage, recovery_speed_percentage "
            "FROM user_segments WHERE slug = $1 OR id = $1",
            slug,
        )
    return seed_data.SEGMENT_BY_SLUG.get(slug) or seed_data.SEGMENT_BY_ID.get(slug)


# --- root causes -------------------------------------------------------------


async def list_root_causes() -> list[dict[str, Any]]:
    if _using_db():
        rows = await db.fetch(
            """
            SELECT rc.id, rc.product, rc.title, rc.description, rc.component, rc.error_type,
                   rc.severity, rc.first_detected, rc.identified_date, rc.fixed_date,
                   rc.fixed_in_version, rc.estimated_users_impacted_percentage,
                   COUNT(i.id) AS affected_issue_count
            FROM root_causes rc
            LEFT JOIN issues i ON i.root_cause_id = rc.id
            GROUP BY rc.id
            ORDER BY rc.estimated_users_impacted_percentage DESC
            """
        )
        return [_normalize_rc(r) for r in rows]
    out = []
    for rc in seed_data.ROOT_CAUSES:
        r = dict(rc)
        r["affected_issue_count"] = len(seed_data.issues_for_root_cause(rc["id"]))
        r.pop("affected_issue_ids", None)
        out.append(_normalize_rc(r))
    return out


async def get_root_cause(rc_id: str) -> dict[str, Any] | None:
    if _using_db():
        row = await db.fetchrow(
            "SELECT id, product, title, description, component, error_type, severity, "
            "first_detected, identified_date, fixed_date, fixed_in_version, "
            "estimated_users_impacted_percentage FROM root_causes WHERE id = $1",
            rc_id,
        )
        return _normalize_rc(row) if row else None
    rc = seed_data.ROOT_CAUSE_BY_ID.get(rc_id)
    if not rc:
        return None
    out = dict(rc)
    out.pop("affected_issue_ids", None)
    return _normalize_rc(out)


# --- competitive -------------------------------------------------------------


async def list_competitive() -> list[dict[str, Any]]:
    if _using_db():
        return await db.fetch(
            "SELECT id, product, display_name, code_quality_score, efficiency_score, "
            "cost_per_task_usd, context_window_tokens, agent_autonomy_score, "
            "market_sentiment, adoption_rate, enterprise_readiness_score, summary "
            "FROM competitive_data ORDER BY market_sentiment DESC"
        )
    return sorted(seed_data.COMPETITIVE_DATA, key=lambda c: -c["market_sentiment"])


# --- timeline ----------------------------------------------------------------


async def list_timeline() -> list[dict[str, Any]]:
    if _using_db():
        rows = await db.fetch(
            "SELECT month, sentiment, issue_freq, status, note "
            "FROM issue_timeseries ORDER BY month ASC"
        )
        return [
            {
                "month": _parse_date(r["month"]),
                "sentiment": float(r["sentiment"]),
                "issue_freq": int(r["issue_freq"]),
                "status": r["status"],
                "note": r["note"],
            }
            for r in rows
        ]
    return [
        {
            "month": _parse_date(t["month"]),
            "sentiment": float(t["sentiment"]),
            "issue_freq": int(t["issue_freq"]),
            "status": t["status"],
            "note": t["note"],
        }
        for t in seed_data.TIMELINE
    ]


# --- issues ------------------------------------------------------------------


async def list_issues(
    *,
    category: str | None = None,
    severity: str | None = None,
    sentiment_min: float | None = None,
    sentiment_max: float | None = None,
    segment: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    if _using_db():
        clauses = []
        params: list[Any] = []
        if category:
            params.append(category)
            clauses.append(f"(category_id = ${len(params)} OR category_id IN (SELECT id FROM issue_categories WHERE slug = ${len(params)}))")
        if severity:
            params.append(severity)
            clauses.append(f"severity = ${len(params)}")
        if sentiment_min is not None:
            params.append(sentiment_min)
            clauses.append(f"sentiment_score >= ${len(params)}")
        if sentiment_max is not None:
            params.append(sentiment_max)
            clauses.append(f"sentiment_score <= ${len(params)}")
        if segment:
            params.append(segment)
            clauses.append(f"${len(params)} = ANY(affected_segments)")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

        total_row = await db.fetchrow(f"SELECT COUNT(*)::int AS c FROM issues {where}", *params)
        total = int(total_row["c"]) if total_row else 0

        params_paged = [*params, limit, offset]
        rows = await db.fetch(
            f"SELECT id, source, source_id, product, title, description, url, category_id, "
            f"severity, sentiment_score, engagement_score, mention_count, affected_segments, "
            f"root_cause_id, duplicate_of_id, created_at FROM issues {where} "
            f"ORDER BY created_at DESC LIMIT ${len(params)+1} OFFSET ${len(params)+2}",
            *params_paged,
        )
        return [_normalize_issue(r) for r in rows], total

    # Seed fallback
    rows = list(seed_data.ISSUES)
    if category:
        cat_id = category
        if category not in seed_data.CATEGORY_BY_ID:
            match = next((c for c in seed_data.CATEGORIES if c["slug"] == category), None)
            cat_id = match["id"] if match else None
        rows = [r for r in rows if r["category_id"] == cat_id]
    if severity:
        rows = [r for r in rows if r["severity"] == severity]
    if sentiment_min is not None:
        rows = [r for r in rows if r["sentiment_score"] >= sentiment_min]
    if sentiment_max is not None:
        rows = [r for r in rows if r["sentiment_score"] <= sentiment_max]
    if segment:
        rows = [r for r in rows if segment in r["affected_segments"]]
    rows.sort(key=lambda r: r["created_at"], reverse=True)
    total = len(rows)
    page = rows[offset : offset + limit]
    return [_normalize_issue(r) for r in page], total


async def get_issue(issue_id: str) -> dict[str, Any] | None:
    if _using_db():
        row = await db.fetchrow(
            "SELECT id, source, source_id, product, title, description, url, category_id, "
            "severity, sentiment_score, engagement_score, mention_count, affected_segments, "
            "root_cause_id, duplicate_of_id, created_at FROM issues WHERE id = $1",
            issue_id,
        )
        return _normalize_issue(row) if row else None
    issue = seed_data.ISSUE_BY_ID.get(issue_id)
    return _normalize_issue(issue) if issue else None


async def issues_by_root_cause(rc_id: str) -> list[dict[str, Any]]:
    if _using_db():
        rows = await db.fetch(
            "SELECT id, source, source_id, product, title, description, url, category_id, "
            "severity, sentiment_score, engagement_score, mention_count, affected_segments, "
            "root_cause_id, duplicate_of_id, created_at FROM issues WHERE root_cause_id = $1 "
            "ORDER BY sentiment_score ASC",
            rc_id,
        )
        return [_normalize_issue(r) for r in rows]
    rows = seed_data.issues_for_root_cause(rc_id)
    rows = sorted(rows, key=lambda r: r["sentiment_score"])
    return [_normalize_issue(r) for r in rows]


async def issues_by_segment(segment_slug: str) -> list[dict[str, Any]]:
    if _using_db():
        rows = await db.fetch(
            "SELECT id, source, source_id, product, title, description, url, category_id, "
            "severity, sentiment_score, engagement_score, mention_count, affected_segments, "
            "root_cause_id, duplicate_of_id, created_at FROM issues "
            "WHERE $1 = ANY(affected_segments) ORDER BY engagement_score DESC",
            segment_slug,
        )
        return [_normalize_issue(r) for r in rows]
    rows = seed_data.issues_for_segment(segment_slug)
    rows = sorted(rows, key=lambda r: -r["engagement_score"])
    return [_normalize_issue(r) for r in rows]


async def search_issues(q: str, limit: int = 50) -> list[dict[str, Any]]:
    needle = q.lower().strip()
    if not needle:
        return []
    if _using_db():
        rows = await db.fetch(
            "SELECT id, source, source_id, product, title, description, url, category_id, "
            "severity, sentiment_score, engagement_score, mention_count, affected_segments, "
            "root_cause_id, duplicate_of_id, created_at FROM issues "
            "WHERE title ILIKE $1 OR description ILIKE $1 "
            "ORDER BY engagement_score DESC LIMIT $2",
            f"%{needle}%",
            limit,
        )
        return [_normalize_issue(r) for r in rows]
    rows = [
        r for r in seed_data.ISSUES
        if needle in r["title"].lower() or needle in (r.get("description") or "").lower()
    ]
    rows = sorted(rows, key=lambda r: -r["engagement_score"])[:limit]
    return [_normalize_issue(r) for r in rows]
