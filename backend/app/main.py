"""Codex Market Analysis FastAPI app."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address

from . import cache, db
from .config import get_settings
from .routes import (
    analytics,
    categories,
    health,
    issues,
    root_causes,
    timeline,
    user_segments,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await db.init_pool()
    await cache.init_redis()
    try:
        yield
    finally:
        await cache.close_redis()
        await db.close_pool()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version=settings.version,
        description=(
            "Pre-computed Codex market-analysis API. Data source of truth: "
            "`backend/app/seed_data.py`. If DATABASE_URL is unset or Postgres "
            "is unreachable, endpoints serve from the in-memory seed dataset."
        ),
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins_list,
        allow_credentials=True,
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    limiter = Limiter(key_func=get_remote_address, default_limits=[settings.rate_limit_default])
    app.state.limiter = limiter

    async def rate_limit_handler(_request, exc: RateLimitExceeded):  # type: ignore[override]
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=429, content={"detail": f"Rate limit exceeded: {exc.detail}"})

    app.add_exception_handler(RateLimitExceeded, rate_limit_handler)
    app.add_middleware(SlowAPIMiddleware)

    app.include_router(health.router)
    app.include_router(issues.router)
    app.include_router(timeline.router)
    app.include_router(root_causes.router)
    app.include_router(user_segments.router)
    app.include_router(categories.router)
    app.include_router(analytics.router)

    return app


app = create_app()
