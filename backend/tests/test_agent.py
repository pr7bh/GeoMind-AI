import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import agent as agent_router
from app.services import osm_discovery as od
from app.services.agent.runner import parse_discovery_request, run_agent
from app.services.agent.tools import AgentContext
from app.services.llm.base import LLMResponse, LLMTimeoutError, ToolCall

DELHI = (77.2167, 28.6315)


def hospital(osm_id, lon, lat, name=None):
    tags = {"amenity": "hospital"}
    if name:
        tags["name"] = name
    return {"type": "node", "id": osm_id, "lon": lon, "lat": lat, "tags": tags}


HOSPITALS = [
    hospital(1, 77.2200, 28.6320, "City Hospital"),
    hospital(2, 77.2400, 28.6400, "Lady Hardinge Hospital"),
    hospital(3, 77.2170, 28.6316),
]


@pytest.fixture
def overpass(monkeypatch):
    """Mock Overpass; tests set .elements or .error."""

    class Fake:
        elements = HOSPITALS
        error = None
        queries: list[str] = []

    async def fake_fetch(query, client=None):
        Fake.queries.append(query)
        if Fake.error:
            raise Fake.error
        return {"elements": Fake.elements, "osm3s": {"timestamp_osm_base": "2026-10-30T00:00:00Z"}}

    monkeypatch.setattr(od, "_fetch_overpass", fake_fetch)
    Fake.queries = []
    return Fake


class ScriptedProvider:
    """Returns queued responses and records what it was sent."""

    name = "fake"
    model = "fake-model"

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    async def chat(self, messages, tools):
        self.calls.append({"messages": json.loads(json.dumps(messages)), "tools": tools})
        item = self.responses.pop(0) if self.responses else LLMResponse("done")
        if isinstance(item, Exception):
            raise item
        return item


def call(name, arguments, call_id="c1"):
    raw = arguments if isinstance(arguments, str) else json.dumps(arguments)
    return ToolCall(call_id, name, arguments if isinstance(arguments, dict) else None, raw)


def run(provider, location=DELHI, message="Find hospitals near me", max_iterations=3):
    return asyncio.run(run_agent(message, AgentContext(location=location), provider, max_iterations))


# Runner: success, empty, truncated

def test_hospital_workflow_via_llm(overpass):
    provider = ScriptedProvider(
        LLMResponse("", [call("discover_features", {"category": "hospitals", "radius_km": 5})]),
        LLMResponse("There are 3 hospitals within 5 km; the nearest is City Hospital."),
    )
    result = run(provider)

    assert result.error is None
    assert [s.status for s in result.steps] == ["completed"]
    assert result.steps[0].summary == "3 hospitals within 5 km"
    assert result.layers[0]["kind"] == "discovery" and result.layers[0]["feature_count"] == 3
    tool_payload = json.loads(provider.calls[1]["messages"][-1]["content"])
    nearest = tool_payload["result"]["nearest"]
    assert nearest[0]["name"] == "Unnamed hospital" and nearest[1]["name"] == "City Hospital"
    assert tool_payload["result"]["unnamed_count"] == 1
    assert "(around:5000,28.6315,77.2167)" in overpass.queries[0]


@pytest.mark.parametrize("category", ["schools", "restaurants", "parks"])
def test_other_categories_use_same_tool(overpass, category):
    overpass.elements = []
    provider = ScriptedProvider(
        LLMResponse("", [call("discover_features", {"category": category, "radius_km": 2})]),
        LLMResponse("None found."),
    )
    result = run(provider)
    assert result.steps[0].status == "completed"
    assert result.steps[0].result["total_found"] == 0


def test_empty_results_are_reported_not_invented(overpass):
    overpass.elements = []
    provider = ScriptedProvider(
        LLMResponse("", [call("discover_features", {"category": "hospital", "radius_km": 5})]),
        LLMResponse("No hospitals were found."),
    )
    result = run(provider)
    payload = json.loads(provider.calls[1]["messages"][-1]["content"])
    assert payload["result"]["returned"] == 0 and payload["result"]["nearest"] == []
    assert result.layers == []


def test_truncated_results_flagged(overpass, monkeypatch):
    monkeypatch.setattr(od, "MAX_ELEMENTS", 3)
    provider = ScriptedProvider(
        LLMResponse("", [call("discover_features", {"category": "hospital", "radius_km": 5})]),
        LLMResponse("ok"),
    )
    result = run(provider)
    assert result.steps[0].result["truncated"] is True
    assert "(truncated)" in result.steps[0].summary


# Runner: failure handling

def test_missing_location_fails_tool_and_prompt_says_so(overpass):
    provider = ScriptedProvider(
        LLMResponse("", [call("discover_features", {"category": "hospital", "radius_km": 5})]),
        LLMResponse("Please select a location on the map."),
    )
    result = run(provider, location=None)

    assert result.steps[0].status == "failed"
    assert "No map location is selected" in result.steps[0].error
    assert "NOT selected a map location" in provider.calls[0]["messages"][0]["content"]
    assert overpass.queries == []


@pytest.mark.parametrize("arguments,expected", [
    ({"category": "hospital", "radius_km": 500}, "radius_km"),
    ({"category": "hospital"}, "radius_km: Field required"),
    ({"category": "hospital", "radius_km": 5, "lat": 1}, "Extra inputs"),
    ("{not json", "not a valid JSON object"),
])
def test_invalid_tool_arguments(overpass, arguments, expected):
    provider = ScriptedProvider(LLMResponse("", [call("discover_features", arguments)]), LLMResponse("x"))
    result = run(provider)
    assert result.steps[0].status == "failed"
    assert expected in result.steps[0].error
    assert overpass.queries == []
    echoed = provider.calls[1]["messages"][2]["tool_calls"][0]["function"]["arguments"]
    json.loads(echoed)  # history always carries valid JSON arguments


def test_unknown_tool(overpass):
    provider = ScriptedProvider(LLMResponse("", [call("run_python", {"code": "1"})]), LLMResponse("x"))
    result = run(provider)
    assert result.steps[0].status == "failed"
    assert "Unknown tool 'run_python'" in result.steps[0].error


def test_tool_execution_failure_is_not_reported_as_success(overpass):
    overpass.error = od.OverpassError("The Overpass API is busy. Please retry in a moment.", 503)
    provider = ScriptedProvider(
        LLMResponse("", [call("discover_features", {"category": "hospital", "radius_km": 5})]),
        LLMResponse("Discovery failed because OpenStreetMap is busy."),
    )
    result = run(provider)
    assert result.steps[0].status == "failed"
    payload = json.loads(provider.calls[1]["messages"][-1]["content"])
    assert payload == {"ok": False, "error": "The Overpass API is busy. Please retry in a moment."}


def test_iteration_limit_stops_loop(overpass):
    looping = [LLMResponse("", [call("create_buffer", {"distance_metres": 100}, f"c{i}")]) for i in range(10)]
    provider = ScriptedProvider(*looping)
    result = run(provider, max_iterations=2)

    assert result.hit_iteration_limit
    assert len(provider.calls) == 3  # 2 tool rounds + 1 final answer call
    assert provider.calls[-1]["tools"] is None
    assert provider.calls[-1]["messages"][-1]["role"] == "user"
    assert all(m["role"] != "system" for m in provider.calls[-1]["messages"][1:])
    assert len(result.steps) == 2


def test_provider_timeout_keeps_partial_steps(overpass):
    provider = ScriptedProvider(
        LLMResponse("", [call("discover_features", {"category": "hospital", "radius_km": 5})]),
        LLMTimeoutError("The remote LLM model did not respond in time."),
    )
    result = run(provider)
    assert result.error_code == "llm_timeout"
    assert result.steps[0].status == "completed"
    assert "did not respond in time" in result.answer


def test_buffer_then_spatial_query_chain(overpass):
    provider = ScriptedProvider(
        LLMResponse("", [
            call("discover_features", {"category": "hospital", "radius_km": 5}, "a"),
            call("create_buffer", {"distance_metres": 1000}, "b"),
        ]),
        LLMResponse("", [call("spatial_query", {"operation": "within"}, "c")]),
        LLMResponse("2 hospitals are within 1 km."),
    )
    result = run(provider)
    assert [s.status for s in result.steps] == ["completed"] * 3
    assert result.steps[2].result["matched_count"] == 2


# Fast path parsing

@pytest.mark.parametrize("message,expected", [
    ("Find hospitals within 5 km of my selected map location.", ("hospital", 5.0)),
    ("show schools within 800 m", ("school", 0.8)),
    ("Find restaurants within 2km", ("restaurant", 2.0)),
    ("list parks in 1.5 kilometres", ("park", 1.5)),
    ("find unicorns within 5 km", None),
    ("which hospital is best for children?", None),
])
def test_parse_discovery_request(message, expected):
    assert parse_discovery_request(message) == expected


# API

client = TestClient(app)


@pytest.fixture
def no_llm(monkeypatch):
    def explode(settings):
        raise AssertionError("LLM must not be called")

    monkeypatch.setattr(agent_router, "create_provider", explode)


def test_api_fast_path_hospitals_without_llm(overpass, no_llm):
    response = client.post("/api/agent/chat", json={
        "message": "Find hospitals within 5 km of my selected map location.",
        "coordinates": list(DELHI),
    }).json()

    assert response["mode"] == "deterministic"
    assert response["success"] is True
    assert response["message"].startswith("Found 3 hospitals within 5 km")
    assert "Unnamed hospital" in response["message"]
    assert response["layers"][0]["geojson"]["type"] == "FeatureCollection"


def test_api_fast_path_requires_location(overpass, no_llm):
    response = client.post("/api/agent/chat", json={"message": "Find hospitals within 5 km"}).json()
    assert response["needs_input"] == ["coordinates"]
    assert overpass.queries == []


def test_api_fast_path_empty_result(overpass, no_llm):
    overpass.elements = []
    response = client.post("/api/agent/chat", json={
        "message": "find parks within 1 km", "coordinates": list(DELHI),
    }).json()
    assert response["message"].startswith("No parks and gardens") or response["message"].startswith("No parks")
    assert response["layers"] == []


def test_api_without_llm_explains(monkeypatch):
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    response = client.post("/api/agent/chat", json={"message": "what is near the river?"}).json()
    assert response["error_code"] == "llm_not_configured"


def test_api_misconfigured_llm(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "remote")
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    response = client.post("/api/agent/chat", json={"message": "what is near the river?"}).json()
    assert response["success"] is False
    assert "LLM_API_KEY" in response["message"]


def test_api_llm_path_and_stream(overpass, monkeypatch):
    def provider_factory(settings):
        return ScriptedProvider(
            LLMResponse("", [call("discover_features", {"category": "hospital", "radius_km": 5})]),
            LLMResponse("3 hospitals found."),
        )

    monkeypatch.setattr(agent_router, "create_provider", provider_factory)
    body = {"message": "Which hospitals are around here?", "coordinates": list(DELHI)}

    response = client.post("/api/agent/chat", json=body).json()
    assert response["mode"] == "llm" and response["message"] == "3 hospitals found."
    assert response["steps"][0]["status"] == "completed"

    with client.stream("POST", "/api/agent/chat/stream", json=body) as stream:
        events = [json.loads(line) for line in stream.iter_lines() if line]
    assert [e["type"] for e in events] == ["thinking", "tool_started", "tool_finished", "thinking", "result"]
    assert events[-1]["response"]["message"] == "3 hospitals found."


def test_api_route_calls_routing_directly(monkeypatch, no_llm):
    seen = {}

    def fake_route(request):
        seen["start"] = request.start
        return {"geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
                "distance_meters": 1000, "distance_km": 1.0, "estimated_duration_minutes": 2, "route_type": "driving"}

    monkeypatch.setattr(agent_router.routing, "calculate_route", fake_route)
    response = client.post("/api/agent/chat", json={
        "message": "route please", "start": [77.2, 28.6], "destination": [77.3, 28.7],
    }).json()
    assert response["intent"] == "route" and seen["start"] == [77.2, 28.6]


def test_api_rejects_oversized_message_and_bad_coordinates():
    assert client.post("/api/agent/chat", json={"message": "x" * 2001}).status_code == 422
    assert client.post("/api/agent/chat", json={"message": "hi", "coordinates": [200, 0]}).status_code == 422
    assert client.post("/api/agent/chat/stream", json={"message": "hi", "coordinates": [200, 0]}).status_code == 422


def test_status_endpoint(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "none")
    assert client.get("/api/agent/status").json()["configured"] is False
