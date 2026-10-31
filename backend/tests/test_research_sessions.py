import asyncio
import io
import json
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader

from app.main import app
from app.routers import research as research_router
from app.services import research_orchestrator as ro
from app.services import research_planner as rp
from app.services import research_sessions as rs
from test_research_orchestrator import (  # noqa: F401 - shared fixtures
    A, B, COMPLEX, COVERAGE_Q, fresh_registry, make_plan, overpass,
)

client = TestClient(app)
WS = "workspace-alpha-0123456789"
OTHER = "workspace-bravo-0123456789"


@pytest.fixture(autouse=True)
def fresh_store(monkeypatch):
    monkeypatch.setattr(rs, "STORE", rs.MemorySessionStore())
    monkeypatch.setattr(research_router, "create_provider", lambda settings: None)


def headers(workspace=WS):
    return {"X-GeoMind-Workspace": workspace}


def create(question="", token=None, workspace=WS):
    body = {"question": question} | ({"client_token": token} if token else {})
    response = client.post("/api/research/sessions", json=body, headers=headers(workspace))
    assert response.status_code == 201, response.text
    return response.json()


def plan_in(session_id, question=COVERAGE_Q, b=None, workspace=WS):
    body = {"question": question, "coordinates": A, "session_id": session_id, "interpreter": "rules"}
    if b:
        body["compare_coordinates"] = b
    response = client.post("/api/research/plan", json=body, headers=headers(workspace))
    assert response.status_code == 200, response.text
    return response.json()


def execute_in(session_id, plan, workspace=WS):
    with client.stream("POST", "/api/research/execute", json={"plan": plan, "session_id": session_id},
                       headers=headers(workspace)) as stream:
        assert stream.status_code == 200
        return [json.loads(line) for line in stream.iter_lines() if line]


def detail(session_id, workspace=WS):
    return client.get(f"/api/research/sessions/{session_id}", headers=headers(workspace))


def full_session(question=COVERAGE_Q, b=None, insights=True):
    session = create(question)
    plan = plan_in(session["session_id"], question, b)
    events = execute_in(session["session_id"], plan)
    xid = events[0]["execution_id"]
    if insights:
        assert client.post(f"/api/research/executions/{xid}/synthesize", json={}).status_code == 200
    return session["session_id"], xid


# CRUD

def test_create_session():
    session = create("Find hospitals within 5 km")
    assert session["session_id"].startswith("ses-") and session["status"] == "draft"
    assert session["title"] == "Find hospitals within 5 km" and session["availability"]["execution"] == "none"
    assert "workspace" not in session and "client_token" not in session


def test_duplicate_creation_with_same_token():
    first = create("Q", token="token-12345678")
    again = create("Q", token="token-12345678")
    assert first["session_id"] == again["session_id"]
    other_workspace = create("Q", token="token-12345678", workspace=OTHER)
    assert other_workspace["session_id"] != first["session_id"]
    assert client.get("/api/research/sessions", headers=headers()).json()["total"] == 1


def test_list_is_ordered_paginated_and_reports_storage():
    ids = [create(f"Question {i}")["session_id"] for i in range(5)]
    page = client.get("/api/research/sessions?limit=2&offset=1", headers=headers()).json()
    assert page["total"] == 5 and page["limit"] == 2 and page["offset"] == 1
    assert [s["session_id"] for s in page["items"]] == list(reversed(ids))[1:3]
    assert page["storage"] == {"kind": "memory", "persistent": False, "note": rs.MemorySessionStore().info().note}
    assert "not permanently saved" in page["storage"]["note"]
    assert client.get("/api/research/sessions?q=question 3", headers=headers()).json()["total"] == 1
    assert client.get("/api/research/sessions?status=draft", headers=headers()).json()["total"] == 5
    assert client.get("/api/research/sessions?limit=51", headers=headers()).status_code == 422


def test_session_detail_and_rename():
    session = create("Original question")
    renamed = client.patch(f"/api/research/sessions/{session['session_id']}", json={"title": "  My  study "},
                           headers=headers()).json()
    assert renamed["title"] == "My study"
    plan_in(session["session_id"])  # a later plan must not overwrite a custom title
    data = detail(session["session_id"]).json()
    assert data["title"] == "My study" and data["status"] == "planned" and data["plan"]["status"] == "ready"
    assert data["availability"]["can_execute"] is True
    for body in ({"title": ""}, {"title": "x" * 121}, {"title": "ok", "status": "completed"}):
        assert client.patch(f"/api/research/sessions/{session['session_id']}", json=body, headers=headers()).status_code == 422


def test_delete_session():
    keep, gone = create("Keep")["session_id"], create("Delete")["session_id"]
    assert client.delete(f"/api/research/sessions/{gone}", headers=headers()).status_code == 204
    assert detail(gone).status_code == 404 and detail(keep).status_code == 200
    assert client.delete(f"/api/research/sessions/{gone}", headers=headers()).status_code == 404


def test_cannot_delete_running_session(overpass):
    session_id, xid = full_session(insights=False)
    ro.REGISTRY.get(xid).status = "running"
    assert client.delete(f"/api/research/sessions/{session_id}", headers=headers()).status_code == 409


# Validation and isolation

@pytest.mark.parametrize("path", ["/api/research/sessions/not-a-session", "/api/research/sessions/ses-XYZ",
                                  "/api/research/sessions/ses-0123456789abcdef0"])
def test_invalid_session_ids(path):
    assert client.get(path, headers=headers()).status_code == 422


def test_unknown_session_and_workspace_rules():
    assert detail("ses-0123456789abcdef").status_code == 404
    assert client.get("/api/research/sessions").status_code == 422
    assert client.get("/api/research/sessions", headers=headers("short")).status_code == 422
    session = create("Private-ish")
    assert detail(session["session_id"], workspace=OTHER).status_code == 404
    assert client.get("/api/research/sessions", headers=headers(OTHER)).json()["total"] == 0
    assert client.delete(f"/api/research/sessions/{session['session_id']}", headers=headers(OTHER)).status_code == 404


def test_cross_session_plans_are_rejected(overpass):
    first, second = create("A")["session_id"], create("B")["session_id"]
    plan_one = plan_in(first)
    plan_in(second, "Find suitable locations for a new hospital")
    response = client.post("/api/research/execute", json={"plan": plan_one, "session_id": second}, headers=headers())
    assert response.status_code == 409 and "does not belong" in response.json()["detail"]
    response = client.post("/api/research/execute", json={"plan": plan_one, "session_id": first}, headers=headers(OTHER))
    assert response.status_code == 404
    response = client.post("/api/research/plan", json={"question": COVERAGE_Q, "session_id": first})
    assert response.status_code == 422
    assert overpass.calls == []


def test_plan_signature_still_enforced_for_sessions(overpass):
    session = create("A")["session_id"]
    plan = plan_in(session)
    plan["steps"][0]["arguments"]["radius_km"] = 9
    assert client.post("/api/research/execute", json={"plan": plan, "session_id": session},
                       headers=headers()).status_code == 409


# Pipeline integration

def test_execution_insights_and_reports_update_the_session(overpass):
    session_id, xid = full_session()
    data = detail(session_id).json()
    assert data["status"] == "completed" and data["execution"]["execution_id"] == xid
    assert [s["status"] for s in data["execution"]["steps"]] == ["completed"] * 3
    assert data["execution"]["results"][0]["capability_id"] == "coverage"
    assert data["insights"]["execution_id"] == xid and data["insight_status"] == "available"
    assert data["availability"] == {**data["availability"], "execution": "retained", "insights": "available"}
    assert ro.REGISTRY.get(xid).session_id == session_id

    pdf = client.post(f"/api/research/executions/{xid}/report", json={"format": "pdf"})
    docx = client.post(f"/api/research/executions/{xid}/report", json={"format": "docx"})
    assert PdfReader(io.BytesIO(pdf.content)).pages and docx.status_code == 200
    reports = client.get(f"/api/research/sessions/{session_id}/reports", headers=headers()).json()["reports"]
    assert [r["format"] for r in reports] == ["docx", "pdf"]  # newest first
    assert reports[1]["size_bytes"] == len(pdf.content) and reports[1]["execution_id"] == xid
    assert all(r["availability"] == "regenerable" and r["session_id"] == session_id for r in reports)
    assert "path" not in json.dumps(reports) and "url" not in json.dumps(reports)


def test_partial_and_failed_executions_are_distinguished(overpass):
    overpass.fail_area = "b"
    partial_id, _ = full_session(COMPLEX, b=B)
    assert detail(partial_id).json()["status"] == "partial"
    overpass.fail_area, overpass.fail = None, {"hospital"}
    failed_id, _ = full_session(insights=False)
    data = detail(failed_id).json()
    assert data["status"] == "failed" and data["availability"]["reports"] == "none"


def test_expired_execution_keeps_metadata_but_not_reports(overpass):
    session_id, xid = full_session()
    client.post(f"/api/research/executions/{xid}/report", json={"format": "pdf"})
    ro.REGISTRY._items.clear()  # execution expired / server restarted
    data = detail(session_id).json()
    assert data["status"] == "completed" and data["availability"]["execution"] == "expired"
    assert data["availability"]["reports"] == "unavailable" and data["reports"][0]["availability"] == "unavailable"
    assert data["insights"] is not None and "run the research again" in data["availability"]["note"]
    assert client.post(f"/api/research/executions/{xid}/report", json={"format": "pdf"}).status_code == 404


def test_running_session_without_execution_is_expired(overpass):
    session_id, xid = full_session(insights=False)
    stored = rs.STORE.get(session_id)
    stored.status = "running"
    rs.STORE.save(stored)
    ro.REGISTRY._items.clear()
    assert detail(session_id).json()["status"] == "expired"


def test_cancellation_updates_the_session(overpass):
    session = rs.create(WS, "Q", None)[0]
    plan = make_plan(COVERAGE_Q)
    rs.attach_plan(session, plan)
    execution = ro.REGISTRY.create(plan, ro.validate_for_execution(plan))
    execution.session_id = session.session_id
    rs.attach_execution(session, execution.id)
    execution.request_cancel()

    async def emit(_):
        return None

    asyncio.run(ro.run_execution(execution, emit, 30))
    rs.record_execution(execution)
    data = detail(session.session_id).json()
    assert data["status"] == "cancelled" and all(s["status"] == "cancelled" for s in data["execution"]["steps"])
    assert overpass.calls == []


def test_updates_for_a_replaced_or_deleted_session_are_ignored(overpass):
    session_id, xid = full_session(insights=False)
    client.delete(f"/api/research/sessions/{session_id}", headers=headers())
    assert client.post(f"/api/research/executions/{xid}/synthesize", json={}).status_code == 200
    assert rs.STORE.get(session_id) is None


def test_reopening_a_session_never_reruns(overpass, monkeypatch):
    session_id, _ = full_session()
    calls = len(overpass.calls)

    def explode(*args, **kwargs):
        raise AssertionError("must not run")

    monkeypatch.setattr(ro, "run_execution", explode)
    for _ in range(3):
        assert detail(session_id).status_code == 200
        assert client.get("/api/research/sessions", headers=headers()).status_code == 200
    assert len(overpass.calls) == calls


def test_synthesis_without_a_session_is_unchanged(overpass):
    plan = make_plan(COVERAGE_Q)
    with client.stream("POST", "/api/research/execute", json={"plan": json.loads(plan.model_dump_json())}) as stream:
        events = [json.loads(line) for line in stream.iter_lines() if line]
    xid = events[0]["execution_id"]
    assert client.post(f"/api/research/executions/{xid}/synthesize", json={}).json()["synthesis_mode"] == "deterministic"


# Retention, expiry and storage

def test_retention_limits():
    for i in range(rs.MAX_SESSIONS_PER_WORKSPACE + 5):
        create(f"Q{i}")
    assert client.get("/api/research/sessions", headers=headers()).json()["total"] == rs.MAX_SESSIONS_PER_WORKSPACE
    session = rs.create(WS, "Q", None)[0]
    session.execution = rs.SessionExecution(execution_id="rx-1", status="completed", started_at=None,
                                            finished_at=None, steps=[], warnings=[], errors=[], results=[])
    rs.STORE.save(session)

    class FakeExecution:
        id, session_id = "rx-1", session.session_id

    for _ in range(rs.MAX_REPORTS_PER_SESSION + 5):
        rs.record_report(FakeExecution, "pdf", b"%PDF-1.4 test")
    assert len(rs.STORE.get(session.session_id).reports) == rs.MAX_REPORTS_PER_SESSION


def test_expired_sessions_are_removed():
    session = create("Old")
    stored = rs.STORE.get(session["session_id"])
    stored.updated_at -= rs.MEMORY_TTL + timedelta(seconds=1)
    rs.STORE.save(stored)
    assert detail(session["session_id"]).status_code == 404


def test_store_configuration():
    assert isinstance(rs.create_store(None), rs.MemorySessionStore)
    assert isinstance(rs.create_store("memory"), rs.MemorySessionStore)
    with pytest.raises(ValueError):
        rs.create_store("postgres://example")


def test_sqlite_store_survives_a_simulated_restart(tmp_path, overpass, monkeypatch):
    path = tmp_path / "sessions.db"
    monkeypatch.setattr(rs, "STORE", rs.create_store(f"sqlite:///{path}"))
    session_id, xid = full_session()
    info = client.get("/api/research/sessions", headers=headers()).json()["storage"]
    assert info["kind"] == "sqlite" and info["persistent"] is True and "Render Free" in info["note"]

    # Restart: new store on the same file, executions gone, plan key changed.
    monkeypatch.setattr(rs, "STORE", rs.create_store(f"sqlite:///{path}"))
    ro.REGISTRY._items.clear()
    monkeypatch.setattr(rp, "_PLAN_KEY", b"new-process-key")
    data = detail(session_id).json()
    assert data["title"] and data["insights"]["execution_id"] == xid
    assert data["availability"]["execution"] == "expired" and data["availability"]["can_execute"] is False


def test_unexecuted_plan_after_restart_must_be_replanned(overpass, monkeypatch):
    session = create("Q")["session_id"]
    plan_in(session)
    monkeypatch.setattr(rp, "_PLAN_KEY", b"new-process-key")
    data = detail(session).json()
    assert data["availability"]["can_execute"] is False and "plan the research again" in data["availability"]["note"]


def test_large_insights_are_not_retained(overpass, monkeypatch):
    monkeypatch.setattr(rs, "MAX_INSIGHTS_BYTES", 100)
    session_id, _ = full_session()
    data = detail(session_id).json()
    assert data["insights"] is None and any("too large" in w for w in data["warnings"])
