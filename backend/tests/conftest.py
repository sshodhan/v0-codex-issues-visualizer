"""Test fixtures.

Tests exercise the seed-data fallback path (no DATABASE_URL, no Redis) so
they are fully hermetic. This is also the production "demo mode" path, so
testing it directly guarantees the Claude-provided numbers match the brief.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# Ensure no DB/Redis are configured for tests.
os.environ.pop("DATABASE_URL", None)
os.environ.pop("REDIS_URL", None)


@pytest_asyncio.fixture
async def client() -> AsyncIterator[AsyncClient]:
    # Reset the cached Settings so env vars above take effect even if the
    # process is reused between test sessions.
    from app import cache as cache_mod
    from app import db as db_mod
    from app.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]

    # Import main *after* env is scrubbed.
    from app.main import create_app

    app = create_app()

    # Run lifespan manually so startup/shutdown hooks fire.
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as c:
        # Trigger lifespan via the transport startup event.
        await db_mod.init_pool()
        await cache_mod.init_redis()
        try:
            yield c
        finally:
            await cache_mod.close_redis()
            await db_mod.close_pool()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
