"""Local Ollama provider (development only; never used on Render)."""

import json
from typing import Any

import httpx

from app.services.llm.base import (
    LLMConfigError,
    LLMError,
    LLMProvider,
    LLMResponse,
    ToolCall,
    parse_arguments,
    text_content,
)


class OllamaProvider(LLMProvider):
    name = "Ollama"

    def __init__(
        self,
        base_url: str,
        model: str,
        timeout_seconds: float,
        max_tokens: int,
        client: httpx.AsyncClient | None = None,
    ):
        super().__init__(model, timeout_seconds, max_tokens, client)
        self.base_url = base_url.rstrip("/")

    def _unreachable_message(self) -> str:
        return (
            "The local Ollama server is not reachable. Start Ollama, or set "
            "LLM_PROVIDER to a remote provider."
        )

    @staticmethod
    def _to_ollama_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # Ollama wants dict arguments and identifies tool results by name.
        tool_names: dict[str, str] = {}
        converted = []

        for message in messages:
            if message["role"] == "assistant" and message.get("tool_calls"):
                calls = []
                for call in message["tool_calls"]:
                    tool_names[call["id"]] = call["function"]["name"]
                    arguments, _ = parse_arguments(call["function"]["arguments"])
                    calls.append({
                        "function": {
                            "name": call["function"]["name"],
                            "arguments": arguments or {},
                        }
                    })
                converted.append({
                    "role": "assistant",
                    "content": message.get("content") or "",
                    "tool_calls": calls,
                })
            elif message["role"] == "tool":
                converted.append({
                    "role": "tool",
                    "content": message["content"],
                    "tool_name": tool_names.get(message.get("tool_call_id", ""), ""),
                })
            else:
                converted.append({"role": message["role"], "content": message["content"]})

        return converted

    async def chat(self, messages, tools):
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": self._to_ollama_messages(messages),
            "stream": False,
            "options": {"num_predict": self.max_tokens},
        }
        if tools:
            payload["tools"] = tools

        response = await self._post(f"{self.base_url}/api/chat", payload)

        if response.status_code == 404:
            raise LLMConfigError(
                f"The Ollama model '{self.model}' is not available locally. "
                f"Run `ollama pull {self.model}` or change OLLAMA_MODEL."
            )

        if response.status_code >= 400:
            raise LLMError(f"Ollama rejected the request ({response.status_code}).")

        message = self._json(response, "Ollama").get("message") or {}
        tool_calls = []

        for index, call in enumerate(message.get("tool_calls") or []):
            function = call.get("function") or {}
            arguments, raw = parse_arguments(function.get("arguments"))
            tool_calls.append(
                ToolCall(
                    id=call.get("id") or f"call_{index}",
                    name=str(function.get("name") or ""),
                    arguments=arguments,
                    raw_arguments=raw if isinstance(raw, str) else json.dumps(raw),
                )
            )

        return LLMResponse(content=text_content(message.get("content")), tool_calls=tool_calls)
