import asyncio
import json
import math

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Point, shape

from app.main import app
from app.routers import agent as agent_router
from app.services import coverage, mcda, osm_discovery as od, suitability
from app.services.workflows.catalog import (
    SuitabilityRequest,
    SuitabilitySettings,
    build_suitability_plan,
    match_comparison,
    match_coverage,
    match_suitability,
    match_workflow,
    run_suitability_workflow,
    serialize_suitability,
)
from app.services.workflows.plan import PlanError, validate_plan
from app.services.workflows.steps import WORKFLOW_TOOLS

CENTRE = (77.2167, 28.6315)  # Delhi
HOSPITAL = SuitabilityRequest("hospital", 5)
DEFAULTS = SuitabilitySettings(weights=suitability.validate_weights("hospital", None, None))


def crit(cid="x", higher=True, method="saturating", saturation=10.0):
    return mcda.Criterion(cid, cid.upper(), "", "m", higher, method, saturation)


# Weights

def test_weights_normalised_to_one_in_criterion_order():
    weights = mcda.normalize_weights({"b": 1, "a": 3}, ["a", "b", "c"])
    assert list(weights) == ["a", "b"] and weights == {"a": 0.75, "b": 0.25}
    assert math.isclose(sum(weights.values()), 1.0)


def test_zero_weight_disables_criterion():
    assert mcda.normalize_weights({"a": 2, "b": 0}, ["a", "b"]) == {"a": 1.0}


@pytest.mark.parametrize("weights,message", [
    ({}, "at least one"),
    ({"a": -1, "b": 2}, "negative"),
    ({"a": float("nan")}, "finite"),
    ({"a": float("inf")}, "finite"),
    ({"a": True}, "finite"),
    ({"a": "1"}, "finite"),
    ({"a": 0, "b": 0}, "above zero"),
    ({"a": 1, "zzz": 1}, "Unknown"),
    ({f"k{i}": 1 for i in range(11)}, "At most 10"),
])
def test_invalid_weights_rejected(weights, message):
    allowed = ["a", "b"] + [f"k{i}" for i in range(11)]
    with pytest.raises(mcda.MCDAError, match=f"(?i){message}"):
        mcda.normalize_weights(weights, allowed)


def test_facility_weight_validation():
    defaults = suitability.validate_weights("hospital", None, None)
    assert defaults == {"distance_existing": 0.35, "service_gap": 0.35, "facility_density": 0.3}
    with pytest.raises(suitability.SuitabilityError, match="hard constraint"):
        suitability.validate_weights("hospital", {"within_study_area": 1}, None)
    with pytest.raises(suitability.SuitabilityError, match="closer to or farther"):
        suitability.validate_weights("hospital", {"pharmacy_proximity": 1}, None)
    with pytest.raises(suitability.SuitabilityError, match="Unknown"):
        suitability.validate_weights("school", {"pharmacy_proximity": 1}, "closer")
    with pytest.raises(suitability.SuitabilityError, match="supports"):
        suitability.validate_weights("park", None, None)
    assert suitability.validate_weights("hospital", {"pharmacy_proximity": 1}, "farther") == {"pharmacy_proximity": 1.0}


# Normalisation

def test_saturating_normalisation_both_directions_and_clamped():
    values = [0, 5, 10, 25, None]
    assert mcda.normalize_values(values, crit(higher=True))[0] == [0.0, 50.0, 100.0, 100.0, None]
    assert mcda.normalize_values(values, crit(higher=False))[0] == [100.0, 50.0, 0.0, 0.0, None]


def test_minmax_normalisation_and_identical_values():
    scores, note = mcda.normalize_values([2, 4, 6], crit(method="minmax"))
    assert scores == [0.0, 50.0, 100.0] and note is None
    assert mcda.normalize_values([2, 4, 6], crit(method="minmax", higher=False))[0] == [100.0, 50.0, 0.0]

    scores, note = mcda.normalize_values([3, 3, None], crit(method="minmax"))
    assert scores == [50.0, 50.0, None] and note == "no_variation"


def test_missing_values_never_become_zero():
    scores, note = mcda.normalize_values([None, None], crit())
    assert scores == [None, None] and note == "unavailable"


# Scoring and ranking

CRITERIA = {"a": crit("a"), "b": crit("b", higher=False)}


def test_weighted_score_is_sum_of_contributions():
    result = mcda.score_candidates(
        [{"id": "p", "values": {"a": 10, "b": 10}}, {"id": "q", "values": {"a": 5, "b": 0}}],
        CRITERIA,
        {"a": 0.25, "b": 0.75},
    )
    q, p = result["ranked"]
    assert (q["id"], q["score"], p["score"]) == ("q", 87.5, 25.0)
    assert q["criteria"]["a"] == {"raw": 5, "normalized": 50.0, "weight": 0.25, "contribution": 12.5}
    assert sum(part["contribution"] for part in q["criteria"].values()) == q["score"]


def test_ties_share_rank_and_order_by_id():
    result = mcda.score_candidates(
        [{"id": i, "values": {"a": v, "b": 0}} for i, v in (("c", 5), ("a", 5), ("b", 10))],
        CRITERIA,
        {"a": 0.5, "b": 0.5},
    )
    assert [(e["id"], e["rank"], e["tied"]) for e in result["ranked"]] == [
        ("b", 1, False), ("a", 2, True), ("c", 2, True),
    ]


def test_unavailable_criterion_dropped_and_weights_renormalised():
    result = mcda.score_candidates(
        [{"id": "p", "values": {"a": 10, "b": None}}, {"id": "q", "values": {"a": 0, "b": None}}],
        CRITERIA,
        {"a": 0.4, "b": 0.6},
    )
    assert result["dropped_criteria"] == ["b"]
    assert result["weights"] == {"a": 1.0} and result["requested_weights"] == {"a": 0.4, "b": 0.6}
    assert [e["score"] for e in result["ranked"]] == [100.0, 0.0]


def test_candidate_missing_a_value_is_unscored_not_zero():
    result = mcda.score_candidates(
        [{"id": "p", "values": {"a": 10, "b": 5}}, {"id": "q", "values": {"a": 10, "b": None}}],
        CRITERIA,
        {"a": 0.5, "b": 0.5},
    )
    assert [e["id"] for e in result["ranked"]] == ["p"]
    assert result["unscored"][0]["id"] == "q" and "B" in result["unscored"][0]["reason"]
    assert "score" not in result["unscored"][0]


def test_no_evaluable_criteria_is_an_error():
    with pytest.raises(mcda.MCDAError):
        mcda.score_candidates([{"id": "p", "values": {"a": None}}], CRITERIA, {"a": 1.0})


def test_explanations_and_pair_comparison():
    result = mcda.score_candidates(
        [{"id": "p", "values": {"a": 10, "b": 10}}, {"id": "q", "values": {"a": 9, "b": 0}}],
        CRITERIA,
        {"a": 0.5, "b": 0.5},
    )
    top, second = result["ranked"]
    assert top["strengths"] == ["A: strong (90/100)", "B: strong (100/100)"]
    assert second["weaknesses"] == ["B: weak (0/100)"]

    pair = mcda.compare_pair(top, second, CRITERIA)
    assert pair["rows"][0]["criterion"] == "b" and pair["rows"][0]["difference"] == 50.0
    assert pair["score_difference"] == 45.0 and "b (50.00 points in favour of q)" in pair["text"]


def test_scoring_is_deterministic():
    rows = [{"id": f"c{i}", "values": {"a": i % 4, "b": i % 3}} for i in range(30)]
    first = mcda.score_candidates(rows, CRITERIA, {"a": 0.5, "b": 0.5})
    second = mcda.score_candidates(list(reversed(rows)), CRITERIA, {"a": 0.5, "b": 0.5})
    assert [(e["id"], e["score"]) for e in first["ranked"]] == [(e["id"], e["score"]) for e in second["ranked"]]


# Candidates

@pytest.mark.parametrize("radius_km", [0.5, 2, 5, 10])
def test_candidate_grid_bounded_stable_and_distributed(radius_km):
    size, grid, dropped = suitability.candidate_grid(radius_km, 100)
    again = suitability.candidate_grid(radius_km, 100)

    assert 0 < len(grid) <= 100 and [c for c, _ in grid] == [c for c, _ in again[1]]
    assert len({c for c, _ in grid}) == len(grid) and all(c.startswith("c-r") for c, _ in grid)
    area = coverage.study_area(radius_km * 1000)
    centroids = [cell.centroid for _, cell in grid]
    assert all(p.within(area) for p in centroids)
    # Every quadrant has candidates.
    for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
        assert any(p.x * sx > 0 and p.y * sy > 0 for p in centroids)
    assert all(cell.area >= suitability.MIN_CELL_FRACTION * size * size for _, cell in grid)


def test_candidate_limit_respected():
    _, grid, _ = suitability.candidate_grid(10, 20)
    assert len(grid) <= 20


# Measures

def feature(fid, lon, lat, **tags):
    return {
        "type": "Feature",
        "id": fid,
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"display_name": fid, "tags": tags},
    }


def found(features, radius_km=10, truncated=False, label="Hospitals"):
    return {
        "category": "hospital", "label": label, "search_radius_km": radius_km,
        "total_found": len(features) + (10 if truncated else 0), "returned": len(features),
        "truncated": truncated, "features": features,
    }


EXISTING = found([feature("node/1", 77.2267, 28.6315), feature("node/2", 77.19, 28.65)])
CONTEXT = found(
    [feature("node/10", 77.2167, 28.6315, amenity="pharmacy"), feature("node/11", 77.25, 28.60, amenity="clinic")],
    radius_km=7, label="All healthcare facilities",
)


def by_id(result):
    return {e["id"]: e for e in result["ranked"] + result["unscored"]}


def test_distance_matches_projection():
    result = suitability.analyse(CENTRE, "hospital", 5, EXISTING, CONTEXT)
    projection = coverage.LocalProjection.centred_on(*CENTRE)
    hospitals = [projection.project(shape(f["geometry"])) for f in EXISTING["features"]]
    for entry in result["ranked"][:10]:
        point = projection.project(Point(entry["lon"], entry["lat"]))
        expected = min(point.distance(h) for h in hospitals)
        assert entry["criteria"]["distance_existing"]["raw"] == pytest.approx(expected, abs=1.0)


def test_all_candidates_inside_study_area_and_bounded():
    result = suitability.analyse(CENTRE, "hospital", 5, EXISTING, CONTEXT)
    projection = coverage.LocalProjection.centred_on(*CENTRE)
    assert result["candidate_count"] <= 100 and result["excluded_by_constraint"] == 0
    for entry in result["ranked"]:
        assert projection.project(Point(entry["lon"], entry["lat"])).distance(Point(0, 0)) <= 5000
        assert 0 <= entry["score"] <= 100
    assert result["weight_total"] == 1.0


def test_no_existing_facilities_is_a_lower_bound_not_missing():
    result = suitability.analyse(CENTRE, "hospital", 5, found([]), CONTEXT)
    for entry in result["ranked"]:
        part = entry["criteria"]["distance_existing"]
        assert part["lower_bound"] is True and part["raw"] == 5000 and part["normalized"] == 100
        assert entry["criteria"]["service_gap"]["raw"] == 100  # no service anywhere
    assert result["existing_count"] == 0 and result["unscored_count"] == 0


def test_context_failure_drops_density_and_reports_it():
    result = suitability.analyse(CENTRE, "hospital", 5, EXISTING, None, context_error="Overpass busy.")
    density = next(c for c in result["criteria"] if c["id"] == "facility_density")
    assert density["status"] == "unavailable" and density["weight"] == 0 and "Overpass busy" in density["note"]
    assert result["weights"] == {"distance_existing": 0.5, "service_gap": 0.5}
    assert result["complete"] is False and result["unscored_count"] == 0
    assert all(e["criteria"].keys() == {"distance_existing", "service_gap"} for e in result["ranked"])


def test_density_counts_within_two_km():
    result = suitability.analyse(CENTRE, "hospital", 5, EXISTING, CONTEXT)
    projection = coverage.LocalProjection.centred_on(*CENTRE)
    context = [projection.project(shape(f["geometry"])) for f in CONTEXT["features"]]
    for entry in result["ranked"]:
        point = projection.project(Point(entry["lon"], entry["lat"]))
        expected = sum(1 for g in context if point.distance(g) <= 2000)
        assert entry["criteria"]["facility_density"]["raw"] == expected


def test_pharmacy_direction_flips_preference():
    closer = suitability.analyse(CENTRE, "hospital", 5, EXISTING, CONTEXT, {"pharmacy_proximity": 1}, "closer")
    farther = suitability.analyse(CENTRE, "hospital", 5, EXISTING, CONTEXT, {"pharmacy_proximity": 1}, "farther")
    assert closer["pharmacy_count"] == 1  # the clinic is not a pharmacy
    near = closer["ranked"][0]["criteria"]["pharmacy_proximity"]["raw"]
    far = farther["ranked"][0]["criteria"]["pharmacy_proximity"]["raw"]
    assert near < far
    a, b = by_id(closer), by_id(farther)
    for cid in a:
        assert a[cid]["score"] + b[cid]["score"] == pytest.approx(100, abs=0.02)


def test_truncation_marks_result_incomplete():
    result = suitability.analyse(CENTRE, "hospital", 5, found(EXISTING["features"], truncated=True), CONTEXT)
    assert result["complete"] is False and any("truncated" in q for q in result["data_quality"])


def test_police_reuses_existing_search_for_density():
    police = found([feature("node/5", 77.2167, 28.6315)], label="Police stations")
    result = suitability.analyse(CENTRE, "police", 5, police, None)
    assert next(c for c in result["criteria"] if c["id"] == "facility_density")["status"] == "used"


def test_minmax_option_and_invalid_options():
    result = suitability.analyse(CENTRE, "hospital", 5, EXISTING, CONTEXT, normalization="minmax")
    assert result["ranked"][0]["score"] <= 100 and result["normalization"] == "minmax"
    with pytest.raises(suitability.SuitabilityError):
        suitability.analyse(CENTRE, "hospital", 11, EXISTING, CONTEXT)
    with pytest.raises(suitability.SuitabilityError):
        suitability.analyse(CENTRE, "hospital", 5, EXISTING, CONTEXT, max_candidates=101)
    with pytest.raises(suitability.SuitabilityError):
        suitability.analyse(CENTRE, "hospital", 5, EXISTING, CONTEXT, existing_saturation_m=9000)


def test_layers_are_valid_wgs84_with_bands():
    result = suitability.analyse(CENTRE, "hospital", 5, EXISTING, CONTEXT)
    cells, points = suitability.layers(result)
    assert len(cells) == len(points) == result["candidate_count"]
    for cell, point in zip(cells, points):
        geometry = shape(cell["geometry"])
        assert geometry.is_valid and point["geometry"]["type"] == "Point"
        lon, lat = point["geometry"]["coordinates"]
        assert -180 <= lon <= 180 and -90 <= lat <= 90
        assert cell["properties"]["score_band"] == suitability.score_band(cell["properties"]["suitability_score"])
    assert suitability.score_band(None) == "unscored" and suitability.score_band(80) == "80-100"


# Request matching

@pytest.mark.parametrize("message,facility,low", [
    ("Find suitable locations for a new hospital", "hospital", False),
    ("Where should I establish a new school?", "school", False),
    ("Rank the best locations for a pharmacy", "pharmacy", False),
    ("Find areas with low healthcare facility density", "hospital", True),
    ("Best sites for a new fire station within 8 km", "fire_station", False),
    ("Suitable places for a police station", "police", False),
])
def test_match_suitability(message, facility, low):
    request = match_suitability(message)
    assert request.facility == facility and request.low_density is low


def test_match_radius_and_unsupported_facility():
    assert match_suitability("Best sites for a new fire station within 8 km").radius_km == 8
    assert match_suitability("Find suitable locations for a new park").facility is None


def test_unsupported_criteria_detected():
    request = match_suitability("Best hospital sites considering population, land cost, zoning and travel time")
    assert set(request.unsupported) == {"population", "land", "cost", "zoning", "travel_time"}


@pytest.mark.parametrize("message", [
    "Find hospitals within 5 km",
    "Identify areas within 5 km that are underserved by hospitals",
    "Compare hospital coverage in these two areas",
    "Find hospitals within 5 km and identify which hospitals have the most pharmacies within 1 km",
])
def test_earlier_workflows_not_captured(message):
    assert match_suitability(message) is None
    assert (
        match_workflow(message) or match_coverage(message) or match_comparison(message)
        or message == "Find hospitals within 5 km"
    )


# Plan

def test_plan_shapes():
    hospital = build_suitability_plan(HOSPITAL, DEFAULTS)
    assert [s["id"] for s in hospital] == ["find_existing", "find_context", "score", "report"]
    assert hospital[0]["arguments"]["radius_km"] == 10 and hospital[1]["arguments"]["radius_km"] == 7
    assert hospital[1]["optional_depends_on"] == ["find_existing"]
    validate_plan(hospital, WORKFLOW_TOOLS)

    police = build_suitability_plan(
        SuitabilityRequest("police", 5), SuitabilitySettings(weights=suitability.validate_weights("police", None, None))
    )
    assert [s["id"] for s in police] == ["find_existing", "score", "report"]
    validate_plan(police, WORKFLOW_TOOLS)

    no_density = build_suitability_plan(HOSPITAL, SuitabilitySettings(weights={"distance_existing": 1.0}))
    assert "find_context" not in [s["id"] for s in no_density]


def test_plan_rejects_raised_limits():
    for change in (
        lambda p: p[2]["arguments"].update(radius_km=11),
        lambda p: p[2]["arguments"].update(max_candidates=101),
        lambda p: p[2]["arguments"].update(weights={f"k{i}": 1 for i in range(11)}),
        lambda p: p[0]["arguments"].update(limit=501),
        lambda p: p[2]["arguments"].update(lat=1),
    ):
        plan = build_suitability_plan(HOSPITAL, DEFAULTS)
        change(plan)
        with pytest.raises(PlanError):
            validate_plan(plan, WORKFLOW_TOOLS)


# Workflow with mocked Overpass

@pytest.fixture
def overpass(monkeypatch):
    class Fake:
        fail: set[str] = set()
        calls: list[str] = []
        in_flight = 0
        max_in_flight = 0
        delay = 0.0

    async def fake_fetch(query, client=None):
        Fake.calls.append(query)
        Fake.in_flight += 1
        Fake.max_in_flight = max(Fake.max_in_flight, Fake.in_flight)
        try:
            if Fake.delay:
                await asyncio.sleep(Fake.delay)
            lat, lon = (float(v) for v in query.split("(around:")[1].split(")")[0].split(",")[1:3])
            kind = "context" if 'nwr["healthcare"]' in query or '"school"' in query and "kindergarten" in query else "existing"
            if kind in Fake.fail:
                raise od.OverpassError("The Overpass API is busy. Please retry in a moment.", 503)
            if kind == "existing":
                tags = {"amenity": "hospital"}
                offsets = [(0.01, 0), (-0.02, 0.01)]
            else:
                tags = {"amenity": "pharmacy"}
                offsets = [(0.005, 0.005), (0.03, -0.01)]
            elements = [
                {"type": "node", "id": 100 + i, "lon": lon + dx, "lat": lat + dy, "tags": {**tags, "name": f"N{i}"}}
                for i, (dx, dy) in enumerate(offsets)
            ]
            return {"elements": elements, "osm3s": {"timestamp_osm_base": "2026-10-30T00:00:00Z"}}
        finally:
            Fake.in_flight -= 1

    monkeypatch.setattr(od, "_fetch_overpass", fake_fetch)
    Fake.calls, Fake.fail, Fake.max_in_flight, Fake.delay = [], set(), 0, 0.0
    return Fake


def run(request=HOSPITAL, settings=DEFAULTS, timeout=30.0):
    events = []

    async def emit(event):
        events.append(event)

    return asyncio.run(run_suitability_workflow(request, settings, CENTRE, timeout, emit)), events


def test_workflow_completes_with_two_sequential_requests(overpass):
    result, events = run()
    assert result.outcome == "completed" and len(overpass.calls) == 2 and overpass.max_in_flight == 1
    assert events[0]["type"] == "plan_created" and events[-1]["type"] == "workflow_completed"

    workflow, layers = serialize_suitability(result)
    analysis = workflow["analysis"]["suitability"]
    assert workflow["type"] == "suitability" and "_geometry" not in analysis
    assert analysis["ranked"][0]["rank"] == 1 and len(layers) == 3
    assert [layer.get("style") for layer in layers] == ["suitability", "suitability", None]
    json.dumps(workflow)  # serialisable
    assert "Highest-scoring analytical candidate" in result.step("report").outcome.result["text"]


def test_context_failure_is_partial_not_zero(overpass):
    overpass.fail = {"context"}
    result, _ = run()
    assert result.outcome == "partial"
    analysis = serialize_suitability(result)[0]["analysis"]
    density = next(c for c in analysis["suitability"]["criteria"] if c["id"] == "facility_density")
    assert density["status"] == "unavailable" and "context search failed" in density["note"]
    assert "error" in analysis["data_sources"]["context"]


def test_existing_failure_fails_without_ranking(overpass):
    overpass.fail = {"existing"}
    result, _ = run()
    assert result.outcome == "failed"
    workflow, layers = serialize_suitability(result)
    assert "suitability" not in workflow["analysis"] and layers == []
    assert result.step("score").status == "skipped"


def test_police_uses_one_request(overpass):
    settings = SuitabilitySettings(weights=suitability.validate_weights("police", None, None))
    result, _ = run(SuitabilityRequest("police", 3), settings)
    assert result.outcome == "completed" and len(overpass.calls) == 1


def test_workflow_timeout(overpass):
    overpass.delay = 0.5
    result, _ = run(timeout=0.2)
    assert result.outcome == "failed"


def test_unsupported_criteria_reported(overpass):
    result, _ = run(SuitabilityRequest("hospital", 5, unsupported=("population", "cost")))
    caveats = result.step("report").outcome.result["caveats"]
    assert any("population or demographic data" in c and "not estimated" in c for c in caveats)


# API

client = TestClient(app)


@pytest.fixture
def no_llm(monkeypatch):
    def explode(settings):
        raise AssertionError("LLM must not be called")

    monkeypatch.setattr(agent_router, "create_provider", explode)


def chat(**body):
    return client.post("/api/agent/chat", json={"message": "Find suitable locations for a new hospital", **body})


def test_api_requires_location(overpass, no_llm):
    response = chat().json()
    assert response["needs_input"] == ["coordinates"] and overpass.calls == []


def test_api_asks_for_facility(overpass, no_llm):
    response = chat(message="Where should we build a new park?", coordinates=list(CENTRE)).json()
    assert response["needs_input"] == ["facility"] and overpass.calls == []


@pytest.mark.parametrize("weights", [
    {"distance_existing": -1},
    {"distance_existing": 0},
    {"unknown": 1},
    {"pharmacy_proximity": 1},
    {"within_study_area": 1},
])
def test_api_rejects_invalid_weights(overpass, no_llm, weights):
    body = {"coordinates": list(CENTRE), "suitability": {"facility": "hospital", "weights": weights}}
    assert chat(**body).status_code == 422
    stream = client.post("/api/agent/chat/stream", json={"message": "x", **body})
    assert stream.status_code == 422 and overpass.calls == []


def test_api_rejects_radius_over_10_km(overpass, no_llm):
    response = chat(message="Best sites for a new hospital within 20 km", coordinates=list(CENTRE)).json()
    assert response["success"] is False and "limited to a 10 km radius" in response["message"]
    assert chat(coordinates=list(CENTRE), suitability={"radius_km": 11}).status_code == 422


def test_api_options_override_message(overpass, no_llm):
    response = chat(
        message="Run site suitability",
        coordinates=list(CENTRE),
        suitability={
            "facility": "school", "radius_km": 3, "weights": {"distance_existing": 2, "service_gap": 2},
            "normalization": "minmax", "max_candidates": 50,
        },
    ).json()
    analysis = response["workflow"]["analysis"]["suitability"]
    assert response["intent"] == "suitability" and analysis["facility"] == "school"
    assert analysis["radius_km"] == 3 and analysis["candidate_count"] <= 50
    assert analysis["weights"] == {"distance_existing": 0.5, "service_gap": 0.5}
    assert len(overpass.calls) == 1  # density disabled: no context search


def test_api_low_density_question(overpass, no_llm):
    response = chat(message="Find areas with low healthcare facility density", coordinates=list(CENTRE)).json()
    assert response["workflow"]["analysis"]["suitability"]["weights"] == {"facility_density": 1.0}


def test_api_stream_sequence(overpass, no_llm):
    body = {"message": "Rank the best locations for a hospital", "coordinates": list(CENTRE)}
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
    assert response["intent"] == "suitability" and response["mode"] == "workflow" and len(response["layers"]) == 3


def test_config_endpoint():
    config = client.get("/api/agent/suitability/config").json()
    assert set(config["facilities"]) == {"hospital", "school", "pharmacy", "police", "fire_station"}
    hospital = {c["id"]: c for c in config["facilities"]["hospital"]["criteria"]}
    assert hospital["pharmacy_proximity"]["enabled_by_default"] is False
    assert hospital["pharmacy_proximity"]["direction_required"] is True
    assert config["limits"]["max_radius_km"] == 10 and config["limits"]["max_candidates"] == 100


def test_earlier_workflows_still_route(overpass, no_llm):
    response = client.post("/api/agent/chat", json={
        "message": "Identify areas within 5 km that are underserved by hospitals.",
        "coordinates": list(CENTRE),
    }).json()
    assert response["intent"] == "coverage"
