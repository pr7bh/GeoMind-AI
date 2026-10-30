import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import agent as agent_router
from app.services import osm_discovery as od
from app.services.workflows import analysis
from app.services.workflows.catalog import (
    build_plan,
    match_workflow,
    run_nearby_count_workflow,
    serialize,
)
from app.services.workflows.plan import (
    MAX_PLAN_STEPS,
    PlanError,
    WorkflowContext,
    execute_plan,
    validate_plan,
)
from app.services.workflows import steps as workflow_steps
from app.services.workflows.steps import WORKFLOW_TOOLS

LOCATION = (77.2, 28.6)
QUESTION = (
    "Find hospitals within 5 km of my selected map location and identify which "
    "hospitals have the most pharmacies within 1 km."
)


def node(osm_id, lon, lat, **tags):
    return {"type": "node", "id": osm_id, "lon": lon, "lat": lat, "tags": tags}


# 0.001 degrees of longitude here is about 97.5 m; of latitude about 111 m.
HOSPITALS = [
    node(1, 77.200, 28.600, amenity="hospital", name="Alpha Hospital"),
    node(2, 77.205, 28.600, amenity="hospital", name="Beta Hospital"),
    node(3, 77.230, 28.600, amenity="hospital", name="Gamma Hospital"),
]
PHARMACIES = [
    node(101, 77.2025, 28.600, amenity="pharmacy", name="Shared Chemist"),  # near Alpha and Beta
    node(102, 77.200, 28.605, amenity="pharmacy", name="North Pharmacy"),   # near Alpha and Beta
    node(103, 77.231, 28.600, amenity="pharmacy", name="Gamma Pharmacy"),   # near Gamma
    node(104, 77.215, 28.600, amenity="pharmacy", name="East Pharmacy"),    # near Beta only
]


@pytest.fixture
def overpass(monkeypatch):
    class Fake:
        hospitals = list(HOSPITALS)
        pharmacies = list(PHARMACIES)
        fail_when: str | None = None
        # Fail pharmacy queries with more than this many search circles.
        fail_if_more_circles_than: int | None = None
        delay = 0.0
        pharmacy_delay = 0.0
        calls: list[str] = []

    async def fake_fetch(query, client=None):
        Fake.calls.append(query)
        if Fake.delay:
            await asyncio.sleep(Fake.delay)
        if Fake.pharmacy_delay and '"pharmacy"' in query:
            await asyncio.sleep(Fake.pharmacy_delay)
        if Fake.fail_if_more_circles_than is not None and '"pharmacy"' in query \
                and len(set(circles(query))) > Fake.fail_if_more_circles_than:
            raise od.OverpassError("The Overpass API is busy. Please retry in a moment.", 503)
        if Fake.fail_when and Fake.fail_when in query:
            raise od.OverpassError("The Overpass API is busy. Please retry in a moment.", 503)
        elements = Fake.hospitals if '"hospital"' in query else Fake.pharmacies
        # Duplicates across union statements, as Overpass may return.
        return {"elements": elements + elements[:1], "osm3s": {"timestamp_osm_base": "2026-10-30T00:00:00Z"}}

    monkeypatch.setattr(od, "_fetch_overpass", fake_fetch)
    Fake.calls = []
    return Fake


def run(timeout=30.0, request=None, location=LOCATION):
    request = request or match_workflow(QUESTION)
    events = []

    async def emit(event):
        events.append(event)

    result = asyncio.run(run_nearby_count_workflow(request, location, timeout, emit))
    return result, events


def ranking_of(result):
    return result.step("rank").outcome.result["ranking"]


# Matching and plan validation

def test_match_workflow_parses_question():
    request = match_workflow(QUESTION)
    assert (request.source_category, request.source_radius_km) == ("hospital", 5.0)
    assert (request.target_category, request.target_radius_km) == ("pharmacy", 1.0)
    assert match_workflow("Find hospitals within 5 km") is None


def test_valid_plan_is_ordered_by_dependencies():
    plan = list(reversed(build_plan(match_workflow(QUESTION))))
    states = validate_plan(plan, WORKFLOW_TOOLS)
    assert [s.step.id for s in states] == ["find_sources", "find_nearby", "rank", "report"]


def plan_with(**changes):
    plan = build_plan(match_workflow(QUESTION))
    for index, change in changes.items():
        plan[int(index[1:])].update(change)
    return plan


@pytest.mark.parametrize("plan,message", [
    (plan_with(s0={"tool": "run_shell"}), "Unknown tool 'run_shell'"),
    (plan_with(s0={"depends_on": ["report"]}), "circular dependency"),
    (plan_with(s1={"depends_on": ["find_sources", "ghost"]}), "missing step 'ghost'"),
    (plan_with(s1={"depends_on": []}), "without depending on it"),
    (plan_with(s2={"arguments": {"nearby_step": "find_sources"}, "depends_on": ["find_sources"]}), "needs output from discover_near_features"),
    (plan_with(s1={"arguments": {"source_step": "find_sources", "category": "pharmacy", "radius_km": 5}}), "radius_km"),
    (plan_with(s0={"arguments": {"category": "hospital", "radius_km": 5, "lat": 1, "lon": 2}}), "Extra inputs"),
    (plan_with(s0={"id": "Bad Id!"}), "Invalid plan step"),
])
def test_invalid_plans_are_rejected(plan, message):
    with pytest.raises(PlanError, match=message):
        validate_plan(plan, WORKFLOW_TOOLS)


def test_plan_step_limit():
    plan = build_plan(match_workflow(QUESTION))
    plan += [dict(plan[2], id=f"extra{i}") for i in range(MAX_PLAN_STEPS - len(plan) + 1)]
    with pytest.raises(PlanError, match=f"at most {MAX_PLAN_STEPS} steps"):
        validate_plan(plan, WORKFLOW_TOOLS)


def test_hospital_limit_cannot_be_raised_by_plan():
    with pytest.raises(PlanError, match="limit"):
        validate_plan(plan_with(s0={"arguments": {"category": "hospital", "radius_km": 5, "limit": 31}}), WORKFLOW_TOOLS)


# Execution, relationships, deduplication and ranking

def test_full_workflow_counts_and_ranking(overpass):
    result, _ = run()

    assert result.outcome == "completed"
    near = result.step("find_nearby").outcome.result
    assert near["distinct_count"] == 4            # P101 counted once overall
    assert near["relationship_count"] == 6        # but once per nearby hospital

    ranking = ranking_of(result)
    assert [(r["name"], r["nearby_count"], r["rank"]) for r in ranking] == [
        ("Beta Hospital", 3, 1),
        ("Alpha Hospital", 2, 2),
        ("Gamma Hospital", 1, 3),
    ]
    alpha = ranking[1]
    assert {m["name"] for m in alpha["nearby"]} == {"Shared Chemist", "North Pharmacy"}
    assert alpha["nearby"][0]["distance_m"] == pytest.approx(244, abs=5)

    # One Overpass call for hospitals and one batch for 3 hospitals.
    assert len(overpass.calls) == 2
    assert overpass.calls[1].count('nwr["amenity"="pharmacy"]') == 3


def test_ties_share_rank(overpass):
    overpass.pharmacies = PHARMACIES + [node(105, 77.193, 28.600, amenity="pharmacy", name="West Pharmacy")]
    ranking = ranking_of(run()[0])

    assert [(r["name"], r["rank"], r["tied"]) for r in ranking] == [
        ("Alpha Hospital", 1, True),   # 3 pharmacies, nearer to the location
        ("Beta Hospital", 1, True),
        ("Gamma Hospital", 3, False),
    ]


def test_polygon_hospital_uses_real_geometry(overpass):
    # A 3 km-wide campus: the pharmacy is 2 km from its centre, 0.5 km from its edge.
    campus = {
        "type": "way", "id": 9, "tags": {"amenity": "hospital", "name": "Big Campus"},
        "geometry": [{"lon": x, "lat": y} for x, y in [
            (77.185, 28.590), (77.215, 28.590), (77.215, 28.610), (77.185, 28.610), (77.185, 28.590)]],
    }
    overpass.hospitals = [campus]
    overpass.pharmacies = [node(201, 77.2205, 28.600, amenity="pharmacy", name="Edge Pharmacy")]
    result, _ = run()

    entry = ranking_of(result)[0]
    assert entry["nearby_count"] == 1
    assert entry["nearby"][0]["distance_m"] == pytest.approx(536, abs=10)
    radius = int(overpass.calls[1].split("(around:")[1].split(",")[0])
    assert radius > 2000  # widened by the campus extent


def test_no_hospitals_stops_gracefully(overpass):
    overpass.hospitals = []
    result, events = run()

    assert result.outcome == "completed"
    assert [s.status for s in result.steps] == ["completed", "skipped", "skipped", "skipped"]
    assert "No hospitals are mapped" in result.stop_reason
    assert len(overpass.calls) == 1
    assert [e["type"] for e in events][-1] == "workflow_completed"


def test_one_failed_batch_is_not_counted_as_zero(overpass):
    overpass.hospitals = [
        node(i, 77.2 + i * 0.001, 28.6, amenity="hospital", name=f"Hospital {i}") for i in range(12)
    ]
    # The second batch (hospitals 10 and 11) contains this coordinate.
    overpass.fail_when = "28.6,77.211"
    result, events = run()

    assert result.outcome == "partial"
    rank = result.step("rank").outcome.result
    assert rank["complete"] is False
    assert {u["name"] for u in rank["unranked"]} == {"Hospital 10", "Hospital 11"}
    assert all("Search failed" in u["reason"] for u in rank["unranked"])
    assert len(rank["ranking"]) == 10
    text = result.step("report").outcome.result["text"]
    assert "Not ranked: Hospital 10" in text and "not counted as zero" in text
    assert events[-1]["type"] == "workflow_partial"


def test_all_searches_failing_fails_the_step(overpass):
    overpass.fail_when = '"pharmacy"'
    result, events = run()

    assert result.outcome == "failed"
    assert result.step("find_nearby").status == "failed"
    assert [s.status for s in result.steps[2:]] == ["skipped", "skipped"]
    assert events[-1]["type"] == "workflow_failed"


def test_server_truncation_marks_counts_as_lower_bounds(overpass, monkeypatch):
    monkeypatch.setattr(od, "MAX_ELEMENTS", 4)
    result, _ = run()

    assert result.outcome == "partial"
    assert all(r["count_is_lower_bound"] for r in ranking_of(result))
    assert "truncated" in result.step("report").outcome.result["text"]


def test_total_nearby_limit(overpass):
    plan = build_plan(match_workflow(QUESTION))
    plan[1]["arguments"]["max_total"] = 2
    states = validate_plan(plan, WORKFLOW_TOOLS)

    async def go():
        context = WorkflowContext(LOCATION, asyncio.get_running_loop().time() + 30)
        return await execute_plan(states, WORKFLOW_TOOLS, context)

    result = asyncio.run(go())
    near = result.step("find_nearby").outcome.result
    assert near["distinct_count"] == 2 and near["global_limit_reached"] is True
    assert result.outcome == "partial"


def test_missing_hospital_geometry_is_skipped():
    sources = analysis.prepare_sources([
        {"type": "Feature", "id": "node/1", "properties": {"name": "No Geometry"}, "geometry": None},
        {"type": "Feature", "id": "node/2", "properties": {"name": "Ok"}, "geometry": {"type": "Point", "coordinates": [77.2, 28.6]}},
    ])
    assert [(s.name, s.status) for s in sources] == [("No Geometry", "skipped"), ("Ok", "pending")]
    assert "No usable geometry" in sources[0].reason


def test_workflow_timeout(overpass):
    overpass.delay = 1.0
    result, events = run(timeout=0.3)

    assert result.outcome == "failed"
    assert "time limit" in result.step("find_sources").error
    assert events[-1]["type"] == "workflow_failed"


def test_cancellation_stops_further_searches(overpass):
    overpass.hospitals = [
        node(i, 77.2 + i * 0.001, 28.6, amenity="hospital", name=f"H{i}") for i in range(25)
    ]
    overpass.delay = 0.2

    async def go():
        task = asyncio.create_task(
            run_nearby_count_workflow(match_workflow(QUESTION), LOCATION, 30, _noop)
        )
        await asyncio.sleep(0.3)  # hospitals done, first pharmacy batch in flight
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        calls_at_cancel = len(overpass.calls)
        await asyncio.sleep(0.6)
        return calls_at_cancel

    calls_at_cancel = asyncio.run(go())
    assert calls_at_cancel == 2
    assert len(overpass.calls) == 2  # no batch started after cancellation


async def _noop(_):
    return None


def test_serialized_layers_keep_relationships(overpass):
    result, _ = run()
    workflow, layers = serialize(result, LOCATION)

    hospitals, pharmacies = layers
    assert hospitals["feature_count"] == 3 and pharmacies["feature_count"] == 4
    beta = next(f for f in hospitals["geojson"]["features"] if f["properties"]["name"] == "Beta Hospital")
    assert beta["properties"]["pharmacy_within_1_km"] == 3
    shared = next(f for f in pharmacies["geojson"]["features"] if f["properties"]["name"] == "Shared Chemist")
    assert shared["properties"]["near_hospital_count"] == 2
    assert workflow["analysis"]["nearby"]["distinct_count"] == 4
    json.dumps(workflow)  # serialisable


# API and streaming

client = TestClient(app)


@pytest.fixture
def no_llm(monkeypatch):
    def explode(settings):
        raise AssertionError("LLM must not be called")

    monkeypatch.setattr(agent_router, "create_provider", explode)


def test_stream_event_sequence(overpass, no_llm):
    with client.stream("POST", "/api/agent/chat/stream", json={"message": QUESTION, "coordinates": list(LOCATION)}) as stream:
        events = [json.loads(line) for line in stream.iter_lines() if line]

    assert [e["type"] for e in events] == [
        "plan_created",
        "step_started", "step_completed",
        "step_started", "step_completed",
        "step_started", "step_completed",
        "step_started", "step_completed",
        "workflow_completed",
        "result",
    ]
    response = events[-1]["response"]
    assert response["mode"] == "workflow" and response["success"] is True
    assert response["message"].startswith("Analysed 3 hospitals within 5 km")
    assert "1. Beta Hospital — 3" in response["message"]
    assert "not opening hours" in response["message"]
    assert len(response["layers"]) == 2


def test_workflow_requires_location(overpass, no_llm):
    response = client.post("/api/agent/chat", json={"message": QUESTION}).json()
    assert response["needs_input"] == ["coordinates"] and overpass.calls == []


def test_invalid_workflow_radius_is_rejected_by_plan_validation(overpass, no_llm):
    message = QUESTION.replace("within 1 km", "within 5 km")
    response = client.post("/api/agent/chat", json={"message": message, "coordinates": list(LOCATION)}).json()
    assert response["error_code"] == "invalid_plan" and overpass.calls == []


@pytest.mark.parametrize("message,mode", [
    ("Find hospitals within 5 km", "deterministic"),
    ("Find schools within 3 km", "deterministic"),
])
def test_simple_requests_keep_direct_path(overpass, no_llm, message, mode):
    response = client.post("/api/agent/chat", json={"message": message, "coordinates": list(LOCATION)}).json()
    assert response["mode"] == mode and response["workflow"] is None


@pytest.mark.parametrize("message", ["Find nearby parks", "Find nearest police station"])
def test_open_requests_still_go_to_llm_path(monkeypatch, message):
    monkeypatch.setenv("LLM_PROVIDER", "none")
    response = client.post("/api/agent/chat", json={"message": message, "coordinates": list(LOCATION)}).json()
    assert response["error_code"] == "llm_not_configured" and response["workflow"] is None


# Milestone 5.1: one combined pharmacy request

def circles(query):
    """(radius_m, lat, lon) for each around() filter; one per OSM selector."""
    return [
        tuple(float(v) for v in part.split(")")[0].split(","))
        for part in query.split("(around:")[1:]
    ]


def near_result(result):
    return result.step("find_nearby").outcome.result


def test_combined_query_has_one_circle_per_hospital(overpass):
    result, _ = run()

    assert len(overpass.calls) == 2  # hospitals + one combined pharmacy query
    # Each circle appears once per category selector (amenity= and healthcare=).
    assert sorted(set(circles(overpass.calls[1]))) == sorted([
        (1001.0, 28.6, 77.2), (1001.0, 28.6, 77.205), (1001.0, 28.6, 77.23),
    ])
    near = near_result(result)
    assert (near["overpass_requests"], near["strategy"]) == (1, "combined")


def test_overlapping_areas_keep_per_hospital_radius(overpass):
    overpass.hospitals = [
        node(1, 77.200, 28.600, amenity="hospital", name="West"),
        node(2, 77.202, 28.600, amenity="hospital", name="East"),  # ~195 m apart
    ]
    overpass.pharmacies = [
        node(301, 77.201, 28.600, amenity="pharmacy", name="Between"),   # near both
        node(302, 77.211, 28.600, amenity="pharmacy", name="Far East"),  # 1072 m from West, 877 m from East
    ]
    result, _ = run()

    by_name = {r["name"]: r for r in ranking_of(result)}
    assert {m["name"] for m in by_name["East"]["nearby"]} == {"Between", "Far East"}
    assert {m["name"] for m in by_name["West"]["nearby"]} == {"Between"}
    near = near_result(result)
    assert near["distinct_count"] == 2       # union of both areas, each pharmacy once
    assert near["relationship_count"] == 3   # "Between" counted for each hospital


def test_large_and_point_hospitals_keep_own_circles(overpass):
    campus = {
        "type": "way", "id": 9, "tags": {"amenity": "hospital", "name": "Big Campus"},
        "geometry": [{"lon": x, "lat": y} for x, y in [
            (77.185, 28.590), (77.215, 28.590), (77.215, 28.610), (77.185, 28.610), (77.185, 28.590)]],
    }
    overpass.hospitals = [campus, node(2, 77.300, 28.600, amenity="hospital", name="Small Clinic Hospital")]
    overpass.pharmacies = [node(201, 77.2205, 28.600, amenity="pharmacy", name="Edge Pharmacy")]
    result, _ = run()

    radii = sorted({r for r, _, _ in circles(overpass.calls[1])})
    assert len(overpass.calls) == 2 and radii[0] == 1001.0 and radii[1] > 2000
    by_name = {r["name"]: r["nearby_count"] for r in ranking_of(result)}
    assert by_name == {"Big Campus": 1, "Small Clinic Hospital": 0}


def test_duplicate_pharmacy_elements_counted_once(overpass):
    overpass.pharmacies = PHARMACIES + PHARMACIES + [dict(PHARMACIES[0])]
    near = near_result(run()[0])
    assert near["distinct_count"] == 4 and near["relationship_count"] == 6


def test_combined_failure_falls_back_to_batches(overpass):
    overpass.hospitals = [
        node(i, 77.2 + i * 0.001, 28.6, amenity="hospital", name=f"Hospital {i}") for i in range(12)
    ]
    overpass.fail_if_more_circles_than = 10
    result, _ = run()

    near = near_result(result)
    assert (near["overpass_requests"], near["strategy"]) == (3, "combined+batches")
    assert result.outcome == "completed"
    assert result.step("rank").outcome.result["complete"] is True


def test_combined_failure_without_time_for_fallback(overpass, monkeypatch):
    monkeypatch.setattr(workflow_steps, "FALLBACK_MIN_SECONDS", 1e9)
    overpass.fail_when = '"pharmacy"'
    result, _ = run()

    assert result.outcome == "failed"
    assert len(overpass.calls) == 2  # no fallback attempted
    assert "Search failed" in result.step("find_nearby").error
    assert [s.status for s in result.steps[2:]] == ["skipped", "skipped"]


def test_combined_timeout_reports_failure_not_zero(overpass):
    # Enough budget to start the combined request, which then hits the deadline.
    overpass.pharmacy_delay = 10.0
    result, events = run(timeout=7.0)

    assert result.outcome == "failed"
    assert "time limit" in result.step("find_nearby").error
    assert len(overpass.calls) == 2  # deadline leaves no room for a fallback
    assert events[-1]["type"] == "workflow_failed"


def test_truncated_combined_response_marks_all_counts_lower_bounds(overpass, monkeypatch):
    monkeypatch.setattr(od, "MAX_ELEMENTS", 5)  # hospitals: 4 elements, pharmacies: 5
    result, _ = run()

    assert result.step("find_sources").outcome.result["truncated"] is False
    assert near_result(result)["server_truncated"] is True
    assert all(r["count_is_lower_bound"] for r in ranking_of(result))
    assert result.outcome == "partial"


def test_cancellation_during_combined_request(overpass):
    overpass.pharmacy_delay = 0.5

    async def go():
        task = asyncio.create_task(
            run_nearby_count_workflow(match_workflow(QUESTION), LOCATION, 30, _noop)
        )
        await asyncio.sleep(0.2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.8)

    asyncio.run(go())
    assert len(overpass.calls) == 2  # no fallback batches after cancellation
