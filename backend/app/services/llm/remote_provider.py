"""Remote OpenAI-compatible chat-completions provider (production).

Works with any service exposing POST {LLM_BASE_URL}/chat/completions with
function tools. The API key is only ever sent in the Authorization header.
"""

from typing import Any

import httpx

from app.services.llm.base import (
    LLMConfigError,
    LLMError,
    LLMProvider,
    LLMRateLimitError,
    LLMResponse,
    LLMUnavailableError,
    ToolCall,
    parse_arguments,
    text_content,
)

ALLOWED_MESSAGE_KEYS = {"role", "content", "tool_calls", "tool_call_id"}


class RemoteProvider(LLMProvider):
    name = "remote LLM"

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: float,
        max_tokens: int,
        client: httpx.AsyncClient | None = None,
    ):
        super().__init__(model, timeout_seconds, max_tokens, client)
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key

    def __repr__(self) -> str:
        return f"RemoteProvider(model={self.model!r})"

    async def chat(self, messages, tools):
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {key: value for key, value in message.items() if key in ALLOWED_MESSAGE_KEYS}
                for message in messages
            ],
            "max_tokens": self.max_tokens,
            "temperature": 0.1,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        response = await self._post(
            f"{self.base_url}/chat/completions",
            payload,
            headers={"Authorization": f"Bearer {self._api_key}"},
        )

        if response.status_code == 429:
            raise LLMRateLimitError(
                "The AI provider is rate limiting requests. Please wait and try again."
            )
        if response.status_code in (401, 403):
            raise LLMConfigError(
                "The AI provider rejected the credentials. Check LLM_API_KEY."
            )
        if response.status_code == 404:
            raise LLMConfigError(
                "The AI provider endpoint or model was not found. Check LLM_BASE_URL and LLM_MODEL."
            )
        if response.status_code >= 500:
            raise LLMUnavailableError("The AI provider is temporarily unavailable.")
        if response.status_code >= 400:
            raise LLMError(f"The AI provider rejected the request ({response.status_code}).")

        choices = self._json(response, "AI provider").get("choices") or []
        choice = choices[0] if choices else None
        message = choice.get("message") if isinstance(choice, dict) else None

        if not isinstance(message, dict):
            raise LLMError("The AI provider returned no message.")

        tool_calls = []
        for index, call in enumerate(message.get("tool_calls") or []):
            if not isinstance(call, dict):
                continue
            function = call.get("function") or {}
            arguments, raw = parse_arguments(function.get("arguments"))
            tool_calls.append(
                ToolCall(
                    id=str(call.get("id") or f"call_{index}"),
                    name=str(function.get("name") or ""),
                    arguments=arguments,
                    raw_arguments=raw,
                )
            )

        return LLMResponse(content=text_content(message.get("content")), tool_calls=tool_calls)
