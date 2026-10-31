import asyncio
import copy
import json
import re

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import research as research_router
from app.services import research_evidence, research_synthesis as rs
from app.services import research_orchestrator as ro
from app.services.llm.base import LLMResponse, LLMTimeoutError, ToolCall
from test_research_orchestrator import (  # noqa: F401 - shared fixtures
    A, B, COMPLEX, COVERAGE_Q, execute, fresh_registry, make_plan, overpass,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def no_llm(monkeypatch):
    monkeypatch.setattr(research_router, "create_provider", lambda settings: None)


def run(question, a=A, b=None):
    events = execute(make_plan(question, a, b))
    return events[0]["execution_id"], events


def synthesize(execution_id, mode="auto"):
    response = client.post(f"/api/research/executions/{execution_id}/synthesize", json={"mode": mode})
    assert response.status_code == 200, response.text
    return response.json()


def evidence_by_id(synthesis):
    return {e["evidence_id"]: e for e in synthesis["evidence"]}


def assert_traceable(synthesis):
    evidence = evidence_by_id(synthesis)
    for item in synthesis["key_findings"] + synthesis["recommendations"]:
        assert item["evidence_ids"] and all(i in evidence for i in item["evidence_ids"])
    for item in synthesis["comparisons"] + synthesis["candidate_insights"]:
        assert all(i in evidence for i in item["evidence_ids"])
    for item in synthesis["evidence"]:
        assert item["source_execution_id"] == synthesis["execution_id"] and item["source_dataset"]
        assert item["kind"] in ("measured", "derived", "interpretation", "assumption")


def result_analysis(events, capability):
    return next(r for r in events[-1]["result"]["results"] if r["capability_id"] == capability)["workflow"]["analysis"]


# Deterministic synthesis per workflow

def test_coverage_synthesis_uses_actual_values(overpass):
    xid, events = run(COVERAGE_Q)
    calls = len(overpass.calls)
    synthesis = synthesize(xid)
    assert len(overpass.calls) == calls  # synthesis never fetches data
    assert synthesis["overall_status"] == "complete" and synthesis["synthesis_mode"] == "deterministic"
    summary = result_analysis(events, "coverage")["coverage"]
    evidence = evidence_by_id(synthesis)
    assert evidence["coverage:underserved_pct"]["observed_value"] == summary["percentages"]["underserved"]
    assert evidence["coverage:services_found"]["observed_value"] == summary["services_count"]
    assert evidence["coverage:underserved_pct"]["source_step_id"] == "coverage.analyse"
    finding = next(f for f in synthesis["key_findings"] if f["finding_id"] == "F-coverage")
    assert f"{summary['percentages']['underserved']:g}%" in finding["conclusion"]
    assert_traceable(synthesis)


def test_comparison_and_suitability_are_connected_but_not_conflated(overpass):
    xid, events = run(COMPLEX + " considering population and zoning", b=B)
    synthesis = synthesize(xid)
    assert_traceable(synthesis)
    metrics = {c["metric"]: c for c in synthesis["comparisons"]}
    rows = {r["label"]: r for r in result_analysis(events, "comparison")["metrics"]}
    for label, row in rows.items():
        assert (metrics[label]["a_value"], metrics[label]["b_value"]) == (row["a"], row["b"])
        assert metrics[label]["comparable"] is True
    ids = {f["finding_id"] for f in synthesis["key_findings"]}
    assert {"F-suitability", "F-cross-coverage-suitability", "F-scope-comparison-suitability"} <= ids
    text = json.dumps(synthesis).lower()
    assert "overall winner" not in text.replace("no overall winner", "") and "best overall" not in text
    assert any("population" in q.lower() for q in synthesis["unsupported_questions"])
    assert any("zoning" in q.lower() for q in synthesis["unsupported_questions"])
    candidates = synthesis["candidate_insights"]
    assert len(candidates) == 5 and all("not a verified or available land parcel" in c["caveat"] for c in candidates)
    ranked = result_analysis(events, "suitability")["suitability"]["ranked"]
    assert [c["candidate_id"] for c in candidates] == [c["id"] for c in ranked[:5]]
    assert [c["score"] for c in candidates] == [c["score"] for c in ranked[:5]]


def test_candidate_coverage_class_matches_the_coverage_grid(overpass):
    xid, events = run("Find suitable locations for a new hospital in underserved areas")
    synthesis = synthesize(xid)
    evidence = evidence_by_id(synthesis)
    for candidate in synthesis["candidate_insights"]:
        assert candidate["coverage_class"] in ("well_covered", "moderate", "underserved", "no_service_found")
        assert evidence[f"cross:{candidate['candidate_id']}:coverage_class"]["kind"] == "derived"
    finding = next(f for f in synthesis["key_findings"] if f["finding_id"] == "F-cross-coverage-suitability")
    assert "not independent confirmation" in finding["explanation"]


def test_nearby_count_synthesis(overpass):
    xid, events = run("Find hospitals within 5 km and identify which hospitals have the most pharmacies within 1 km")
    synthesis = synthesize(xid)
    ranking = result_analysis(events, "nearby_count")["ranking"]
    top = next(f for f in synthesis["key_findings"] if f["finding_id"] == "F-nearby-top")
    assert ranking[0]["name"] in top["conclusion"] and str(ranking[0]["nearby_count"]) in top["conclusion"]
    assert_traceable(synthesis)


def test_discovery_tool_synthesis(overpass):
    xid, _ = run("Which is the nearest pharmacy?")
    synthesis = synthesize(xid)
    assert synthesis["key_findings"] and synthesis["evidence"][0]["finding_type"] == "measurement"
    assert_traceable(synthesis)


# Missing data, contradictions and uncertainty

def test_failed_area_is_missing_not_zero(overpass):
    overpass.fail_area = "b"
    xid, _ = run(COMPLEX, b=B)
    synthesis = synthesize(xid)
    assert synthesis["overall_status"] == "partial"
    for comparison in synthesis["comparisons"]:
        assert comparison["b_value"] is None and comparison["comparable"] is False and comparison["better"] is None
        assert "missing, not zero" in comparison["note"]
    assert not any(f["finding_id"].startswith("F-compare-") for f in synthesis["key_findings"])
    assert any("Area B could not be analysed" in w for w in synthesis["data_quality_warnings"])
    assert "incomplete" in synthesis["executive_summary"]


def test_truncated_discovery_is_flagged(overpass):
    overpass.many = {"hospital"}
    xid, _ = run(COVERAGE_Q)
    synthesis = synthesize(xid)
    assert synthesis["overall_status"] == "partial"
    assert evidence_by_id(synthesis)["coverage:services_found"]["partial_or_truncated"] is True
    assert any("truncated" in w for w in synthesis["data_quality_warnings"])


def test_failed_execution_has_no_conclusions(overpass):
    overpass.fail = {"hospital"}
    xid, _ = run(COVERAGE_Q)
    synthesis = synthesize(xid)
    assert synthesis["overall_status"] == "failed" and synthesis["key_findings"] == []
    assert "no conclusions" in synthesis["executive_summary"]


def test_mismatched_settings_are_not_compared(overpass):
    xid, _ = run(COMPLEX, b=B)
    digest = copy.deepcopy(ro.REGISTRY.get(xid).digest)
    digest["capabilities"]["comparison"]["thresholds"]["b"]["moderate_m"] = 2000
    synthesis = rs.deterministic(xid, digest)
    assert all(c["comparable"] is False for c in synthesis.model_dump()["comparisons"])
    assert any("different settings" in w for w in synthesis.data_quality_warnings)


def test_tied_top_candidates_are_reported_as_ties(overpass):
    xid, _ = run(COMPLEX, b=B)
    digest = copy.deepcopy(ro.REGISTRY.get(xid).digest)
    suit = digest["capabilities"]["suitability"]
    for candidate in suit["top"][:3]:
        candidate["score"] = 90.0
    suit["tied_at_top"] = 3
    synthesis = rs.deterministic(xid, digest)
    top = next(f for f in synthesis.key_findings if f.finding_id == "F-suitability")
    assert "share the highest score of 90/100" in top.conclusion
    assert any("tied" in r.text for r in synthesis.recommendations)


def test_findings_without_evidence_are_dropped(overpass):
    builder = rs._Builder("rx-test", {})
    builder.finding("F-x", "Unsupported", "Candidate C has the highest population demand.", ["nope"], "", "")
    assert builder.findings == []


# API behaviour

def test_synthesis_api_errors(overpass):
    assert client.post("/api/research/executions/rx-unknown/synthesize", json={}).status_code == 404
    plan = make_plan(COVERAGE_Q)
    running = ro.REGISTRY.create(plan, ro.validate_for_execution(plan))
    running.status = "running"
    assert client.post(f"/api/research/executions/{running.id}/synthesize", json={}).status_code == 409
    running.close("cancelled")
    response = client.post(f"/api/research/executions/{running.id}/synthesize", json={})
    assert response.status_code == 409 and "Run the research again" in response.json()["detail"]
    xid, _ = run(COVERAGE_Q)
    assert client.post(f"/api/research/executions/{xid}/synthesize", json={"mode": "magic"}).status_code == 422
    assert client.post(f"/api/research/executions/{xid}/synthesize", json={"sql": "x"}).status_code == 422


def test_digest_is_bounded_and_has_no_geometry(overpass):
    overpass.many = {"hospital"}
    xid, _ = run(COMPLEX, b=B)
    digest = ro.REGISTRY.get(xid).digest
    text = json.dumps(digest)
    assert len(text) <= research_evidence.MAX_DIGEST_BYTES and '"geometry"' not in text and "coordinates\": [[" not in text
    assert client.get(f"/api/research/executions/{xid}").json()["synthesis_available"] is True
    assert len(synthesize(xid)["evidence"]) <= rs.MAX_EVIDENCE


def test_cancelled_execution_synthesis(overpass):
    plan = make_plan(COVERAGE_Q)

    async def scenario():
        execution = ro.REGISTRY.create(plan, ro.validate_for_execution(plan))
        execution.request_cancel()

        async def emit(_):
            return None

        await ro.run_execution(execution, emit, 30)
        return execution

    execution = asyncio.run(scenario())
    synthesis = rs.deterministic(execution.id, execution.digest)
    assert synthesis.overall_status == "failed" and synthesis.key_findings == []


# LLM-assisted narrative (mocked provider)

class Provider:
    name, model = "fake", "fake-model"

    def __init__(self, *responses):
        self.responses, self.calls = list(responses), 0

    async def chat(self, messages, tools):
        self.calls += 1
        assert tools[0]["function"]["name"] == "write_research_narrative"
        payload = json.loads(messages[1]["content"])
        assert all(set(e) == {"id", "title", "value", "unit", "scope", "quality"} for e in payload["evidence"])
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def narrative(**arguments):
    return LLMResponse("", [ToolCall("n1", "write_research_narrative", arguments, json.dumps(arguments))])


def base_synthesis(overpass_fixture, question=COVERAGE_Q):
    xid, _ = run(question)
    return rs.deterministic(xid, ro.REGISTRY.get(xid).digest)


def llm(base, *responses):
    return asyncio.run(rs.llm_assisted(base, Provider(*responses), 5))


def test_valid_llm_narrative_is_used_without_changing_findings(overpass):
    base = base_synthesis(overpass)
    pct = next(e for e in base.evidence if e.evidence_id == "coverage:underserved_pct").observed_value
    result = llm(base, narrative(
        executive_summary=f"About {pct:g}% of the study area is underserved by mapped hospitals.",
        connections=[{"text": f"Underserved cells make up {pct:g}% of the grid.", "evidence_ids": ["coverage:underserved_pct"]}],
        recommendations=[{"text": "Check the underserved cells on the map.", "evidence_ids": ["coverage:underserved_pct"]}],
    ))
    assert result.synthesis_mode == "llm_assisted" and result.rejected_llm_claims == 0
    assert result.executive_summary.startswith(f"About {pct:g}%")
    assert [f.conclusion for f in result.key_findings[: len(base.key_findings)]] == [f.conclusion for f in base.key_findings]
    assert result.key_findings[-1].source == "llm" and result.recommendations[-1].source == "llm"
    assert result.evidence == base.evidence and result.data_quality_warnings == base.data_quality_warnings


@pytest.mark.parametrize("bad", [
    {"executive_summary": "73.4% of the area is underserved."},                                    # invented number
    {"executive_summary": "The area has high population demand."},                                 # unsupported data
    {"executive_summary": "Area A is the overall winner."},                                         # overall winner
])
def test_invented_or_unsupported_summaries_are_rejected(overpass, bad):
    base = base_synthesis(overpass)
    result = llm(base, narrative(**bad))
    assert result.executive_summary == base.executive_summary
    assert result.synthesis_mode == "deterministic" and result.rejected_llm_claims == 1


def test_connections_need_real_evidence(overpass):
    base = base_synthesis(overpass)
    result = llm(base, narrative(
        executive_summary="Coverage findings are summarised below.",
        connections=[
            {"text": "Coverage is weak.", "evidence_ids": ["made-up:id"]},
            {"text": "Candidate sites score 99/100.", "evidence_ids": ["coverage:underserved_pct"]},
        ],
    ))
    assert result.rejected_llm_claims == 2
    assert not any(f.source == "llm" for f in result.key_findings)


def test_partial_status_caveat_cannot_be_hidden(overpass):
    overpass.many = {"hospital"}
    base = base_synthesis(overpass)
    assert base.overall_status == "partial"
    result = llm(base, narrative(executive_summary="Coverage was measured across the study area."))
    assert "incomplete" in result.executive_summary


@pytest.mark.parametrize("response", [
    LLMTimeoutError("The model took too long to respond."),
    LLMResponse("Here is a narrative without the tool."),
    LLMResponse("", [ToolCall("n1", "write_research_narrative", None, "{bad json")]),
    narrative(executive_summary="ok", coordinates=[1, 2]),
])
def test_provider_failures_fall_back_to_deterministic(overpass, response):
    base = base_synthesis(overpass)
    result = llm(base, response)
    assert result.synthesis_mode == "deterministic" and result.key_findings == base.key_findings
    assert any("not used" in line for line in result.methodology)


def test_api_auto_mode_uses_llm_once_and_caches(overpass, monkeypatch):
    xid, _ = run(COVERAGE_Q)
    provider = Provider(narrative(executive_summary="Coverage of mapped hospitals was measured."))
    monkeypatch.setattr(research_router, "create_provider", lambda settings: provider)
    first = synthesize(xid)
    second = synthesize(xid)
    assert first["synthesis_mode"] == "llm_assisted" and first == second and provider.calls == 1
    assert synthesize(xid, mode="deterministic")["synthesis_mode"] == "deterministic"
    assert provider.calls == 1


def test_numbers_must_match_cited_values():
    from app.schemas.research import EvidenceItem

    item = EvidenceItem(
        evidence_id="e", source_execution_id="x", source_step_id=None, capability_id="coverage",
        finding_type="measurement", kind="measured", title="Average distance", description="d",
        observed_value=1712.4, unit="m", geographic_scope="5 km around Area A", methodology="m",
        source_dataset="OSM", quality="complete", limitations=[], partial_or_truncated=False,
    )
    assert rs._numbers_supported("The average is 1.71 km within 5 km.", [item])
    assert rs._numbers_supported("The average is 1712.4 m.", [item])
    assert not rs._numbers_supported("The average is 1.9 km.", [item])
    assert re.search(rs.UNSUPPORTED_TOPICS, "travel time is short")
