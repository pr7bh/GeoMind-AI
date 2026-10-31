import asyncio
import json
import re

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import research as research_router
from app.schemas.research import ResearchPlan, ResearchPlanRequest
from app.services import coverage, osm_discovery as od
from app.services import research_orchestrator as ro
from app.services import research_planner as rp

A = [77.2167, 28.6315]
B = [78.0081, 27.1767]
COMPLEX = (
    "Compare hospital accessibility between two areas, identify underserved locations, "
    "and recommend suitable locations for a new hospital."
)
client = TestClient(app)


def _kind(query: str) -> str:
    if 'nwr["healthcare"]' in query:
        return "healthcare"
    match = re.search(r'"amenity"="(\w+)"', query)
    return match[1] if match else "other"


@pytest.fixture
def overpass(monkeypatch):
    """Fake Overpass. Set .fail (kinds), .fail_area ("a"/"b"), .many (kinds), .delay, .empty (kinds)."""

    class Fake:
        fail: set[str] = set()
        fail_area: str | None = None
        many: set[str] = set()
        empty: set[str] = set()
        delay = 0.0
        calls: list[str] = []
        started: asyncio.Event | None = None
        cancelled = 0

    async def fake_fetch(query, client=None):
        Fake.calls.append(query)
        if Fake.started is not None:
            Fake.started.set()
        try:
            if Fake.delay:
                await asyncio.sleep(Fake.delay)
        except asyncio.CancelledError:
            Fake.cancelled += 1
            raise
        lat, lon = (float(v) for v in query.split("(around:")[1].split(")")[0].split(",")[1:3])
        kind = _kind(query)
        if kind in Fake.fail or (Fake.fail_area and ("a" if lon < 77.6 else "b") == Fake.fail_area):
            raise od.OverpassError("The Overpass API is busy. Please retry in a moment.", 503)
        if kind in Fake.empty:
            return {"elements": [], "osm3s": {"timestamp_osm_base": "2026-10-30T00:00:00Z"}}
        offsets = [(dx * 0.002, dy * 0.002) for dx in range(-12, 13) for dy in range(-12, 13)] if kind in Fake.many \
            else [(0.01, 0.0), (-0.02, 0.01), (0.0, -0.03)]
        amenity = "pharmacy" if kind == "healthcare" else kind
        elements = [
            {"type": "node", "id": 100 + i, "lon": lon + dx, "lat": lat + dy, "tags": {"amenity": amenity, "name": f"N{i}"}}
            for i, (dx, dy) in enumerate(offsets)
        ]
        return {"elements": elements, "osm3s": {"timestamp_osm_base": "2026-10-30T00:00:00Z"}}

    monkeypatch.setattr(od, "_fetch_overpass", fake_fetch)
    return Fake


@pytest.fixture(autouse=True)
def fresh_registry(monkeypatch):
    monkeypatch.setattr(ro, "REGISTRY", ro.ExecutionRegistry())


def make_plan(question, a=A, b=None) -> ResearchPlan:
    request = ResearchPlanRequest(question=question, coordinates=a, compare_coordinates=b, interpreter="rules")
    return asyncio.run(rp.plan_research(request, None, 5))


def body(plan: ResearchPlan) -> dict:
    return {"plan": json.loads(plan.model_dump_json())}


def execute(plan: ResearchPlan) -> list[dict]:
    with client.stream("POST", "/api/research/execute", json=body(plan)) as stream:
        assert stream.status_code == 200
        return [json.loads(line) for line in stream.iter_lines() if line]


def resign(plan: ResearchPlan, **changes) -> ResearchPlan:
    """Simulate a validly signed but unsafe plan, to test validation beyond the signature."""
    changed = plan.model_copy(update=changes, deep=True)
    changed.signature = rp.sign_plan(changed)
    return changed


def final(events):
    return events[-1]


def result_for(events, capability):
    return next(r for r in final(events)["result"]["results"] if r["capability_id"] == capability)


def step_events(events, step_id):
    return [e["type"] for e in events if e.get("step_id") == step_id]


COVERAGE_Q = "Identify areas with poor hospital coverage around this location"


# Plan validation

def test_ready_plan_executes(overpass):
    events = execute(make_plan(COVERAGE_Q))
    assert events[0]["type"] == "execution_started" and final(events)["type"] == "execution_completed"
    assert all(e["execution_id"] == events[0]["execution_id"] for e in events)


@pytest.mark.parametrize("question,a,b,status", [
    ("Find suitable locations for a new hospital", None, None, "needs_input"),
    ("Compare hospital coverage between two areas", A, None, "needs_input"),
    ("Identify areas within 20 km that are underserved by hospitals", A, None, "invalid"),
    ("What is the meaning of life?", A, None, "unsupported"),
])
def test_non_ready_plans_rejected(overpass, question, a, b, status):
    plan = make_plan(question, a, b)
    assert plan.status == status
    response = client.post("/api/research/execute", json=body(plan))
    assert response.status_code == 409 and status in response.json()["detail"]
    assert overpass.calls == []


def test_client_modified_plan_rejected(overpass):
    plan = body(make_plan(COVERAGE_Q))
    plan["plan"]["steps"][0]["arguments"]["radius_km"] = 9
    response = client.post("/api/research/execute", json=plan)
    assert response.status_code == 409 and "changed" in response.json()["detail"]

    plan = body(make_plan(COVERAGE_Q))
    plan["plan"]["status"] = "ready"
    plan["plan"]["signature"] = "0" * 64
    assert client.post("/api/research/execute", json=plan).status_code == 409
    assert overpass.calls == []


def test_plan_from_another_process_expires(overpass, monkeypatch):
    plan = make_plan(COVERAGE_Q)
    monkeypatch.setattr(rp, "_PLAN_KEY", b"restarted-server-key")
    assert client.post("/api/research/execute", json=body(plan)).status_code == 409


def edit_step(plan, index, **changes):
    steps = [s.model_copy(deep=True) for s in plan.steps]
    steps[index] = steps[index].model_copy(update=changes)
    return resign(plan, steps=steps)


@pytest.mark.parametrize("mutate,message", [
    (lambda p: edit_step(p, 0, capability_id="teleport"), "Unknown capability"),
    (lambda p: edit_step(p, 0, tool="spatial_query"), "not allowed"),
    (lambda p: edit_step(p, 0, arguments={"category": "hospital", "radius_km": 99, "limit": 500}), "Invalid arguments"),
    (lambda p: edit_step(p, 0, arguments={"category": "hospital", "radius_km": 10, "limit": 500, "sql": "drop"}), "Invalid arguments"),
    (lambda p: edit_step(p, 2, arguments={"coverage_step": "coverage.find_services"}), "cannot use"),
    (lambda p: edit_step(p, 1, dependencies=[]), "without depending"),
    (lambda p: edit_step(p, 0, dependencies=["coverage.report"]), "circular"),
    (lambda p: edit_step(p, 2, execution_order=0), "order"),
    (lambda p: resign(p, selected_areas=[p.selected_areas[0].model_copy(update={"coordinates": [200.0, 0.0]}), p.selected_areas[1]]), "longitude"),
    (lambda p: resign(p, steps=[s.model_copy(update={"id": f"coverage.s{i}", "dependencies": [], "arguments": p.steps[0].arguments, "execution_order": i + 1})
                                for i, s in enumerate([p.steps[0]] * 17)]), "at most 16"),
    (lambda p: resign(p, steps=[s.model_copy(update={"id": f"coverage.s{i}", "execution_order": i + 1})
                                for i, s in enumerate([p.steps[0]] * 9)]), "discovery requests"),
])
def test_unsafe_signed_plans_still_fail_validation(overpass, mutate, message):
    plan = mutate(make_plan(COVERAGE_Q))
    response = client.post("/api/research/execute", json=body(plan))
    assert response.status_code == 422 and message in response.json()["detail"]
    assert overpass.calls == []


def test_extra_request_fields_rejected():
    assert client.post("/api/research/execute", json={**body(make_plan(COVERAGE_Q)), "run_python": "x"}).status_code == 422


# Execution

def test_sequential_execution_in_dependency_order(overpass):
    plan = make_plan(COVERAGE_Q)
    events = execute(plan)
    started = [e["step_id"] for e in events if e["type"] == "step_started"]
    assert started == [s.id for s in plan.steps] == ["coverage.find_services", "coverage.analyse", "coverage.report"]
    kinds = [e["type"] for e in events]
    assert kinds == ["execution_started"] + ["step_started", "step_completed"] * 3 + ["execution_completed"]
    assert final(events)["status"] == "completed" and len(overpass.calls) == 1


def test_results_are_passed_between_steps_and_rendered_by_existing_serialisers(overpass):
    events = execute(make_plan(COVERAGE_Q))
    result = result_for(events, "coverage")
    workflow = result["workflow"]
    assert workflow["type"] == "coverage" and workflow["outcome"] == "completed"
    assert workflow["analysis"]["coverage"]["services_count"] == 3  # discovered features reached the analysis
    assert {layer.get("style") for layer in result["layers"]} == {"coverage", None}
    assert "Coverage of hospitals" in result["message"]


def test_independent_branch_survives_a_failed_branch(overpass):
    overpass.fail_area = "b"
    events = execute(make_plan(COMPLEX, b=B))
    assert final(events)["status"] == "partial"
    comparison = result_for(events, "comparison")
    assert comparison["outcome"] == "partial"
    assert comparison["workflow"]["analysis"]["areas"]["b"]["metrics"] is None  # missing, not zero
    assert comparison["workflow"]["analysis"]["areas"]["a"]["metrics"] is not None
    assert {layer["area"] for layer in comparison["layers"]} == {"a"}  # Area A preserved
    assert result_for(events, "suitability")["outcome"] in ("completed", "partial")
    assert "step_failed" in step_events(events, "comparison.area_b")


def test_required_dependency_failure_blocks_downstream(overpass):
    overpass.fail = {"hospital"}
    events = execute(make_plan(COVERAGE_Q))
    assert step_events(events, "coverage.find_services")[-1] == "step_failed"
    assert step_events(events, "coverage.analyse") == ["step_blocked"]
    assert step_events(events, "coverage.report") == ["step_blocked"]
    assert final(events)["type"] == "execution_failed" and final(events)["status"] == "failed"
    result = result_for(events, "coverage")
    assert "coverage" not in result["workflow"]["analysis"] and result["layers"] == []


def test_optional_dependency_failure_allows_valid_continuation(overpass):
    overpass.fail = {"healthcare"}
    events = execute(make_plan("Find suitable locations for a new hospital"))
    assert step_events(events, "suitability.find_context")[-1] == "step_failed"
    assert step_events(events, "suitability.score")[-1] in ("step_completed", "step_partial")
    suitability = result_for(events, "suitability")["workflow"]["analysis"]["suitability"]
    density = next(c for c in suitability["criteria"] if c["id"] == "facility_density")
    assert density["status"] == "unavailable" and density["weight"] == 0
    assert final(events)["status"] == "partial"


def test_suitability_facility_failure_produces_no_ranking(overpass):
    overpass.fail = {"hospital"}
    events = execute(make_plan("Find suitable locations for a new hospital"))
    result = result_for(events, "suitability")
    assert result["outcome"] == "failed" and "suitability" not in result["workflow"]["analysis"]
    assert step_events(events, "suitability.score") == ["step_blocked"]
    assert final(events)["status"] == "failed"


def test_duplicate_discovery_is_reused(overpass):
    events = execute(make_plan(COMPLEX, b=B))
    reuse = next(e for e in events if e.get("step_id") == "suitability.find_existing" and e["type"] == "step_completed")
    assert reuse["reused_from"] == "comparison.area_a" and "no new request" in reuse["summary"]
    # Area A, Area B, healthcare context: the suitability hospital search was not repeated.
    assert [_kind(q) for q in overpass.calls] == ["hospital", "hospital", "healthcare"]
    assert final(events)["status"] == "completed"


def test_incompatible_discovery_is_not_reused(overpass):
    plan = make_plan("Compare coverage of hospitals between two areas and find suitable locations for a new pharmacy", b=B)
    events = execute(plan)
    find = next(e for e in events if e.get("step_id") == "suitability.find_existing" and e["type"] == "step_completed")
    assert find["reused_from"] is None
    assert [_kind(q) for q in overpass.calls] == ["hospital", "hospital", "pharmacy", "healthcare"]


def test_plan_level_merge_keeps_both_workflows_complete(overpass):
    events = execute(make_plan("Find suitable locations for a new hospital in underserved areas"))
    suitability = result_for(events, "suitability")["workflow"]["analysis"]
    assert suitability["data_sources"]["existing"]["label"] == "Hospitals"  # found via the alias
    assert len([q for q in overpass.calls if _kind(q) == "hospital"]) == 1


def test_stop_skips_only_that_capability(overpass):
    overpass.empty = {"hospital"}
    events = execute(make_plan("Find hospitals within 5 km and identify which hospitals have the most pharmacies within 1 km"))
    assert step_events(events, "nearby_count.find_nearby") == ["step_skipped"]
    assert final(events)["status"] in ("completed", "completed_with_warnings")
    assert "nothing to analyse" in result_for(events, "nearby_count")["message"]


def test_agent_tool_plan_runs_through_execute_tool(overpass):
    events = execute(make_plan("Which is the nearest pharmacy?"))
    assert [e["step_id"] for e in events if e["type"] == "step_completed"] == [
        "find_nearest_features.discover", "find_nearest_features.rank",
    ]
    result = result_for(events, "find_nearest_features")
    assert result["outcome"] == "completed" and len(result["layers"]) == 1


def test_truncated_data_is_partial_with_warning(overpass):
    overpass.many = {"hospital"}
    events = execute(make_plan(COVERAGE_Q))
    partial = next(e for e in events if e["type"] == "step_partial")
    assert partial["step_id"] == "coverage.find_services" and "incomplete" in partial["warning"]
    assert final(events)["status"] == "completed_with_warnings"


# Streaming safety

def test_errors_never_leak_internals(overpass, monkeypatch):
    def explode(*args, **kwargs):
        raise RuntimeError("secret-token-123 at /srv/app.py line 9")

    monkeypatch.setattr(coverage, "analyse", explode)
    with client.stream("POST", "/api/research/execute", json=body(make_plan(COVERAGE_Q))) as stream:
        text = stream.read().decode()
    assert "secret-token-123" not in text and "Traceback" not in text and "/srv/" not in text
    assert "The step failed unexpectedly." in text


# State, cancellation and the registry

async def run_direct(plan, on_event=None, before=None):
    execution = ro.REGISTRY.create(plan, ro.validate_for_execution(plan))
    events = []

    async def emit(event):
        events.append(event)
        if on_event:
            on_event(execution, event)

    if before:
        before(execution)
    execution.task = asyncio.current_task()
    await ro.run_execution(execution, emit, 30)
    return execution, events


def test_state_after_completion(overpass):
    events = execute(make_plan(COVERAGE_Q))
    state = client.get(f"/api/research/executions/{events[0]['execution_id']}").json()
    assert state["status"] == "completed" and state["completed_steps"] == state["total_steps"] == 3
    assert all(s["status"] == "completed" and s["finished_at"] for s in state["steps"])
    assert state["results"][0]["capability_id"] == "coverage" and "layers" not in state["results"][0]
    assert len(json.dumps(state)) < 20_000  # no GIS payloads retained


def test_cancel_before_execution_runs_nothing(overpass):
    execution, events = asyncio.run(run_direct(make_plan(COVERAGE_Q), before=lambda e: e.request_cancel()))
    assert [e["type"] for e in events] == ["execution_started", "execution_cancelled"]
    assert execution.status == "cancelled" and overpass.calls == []
    assert all(r.status == "cancelled" for r in execution.records.values())


def test_cancel_during_active_request(overpass):
    overpass.delay = 5

    plan = make_plan(COVERAGE_Q)

    async def scenario():
        overpass.started = asyncio.Event()
        task = asyncio.create_task(run_direct(plan))
        await overpass.started.wait()
        execution = next(iter(ro.REGISTRY._items.values()))
        execution.task = task
        execution.request_cancel()
        try:
            return await task
        except asyncio.CancelledError:
            return execution, None

    execution, _ = asyncio.run(scenario())
    assert overpass.cancelled == 1  # the in-flight HTTP request was cancelled
    assert execution.status == "cancelled"
    assert execution.records["coverage.find_services"].status == "cancelled"


def test_cancel_between_steps_keeps_completed_results(overpass):
    def cancel_after_first(execution, event):
        if event["type"] == "step_completed":
            execution.request_cancel()

    execution, events = asyncio.run(run_direct(make_plan(COVERAGE_Q), on_event=cancel_after_first))
    assert events[-1]["type"] == "execution_cancelled"
    steps = {s["id"]: s["status"] for s in events[-1]["result"]["steps"]}
    assert steps == {"coverage.find_services": "completed", "coverage.analyse": "cancelled", "coverage.report": "cancelled"}
    assert len(overpass.calls) == 1


def test_cancel_endpoint(overpass):
    assert client.post("/api/research/executions/rx-missing/cancel").status_code == 404
    events = execute(make_plan(COVERAGE_Q))
    response = client.post(f"/api/research/executions/{events[0]['execution_id']}/cancel")
    assert response.status_code == 409 and "already finished" in response.json()["detail"]


def test_disconnect_cancels_the_run(overpass):
    overpass.delay = 5
    overpass.started = None

    class Disconnecting:
        async def is_disconnected(self):
            return bool(overpass.calls)

    plan = make_plan(COVERAGE_Q)

    async def scenario():
        request = research_router.ResearchExecuteRequest(plan=plan)
        response = await research_router.execute_research(request, Disconnecting())
        events = [json.loads(chunk) async for chunk in response.body_iterator]
        await asyncio.sleep(0.05)
        return events

    events = asyncio.run(scenario())
    execution = next(iter(ro.REGISTRY._items.values()))
    assert execution.status == "cancelled" and "execution_completed" not in [e["type"] for e in events]
    assert all(r.state is None for r in execution.records.values())


def test_expired_execution():
    registry = ro.ExecutionRegistry(ttl_seconds=0)
    plan = make_plan(COVERAGE_Q)
    execution = registry.create(plan, ro.validate_for_execution(plan))
    execution.close("cancelled")
    assert registry.get(execution.id) is None
    response = client.get("/api/research/executions/rx-unknown")
    assert response.status_code == 404 and "lost when the server restarts" in response.json()["detail"]


def test_registry_is_bounded():
    plan = make_plan(COVERAGE_Q)
    steps = ro.validate_for_execution(plan)
    registry = ro.ExecutionRegistry(max_retained=2, max_active=1)
    first = registry.create(plan, steps)
    with pytest.raises(ro.ExecutionRejected) as busy:
        registry.create(plan, steps)
    assert busy.value.status_code == 429
    first.close("completed")
    second = registry.create(plan, steps)
    second.close("completed")
    registry.create(plan, steps)
    assert len(registry) == 2 and registry.get(first.id) is None  # oldest finished evicted


def test_execution_releases_gis_payloads(overpass):
    execution, _ = asyncio.run(run_direct(make_plan(COMPLEX, b=B)))
    assert all(r.state is None and r.layers == [] for r in execution.records.values())


def test_result_size_is_bounded(overpass, monkeypatch):
    monkeypatch.setattr(ro, "MAX_RESULT_BYTES", 2_000)
    events = execute(make_plan(COVERAGE_Q))
    assert all(layer.get("style") != "coverage" for layer in result_for(events, "coverage")["layers"])
    assert any("omitted" in w for w in final(events)["result"]["warnings"])


def test_budget_scales_per_workflow_and_is_capped():
    assert ro.execution_budget(make_plan(COVERAGE_Q), 90) == 90
    assert ro.execution_budget(make_plan(COMPLEX, b=B), 90) == 180
    assert ro.execution_budget(make_plan(COMPLEX, b=B), 300) == ro.MAX_EXECUTION_SECONDS


def test_existing_streams_unaffected(overpass, monkeypatch):
    monkeypatch.setattr("app.routers.agent.create_provider", lambda settings: None)
    with client.stream("POST", "/api/agent/chat/stream", json={"message": COVERAGE_Q, "coordinates": A}) as stream:
        kinds = [json.loads(line)["type"] for line in stream.iter_lines() if line]
    assert kinds[0] == "plan_created" and kinds[-1] == "result"
