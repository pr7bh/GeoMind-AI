import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import research as research_router
from app.schemas.research import ResearchPlan, ResearchPlanRequest
from app.services import osm_discovery as od
from app.services import research_planner as rp
from app.services.agent.tools import TOOLS as AGENT_TOOLS
from app.services.llm.base import LLMConfigError, LLMResponse, LLMTimeoutError, ToolCall
from app.services.workflows import catalog
from app.services.workflows.steps import WORKFLOW_TOOLS

A = [77.2167, 28.6315]
B = [77.30, 28.55]
COMPLEX = (
    "Compare hospital accessibility between two areas, identify underserved locations, "
    "and recommend suitable locations for a new hospital."
)
LLM_ONLY = "Which neighbourhood would benefit most from more clinics?"

client = TestClient(app)


@pytest.fixture(autouse=True)
def no_overpass(monkeypatch):
    """Planning must never run a GIS step or contact Overpass."""
    calls = []

    async def explode(query, client=None):
        calls.append(query)
        raise AssertionError("Overpass must not be called while planning")

    monkeypatch.setattr(od, "_fetch_overpass", explode)
    yield calls
    assert calls == []


def plan(question, a=A, b=None, provider=None, interpreter="auto", timeout=5.0):
    request = ResearchPlanRequest(question=question, coordinates=a, compare_coordinates=b, interpreter=interpreter)
    return asyncio.run(rp.plan_research(request, provider, timeout))


def capabilities(result):
    return [c.id for c in result.capabilities]


def assert_order_respects_dependencies(result):
    position = {s.id: s.execution_order for s in result.steps}
    assert [s.execution_order for s in result.steps] == list(range(1, len(result.steps) + 1))
    for step in result.steps:
        for dep in step.dependencies + step.optional_dependencies:
            assert position[dep] < step.execution_order


# Catalog: capability ids are real

def test_capabilities_are_real_tools_or_workflow_types():
    workflow_types = {"nearby_count", "coverage", "comparison", "suitability"}
    for cid, capability in catalog.CAPABILITIES.items():
        assert cid in AGENT_TOOLS or cid in workflow_types
        assert capability.kind == ("tool" if cid in AGENT_TOOLS else "workflow")


# Intent recognition (rules only, no LLM)

@pytest.mark.parametrize("question,b,expected", [
    ("Find hospitals within 5 km.", None, ["discover_features"]),
    ("Find hospitals within 5 km and identify which hospitals have the most pharmacies within 1 km", None, ["nearby_count"]),
    ("Identify areas with poor hospital coverage around this location.", None, ["coverage"]),
    ("Compare hospital coverage between two areas.", B, ["comparison"]),
    ("Find suitable locations for a new hospital.", None, ["suitability"]),
    ("Where should I establish a new school?", None, ["suitability"]),
    ("Which is the nearest pharmacy?", None, ["find_nearest_features"]),
    ("Show schools within a 500 m buffer", None, ["spatial_query"]),
    (COMPLEX, B, ["comparison", "suitability"]),
])
def test_intent_recognition(question, b, expected):
    result = plan(question, b=b)
    assert capabilities(result) == expected
    assert result.status == "ready" and result.interpreter == "rules"
    assert all(s.status in ("ready", "planned") for s in result.steps)
    assert_order_respects_dependencies(result)


def test_unsupported_question():
    result = plan("What is the meaning of life?")
    assert result.status == "unsupported" and result.steps == [] and result.capabilities == []
    assert "Find hospitals within 5 km" in result.clarification_questions[0]


def test_ambiguous_questions_ask_or_assume_explicitly():
    no_category = plan("Compare these two areas", b=B)
    assert no_category.status == "needs_input" and [m.id for m in no_category.missing_inputs] == ["category"]
    assert no_category.steps == []

    no_radius = plan("Find hospitals")
    assert no_radius.status == "ready" and no_radius.steps[0].arguments["radius_km"] == 5
    assert any("default 5 km" in a for a in no_radius.assumptions)

    no_facility = plan("Find suitable sites for a new park")
    assert no_facility.status == "needs_input" and no_facility.missing_inputs[0].id == "facility"


# Plan construction

def test_coverage_plan_steps_and_dependencies():
    result = plan("Identify areas with poor hospital coverage around this location.")
    assert [(s.id, s.tool, s.dependencies, s.status) for s in result.steps] == [
        ("coverage.find_services", "discover_services", [], "ready"),
        ("coverage.analyse", "analyse_coverage", ["coverage.find_services"], "planned"),
        ("coverage.report", "report_coverage", ["coverage.find_services", "coverage.analyse"], "planned"),
    ]
    assert result.steps[1].arguments["services_step"] == "coverage.find_services"
    assert result.steps[2].title == "Identify underserved cells"
    assert result.steps[0].arguments == {"category": "hospital", "radius_km": 10.0, "limit": 500}


def test_complex_plan_avoids_duplicate_analysis():
    result = plan(COMPLEX, b=B)
    ids = [s.id for s in result.steps]
    assert "coverage.find_services" not in ids  # covered by the comparison
    assert ids[:4] == ["comparison.area_a", "comparison.area_b", "comparison.compare", "comparison.report"]
    assert ids[4:] == ["suitability.find_existing", "suitability.find_context", "suitability.score", "suitability.report"]
    assert any("no separate coverage analysis" in a for a in result.assumptions)
    assert any("Area A" in a for a in result.assumptions)
    assert result.objective.startswith("Compare hospital coverage between Area A and Area B; then recommend")


def test_identical_steps_are_merged_and_references_rewritten():
    result = plan("Find suitable locations for a new hospital in underserved areas")
    discovery = [s for s in result.steps if s.tool == "discover_services" and s.arguments["category"] == "hospital"]
    assert [s.id for s in discovery] == ["coverage.find_services"]
    score = next(s for s in result.steps if s.id == "suitability.score")
    assert score.arguments["existing_step"] == "coverage.find_services"
    assert score.dependencies == ["coverage.find_services"]
    assert_order_respects_dependencies(result)


def test_step_arguments_are_executable_by_existing_tools():
    for question, b in ((COMPLEX, B), ("Find hospitals within 5 km and identify which hospitals have the most pharmacies within 1 km", None),
                        ("Show schools within a 500 m buffer", None)):
        for step in plan(question, b=b).steps:
            model = (WORKFLOW_TOOLS[step.tool] if step.capability_id in {"nearby_count", "coverage", "comparison", "suitability"}
                     else AGENT_TOOLS[step.tool]).args_model
            model.model_validate(step.arguments)
            assert not any(k in step.arguments for k in ("lat", "lon", "coordinates", "location"))


def test_plans_are_deterministic_and_serialisable():
    first, second = plan(COMPLEX, b=B), plan(COMPLEX, b=B)
    assert first.id == second.id and first.steps == second.steps
    assert plan(COMPLEX, b=[77.31, 28.55]).id != first.id

    restored = ResearchPlan.model_validate(json.loads(first.model_dump_json()))
    assert restored == first
    assert restored.executed is False


# Missing inputs

def test_missing_location_blocks_every_located_step():
    result = plan("Find suitable locations for a new hospital.", a=None)
    assert result.status == "needs_input"
    assert result.missing_inputs[0].id == "location" and result.missing_inputs[0].action == "pick_location"
    assert result.clarification_questions == ["Select a location on the map to define the study area."]
    assert all(s.status == "blocked" for s in result.steps)


def test_missing_area_b_blocks_only_area_b():
    result = plan("Compare hospital coverage between two areas.")
    assert result.status == "needs_input"
    assert [m.id for m in result.missing_inputs] == ["compare_location"]
    status = {s.id: s.status for s in result.steps}
    assert status["comparison.area_b"] == "blocked" and status["comparison.area_a"] == "ready"
    assert "Select the second area on the map." in result.clarification_questions
    assert next(a for a in result.selected_areas if a.id == "b").required is True


def test_unavailable_criteria_are_explained_not_estimated():
    result = plan("Find suitable hospital sites based on population density and land ownership")
    assert capabilities(result) == ["suitability"]
    note = " ".join(result.limitations)
    assert "population" in note and "land" in note and "not estimated" in note
    assert "Supported criteria instead" in note


# Limits and validation

@pytest.mark.parametrize("question", [
    "Identify areas within 20 km that are underserved by hospitals",
    "Best sites for a new hospital within 15 km",
])
def test_radius_limits_make_plan_invalid(question):
    result = plan(question)
    assert result.status == "invalid" and result.steps == []
    assert any("limited to a 10 km radius" in c for c in result.clarification_questions)


def test_discovery_radius_over_category_limit_is_invalid():
    result = plan("Find buildings within 3 km")  # building discovery is limited to 2 km
    assert result.status == "invalid" and "limited to" in result.clarification_questions[-1]


def step(id_, deps=(), capability="coverage", tool="discover_services", optional=()):
    return {"id": id_, "capability_id": capability, "tool": tool, "description": "d", "arguments": {},
            "depends_on": list(deps), "optional_depends_on": list(optional)}


@pytest.mark.parametrize("steps,message", [
    ([step("a", ["b"]), step("b", ["a"])], "circular"),
    ([step("a"), step("a")], "unique"),
    ([step("a", ["missing"])], "unknown step"),
    ([step("a", ["a"])], "itself"),
    ([step("a", capability="teleport")], "Unknown capability"),
    ([step("a", tool="drop_table")], "Unknown tool"),
])
def test_dependency_validation(steps, message):
    with pytest.raises(rp.ResearchPlanError, match=message):
        rp.validate_research_steps(steps)


def test_validation_orders_steps_stably():
    ordered = rp.validate_research_steps([step("c", ["a"]), step("a"), step("b", optional=["a"])])
    assert [s["id"] for s in ordered] == ["a", "c", "b"]


# LLM interpretation (mocked provider)

class Provider:
    name, model = "fake", "fake-model"

    def __init__(self, *responses, delay=0.0):
        self.responses, self.calls, self.delay = list(responses), [], delay

    async def chat(self, messages, tools):
        self.calls.append({"messages": messages, "tools": tools})
        if self.delay:
            await asyncio.sleep(self.delay)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def proposal(intents, objective="Assess clinic access", name="propose_research_plan"):
    arguments = {"objective": objective, "intents": intents}
    return LLMResponse("", [ToolCall("c1", name, arguments, json.dumps(arguments))])


def test_rules_handle_supported_questions_without_calling_the_llm():
    provider = Provider()
    result = plan("Identify areas with poor hospital coverage around this location.", provider=provider)
    assert result.interpreter == "rules" and provider.calls == []


def test_no_llm_configured_falls_back_to_rules():
    assert rp.rule_intents(LLM_ONLY)[0] == []
    result = plan(LLM_ONLY, provider=None)
    assert result.status == "unsupported" and result.interpreter == "rules"


def test_valid_llm_proposal_goes_through_the_same_builders():
    provider = Provider(proposal([{"capability_id": "coverage", "category": "clinics", "radius_km": 3}]))
    result = plan(LLM_ONLY, provider=provider)
    assert result.interpreter == "llm" and result.status == "ready"
    assert [s.id for s in result.steps] == ["coverage.find_services", "coverage.analyse", "coverage.report"]
    assert result.steps[0].arguments["category"] == "clinic"
    tool_names = [t["function"]["name"] for t in provider.calls[0]["tools"]]
    assert tool_names == ["propose_research_plan"]


@pytest.mark.parametrize("response", [
    proposal([{"capability_id": "teleport_hospital"}]),                                  # invented capability
    proposal([{"capability_id": "coverage", "category": "hospital", "lat": 1, "lon": 2}]),  # coordinates
    proposal([{"capability_id": "coverage", "category": "unicorns"}]),                   # unknown dataset
    proposal([{"capability_id": "coverage", "category": "restaurant"}]),                 # not a service
    proposal([{"capability_id": "coverage", "category": "hospital", "radius_km": -3}]),  # bad value
    proposal([], objective="nothing"),                                                   # empty
    proposal([{"capability_id": "coverage", "category": "hospital"}], name="run_sql"),   # wrong tool
    LLMResponse("Just build a hospital downtown."),                                      # no tool call
    LLMResponse("", [ToolCall("c1", "propose_research_plan", None, "{not json")]),       # malformed
])
def test_invalid_llm_output_never_becomes_a_plan(response):
    result = plan(LLM_ONLY, provider=Provider(response))
    assert result.status == "unsupported" and result.steps == [] and result.interpreter == "rules"
    assert any("could not produce a valid plan" in note for note in result.limitations)


def test_llm_radius_over_limit_is_invalid_not_clamped():
    result = plan(LLM_ONLY, provider=Provider(proposal([{"capability_id": "coverage", "category": "clinic", "radius_km": 25}])))
    assert result.status == "invalid" and result.interpreter == "llm"


@pytest.mark.parametrize("provider,reason", [
    (Provider(LLMTimeoutError("The model took too long to respond.")), "took too long"),
    (Provider(LLMResponse("late"), delay=rp.LLM_TIMEOUT_MARGIN_SECONDS + 0.5), "timed out"),
])
def test_provider_failures_fall_back(provider, reason):
    result = plan(LLM_ONLY, provider=provider, timeout=0.1)
    assert result.status == "unsupported" and any(reason in note for note in result.limitations)


def test_rules_interpreter_never_calls_the_llm():
    provider = Provider()
    plan(LLM_ONLY, provider=provider, interpreter="rules")
    assert provider.calls == []


# API

def post(**body):
    return client.post("/api/research/plan", json={"coordinates": A, **body})


def test_api_plan_ready_without_llm(monkeypatch):
    monkeypatch.setattr(research_router, "create_provider", lambda settings: None)
    response = post(question="Find hospitals within 5 km.")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ready" and data["executed"] is False and data["interpreter"] == "rules"
    assert data["steps"][0]["capability_id"] == "discover_features"
    assert data["id"].startswith("rp-") and data["created_at"]


def test_api_needs_input_and_unsupported(monkeypatch):
    monkeypatch.setattr(research_router, "create_provider", lambda settings: None)
    needs = client.post("/api/research/plan", json={"question": "Find suitable locations for a new hospital."}).json()
    assert needs["status"] == "needs_input" and needs["missing_inputs"][0]["id"] == "location"
    unsupported = post(question="What is the meaning of life?").json()
    assert unsupported["status"] == "unsupported"


@pytest.mark.parametrize("body", [
    {"question": ""},
    {"question": "x" * 2001},
    {"question": "Find hospitals", "coordinates": [181, 0]},
    {"question": "Find hospitals", "compare_coordinates": [0, 91]},
    {"question": "Find hospitals", "coordinates": [1]},
    {"question": "Find hospitals", "execute": True},
    {"question": "Find hospitals", "interpreter": "magic"},
])
def test_api_rejects_invalid_requests(body):
    assert client.post("/api/research/plan", json=body).status_code == 422


def test_api_misconfigured_llm_still_plans(monkeypatch):
    def misconfigured(settings):
        raise LLMConfigError("LLM_PROVIDER=remote requires LLM_API_KEY.")

    monkeypatch.setattr(research_router, "create_provider", misconfigured)
    data = post(question=LLM_ONLY).json()
    assert data["status"] == "unsupported" and "misconfigured" in data["limitations"][0]


def test_api_rules_interpreter_skips_provider(monkeypatch):
    def explode(settings):
        raise AssertionError("provider must not be created")

    monkeypatch.setattr(research_router, "create_provider", explode)
    assert post(question=LLM_ONLY, interpreter="rules").json()["status"] == "unsupported"


def test_existing_endpoints_unaffected(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "none")
    assert client.get("/api/agent/status").json()["configured"] is False
    assert client.get("/api/agent/suitability/config").status_code == 200
