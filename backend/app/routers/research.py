import asyncio
import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from app.config import get_settings
from app.routers.agent import _valid_location
from app.schemas.research import ResearchPlan, ResearchPlanRequest
from app.services import research_orchestrator as orchestrator
from app.services import research_planner
from app.services.llm.base import LLMConfigError
from app.services.llm.factory import create_provider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/research", tags=["Research Planner"])

EXPIRED = (
    "Execution not found. Executions are kept in memory for 30 minutes and are lost "
    "when the server restarts or sleeps."
)


@router.post("/plan", response_model=ResearchPlan)
async def plan_research(request: ResearchPlanRequest) -> ResearchPlan:
    """Turn a research question into a validated plan. Nothing is executed."""
    _valid_location(request.coordinates)
    _valid_location(request.compare_coordinates)

    settings = get_settings()
    provider, note = None, None
    if request.interpreter == "auto":
        try:
            provider = create_provider(settings)
        except LLMConfigError as exc:
            note = f"The AI interpreter is misconfigured ({exc}); rule-based planning was used."

    return await research_planner.plan_research(request, provider, settings.llm_timeout_seconds, note)


class ResearchExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The plan exactly as returned by /plan; its signature is verified.
    plan: ResearchPlan


@router.post("/execute")
async def execute_research(request: ResearchExecuteRequest, http_request: Request):
    """Execute an approved plan, streamed as newline-delimited JSON events.

    Events: execution_started, step_started, step_completed | step_partial |
    step_failed | step_blocked | step_skipped, then execution_completed,
    execution_failed or execution_cancelled (with results). The run is tied
    to this stream: disconnecting cancels it.
    """
    try:
        steps = orchestrator.validate_for_execution(request.plan)
        execution = orchestrator.REGISTRY.create(request.plan, steps)
    except orchestrator.ExecutionRejected as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

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
