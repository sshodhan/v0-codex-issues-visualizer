"""Application settings loaded from env vars or .env file."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # App
    app_name: str = "Codex Market Analysis API"
    version: str = "0.1.0"
    environment: str = "development"

    # Supabase / Postgres
    # asyncpg-compatible URL, e.g. postgresql://user:pass@host:5432/postgres
    database_url: str | None = None

    # Redis
    redis_url: str | None = None

    # CORS — comma-separated list of origins
    allowed_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    # Cache TTLs (seconds)
    cache_ttl_short: int = 300   # 5 min for lists
    cache_ttl_long: int = 1800   # 30 min for analytics rollups

    # Rate limiting (per-IP)
    rate_limit_default: str = "60/minute"

    @property
    def allowed_origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
