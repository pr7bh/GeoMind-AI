import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Path, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app.config import get_settings
from app.routers.agent import _valid_location
from app.schemas.research import (
    SESSION_ID_PATTERN,
    WORKSPACE_PATTERN,
    ResearchPlan,
    ResearchPlanRequest,
    ResearchSynthesis,
    SessionCreate,
    SessionDetail,
    SessionList,
    SessionUpdate,
    SynthesisRequest,
)
from app.services import research_orchestrator as orchestrator
from app.services import research_planner, research_report, research_sessions, research_synthesis
from app.services.llm.base import LLMConfigError
from app.services.llm.factory import create_provider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/research", tags=["Research Planner"])

EXPIRED = (
    "Execution not found. Executions are kept in memory for 30 minutes and are lost "
    "when the server restarts or sleeps. Run the research again."
)


WORKSPACE_HEADER = Header(
    None, alias="X-GeoMind-Workspace", pattern=WORKSPACE_PATTERN,
    description="Random per-browser key that scopes research sessions (not authentication).",
)
SESSION_ID = Path(..., pattern=SESSION_ID_PATTERN)


def _session(session_id: str, workspace: str | None):
    if workspace is None:
        raise HTTPException(status_code=422, detail="The X-GeoMind-Workspace header is required for research sessions.")
    session = research_sessions.get(session_id, workspace)
    if session is None:
        raise HTTPException(
            status_code=404,
            detail="Research session not found. Sessions in server memory are lost when the server restarts or sleeps.",
        )
    return session


@router.post("/plan", response_model=ResearchPlan)
async def plan_research(request: ResearchPlanRequest, workspace: str | None = WORKSPACE_HEADER) -> ResearchPlan:
    """Turn a research question into a validated plan. Nothing is executed."""
    _valid_location(request.coordinates)
    _valid_location(request.compare_coordinates)
    session = _session(request.session_id, workspace) if request.session_id else None

    settings = get_settings()
    provider, note = None, None
    if request.interpreter == "auto":
        try:
            provider = create_provider(settings)
        except LLMConfigError as exc:
            note = f"The AI interpreter is misconfigured ({exc}); rule-based planning was used."

    plan = await research_planner.plan_research(request, provider, settings.llm_timeout_seconds, note)
    if session is not None:
        research_sessions.attach_plan(session, plan)
    return plan


class ResearchExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The plan exactly as returned by /plan; its signature is verified.
    plan: ResearchPlan
    # Session the plan belongs to (needs the workspace header).
    session_id: str | None = Field(default=None, pattern=SESSION_ID_PATTERN)


@router.post("/execute")
async def execute_research(
    request: ResearchExecuteRequest, http_request: Request, workspace: str | None = WORKSPACE_HEADER,
):
    """Execute an approved plan, streamed as newline-delimited JSON events.

    Events: execution_started, step_started, step_completed | step_partial |
    step_failed | step_blocked | step_skipped, then execution_completed,
    execution_failed or execution_cancelled (with results). The run is tied
    to this stream: disconnecting cancels it.
    """
    session = _session(request.session_id, workspace) if request.session_id else None
    if session is not None:
        if session.plan is None or session.plan.id != request.plan.id or session.plan.signature != request.plan.signature:
            raise HTTPException(status_code=409, detail="This plan does not belong to the research session.")
        live = orchestrator.REGISTRY.get(session.execution.execution_id) if session.execution else None
        if live is not None and not live.finished:
            raise HTTPException(status_code=409, detail="This research session is already running.")

    try:
        steps = orchestrator.validate_for_execution(request.plan)
        execution = orchestrator.REGISTRY.create(request.plan, steps)
    except orchestrator.ExecutionRejected as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    if session is not None:
        execution.session_id = session.session_id
        research_sessions.attach_execution(session, execution.id)

    budget = orchestrator.execution_budget(request.plan, get_settings().agent_timeout_seconds)

    async def events() -> AsyncIterator[str]:
        queue: asyncio.Queue[dict | None] = asyncio.Queue()

        async def worker() -> None:
            try:
                await orchestrator.run_execution(execution, queue.put, budget)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("Research execution %s failed", execution.id)
                execution.close("failed", "The research execution failed unexpectedly.")
                await queue.put({"type": "execution_failed", "execution_id": execution.id,
                                 "status": "failed", "result": execution.public()})
            finally:
                research_sessions.record_execution(execution)
                queue.put_nowait(None)

        execution.task = asyncio.create_task(worker())

        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    if await http_request.is_disconnected():
                        break
                    continue
                if event is None:
                    break
                yield json.dumps(event, default=str) + "\n"
        finally:
            # Client gone or run finished: never leave work running.
            if not execution.finished:
                execution.request_cancel()
                execution.task.cancel()
                execution.close("cancelled", "The connection closed before the research finished.")
                research_sessions.record_execution(execution)

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "X-Execution-Id": execution.id},
    )


@router.get("/executions/{execution_id}")
def get_execution(execution_id: str):
    """Status and step summaries of a recent execution (no GIS payloads)."""
    execution = orchestrator.REGISTRY.get(execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail=EXPIRED)
    return execution.public()


@router.post("/executions/{execution_id}/cancel")
def cancel_execution(execution_id: str):
    execution = orchestrator.REGISTRY.get(execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail=EXPIRED)
    if execution.finished:
        raise HTTPException(status_code=409, detail=f"The execution already finished ({execution.status}).")
    execution.request_cancel()
    return {"execution_id": execution.id, "cancel_requested": True, "status": execution.status}


@router.post("/executions/{execution_id}/synthesize", response_model=ResearchSynthesis)
async def synthesize_execution(execution_id: str, request: SynthesisRequest) -> ResearchSynthesis:
    """Evidence-based synthesis of a finished execution. Never re-runs GIS steps."""
    execution = orchestrator.REGISTRY.get(execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail=EXPIRED)
    if not execution.finished:
        raise HTTPException(status_code=409, detail="The research is still running; synthesise it when it finishes.")
    if execution.digest is None:
        raise HTTPException(status_code=409, detail="No evidence was kept for this execution. Run the research again.")

    if request.mode in execution.syntheses:
        return execution.syntheses[request.mode]

    settings = get_settings()
    provider = None
    if request.mode == "auto":
        try:
            provider = create_provider(settings)
        except LLMConfigError:
            provider = None  # deterministic synthesis still works

    synthesis = await research_synthesis.synthesize(execution.id, execution.digest, provider, settings.llm_timeout_seconds)
    execution.syntheses[request.mode] = synthesis
    research_sessions.record_insights(execution, synthesis)
    return synthesis


class ReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format: Literal["pdf", "docx"]


@router.post("/executions/{execution_id}/report")
async def research_report_download(execution_id: str, request: ReportRequest):
    """Download a PDF or DOCX report built from the execution's existing insights.

    Uses only the retained plan, evidence digest and synthesis: no workflow is
    re-run and no data is fetched. The file is generated in memory, never stored.
    """
    execution = orchestrator.REGISTRY.get(execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail=EXPIRED)
    if not execution.finished:
        raise HTTPException(status_code=409, detail="The research is still running; create the report when it finishes.")
    if execution.status in ("failed", "cancelled"):
        raise HTTPException(
            status_code=409,
            detail=f"No report can be created because the research {execution.status}. Run the research again.",
        )
    synthesis = execution.syntheses.get("auto") or execution.syntheses.get("deterministic")
    if synthesis is None:
        raise HTTPException(status_code=409, detail="Generate Research Insights first; the report is built from them.")
    if synthesis.overall_status in ("failed", "insufficient_evidence"):
        raise HTTPException(status_code=409, detail="The insights contain no evidence-supported findings to report.")

    try:
        report = research_report.build_report(execution, synthesis)
        content = await asyncio.to_thread(research_report.render, report, request.format)
    except research_report.ReportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception:  # noqa: BLE001 - never leak internals
        logger.exception("Report generation failed for %s", execution.id)
        raise HTTPException(status_code=500, detail="The report could not be generated.") from None

    research_sessions.record_report(execution, request.format, content)
    name = research_report.filename(execution.id, request.format)
    return Response(
        content=content,
        media_type=research_report.CONTENT_TYPES[request.format],
        headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"},
    )


# Research sessions (workspace and report history)

@router.post("/sessions", response_model=SessionDetail, status_code=201)
def create_session(request: SessionCreate, workspace: str | None = WORKSPACE_HEADER):
    """Start a research session. Retrying with the same client_token returns the same session."""
    if workspace is None:
        raise HTTPException(status_code=422, detail="The X-GeoMind-Workspace header is required for research sessions.")
    session, _ = research_sessions.create(workspace, request.question, request.client_token)
    return research_sessions.detail(session, orchestrator.REGISTRY)


@router.get("/sessions", response_model=SessionList)
def list_sessions(
    workspace: str | None = WORKSPACE_HEADER,
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0, le=10_000),
    status: str | None = Query(None, pattern=r"^(draft|planned|running|completed|partial|failed|cancelled|expired)$"),
    q: str | None = Query(None, max_length=100),
):
    if workspace is None:
        raise HTTPException(status_code=422, detail="The X-GeoMind-Workspace header is required for research sessions.")
    items, total = research_sessions.list_sessions(workspace, orchestrator.REGISTRY, limit, offset, status, q)
    return SessionList(items=items, total=total, limit=limit, offset=offset, storage=research_sessions.STORE.info())


@router.get("/sessions/{session_id}", response_model=SessionDetail)
def get_session(session_id: str = SESSION_ID, workspace: str | None = WORKSPACE_HEADER):
    """Session detail from stored metadata; never re-runs anything."""
    return research_sessions.detail(_session(session_id, workspace), orchestrator.REGISTRY)


@router.patch("/sessions/{session_id}", response_model=SessionDetail)
def update_session(request: SessionUpdate, session_id: str = SESSION_ID, workspace: str | None = WORKSPACE_HEADER):
    session = research_sessions.rename(_session(session_id, workspace), request.title)
    return research_sessions.detail(session, orchestrator.REGISTRY)


@router.delete("/sessions/{session_id}", status_code=204)
def delete_session(session_id: str = SESSION_ID, workspace: str | None = WORKSPACE_HEADER):
    session = _session(session_id, workspace)
    live = orchestrator.REGISTRY.get(session.execution.execution_id) if session.execution else None
    if live is not None and not live.finished:
        raise HTTPException(status_code=409, detail="Cancel the running research before deleting the session.")
    research_sessions.delete(session)
    return Response(status_code=204)


@router.get("/sessions/{session_id}/reports")
def session_reports(session_id: str = SESSION_ID, workspace: str | None = WORKSPACE_HEADER):
    """Report history. Files are not stored: "regenerable" reports can be downloaded again
    from the report endpoint while their execution is retained; others need a new run."""
    return {"session_id": session_id, "reports": research_sessions.detail(_session(session_id, workspace), orchestrator.REGISTRY).reports}
