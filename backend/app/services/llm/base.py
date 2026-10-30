"""Provider-independent LLM interface used by the agent.

Messages use the OpenAI chat shape (role/content, assistant tool_calls with
ids, role "tool" results with tool_call_id). Providers translate as needed.
"""

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx


@dataclass
class ToolCall:
    id: str
    name: str
    # None when the model sent arguments that are not a JSON object.
    arguments: dict[str, Any] | None
    raw_arguments: str = ""


@dataclass
class LLMResponse:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)


class LLMError(Exception):
    """Base error. `str(error)` is safe to show to users (no secrets)."""

    code = "llm_error"
    status_code = 502


class LLMConfigError(LLMError):
    code = "llm_not_configured"
    status_code = 503


class LLMUnavailableError(LLMError):
    code = "llm_unavailable"
    status_code = 503


class LLMTimeoutError(LLMError):
    code = "llm_timeout"
    status_code = 504


class LLMRateLimitError(LLMError):
    code = "llm_rate_limited"
    status_code = 429


class LLMProvider(ABC):
    name: str

    def __init__(
        self,
        model: str,
        timeout_seconds: float,
        max_tokens: int,
        client: httpx.AsyncClient | None = None,
    ):
        self.model = model
        self.timeout = httpx.Timeout(timeout_seconds, connect=min(5.0, timeout_seconds))
        self.max_tokens = max_tokens
        self._client = client

    @abstractmethod
    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
    ) -> LLMResponse:
        """Return the model's reply, possibly requesting tool calls."""

    async def _post(
        self,
        url: str,
        payload: dict[str, Any],
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.timeout)

        try:
            return await client.post(url, json=payload, headers=headers, timeout=self.timeout)
        except httpx.TimeoutException as exc:
            raise LLMTimeoutError(
                f"The {self.name} model did not respond in time."
            ) from exc
        except httpx.RequestError as exc:
            raise LLMUnavailableError(self._unreachable_message()) from exc
        finally:
            if owns_client:
                await client.aclose()

    def _unreachable_message(self) -> str:
        return f"The {self.name} service could not be reached."

    @staticmethod
    def _json(response: httpx.Response, provider: str) -> dict[str, Any]:
        try:
            data = response.json()
        except ValueError as exc:
            raise LLMError(f"The {provider} service returned an invalid response.") from exc

        if not isinstance(data, dict):
            raise LLMError(f"The {provider} service returned an invalid response.")

        return data


def text_content(content: Any) -> str:
    """Normalise message content: a string, null, or a list of text parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    return ""


def parse_arguments(raw: Any) -> tuple[dict[str, Any] | None, str]:
    """Accept dict or JSON-string arguments; None when not a JSON object."""
    if isinstance(raw, dict):
        return raw, json.dumps(raw)

    text = raw if isinstance(raw, str) else ""

    try:
        value = json.loads(text) if text.strip() else {}
    except ValueError:
        return None, text

    return (value, text) if isinstance(value, dict) else (None, text)
