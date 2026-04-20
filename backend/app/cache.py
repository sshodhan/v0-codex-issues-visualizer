"""Redis-backed JSON cache with graceful degradation.

If REDIS_URL is unset or Redis is unreachable, `cached()` becomes a no-op
so the API keeps working in local dev.
"""

from __future__ import annotations

import functools
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import redis.asyncio as aioredis

from .config import get_settings

log = logging.getLogger(__name__)

_client: aioredis.Redis | None = None
_init_failed: bool = False


async def init_redis() -> None:
    global _client, _init_failed
    settings = get_settings()
    if not settings.redis_url:
        log.info("REDIS_URL not set; cache disabled")
        return
    try:
        _client = aioredis.from_url(settings.redis_url, decode_responses=True)
        await _client.ping()
        log.info("Redis cache connected")
    except Exception as exc:  # pragma: no cover
        _init_failed = True
        _client = None
        log.warning("Redis unavailable; cache disabled: %s", exc)


async def close_redis() -> None:
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:  # pragma: no cover
            pass
        _client = None


def redis_status() -> str:
    if _client is not None:
        return "connected"
    if _init_failed:
        return "error"
    return "disabled"


def cached(key_prefix: str, ttl: int | None = None) -> Callable[..., Callable[..., Awaitable[Any]]]:
    """Decorate an async function so its JSON-serializable result is cached.

    Cache key is built from `key_prefix` + sorted kwargs. Positional args
    are included by repr. If Redis is not available the wrapped function
    is called directly.
    """
    settings = get_settings()
    effective_ttl = ttl if ttl is not None else settings.cache_ttl_short

    def decorator(fn: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            if _client is None:
                return await fn(*args, **kwargs)

            key_parts = [key_prefix]
            if args:
                key_parts.append("|".join(repr(a) for a in args))
            if kwargs:
                key_parts.append("|".join(f"{k}={kwargs[k]!r}" for k in sorted(kwargs)))
            key = ":".join(key_parts)

            try:
                hit = await _client.get(key)
                if hit is not None:
                    return json.loads(hit)
            except Exception as exc:  # pragma: no cover
                log.warning("cache read failed (%s): %s", key, exc)

            result = await fn(*args, **kwargs)
            try:
                await _client.set(key, json.dumps(result, default=str), ex=effective_ttl)
            except Exception as exc:  # pragma: no cover
                log.warning("cache write failed (%s): %s", key, exc)
            return result

        return wrapper

    return decorator
