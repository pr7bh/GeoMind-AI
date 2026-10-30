import asyncio
import json

import httpx
import pytest

from app.config import Settings
from app.services.llm.base import (
    LLMConfigError,
    LLMRateLimitError,
    LLMTimeoutError,
    LLMUnavailableError,
)
from app.services.llm.factory import create_provider, describe_provider
from app.services.llm.ollama_provider import OllamaProvider
from app.services.llm.remote_provider import RemoteProvider

SECRET = "sk-test-secret-value"
MESSAGES = [{"role": "user", "content": "hi"}]


def settings(**env):
    return Settings.from_env(env)


def client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def run(coro):
    return asyncio.run(coro)


# Configuration and provider selection

def test_no_provider_configured_returns_none():
    assert create_provider(settings()) is None
    assert create_provider(settings(LLM_PROVIDER="none")) is None


def test_selects_ollama():
    provider = create_provider(settings(
        LLM_PROVIDER="ollama", OLLAMA_BASE_URL="http://ollama.test", OLLAMA_MODEL="llama3.1",
    ))
    assert isinstance(provider, OllamaProvider)
    assert provider.model == "llama3.1"


def test_selects_remote():
    provider = create_provider(settings(
        LLM_PROVIDER="remote", LLM_BASE_URL="https://llm.test/v1", LLM_API_KEY=SECRET, LLM_MODEL="m",
    ))
    assert isinstance(provider, RemoteProvider)
    assert SECRET not in repr(provider)


@pytest.mark.parametrize("env,missing", [
    ({"LLM_PROVIDER": "ollama", "OLLAMA_MODEL": "x"}, "OLLAMA_BASE_URL"),
    ({"LLM_PROVIDER": "remote", "LLM_BASE_URL": "https://x", "LLM_MODEL": "m"}, "LLM_API_KEY"),
    ({"LLM_PROVIDER": "remote", "LLM_API_KEY": SECRET}, "LLM_BASE_URL, LLM_MODEL"),
])
def test_missing_configuration_is_reported(env, missing):
    with pytest.raises(LLMConfigError, match=missing):
        create_provider(settings(**env))


def test_unknown_provider_rejected():
    with pytest.raises(LLMConfigError, match="Unknown LLM_PROVIDER"):
        create_provider(settings(LLM_PROVIDER="magic"))


def test_status_never_exposes_key_or_url():
    status = describe_provider(settings(
        LLM_PROVIDER="remote", LLM_BASE_URL="https://private.llm/v1", LLM_API_KEY=SECRET, LLM_MODEL="m",
    ))
    assert status == {"configured": True, "provider": "remote", "model": "m", "error": None}
    assert SECRET not in json.dumps(status) and "private.llm" not in json.dumps(status)


def test_settings_are_bounded():
    s = settings(LLM_TIMEOUT_SECONDS="9999", AGENT_MAX_ITERATIONS="50", CORS_ORIGINS="https://a.vercel.app/, https://b.app")
    assert s.llm_timeout_seconds == 120
    assert s.agent_max_iterations == 5
    assert s.cors_origins == ("https://a.vercel.app", "https://b.app")


# Ollama

def ollama(handler):
    return OllamaProvider("http://ollama.test", "llama3.1", 5, 100, client(handler))


def test_ollama_unavailable():
    def handler(request):
        raise httpx.ConnectError("refused")

    with pytest.raises(LLMUnavailableError, match="Ollama server is not reachable"):
        run(ollama(handler).chat(MESSAGES, None))


def test_ollama_missing_model():
    with pytest.raises(LLMConfigError, match="ollama pull llama3.1"):
        run(ollama(lambda r: httpx.Response(404, json={"error": "model not found"})).chat(MESSAGES, None))


def test_ollama_parses_tool_calls_and_converts_history():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"message": {
            "role": "assistant", "content": "",
            "tool_calls": [{"function": {"name": "discover_features", "arguments": {"category": "hospital", "radius_km": 5}}}],
        }})

    history = MESSAGES + [
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "create_buffer", "arguments": '{"distance_metres": 10}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "{}"},
    ]
    response = run(ollama(handler).chat(history, [{"type": "function"}]))

    assert response.tool_calls[0].name == "discover_features"
    assert response.tool_calls[0].arguments == {"category": "hospital", "radius_km": 5}
    sent = seen["body"]["messages"]
    assert sent[1]["tool_calls"][0]["function"]["arguments"] == {"distance_metres": 10}
    assert sent[2] == {"role": "tool", "content": "{}", "tool_name": "create_buffer"}
    assert seen["body"]["stream"] is False


# Remote OpenAI-compatible

def remote(handler):
    return RemoteProvider("https://llm.test/v1", SECRET, "model-x", 5, 100, client(handler))


def test_remote_timeout():
    def handler(request):
        raise httpx.ReadTimeout("slow")

    with pytest.raises(LLMTimeoutError):
        run(remote(handler).chat(MESSAGES, None))


def test_remote_rate_limited():
    with pytest.raises(LLMRateLimitError):
        run(remote(lambda r: httpx.Response(429, json={"error": "slow down"})).chat(MESSAGES, None))


@pytest.mark.parametrize("status,error", [(401, LLMConfigError), (503, LLMUnavailableError)])
def test_remote_errors_do_not_leak_secret(status, error):
    with pytest.raises(error) as info:
        run(remote(lambda r: httpx.Response(status, text=f"bad key {SECRET}")).chat(MESSAGES, None))
    assert SECRET not in str(info.value)


def test_remote_sends_bearer_and_parses_tool_calls():
    seen = {}

    def handler(request):
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"message": {
            "role": "assistant", "content": None,
            "tool_calls": [
                {"id": "a", "type": "function", "function": {"name": "create_buffer", "arguments": '{"distance_metres": 500}'}},
                {"id": "b", "type": "function", "function": {"name": "create_buffer", "arguments": "{not json"}},
            ],
        }}]})

    history = MESSAGES + [{"role": "tool", "tool_call_id": "z", "content": "{}", "name": "extra"}]
    response = run(remote(handler).chat(history, [{"type": "function"}]))

    assert seen["auth"] == f"Bearer {SECRET}"
    assert "name" not in seen["body"]["messages"][1]
    assert seen["body"]["tool_choice"] == "auto"
    assert response.tool_calls[0].arguments == {"distance_metres": 500}
    assert response.tool_calls[1].arguments is None


@pytest.mark.parametrize("body,content", [
    ({"choices": [{"message": {"content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}}]}, "ab"),
    ({"choices": [{"message": {"content": None}, "finish_reason": "length"}]}, ""),
])
def test_remote_normalises_content(body, content):
    response = run(remote(lambda r: httpx.Response(200, json=body)).chat(MESSAGES, None))
    assert response.content == content


@pytest.mark.parametrize("body", [{"choices": ["oops"]}, {"error": {"message": "overloaded"}}, {"choices": []}])
def test_remote_malformed_choices_raise_llm_error(body):
    from app.services.llm.base import LLMError

    with pytest.raises(LLMError):
        run(remote(lambda r: httpx.Response(200, json=body)).chat(MESSAGES, None))
