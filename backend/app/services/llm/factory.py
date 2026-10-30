from app.config import Settings
from app.services.llm.base import LLMConfigError, LLMProvider
from app.services.llm.ollama_provider import OllamaProvider
from app.services.llm.remote_provider import RemoteProvider

REMOTE_ALIASES = {"remote", "openai_compatible", "openai-compatible"}


def create_provider(settings: Settings) -> LLMProvider | None:
    """Build the configured provider, or None when no LLM is configured."""
    provider = settings.llm_provider

    if provider in (None, "none", "off"):
        return None

    if provider == "ollama":
        missing = [
            name
            for name, value in (
                ("OLLAMA_BASE_URL", settings.ollama_base_url),
                ("OLLAMA_MODEL", settings.ollama_model),
            )
            if not value
        ]
        if missing:
            raise LLMConfigError(
                f"LLM_PROVIDER=ollama requires {', '.join(missing)}."
            )
        return OllamaProvider(
            base_url=settings.ollama_base_url,
            model=settings.ollama_model,
            timeout_seconds=settings.llm_timeout_seconds,
            max_tokens=settings.llm_max_tokens,
        )

    if provider in REMOTE_ALIASES:
        missing = [
            name
            for name, value in (
                ("LLM_BASE_URL", settings.llm_base_url),
                ("LLM_API_KEY", settings.llm_api_key),
                ("LLM_MODEL", settings.llm_model),
            )
            if not value
        ]
        if missing:
            raise LLMConfigError(
                f"LLM_PROVIDER={provider} requires {', '.join(missing)}."
            )
        return RemoteProvider(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            model=settings.llm_model,
            timeout_seconds=settings.llm_timeout_seconds,
            max_tokens=settings.llm_max_tokens,
        )

    raise LLMConfigError(
        f"Unknown LLM_PROVIDER '{provider}'. Use 'ollama', 'remote' or 'none'."
    )


def describe_provider(settings: Settings) -> dict:
    """Public, secret-free description for the UI."""
    try:
        provider = create_provider(settings)
    except LLMConfigError as exc:
        return {"configured": False, "provider": settings.llm_provider, "model": None, "error": str(exc)}

    if provider is None:
        return {"configured": False, "provider": None, "model": None, "error": None}

    return {
        "configured": True,
        "provider": "ollama" if isinstance(provider, OllamaProvider) else "remote",
        "model": provider.model,
        "error": None,
    }
