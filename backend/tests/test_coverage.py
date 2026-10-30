import asyncio
import json
import math

import pytest
from fastapi.testclient import TestClient
from pyproj import Geod
from shapely.geometry import Point, shape

from app.main import app
from app.routers import agent as agent_router
from app.services import coverage, osm_discovery as od
from app.services.agent.runner import run_agent
from app.services.agent.tools import AgentContext
from app.services.llm.base import LLMResponse, ToolCall
from app.services.workflows.catalog import (
    CoverageRequest,
    build_coverage_plan,
    match_coverage,
    run_coverage_workflow,
    serialize_coverage,
)
from app.services.workflows.plan import PlanError, validate_plan
from app.services.workflows.steps import WORKFLOW_TOOLS

geod = Geod(ellps="WGS84")
CENTRE = (77.2167, 28.6315)


def service(osm_id, lon, lat, name=None):
    props = {"display_name": name or f"Hospital {osm_id}", "name": name}
    return {"type": "Feature", "id": f"node/{osm_id}", "properties": props,
            "geometry": {"type": "Point", "coordinates": [lon, lat]}}


def geodesic_m(a, b):
    return geod.inv(a[0], a[1], b[0], b[1])[2]


# Study area, CRS and grid

def test_study_area_and_projection():
    area = coverage.study_area(5000)
    assert area.area == pytest.approx(math.pi * 5000**2, rel=0.002)

    projection = coverage.LocalProjection.centred_on(*CENTRE)
    east = (CENTRE[0] + 0.05, CENTRE[1])
    projected = projection.project(Point(east))
    assert math.hypot(projected.x, projected.y) == pytest.approx(geodesic_m(CENTRE, east), rel=1e-6)
    back = projection.unproject(projected)
    assert (back.x, back.y) == pytest.approx(east, abs=1e-9)


def test_grid_is_clipped_with_stable_ids():
    grid = coverage.build_grid(2000, 500)
    area = coverage.study_area(2000)

    assert all(area.buffer(1e-6).contains(cell) for _, cell in grid)
    assert sum(cell.area for _, cell in grid) == pytest.approx(area.area, rel=1e-6)
    assert any(cell.area < 500 * 500 - 1 for _, cell in grid)  # edge cells clipped
    assert [cid for cid, _ in grid] == [cid for cid, _ in coverage.build_grid(2000, 500)]
    assert grid[0][0] == "r0c1" and len({cid for cid, _ in grid}) == len(grid)


def test_cell_limit_adjusts_cell_size():
    size, adjusted = coverage.choose_cell_size(10_000, 250)
    assert adjusted and size > 250
    assert len(coverage.build_grid(10_000, size)) <= coverage.MAX_CELLS
    # A request that already fits is kept as-is.
    assert coverage.choose_cell_size(2000, 500) == (500, False)


@pytest.mark.parametrize("size", [100, 6000])
def test_cell_size_out_of_bounds_rejected(size):
    with pytest.raises(coverage.CoverageError, match="Cell size"):
        coverage.choose_cell_size(5000, size)


@pytest.mark.parametrize("radius", [0, -1, 10.01, 25])
def test_invalid_radius_rejected(radius):
    with pytest.raises(coverage.CoverageError, match="radius"):
        coverage.analyse(CENTRE, radius, [])


# Classification and nearest service

@pytest.mark.parametrize("distance,expected", [
    (0, "well_covered"), (2000, "well_covered"), (2000.1, "moderate"),
    (5000, "moderate"), (5000.1, "underserved"), (None, "no_service_found"),
])
def test_threshold_boundaries(distance, expected):
    assert coverage.classify(distance, 2000, 5000) == expected


def test_zero_services_gives_null_statistics():
    result = coverage.analyse(CENTRE, 2, [])
    summary = result["summary"]

    assert summary["counts"]["no_service_found"] == summary["total_cells"]
    assert summary["percentages"]["no_service_found"] == 100.0
    assert summary["average_distance_m"] is None and summary["max_distance_m"] is None
    assert all(c["properties"]["nearest_distance_m"] is None for c in result["cells"])


def test_one_service_distances_match_geodesic():
    result = coverage.analyse(CENTRE, 3, [service(1, *CENTRE)], cell_size_m=500)

    for cell in result["cells"]:
        centroid = shape(cell["geometry"]).centroid
        expected = geodesic_m(CENTRE, (centroid.x, centroid.y))
        assert cell["properties"]["nearest_distance_m"] == pytest.approx(expected, rel=0.01, abs=5)
        assert cell["properties"]["nearest_service_id"] == "node/1"


def test_multiple_services_nearest_matches_brute_force():
    services = [
        service(1, CENTRE[0] - 0.03, CENTRE[1]),
        service(2, CENTRE[0] + 0.03, CENTRE[1] + 0.01),
        service(3, CENTRE[0], CENTRE[1] - 0.04),
    ]
    result = coverage.analyse(CENTRE, 5, services, cell_size_m=1000)

    for cell in result["cells"]:
        centroid = shape(cell["geometry"]).centroid
        distances = {s["id"]: geodesic_m((centroid.x, centroid.y), s["geometry"]["coordinates"]) for s in services}
        best = min(distances, key=distances.get)
        assert cell["properties"]["nearest_service_id"] == best
        assert cell["properties"]["nearest_distance_m"] == pytest.approx(distances[best], rel=0.01, abs=5)


def test_percentages_and_statistics_consistent():
    result = coverage.analyse(CENTRE, 8, [service(1, *CENTRE)])
    summary = result["summary"]
    counts, pct = summary["counts"], summary["percentages"]

    assert sum(counts.values()) == summary["total_cells"] <= coverage.MAX_CELLS
    for name, count in counts.items():
        assert pct[name] == round(100 * count / summary["total_cells"], 1)
    distances = [c["properties"]["nearest_distance_m"] for c in result["cells"]]
    assert summary["max_distance_m"] == pytest.approx(max(distances), abs=0.1)
    assert summary["average_distance_m"] == pytest.approx(sum(distances) / len(distances), abs=0.1)
    assert counts["underserved"] > 0 and counts["well_covered"] > 0


def test_dedup_and_invalid_geometries():
    bowtie = {"type": "Polygon", "coordinates": [[[77.2, 28.6], [77.21, 28.61], [77.21, 28.6], [77.2, 28.61], [77.2, 28.6]]]}
    services = [
        service(1, *CENTRE),
        service(1, *CENTRE),                                            # duplicate identity
        {"type": "Feature", "id": "way/2", "properties": {}, "geometry": bowtie},
        {"type": "Feature", "id": "node/3", "properties": {}, "geometry": None},
        {"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [77.2, 28.6]}},
    ]
    summary = coverage.analyse(CENTRE, 1, services)["summary"]
    assert summary["services_count"] == 1
    assert summary["invalid_services"] == 3


def test_output_is_wgs84_geojson():
    cells = coverage.analyse(CENTRE, 1, [])["cells"]
    for cell in cells:
        geometry = shape(cell["geometry"])
        assert geometry.is_valid
        lon, lat = geometry.centroid.x, geometry.centroid.y
        assert abs(lon - CENTRE[0]) < 0.02 and abs(lat - CENTRE[1]) < 0.02
    json.dumps(cells)


# Matching and plans

@pytest.mark.parametrize("message,category,radius", [
    ("Identify areas within 10 km of my selected location that are underserved by hospitals.", "hospital", 10),
    ("Find underserved areas for hospitals.", "hospital", 5),
    ("Show me school coverage gaps within 5 km", "school", 5),
    ("Which parts of this area are far from police stations?", "police", 5),
    ("Analyse pharmacy coverage around this location", "pharmacy", 5),
    ("Where are the gaps in park access within 3000 m?", "park", 3),
])
def test_match_coverage(message, category, radius):
    assert match_coverage(message) == CoverageRequest(category, radius)


@pytest.mark.parametrize("message", [
    "Find hospitals within 5 km", "Find nearest police station", "Find nearby parks",
    "Show road coverage within 2 km",
    "Find hospitals within 5 km and identify which hospitals have the most pharmacies within 1 km.",
])
def test_non_coverage_requests_not_matched(message):
    assert match_coverage(message) is None


def test_coverage_plan_validates_and_searches_past_the_edge():
    states = validate_plan(build_coverage_plan(CoverageRequest("hospital", 8)), WORKFLOW_TOOLS)
    assert [s.step.tool for s in states] == ["discover_services", "analyse_coverage", "report_coverage"]
    assert states[0].args.radius_km == 13


def test_plan_limits_cannot_be_raised():
    plan = build_coverage_plan(CoverageRequest("hospital", 5))
    plan[0]["arguments"]["limit"] = 501
    with pytest.raises(PlanError, match="limit"):
        validate_plan(plan, WORKFLOW_TOOLS)
    plan = build_coverage_plan(CoverageRequest("hospital", 5))
    plan[1]["arguments"]["radius_km"] = 11
    with pytest.raises(PlanError, match="radius_km"):
        validate_plan(plan, WORKFLOW_TOOLS)


# Workflow with mocked Overpass

def node(osm_id, lon, lat):
    return {"type": "node", "id": osm_id, "lon": lon, "lat": lat, "tags": {"amenity": "hospital", "name": f"H{osm_id}"}}


@pytest.fixture
def overpass(monkeypatch):
    class Fake:
        elements = [node(1, CENTRE[0] + 0.01, CENTRE[1]), node(2, CENTRE[0] - 0.04, CENTRE[1] + 0.02)]
        error = None
        delay = 0.0
        calls: list[str] = []

    async def fake_fetch(query, client=None):
        Fake.calls.append(query)
        if Fake.delay:
            await asyncio.sleep(Fake.delay)
        if Fake.error:
            raise Fake.error
        return {"elements": Fake.elements + Fake.elements[:1], "osm3s": {"timestamp_osm_base": "2026-10-30T00:00:00Z"}}

    monkeypatch.setattr(od, "_fetch_overpass", fake_fetch)
    Fake.calls = []
    return Fake


def run(request=CoverageRequest("hospital", 5), timeout=30.0):
    events = []

    async def emit(event):
        events.append(event)

    return asyncio.run(run_coverage_workflow(request, CENTRE, timeout, emit)), events


def test_workflow_completes_with_single_overpass_request(overpass):
    result, events = run()

    assert result.outcome == "completed"
    assert len(overpass.calls) == 1 and "(around:10000," in overpass.calls[0]
    summary = result.step("analyse").outcome.result["summary"]
    assert summary["services_count"] == 2 and summary["partial"] is False
    assert [e["type"] for e in events][-1] == "workflow_completed"
    text = result.step("report").outcome.result["text"]
    assert "not travel time, road access or population coverage" in text


def test_workflow_with_no_services(overpass):
    overpass.elements = []
    result, _ = run()

    summary = result.step("analyse").outcome.result["summary"]
    assert result.outcome == "completed"
    assert summary["counts"]["no_service_found"] == summary["total_cells"]
    assert "No distances were calculated" in result.step("report").outcome.result["text"]


def test_discovery_failure_is_not_zero_services(overpass):
    overpass.error = od.OverpassError("The Overpass API is busy. Please retry in a moment.", 503)
    result, events = run()

    assert result.outcome == "failed"
    assert [s.status for s in result.steps] == ["failed", "skipped", "skipped"]
    workflow, layers = serialize_coverage(result, CENTRE)
    assert layers == [] and "coverage" not in workflow["analysis"]
    assert events[-1]["type"] == "workflow_failed"


def test_truncated_discovery_marks_partial(overpass, monkeypatch):
    monkeypatch.setattr(od, "MAX_ELEMENTS", 3)
    result, _ = run()

    summary = result.step("analyse").outcome.result["summary"]
    assert summary["discovery_truncated"] and summary["partial"]
    assert result.outcome == "partial"
    assert "may be incomplete" in result.step("report").outcome.result["text"]


def test_unsupported_category_fails_cleanly(overpass):
    result, _ = run(CoverageRequest("road", 2))
    assert result.outcome == "failed"
    assert "service categories only" in result.step("find_services").error
    assert overpass.calls == []


def test_workflow_timeout(overpass):
    overpass.delay = 1.0
    result, _ = run(timeout=0.3)
    assert result.outcome == "failed"
    assert "time limit" in result.step("find_services").error


def test_workflow_cancellation(overpass):
    overpass.delay = 0.5

    async def go():
        task = asyncio.create_task(run_coverage_workflow(CoverageRequest("hospital", 5), CENTRE, 30, _noop))
        await asyncio.sleep(0.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(go())
    assert len(overpass.calls) == 1


async def _noop(_):
    return None


def test_serialized_layers(overpass):
    result, _ = run()
    workflow, layers = serialize_coverage(result, CENTRE)

    cells, services = layers
    assert cells["kind"] == "analysis" and cells["style"] == "coverage"
    props = cells["geojson"]["features"][0]["properties"]
    assert set(props) >= {"cell_id", "coverage_class", "nearest_distance_m", "nearest_service_id", "nearest_service_name"}
    assert services["kind"] == "discovery" and services["feature_count"] == 2
    assert workflow["type"] == "coverage" and workflow["analysis"]["services"]["attribution"]
    assert len(json.dumps(workflow)) < 50_000  # cells travel in the layer, not the summary


# API, streaming and agent

client = TestClient(app)


@pytest.fixture
def no_llm(monkeypatch):
    def explode(settings):
        raise AssertionError("LLM must not be called")

    monkeypatch.setattr(agent_router, "create_provider", explode)


QUESTION = "Identify areas within 5 km of my selected location that are underserved by hospitals."


def test_stream_event_sequence(overpass, no_llm):
    with client.stream("POST", "/api/agent/chat/stream", json={"message": QUESTION, "coordinates": list(CENTRE)}) as stream:
        events = [json.loads(line) for line in stream.iter_lines() if line]

    assert [e["type"] for e in events] == [
        "plan_created",
        "step_started", "step_completed",
        "step_started", "step_completed",
        "step_started", "step_completed",
        "workflow_completed", "result",
    ]
    response = events[-1]["response"]
    assert response["intent"] == "coverage" and response["mode"] == "workflow"
    assert response["workflow"]["analysis"]["coverage"]["services_count"] == 2


def test_api_requires_location(overpass, no_llm):
    response = client.post("/api/agent/chat", json={"message": QUESTION}).json()
    assert response["needs_input"] == ["coordinates"] and overpass.calls == []


def test_api_rejects_radius_over_10_km(overpass, no_llm):
    response = client.post("/api/agent/chat", json={
        "message": QUESTION.replace("5 km", "25 km"), "coordinates": list(CENTRE),
    }).json()
    assert response["success"] is False and "limited to a 10 km radius" in response["message"]
    assert overpass.calls == []


def test_agent_tool_returns_calculated_values_only(overpass):
    class Provider:
        name, model = "fake", "fake"

        def __init__(self):
            self.calls = []

        async def chat(self, messages, tools):
            self.calls.append(json.loads(json.dumps(messages)))
            if len(self.calls) == 1:
                return LLMResponse("", [ToolCall("c1", "analyse_service_coverage", {"category": "schools", "radius_km": 4}, "{}")])
            return LLMResponse("Coverage summarised.")

    provider = Provider()
    result = asyncio.run(run_agent("Where are school gaps?", AgentContext(location=CENTRE), provider, 3))

    assert result.steps[0].status == "completed"
    payload = json.loads(provider.calls[1][-1]["content"])["result"]
    assert set(payload["counts"]) == set(coverage.CLASSES)
    assert payload["radius_km"] == 4
    assert [layer["kind"] for layer in result.layers] == ["analysis", "discovery"]
