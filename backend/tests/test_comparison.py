import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import shape

from app.main import app
from app.routers import agent as agent_router
from app.services import comparison, coverage, osm_discovery as od
from app.services.workflows.catalog import (
    ComparisonRequest,
    build_comparison_plan,
    match_comparison,
    match_coverage,
    run_comparison_workflow,
    serialize_comparison,
)
from app.services.workflows.plan import PlanError, validate_plan
from app.services.workflows.steps import WORKFLOW_TOOLS

AREA_A = (77.2167, 28.6315)   # Delhi
AREA_B = (78.0081, 27.1767)   # Agra
REQUEST = ComparisonRequest("hospital", 5)


# Pure comparison maths

def metrics(**overrides):
    base = {
        "services_in_area": 10, "density_per_km2": 0.2, "well_covered_pct": 80.0,
        "underserved_pct": 5.0, "average_distance_m": 1200.0,
        "density_complete": True, "coverage_complete": True,
    }
    return {**base, **overrides}


def row(result, key):
    return next(r for r in result["metrics"] if r["key"] == key)


def test_differences_relative_and_better_per_metric():
    result = comparison.compare(
        metrics(),
        metrics(services_in_area=4, density_per_km2=0.08, well_covered_pct=90.0, underserved_pct=2.0, average_distance_m=900.0),
    )

    services = row(result, "services_in_area")
    assert (services["difference"], services["relative_difference_pct"], services["better"]) == (6, 150.0, "a")
    assert row(result, "well_covered_pct")["better"] == "b"          # higher is better
    assert row(result, "underserved_pct")["better"] == "b"           # lower is better
    assert row(result, "average_distance_m")["better"] == "b"        # lower is better
    assert row(result, "density_per_km2")["difference"] == pytest.approx(0.12)
    assert result["overall_winner"] is None                          # no single winner
    assert result["complete"] is True


def test_zero_denominator_and_ties():
    result = comparison.compare(metrics(services_in_area=3), metrics(services_in_area=0, underserved_pct=5.0))
    services = row(result, "services_in_area")
    assert services["difference"] == 3 and services["relative_difference_pct"] is None
    assert row(result, "underserved_pct")["better"] == "tie"


def test_missing_values_are_null_not_zero():
    result = comparison.compare(metrics(average_distance_m=None), None)
    for r in result["metrics"]:
        assert r["b"] is None and r["difference"] is None and r["better"] is None
        assert r["definitive"] is False
    assert result["complete"] is False

    no_services = comparison.compare(metrics(average_distance_m=None), metrics())
    assert row(no_services, "average_distance_m")["better"] is None


def test_incomplete_area_makes_metrics_indicative():
    result = comparison.compare(metrics(density_complete=False), metrics())
    assert row(result, "services_in_area")["definitive"] is False
    assert row(result, "well_covered_pct")["definitive"] is True
    assert result["complete"] is False


def test_density_completeness_from_truncation():
    found = {"truncated": True, "returned": 2, "total_found": 9, "osm_base": None,
             "features": [{"properties": {"distance_km": d}} for d in (1.0, 7.5)]}
    summary = {"radius_km": 5, "centre": [0, 0], "cell_size_m": 500, "total_cells": 300,
               "counts": {}, "percentages": {"well_covered": 1, "moderate": 1, "underserved": 1, "no_service_found": 0},
               "services_count": 2, "average_distance_m": 1.0, "max_distance_m": 2.0,
               "partial": True, "invalid_services": 0}
    within = {"count": 1, "area_km2": 78.5}

    assert comparison.area_metrics(found, summary, within)["density_complete"] is True   # kept beyond 5 km
    found["features"] = [{"properties": {"distance_km": 2.0}}]
    assert comparison.area_metrics(found, summary, within)["density_complete"] is False
    assert comparison.area_metrics(found, summary, {"count": 4, "area_km2": 0})["density_per_km2"] is None


# Matching and plan

@pytest.mark.parametrize("message,category", [
    ("Compare hospital coverage around Location A and Location B.", "hospital"),
    ("Compare school coverage between these two areas.", "school"),
    ("Which area has better pharmacy coverage?", "pharmacy"),
    ("Compare police station density.", "police"),
    ("Which area has more pharmacies?", "pharmacy"),
    ("Which location has more underserved areas?", None),
    ("Compare service accessibility in both locations.", None),
])
def test_match_comparison(message, category):
    assert match_comparison(message).category == category


@pytest.mark.parametrize("message", [
    "Analyse pharmacy coverage around this location",
    "Find hospitals within 5 km",
    "Which parts of this area are far from police stations?",
])
def test_non_comparisons_not_matched(message):
    assert match_comparison(message) is None


def test_both_areas_share_identical_methodology():
    states = validate_plan(build_comparison_plan(ComparisonRequest("school", 10)), WORKFLOW_TOOLS)
    a, b = states[0].args.model_dump(), states[1].args.model_dump()
    assert (a.pop("area"), b.pop("area")) == ("a", "b")
    assert a == b
    assert a["cell_size_m"] == coverage.choose_cell_size(10_000, None)[0]


def test_plan_rejects_raised_limits_and_bad_optional_dependencies():
    plan = build_comparison_plan(REQUEST)
    plan[0]["arguments"]["limit"] = 501
    with pytest.raises(PlanError, match="limit"):
        validate_plan(plan, WORKFLOW_TOOLS)

    plan = build_comparison_plan(REQUEST)
    plan[2]["optional_depends_on"] = ["area_a", "ghost"]
    with pytest.raises(PlanError, match="missing step 'ghost'"):
        validate_plan(plan, WORKFLOW_TOOLS)

    plan = build_comparison_plan(REQUEST)
    plan[0]["optional_depends_on"] = ["report"]
    with pytest.raises(PlanError, match="circular"):
        validate_plan(plan, WORKFLOW_TOOLS)

    plan = build_comparison_plan(REQUEST)
    plan[0]["arguments"]["lat"] = 1
    with pytest.raises(PlanError, match="Extra inputs"):
        validate_plan(plan, WORKFLOW_TOOLS)


# Workflow with mocked Overpass

def hospitals_near(lon, lat, offsets, start_id):
    return [
        {"type": "node", "id": start_id + i, "lon": lon + dx, "lat": lat + dy,
         "tags": {"amenity": "hospital", "name": f"H{start_id + i}"}}
        for i, (dx, dy) in enumerate(offsets)
    ]


@pytest.fixture
def overpass(monkeypatch):
    class Fake:
        fail_area: set[str] = set()
        delay = 0.0
        calls: list[str] = []
        in_flight = 0
        max_in_flight = 0

    async def fake_fetch(query, client=None):
        Fake.calls.append(query)
        Fake.in_flight += 1
        Fake.max_in_flight = max(Fake.max_in_flight, Fake.in_flight)
        try:
            if Fake.delay:
                await asyncio.sleep(Fake.delay)
            lat, lon = (float(v) for v in query.split("(around:")[1].split(")")[0].split(",")[1:3])
            area = "a" if lon < 77.6 else "b"
            if area in Fake.fail_area:
                raise od.OverpassError("The Overpass API is busy. Please retry in a moment.", 503)
            if area == "a":
                elements = hospitals_near(lon, lat, [(0.01, 0), (-0.02, 0.01), (0.0, -0.03)], 100)
            else:
                elements = hospitals_near(lon, lat, [(0.06, 0.02)], 200)
            return {"elements": elements + elements[:1], "osm3s": {"timestamp_osm_base": "2026-10-30T00:00:00Z"}}
        finally:
            Fake.in_flight -= 1

    monkeypatch.setattr(od, "_fetch_overpass", fake_fetch)
    Fake.calls = []
    Fake.max_in_flight = 0
    return Fake


def run(timeout=30.0, request=REQUEST):
    events = []

    async def emit(event):
        events.append(event)

    return asyncio.run(run_comparison_workflow(request, AREA_A, AREA_B, timeout, emit)), events


def compare_result(result):
    return result.step("compare").outcome.result


def test_both_areas_succeed_sequentially(overpass):
    result, events = run()

    assert result.outcome == "completed"
    assert len(overpass.calls) == 2 and overpass.max_in_flight == 1
    rows = {r["key"]: r for r in compare_result(result)["metrics"]}
    assert rows["services_in_area"]["a"] == 3 and rows["services_in_area"]["b"] == 0
    assert rows["services_in_area"]["better"] == "a"
    assert rows["services_in_area"]["relative_difference_pct"] is None   # B is zero
    assert rows["well_covered_pct"]["a"] > rows["well_covered_pct"]["b"]
    assert rows["density_per_km2"]["a"] == pytest.approx(3 / rows_area(result), abs=1e-4)  # rounded to 4 dp
    text = result.step("report").outcome.result["text"]
    assert "no single overall winner" in text.lower()
    assert [e["type"] for e in events][-1] == "workflow_completed"


def rows_area(result):
    return result.step("area_a").outcome.result["metrics"]["study_area_km2"]


def test_area_a_failure_keeps_area_b(overpass):
    overpass.fail_area = {"a"}
    result, _ = run()

    assert result.outcome == "partial"
    assert [s.status for s in result.steps] == ["failed", "completed", "completed", "completed"]
    areas = compare_result(result)["areas"]
    assert areas["a"]["metrics"] is None and "busy" in areas["a"]["error"]
    assert all(r["a"] is None and r["better"] is None for r in compare_result(result)["metrics"])
    text = result.step("report").outcome.result["text"]
    assert "Area A could not be analysed" in text and "not zero" in text
    _, layers = serialize_comparison(result)
    assert {layer["area"] for layer in layers} == {"b"}


def test_area_b_failure_keeps_area_a(overpass):
    overpass.fail_area = {"b"}
    result, _ = run()

    assert result.outcome == "partial"
    assert compare_result(result)["areas"]["b"]["metrics"] is None
    _, layers = serialize_comparison(result)
    assert {layer["area"] for layer in layers} == {"a"} and len(layers) == 2


def test_both_areas_failing_fails_workflow(overpass):
    overpass.fail_area = {"a", "b"}
    result, events = run()

    assert result.outcome == "failed"
    assert [s.status for s in result.steps] == ["failed", "failed", "failed", "skipped"]
    assert "Both areas failed" in result.step("compare").error
    workflow, layers = serialize_comparison(result)
    assert layers == [] and workflow["analysis"]["areas"]["a"]["metrics"] is None
    assert events[-1]["type"] == "workflow_failed"


def test_truncation_makes_comparison_indicative(overpass, monkeypatch):
    monkeypatch.setattr(od, "MAX_ELEMENTS", 2)
    result, _ = run()

    compared = compare_result(result)
    assert compared["complete"] is False and result.outcome == "partial"
    assert any(not r["definitive"] for r in compared["metrics"])
    text = result.step("report").outcome.result["text"]
    assert "indicative only" in text and "should not be read as a definitive ranking" in text


def test_cancellation_between_stages(overpass):
    overpass.delay = 0.3

    async def go():
        task = asyncio.create_task(run_comparison_workflow(REQUEST, AREA_A, AREA_B, 30, _noop))
        await asyncio.sleep(0.45)  # Area A done, Area B request in flight
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.5)

    asyncio.run(go())
    assert len(overpass.calls) == 2  # nothing started after cancellation


async def _noop(_):
    return None


def test_workflow_timeout(overpass):
    overpass.delay = 1.0
    result, _ = run(timeout=0.5)
    assert result.outcome == "failed"
    assert "time limit" in result.step("area_a").error


def test_cell_and_service_limits(overpass):
    result, _ = run(request=ComparisonRequest("hospital", 10))
    for key in ("area_a", "area_b"):
        summary = result.step(key).outcome.result["coverage"]["summary"]
        assert summary["total_cells"] <= coverage.MAX_CELLS
    assert all('out geom' in q for q in overpass.calls)


def test_layers_are_tagged_valid_wgs84(overpass):
    result, _ = run()
    workflow, layers = serialize_comparison(result)

    assert [(l["area"], l["kind"]) for l in layers] == [("a", "analysis"), ("a", "discovery"), ("b", "analysis"), ("b", "discovery")]
    for layer in layers:
        for feature in layer["geojson"]["features"][:20]:
            geometry = shape(feature["geometry"])
            assert geometry.is_valid and -180 <= geometry.centroid.x <= 180 and -90 <= geometry.centroid.y <= 90
    assert workflow["type"] == "comparison" and workflow["analysis"]["overall_winner"] is None
    json.dumps(workflow)


# API

client = TestClient(app)
QUESTION = "Compare hospital coverage around Location A and Location B."


@pytest.fixture
def no_llm(monkeypatch):
    def explode(settings):
        raise AssertionError("LLM must not be called")

    monkeypatch.setattr(agent_router, "create_provider", explode)


@pytest.mark.parametrize("body,missing", [
    ({"compare_coordinates": list(AREA_B)}, ["coordinates"]),
    ({"coordinates": list(AREA_A)}, ["compare_coordinates"]),
    ({}, ["coordinates", "compare_coordinates"]),
])
def test_api_requires_both_areas(overpass, no_llm, body, missing):
    response = client.post("/api/agent/chat", json={"message": QUESTION, **body}).json()
    assert response["needs_input"] == missing and overpass.calls == []


def test_api_asks_for_category(overpass, no_llm):
    response = client.post("/api/agent/chat", json={
        "message": "Which location has more underserved areas?",
        "coordinates": list(AREA_A), "compare_coordinates": list(AREA_B),
    }).json()
    assert response["needs_input"] == ["category"] and overpass.calls == []


def test_api_rejects_radius_over_10_km(overpass, no_llm):
    response = client.post("/api/agent/chat", json={
        "message": "Compare hospital coverage within 20 km in both areas",
        "coordinates": list(AREA_A), "compare_coordinates": list(AREA_B),
    }).json()
    assert response["success"] is False and "limited to a 10 km radius" in response["message"]


def test_api_stream_sequence(overpass, no_llm):
    body = {"message": QUESTION, "coordinates": list(AREA_A), "compare_coordinates": list(AREA_B)}
    with client.stream("POST", "/api/agent/chat/stream", json=body) as stream:
        events = [json.loads(line) for line in stream.iter_lines() if line]

    assert [e["type"] for e in events] == [
        "plan_created",
        "step_started", "step_completed",
        "step_started", "step_completed",
        "step_started", "step_completed",
        "step_started", "step_completed",
        "workflow_completed", "result",
    ]
    response = events[-1]["response"]
    assert response["intent"] == "comparison" and len(response["layers"]) == 4


def test_single_area_coverage_unchanged(overpass, no_llm):
    assert match_coverage("Analyse pharmacy coverage around this location") is not None
    response = client.post("/api/agent/chat", json={
        "message": "Identify areas within 5 km that are underserved by hospitals.",
        "coordinates": list(AREA_A),
    }).json()
    assert response["intent"] == "coverage" and response["workflow"]["type"] == "coverage"
