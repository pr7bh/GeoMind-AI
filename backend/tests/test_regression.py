"""Cross-milestone regression suite (M4–M8).

One deterministic, category-aware fake Overpass serves every workflow, so
these tests check that the features keep working together through the
public API: routing between workflows, consistent success / partial /
failure states, streaming and cancellation, layer validity and limits.
Milestone-specific details stay in the per-milestone test modules.
"""

import asyncio
import json
import re

import pytest
from fastapi.testclient import TestClient
from pyproj import Geod
from shapely.geometry import shape

from app.config import get_settings
from app.main import MAX_BODY_BYTES, app
from app.routers import agent as agent_router
from app.schemas.analysis import MAX_FEATURES
from app.services import coverage, mcda, osm_discovery as od, suitability
from app.services.llm.base import LLMResponse, LLMTimeoutError, ToolCall
from app.services.workflows import steps

DELHI = (77.2167, 28.6315)
AGRA = (78.0081, 27.1767)
GEOD = Geod(ellps="WGS84")

client = TestClient(app)

# Offsets (degrees) from each query centre.
HOSPITALS = [(0.01, 0.0), (-0.02, 0.01), (0.0, -0.03)]
PHARMACIES = [(0.012, 0.001), (0.009, -0.001), (-0.021, 0.011)]
OTHERS = [(0.004, 0.006), (-0.015, -0.012)]


def _centre(query: str) -> tuple[float, float]:
    lat, lon = (float(v) for v in query.split("(around:")[1].split(")")[0].split(",")[1:3])
    return lon, lat


def _kind(query: str) -> str:
    if 'nwr["healthcare"]' in query:
        return "healthcare"
    match = re.search(r'"amenity"="(\w+)"', query) or re.search(r'\["\w+"="(\w+)"\]', query)
    return match[1] if match else "other"


def _nodes(lon, lat, offsets, amenity, start):
    return [
        {"type": "node", "id": start + i, "lon": lon + dx, "lat": lat + dy,
         "tags": {"amenity": amenity, "name": f"{amenity} {start + i}"}}
        for i, (dx, dy) in enumerate(offsets)
    ]


@pytest.fixture
def overpass(monkeypatch):
    """Category-aware fake. Set .fail (kinds), .fail_area ("a"/"b"), .many (kinds), .delay."""

    class Fake:
        fail: set[str] = set()
        fail_area: str | None = None
        many: set[str] = set()
        delay = 0.0
        calls: list[str] = []

    async def fake_fetch(query, client=None):
        Fake.calls.append(query)
        if Fake.delay:
            await asyncio.sleep(Fake.delay)
        lon, lat = _centre(query)
        kind = _kind(query)
        area = "a" if lon < 77.6 else "b"
        if kind in Fake.fail or area == Fake.fail_area:
            raise od.OverpassError("The Overpass API is busy. Please retry in a moment.", 503)

        if kind in Fake.many:
            grid = [(dx * 0.002, dy * 0.002) for dx in range(-12, 13) for dy in range(-12, 13)]
            elements = _nodes(lon, lat, grid, kind, 10_000)
        elif kind == "hospital":
            elements = _nodes(lon, lat, HOSPITALS, "hospital", 100)
        elif kind == "pharmacy":
            # Pharmacies sit around the real query centre, near hospital 100.
            base_lon, base_lat = DELHI if area == "a" else AGRA
            elements = _nodes(base_lon, base_lat, PHARMACIES, "pharmacy", 300)
        elif kind == "healthcare":
            elements = (
                _nodes(lon, lat, HOSPITALS, "hospital", 100)
                + _nodes(lon, lat, PHARMACIES, "pharmacy", 300)
                + _nodes(lon, lat, OTHERS, "clinic", 400)
            )
        else:
            elements = _nodes(lon, lat, OTHERS, kind, 500)
        # Overpass may repeat elements across union statements.
        return {"elements": elements + elements[:1], "osm3s": {"timestamp_osm_base": "2026-10-30T00:00:00Z"}}

    monkeypatch.setattr(od, "_fetch_overpass", fake_fetch)
    Fake.calls = []
    return Fake


@pytest.fixture
def no_llm(monkeypatch):
    def explode(settings):
        raise AssertionError("LLM must not be called")

    monkeypatch.setattr(agent_router, "create_provider", explode)


class ScriptedProvider:
    name = "fake"
    model = "fake-model"

    def __init__(self, *responses):
        self.responses = list(responses)

    async def chat(self, messages, tools):
        item = self.responses.pop(0) if self.responses else LLMResponse("done")
        if isinstance(item, Exception):
            raise item
        return item


def tool_call(name, arguments, call_id):
    return ToolCall(call_id, name, arguments, json.dumps(arguments))


def assert_valid_layers(layers):
    for layer in layers:
        collection = layer["geojson"]
        assert collection["type"] == "FeatureCollection"
        assert layer["feature_count"] == len(collection["features"]) > 0
        for feature in collection["features"]:
            geometry = shape(feature["geometry"])
            assert geometry.is_valid and not geometry.is_empty
            minx, miny, maxx, maxy = geometry.bounds
            assert -180 <= minx <= maxx <= 180 and -90 <= miny <= maxy <= 90


M5_QUESTION = "Find hospitals within 5 km and identify which hospitals have the most pharmacies within 1 km"
COVERAGE_QUESTION = "Identify areas within 5 km that are underserved by hospitals"
COMPARE_QUESTION = "Compare hospital coverage in these two areas"
SUITABILITY_QUESTION = "Find suitable locations for a new hospital"


def ask(message, **body):
    return client.post("/api/agent/chat", json={"message": message, "coordinates": list(DELHI), **body})


# Routing: every milestone through one app, no LLM

@pytest.mark.parametrize("message,extra,intent,workflow_type,requests", [
    ("Find hospitals within 5 km", {}, "discover_features", None, 1),
    (M5_QUESTION, {}, "workflow", "nearby_count", 2),
    (COVERAGE_QUESTION, {}, "coverage", "coverage", 1),
    (COMPARE_QUESTION, {"compare_coordinates": list(AGRA)}, "comparison", "comparison", 2),
    (SUITABILITY_QUESTION, {}, "suitability", "suitability", 2),
    ("Where should I establish a new school?", {}, "suitability", "suitability", 2),
    ("Rank the best locations for a pharmacy", {}, "suitability", "suitability", 2),
    ("Find areas with low healthcare facility density", {}, "suitability", "suitability", 2),
])
def test_each_milestone_routes_without_llm(overpass, no_llm, message, extra, intent, workflow_type, requests):
    response = ask(message, **extra)
    assert response.status_code == 200
    data = response.json()

    assert data["intent"] == intent and data["success"] is True
    assert data["error_code"] is None
    assert len(overpass.calls) == requests  # as few Overpass requests as designed
    if workflow_type:
        assert data["mode"] == "workflow" and data["workflow"]["type"] == workflow_type
        assert data["workflow"]["outcome"] == "completed"
    assert_valid_layers(data["layers"])


def test_full_session_runs_every_workflow_in_sequence(overpass, no_llm):
    """The same app answers all milestone questions one after another."""
    types = []
    for message, extra in (
        ("Find hospitals within 5 km", {}),
        (M5_QUESTION, {}),
        (COVERAGE_QUESTION, {}),
        (COMPARE_QUESTION, {"compare_coordinates": list(AGRA)}),
        (SUITABILITY_QUESTION, {}),
        ("Find hospitals within 5 km", {}),
    ):
        data = ask(message, **extra).json()
        assert data["success"] is True
        types.append((data["workflow"] or {}).get("type", data["intent"]))
    assert types == ["discover_features", "nearby_count", "coverage", "comparison", "suitability", "discover_features"]
    assert len(overpass.calls) == 1 + 2 + 1 + 2 + 2 + 1


@pytest.mark.parametrize("message,extra", [
    (M5_QUESTION, {}),
    (COVERAGE_QUESTION, {}),
    (SUITABILITY_QUESTION, {}),
    ("Find hospitals within 5 km", {}),
])
def test_location_is_required_everywhere(overpass, no_llm, message, extra):
    data = client.post("/api/agent/chat", json={"message": message, **extra}).json()
    assert "coordinates" in data["needs_input"] and overpass.calls == []


@pytest.mark.parametrize("message", [
    "Identify areas within 20 km that are underserved by hospitals",
    "Compare hospital coverage within 20 km in both areas",
    "Best sites for a new hospital within 20 km",
])
def test_radius_limit_enforced_everywhere(overpass, no_llm, message):
    data = ask(message, compare_coordinates=list(AGRA)).json()
    assert data["success"] is False and "10 km" in data["message"] and overpass.calls == []


def test_invalid_coordinates_rejected_on_every_path(overpass):
    for message in ("Find hospitals within 5 km", M5_QUESTION, COVERAGE_QUESTION, SUITABILITY_QUESTION):
        for path in ("/api/agent/chat", "/api/agent/chat/stream"):
            assert client.post(path, json={"message": message, "coordinates": [181, 0]}).status_code == 422
            assert client.post(path, json={"message": message, "coordinates": [0, 91]}).status_code == 422
    assert client.post("/api/agent/chat", json={
        "message": COMPARE_QUESTION, "coordinates": list(DELHI), "compare_coordinates": [0, -91],
    }).status_code == 422
    assert overpass.calls == []


# M4: deterministic GIS, LLM tool path, provider failures

def test_m4_nearest_features_distances_are_geodesic(no_llm):
    features = [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [DELHI[0] + dx, DELHI[1] + dy]},
         "properties": {"name": f"p{i}"}}
        for i, (dx, dy) in enumerate([(0.05, 0), (0.001, 0.001), (-0.02, 0.01)])
    ]
    data = ask("Which hospital is nearest?", features=features, limit=2).json()
    results = data["parameters"]["result"]["results"]
    assert data["intent"] == "nearest_features" and len(results) == 2
    for item in results:
        lon, lat = item["feature"]["geometry"]["coordinates"]
        _, _, expected = GEOD.inv(DELHI[0], DELHI[1], lon, lat)
        assert item["distance_metres"] == pytest.approx(expected, rel=1e-3)
    assert results[0]["distance_metres"] < results[1]["distance_metres"]


def test_m4_llm_discovery_buffer_and_spatial_query(overpass, monkeypatch):
    monkeypatch.setattr(agent_router, "create_provider", lambda settings: ScriptedProvider(
        LLMResponse("", [
            tool_call("discover_features", {"category": "hospital", "radius_km": 5}, "a"),
            tool_call("create_buffer", {"distance_metres": 1500}, "b"),
        ]),
        LLMResponse("", [tool_call("spatial_query", {"operation": "within"}, "c")]),
        LLMResponse("1 hospital lies within 1.5 km."),
    ))
    # Wording the deterministic rules cannot answer, so the LLM tool chain runs.
    data = ask("Are any hospitals inside a 1.5 km buffer around here?").json()
    assert data["mode"] == "llm" and data["success"] is True
    assert [s["tool"] for s in data["steps"]] == ["discover_features", "create_buffer", "spatial_query"]
    assert all(s["status"] == "completed" for s in data["steps"])
    assert_valid_layers(data["layers"])


def test_m4_provider_timeout_is_a_failure_not_an_answer(overpass, monkeypatch):
    monkeypatch.setattr(
        agent_router, "create_provider",
        lambda settings: ScriptedProvider(LLMTimeoutError("The model took too long to respond.")),
    )
    data = ask("Tell me about healthcare around here").json()
    assert data["success"] is False and data["mode"] == "llm" and data["error_code"]


def test_m4_malformed_tool_arguments_fail_the_step(overpass, monkeypatch):
    bad = ToolCall("x", "discover_features", None, "{not json")
    monkeypatch.setattr(agent_router, "create_provider", lambda settings: ScriptedProvider(
        LLMResponse("", [bad]), LLMResponse("I could not run that search."),
    ))
    data = ask("Tell me about healthcare around here").json()
    assert data["steps"][0]["status"] == "failed" and overpass.calls == []


def test_m4_discovery_failure_is_reported(overpass, no_llm):
    overpass.fail = {"hospital"}
    data = ask("Find hospitals within 5 km").json()
    assert data["success"] is False and data["layers"] == []
    assert data["steps"][0]["status"] == "failed"


# M5–M8: failure and partial states are consistent and never zero

def outcome(data):
    workflow = data["workflow"]
    assert data["success"] is (workflow["outcome"] != "failed")
    return workflow["outcome"], workflow["analysis"]


def test_m5_pharmacy_search_failure_is_not_zero(overpass, no_llm):
    overpass.fail = {"pharmacy"}
    state, analysis = outcome(ask(M5_QUESTION).json())
    assert state in ("partial", "failed")
    # A failed search must not be presented as "0 pharmacies".
    assert not any(entry["nearby_count"] == 0 for entry in analysis.get("ranking", []))


def test_m5_distances_dedup_and_ranking(overpass, no_llm):
    state, analysis = outcome(ask(M5_QUESTION).json())
    assert state == "completed"
    top = analysis["ranking"][0]
    ids = [item["id"] for item in top["nearby"]]
    assert len(ids) == len(set(ids))  # duplicate elements counted once
    for item in top["nearby"]:
        assert item["distance_m"] <= 1000
    ranks = [entry["rank"] for entry in analysis["ranking"]]
    assert ranks == sorted(ranks)


def test_m5_truncated_sources_reported(overpass, no_llm):
    overpass.many = {"hospital"}
    _, analysis = outcome(ask(M5_QUESTION).json())
    assert analysis["sources"]["truncated"] is True
    assert analysis["sources"]["returned"] == steps.MAX_SOURCES


def test_m6_failed_discovery_produces_no_coverage(overpass, no_llm):
    overpass.fail = {"hospital"}
    data = ask(COVERAGE_QUESTION).json()
    state, analysis = outcome(data)
    assert state == "failed" and "coverage" not in analysis and data["layers"] == []


def test_m6_truncation_marks_partial(overpass, no_llm):
    overpass.many = {"hospital"}
    data = ask(COVERAGE_QUESTION).json()
    state, analysis = outcome(data)
    assert state == "partial" and analysis["coverage"]["discovery_truncated"] is True
    assert sum(analysis["coverage"]["percentages"].values()) == pytest.approx(100, abs=0.5)


def test_m7_one_area_failing_keeps_the_other(overpass, no_llm):
    overpass.fail_area = "b"
    data = ask(COMPARE_QUESTION, compare_coordinates=list(AGRA)).json()
    state, analysis = outcome(data)
    assert state == "partial" and analysis["overall_winner"] is None
    assert analysis["areas"]["b"]["metrics"] is None and analysis["areas"]["b"]["error"]
    assert {layer["area"] for layer in data["layers"]} == {"a"}
    assert all(row["b"] is None and row["better"] is None for row in analysis["metrics"])


def test_m7_identical_configuration_and_no_winner(overpass, no_llm):
    _, analysis = outcome(ask(COMPARE_QUESTION, compare_coordinates=list(AGRA)).json())
    a, b = analysis["areas"]["a"]["metrics"], analysis["areas"]["b"]["metrics"]
    assert (a["radius_km"], a["cell_size_m"]) == (b["radius_km"], b["cell_size_m"])
    assert analysis["overall_winner"] is None


def test_m8_context_failure_is_partial_with_redistributed_weights(overpass, no_llm):
    overpass.fail = {"healthcare"}
    data = ask(SUITABILITY_QUESTION).json()
    state, analysis = outcome(data)
    result = analysis["suitability"]
    assert state == "partial" and result["weights"] == {"distance_existing": 0.5, "service_gap": 0.5}
    density = next(c for c in result["criteria"] if c["id"] == "facility_density")
    assert density["status"] == "unavailable" and density["weight"] == 0
    assert result["scored_count"] == result["candidate_count"]


def test_m8_existing_failure_fails_cleanly(overpass, no_llm):
    overpass.fail = {"hospital"}
    data = ask(SUITABILITY_QUESTION).json()
    state, analysis = outcome(data)
    assert state == "failed" and "suitability" not in analysis and data["layers"] == []


def test_m8_unavailable_data_is_explained_not_estimated(overpass, no_llm):
    data = ask(
        "Find suitable locations for a new hospital considering population, zoning, "
        "land ownership, traffic and travel time"
    ).json()
    caveats = " ".join(data["workflow"]["analysis"]["caveats"])
    for phrase in ("population", "zoning", "land availability", "traffic", "travel time"):
        assert phrase in caveats
    assert "not estimated" in caveats
    assert "not available land parcels" in caveats


# Streaming and cancellation

@pytest.mark.parametrize("message,extra", [
    (M5_QUESTION, {}),
    (COVERAGE_QUESTION, {}),
    (COMPARE_QUESTION, {"compare_coordinates": list(AGRA)}),
    (SUITABILITY_QUESTION, {}),
])
def test_stream_events_are_well_formed(overpass, no_llm, message, extra):
    body = {"message": message, "coordinates": list(DELHI), **extra}
    with client.stream("POST", "/api/agent/chat/stream", json=body) as stream:
        events = [json.loads(line) for line in stream.iter_lines() if line]

    kinds = [e["type"] for e in events]
    assert kinds[0] == "plan_created" and kinds[-1] == "result" and kinds[-2] == "workflow_completed"
    planned = {step["id"] for step in events[0]["plan"]}
    started = [e["step_id"] for e in events if e["type"] == "step_started"]
    finished = [e["step_id"] for e in events if e["type"] in ("step_completed", "step_failed", "step_skipped")]
    assert set(started) <= planned and set(finished) == planned
    assert events[-1]["response"]["workflow"]["outcome"] == "completed"


def test_stream_disconnect_cancels_running_search(monkeypatch):
    state = {"started": False, "cancelled": False}

    async def slow_fetch(query, client=None):
        state["started"] = True
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise
        return {"elements": []}

    monkeypatch.setattr(od, "_fetch_overpass", slow_fetch)

    class DisconnectingRequest:
        async def is_disconnected(self):
            return state["started"]

    async def main():
        request = agent_router.AgentRequest(message=COVERAGE_QUESTION, coordinates=list(DELHI))
        response = await agent_router.chat_with_agent_stream(request, DisconnectingRequest())
        events = [json.loads(chunk) async for chunk in response.body_iterator]
        for _ in range(20):  # let the cancelled task unwind
            if state["cancelled"]:
                break
            await asyncio.sleep(0.01)
        return events

    events = asyncio.run(main())
    assert state["cancelled"] is True
    assert "result" not in [e["type"] for e in events]


# Limits are unchanged

def test_global_and_analysis_limits_unchanged():
    assert MAX_BODY_BYTES == 25 * 1024 * 1024
    assert MAX_FEATURES == 50_000
    assert coverage.MAX_STUDY_RADIUS_KM == 10 and coverage.MAX_CELLS == 500
    assert steps.MAX_SERVICES == 500 and steps.MAX_SOURCES == 30
    assert suitability.MAX_CANDIDATES == 100 and mcda.MAX_CRITERIA == 10
    assert get_settings().agent_timeout_seconds <= 300
