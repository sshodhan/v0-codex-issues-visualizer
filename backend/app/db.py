"""asyncpg pool management + thin query helpers.

Every route is designed to work without a DB: if `DATABASE_URL` is not set
or the connection fails, `get_pool()` returns `None` and callers fall back
to the in-memory seed data (the Claude-provided canonical dataset).
"""

from __future__ import annotations

import logging
from typing import Any

import asyncpg

from .config import get_settings

log = logging.getLogger(__name__)

_pool: asyncpg.Pool | None = None
_init_failed: bool = False


async def init_pool() -> None:
    """Create the pool at startup. Silently no-ops if DATABASE_URL is unset."""
    global _pool, _init_failed
    settings = get_settings()
    if not settings.database_url:
        log.info("DATABASE_URL not set; running in seed-data fallback mode")
        return
    try:
        _pool = await asyncpg.create_pool(
            dsn=settings.database_url,
            min_size=1,
            max_size=10,
            command_timeout=10,
        )
        log.info("asyncpg pool initialized")
    except Exception as exc:  # pragma: no cover - connection errors are env-specific
        _init_failed = True
        log.warning("Failed to init asyncpg pool; using seed-data fallback: %s", exc)


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool | None:
    return _pool


def db_status() -> str:
    if _pool is not None:
        return "connected"
    if _init_failed:
        return "error"
    return "disabled"


async def fetch(query: str, *args: Any) -> list[dict[str, Any]]:
    pool = get_pool()
    if pool is None:
        raise RuntimeError("DB not available")
    rows = await pool.fetch(query, *args)
    return [dict(r) for r in rows]


async def fetchrow(query: str, *args: Any) -> dict[str, Any] | None:
    pool = get_pool()
    if pool is None:
        raise RuntimeError("DB not available")
    row = await pool.fetchrow(query, *args)
    return dict(row) if row else None
