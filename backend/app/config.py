"""Runtime configuration read from environment variables.

Locally, put values in backend/.env and start uvicorn with --env-file .env.
On Render, set them in the service's Environment settings.
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_CORS_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")


def _clean(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


def _bounded_number(raw: str | None, default: float, low: float, high: float) -> float:
    try:
        value = float(raw) if raw not in (None, "") else default
    except ValueError:
        value = default
    return min(max(value, low), high)


@dataclass(frozen=True)
class Settings:
    cors_origins: tuple[str, ...]
    llm_provider: str | None
    ollama_base_url: str | None
    ollama_model: str | None
    llm_base_url: str | None
    llm_api_key: str | None
    llm_model: str | None
    llm_timeout_seconds: float
    llm_max_tokens: int
    agent_max_iterations: int
    agent_timeout_seconds: float

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        origins = tuple(
            origin.strip().rstrip("/")
            for origin in (env.get("CORS_ORIGINS") or "").split(",")
            if origin.strip()
        )

        return cls(
            cors_origins=origins or DEFAULT_CORS_ORIGINS,
            llm_provider=(_clean(env.get("LLM_PROVIDER")) or "").lower() or None,
            ollama_base_url=_clean(env.get("OLLAMA_BASE_URL")),
            ollama_model=_clean(env.get("OLLAMA_MODEL")),
            llm_base_url=_clean(env.get("LLM_BASE_URL")),
            llm_api_key=_clean(env.get("LLM_API_KEY")),
            llm_model=_clean(env.get("LLM_MODEL")),
            llm_timeout_seconds=_bounded_number(env.get("LLM_TIMEOUT_SECONDS"), 30, 1, 120),
            llm_max_tokens=int(_bounded_number(env.get("LLM_MAX_TOKENS"), 700, 64, 4000)),
            agent_max_iterations=int(_bounded_number(env.get("AGENT_MAX_ITERATIONS"), 3, 1, 5)),
            agent_timeout_seconds=_bounded_number(env.get("AGENT_TIMEOUT_SECONDS"), 90, 10, 300),
        )


def get_settings() -> Settings:
    return Settings.from_env()
