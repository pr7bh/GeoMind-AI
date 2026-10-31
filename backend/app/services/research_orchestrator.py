"""Research orchestration: execute an approved, server-signed research plan.

Steps run one at a time in the plan's dependency order through the existing
tool boundaries: workflow steps via `WORKFLOW_TOOLS[tool].run(args, context,
inputs)` and agent tools via `execute_tool`. Nothing here performs GIS work
itself. Results are rendered with the existing workflow serialisers, so the
frontend shows them with its existing views and layer handling.

State lives only in memory, scoped to one execution, and is bounded: a small
registry keeps recent executions (without their GIS payloads) for status
look-ups. It does not survive a restart and is not shared between instances.
"""

import asyncio
import copy
import json
import logging
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from pydantic import ValidationError

from app.schemas.research import ResearchPlan, ResearchStep
from app.services import research_evidence, research_planner
from app.services.agent.runner import execute_tool
from app.services.agent.tools import TOOLS as AGENT_TOOLS
from app.services.agent.tools import AgentContext
from app.services.workflows import catalog
from app.services.workflows.plan import (
    PlanStep,
    StepError,
    StepOutcome,
    StepState,
    StopWorkflow,
    WorkflowContext,
    WorkflowRun,
)
from app.services.workflows.steps import WORKFLOW_TOOLS

logger = logging.getLogger(__name__)

MAX_EXECUTION_STEPS = 16
# Steps that query Overpass (each is one bounded request, or two for areas).
MAX_DISCOVERY_STEPS = 8
MAX_ACTIVE_EXECUTIONS = 2
MAX_RETAINED_EXECUTIONS = 20
EXECUTION_TTL_SECONDS = 30 * 60
# One workflow already gets AGENT_TIMEOUT_SECONDS on its own; a plan of
# several gets that per workflow capability, capped.
MAX_EXECUTION_SECONDS = 240.0
# Cap on map layers returned at the end (GeoJSON, serialised).
MAX_RESULT_BYTES = 8 * 1024 * 1024

WORKFLOW_CAPABILITIES = {"nearby_count", "coverage", "comparison", "suitability"}
# Tools each capability may execute; anything else is rejected.
ALLOWED_TOOLS: dict[str, set[str]] = {
    "nearby_count": {"discover_features", "discover_near_features", "rank_by_nearby_count", "report_findings"},
    "coverage": {"discover_services", "analyse_coverage", "report_coverage"},
    "comparison": {"analyse_area", "compare_areas", "report_comparison"},
    "suitability": {"discover_services", "score_suitability", "report_suitability"},
    "discover_features": {"discover_features"},
    "find_nearest_features": {"discover_features", "find_nearest_features"},
    "create_buffer": {"create_buffer"},
    "spatial_query": {"create_buffer", "discover_features", "spatial_query"},
}
assert set(ALLOWED_TOOLS) == set(catalog.CAPABILITIES)
DISCOVERY_TOOLS = {"discover_features", "discover_near_features", "discover_services", "analyse_area"}

Emit = Callable[[dict[str, Any]], Awaitable[None]]


class ExecutionRejected(Exception):
    """The plan cannot be executed; the message is safe to show."""

    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _is_workflow(step: ResearchStep) -> bool:
    return step.capability_id in WORKFLOW_CAPABILITIES


def _args_model(step: ResearchStep):
    return (WORKFLOW_TOOLS[step.tool] if _is_workflow(step) else AGENT_TOOLS[step.tool]).args_model


# Validation (never trust the client)

def validate_for_execution(plan: ResearchPlan) -> list[ResearchStep]:
    """Re-check a submitted plan; returns its steps in execution order."""
    if not research_planner.verify_plan(plan):
        raise ExecutionRejected(
            "This plan was changed after it was created, or it has expired because the server restarted. "
            "Create the plan again.",
            409,
        )
    if plan.status != "ready":
        raise ExecutionRejected(f"Only ready plans can be executed; this plan is '{plan.status}'.", 409)
    if not plan.steps:
        raise ExecutionRejected("The plan has no steps.")
    if len(plan.steps) > MAX_EXECUTION_STEPS:
        raise ExecutionRejected(f"Plans may have at most {MAX_EXECUTION_STEPS} steps.")
    if sum(1 for s in plan.steps if s.tool in DISCOVERY_TOOLS) > MAX_DISCOVERY_STEPS:
        raise ExecutionRejected(f"Plans may make at most {MAX_DISCOVERY_STEPS} discovery requests.")

    areas = {area.id: area.coordinates for area in plan.selected_areas}
    for coords in areas.values():
        if coords is not None and not (-180 <= coords[0] <= 180 and -90 <= coords[1] <= 90):
            raise ExecutionRejected("Invalid longitude or latitude.")

    known = {s.id for s in plan.steps}
    aliases: set[str] = set()
    for step in plan.steps:
        if step.capability_id not in catalog.CAPABILITIES:
            raise ExecutionRejected(f"Unknown capability '{step.capability_id}'.")
        if step.tool not in ALLOWED_TOOLS[step.capability_id]:
            raise ExecutionRejected(f"Tool '{step.tool}' is not allowed for '{step.capability_id}'.")
        try:
            args = _args_model(step).model_validate(step.arguments)
        except ValidationError as exc:
            raise ExecutionRejected(f"Invalid arguments for step '{step.id}': {exc.errors()[0]['msg']}") from exc
        if research_planner._canonical(args.model_dump()) != research_planner._canonical(step.arguments):
            raise ExecutionRejected(f"Invalid arguments for step '{step.id}'.")
        if _is_workflow(step):
            for arg_name, producers in WORKFLOW_TOOLS[step.tool].step_refs:
                ref = getattr(args, arg_name)
                if ref is None:
                    continue
                if ref not in step.dependencies + step.optional_dependencies:
                    raise ExecutionRejected(f"Step '{step.id}' uses '{ref}' without depending on it.")
                producer = next(s for s in plan.steps if s.id == ref)
                if producer.tool not in producers:
                    raise ExecutionRejected(f"Step '{step.id}' cannot use the output of '{ref}'.")
        for alias in step.aliases:
            if alias in known or alias in aliases or "." not in alias:
                raise ExecutionRejected(f"Invalid step alias '{alias}'.")
            aliases.add(alias)
        for needed in step.required_inputs:
            if needed == "location" and areas.get("a") is None:
                raise ExecutionRejected("The plan needs Area A.", 409)
            if needed == "compare_location" and areas.get("b") is None:
                raise ExecutionRejected("The plan needs Area B.", 409)

    try:
        ordered = research_planner.validate_research_steps([
            {
                "id": s.id, "capability_id": s.capability_id, "tool": s.tool,
                "depends_on": s.dependencies, "optional_depends_on": s.optional_dependencies,
            }
            for s in plan.steps
        ])
    except research_planner.ResearchPlanError as exc:
        raise ExecutionRejected(str(exc)) from exc

    order = {s.id: s.execution_order for s in plan.steps}
    for step in plan.steps:
        if any(order[d] >= step.execution_order for d in step.dependencies + step.optional_dependencies):
            raise ExecutionRejected("The execution order does not respect the dependencies.")
    by_id = {s.id: s for s in plan.steps}
    return sorted((by_id[s["id"]] for s in ordered), key=lambda s: s.execution_order)


# Execution state

@dataclass
class StepRecord:
    step: ResearchStep
    status: str = "pending"  # pending|running|completed|partial|failed|blocked|skipped|cancelled
    summary: str = ""
    error: str | None = None
    reused_from: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    preview: dict[str, Any] = field(default_factory=dict)
    # In-memory results for dependent steps; released when the run ends.
    state: StepState | None = None
    layers: list[dict[str, Any]] = field(default_factory=list)

    @property
    def succeeded(self) -> bool:
        return self.status in ("completed", "partial")

    def public(self) -> dict[str, Any]:
        return {
            "id": self.step.id,
            "capability_id": self.step.capability_id,
            "title": self.step.title,
            "status": self.status,
            "summary": self.summary,
            "error": self.error,
            "reused_from": self.reused_from,
            "started_at": _iso(self.started_at),
            "finished_at": _iso(self.finished_at),
        }


@dataclass
class Execution:
    plan: ResearchPlan
    steps: list[ResearchStep]
    id: str = field(default_factory=lambda: f"rx-{uuid.uuid4().hex[:12]}")
    status: str = "queued"
    created_at: datetime = field(default_factory=_now)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    current_step: str | None = None
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    summaries: list[dict[str, Any]] = field(default_factory=list)
    cancel_requested: bool = False
    task: asyncio.Task | None = None
    records: dict[str, StepRecord] = field(default_factory=dict)
    # Compact evidence kept after GIS payloads are released (for synthesis),
    # and the latest synthesis per mode.
    digest: dict[str, Any] | None = None
    syntheses: dict[str, Any] = field(default_factory=dict)
    # Research session that owns this execution (set server-side only).
    session_id: str | None = None

    def __post_init__(self) -> None:
        self.records = {s.id: StepRecord(s) for s in self.steps}

    @property
    def finished(self) -> bool:
        return self.status not in ("queued", "running")

    def request_cancel(self) -> None:
        """Stop scheduling steps; interrupt the running step's await.

        Before the run has started, only the flag is set: the run then
        emits its start and cancellation events itself.
        """
        self.cancel_requested = True
        if self.status == "running" and self.task and not self.task.done():
            self.task.cancel()

    def close(self, status: str, message: str | None = None) -> None:
        """Synchronously finish an execution that could not finish itself."""
        if self.finished:
            return
        for record in self.records.values():
            if record.status in ("pending", "running"):
                record.status, record.finished_at = "cancelled", _now()
            record.state, record.layers = None, []
        if message:
            self.errors.append(message)
        self.status, self.finished_at, self.current_step = status, _now(), None

    def public(self) -> dict[str, Any]:
        records = list(self.records.values())
        return {
            "execution_id": self.id,
            "plan_id": self.plan.id,
            "status": self.status,
            "current_step": self.current_step,
            "completed_steps": sum(1 for r in records if r.succeeded),
            "total_steps": len(records),
            "steps": [r.public() for r in records],
            "warnings": self.warnings,
            "errors": self.errors,
            "results": self.summaries,
            "synthesis_available": self.digest is not None,
            "created_at": _iso(self.created_at),
            "started_at": _iso(self.started_at),
            "finished_at": _iso(self.finished_at),
            "retained_until": _iso(datetime.fromtimestamp(self.created_at.timestamp() + EXECUTION_TTL_SECONDS, timezone.utc)),
        }


class ExecutionRegistry:
    """Bounded, in-memory, single-instance registry of recent executions."""

    def __init__(self, max_retained: int = MAX_RETAINED_EXECUTIONS, max_active: int = MAX_ACTIVE_EXECUTIONS,
                 ttl_seconds: float = EXECUTION_TTL_SECONDS):
        self.max_retained, self.max_active, self.ttl = max_retained, max_active, ttl_seconds
        self._items: OrderedDict[str, Execution] = OrderedDict()

    def _purge(self) -> None:
        cutoff = _now().timestamp() - self.ttl
        for key in [k for k, e in self._items.items() if e.finished and e.created_at.timestamp() < cutoff]:
            del self._items[key]

    def create(self, plan: ResearchPlan, steps: list[ResearchStep]) -> Execution:
        self._purge()
        if sum(1 for e in self._items.values() if not e.finished) >= self.max_active:
            raise ExecutionRejected("Too many research executions are running. Try again shortly.", 429)
        while len(self._items) >= self.max_retained:
            oldest = next((k for k, e in self._items.items() if e.finished), None)
            if oldest is None:
                raise ExecutionRejected("Too many research executions are running. Try again shortly.", 429)
            del self._items[oldest]
        execution = Execution(plan, steps)
        self._items[execution.id] = execution
        return execution

    def get(self, execution_id: str) -> Execution | None:
        self._purge()
        return self._items.get(execution_id)

    def __len__(self) -> int:
        return len(self._items)


REGISTRY = ExecutionRegistry()


# Running steps

def _local_id(step_id: str) -> str:
    return step_id.split(".", 1)[1]


def _step_state(step: ResearchStep, local_id: str, record: StepRecord, outcome: StepOutcome | None) -> StepState:
    """A StepState for the existing tool and serialiser interfaces."""
    status = {"completed": "completed", "partial": "completed", "failed": "failed"}.get(record.status, "skipped")
    state = StepState(
        step=PlanStep.model_construct(
            id=local_id, tool=step.tool, description=step.description[:200], arguments=step.arguments,
            depends_on=[_local_id(d) for d in step.dependencies],
            optional_depends_on=[_local_id(d) for d in step.optional_dependencies],
        ),
        args=_args_model(step).model_validate(step.arguments),
        status=status,
        summary=record.summary,
        error=record.error,
        outcome=outcome,
    )
    return state


def _discovery_key(location: tuple[float, float] | None, category: str, radius_km: float, limit: int) -> str:
    # Same function (discover_service_features), same centre and parameters.
    return json.dumps(["services", location, category, float(radius_km), int(limit)])


class Orchestrator:
    def __init__(self, execution: Execution, emit: Emit, budget_seconds: float):
        self.execution = execution
        self.emit_fn = emit
        areas = {a.id: tuple(a.coordinates) if a.coordinates else None for a in execution.plan.selected_areas}
        self.location = areas.get("a")
        self.loop = asyncio.get_running_loop()
        self.context = WorkflowContext(
            location=self.location,
            deadline=self.loop.time() + budget_seconds,
            locations={k: v for k, v in areas.items() if v is not None},
        )
        self.agent_context = AgentContext(location=self.location)
        self.discoveries: dict[str, tuple[str, dict[str, Any]]] = {}
        self.stopped: dict[str, str] = {}  # capability -> stop reason

    async def emit(self, event: dict[str, Any]) -> None:
        await self.emit_fn({"execution_id": self.execution.id, **event})

    async def run(self) -> None:
        execution = self.execution
        execution.status, execution.started_at = "running", _now()
        try:
            await self.emit({
                "type": "execution_started",
                "plan_id": execution.plan.id,
                "total_steps": len(execution.steps),
                "steps": [r.public() for r in execution.records.values()],
            })
            for step in execution.steps:
                if execution.cancel_requested:
                    raise asyncio.CancelledError
                await self._run_step(execution.records[step.id])
            execution.current_step = None
            results = self._results()
            self._finish_status(results)
            event_type = "execution_failed" if execution.status == "failed" else "execution_completed"
            await self.emit({"type": event_type, "status": execution.status, "result": self._final(results)})
        except asyncio.CancelledError:
            # Handled here: clear the task's cancel request so later awaits
            # (and timeout contexts) do not re-raise it.
            task = asyncio.current_task()
            if task is not None:
                task.uncancel()
            self._cancel_remaining()
            results = self._results()
            execution.status, execution.finished_at = "cancelled", _now()
            await self.emit({"type": "execution_cancelled", "status": "cancelled", "result": self._final(results)})
        finally:
            for record in execution.records.values():  # release GIS payloads
                record.state, record.layers = None, []
            self.discoveries.clear()

    async def _run_step(self, record: StepRecord) -> None:
        step = record.step
        self.execution.current_step = step.id

        if step.capability_id in self.stopped:
            await self._set(record, "skipped", error=self.stopped[step.capability_id], event="step_skipped")
            return
        failed = [d for d in step.dependencies if not self.execution.records[d].succeeded]
        if failed:
            await self._set(record, "blocked", event="step_blocked",
                            error=f"Required step {', '.join(failed)} did not complete.")
            return
        if self.context.remaining() <= 0:
            await self._set(record, "failed", event="step_failed", error="The research time limit was reached before this step.")
            return

        record.status, record.started_at = "running", _now()
        await self.emit({"type": "step_started", "step_id": step.id, "title": step.title})

        outcome: StepOutcome | None = None
        try:
            if _is_workflow(step):
                outcome = self._reuse(record) or await asyncio.wait_for(
                    WORKFLOW_TOOLS[step.tool].run(
                        _args_model(step).model_validate(step.arguments),
                        self.context,
                        {d: self.execution.records[d].state for d in step.dependencies + step.optional_dependencies
                         if self.execution.records[d].state is not None},
                    ),
                    timeout=max(self.context.remaining(), 0.001),
                )
            else:
                outcome = await self._run_agent_tool(record)
        except StopWorkflow as stop:
            outcome = stop.outcome
            self.stopped[step.capability_id] = stop.reason
            self.execution.warnings.append(stop.reason)
        except StepError as exc:
            record.error = str(exc)
        except (asyncio.TimeoutError, TimeoutError):
            record.error = "The research time limit was reached during this step."
        except asyncio.CancelledError:
            record.status, record.finished_at = "cancelled", _now()
            raise
        except Exception:  # noqa: BLE001 - never leak internals
            logger.exception("Research step %s failed", step.id)
            record.error = "The step failed unexpectedly."

        if outcome is None:
            await self._set(record, "failed", error=record.error or "The step failed.", event="step_failed")
            return

        record.summary, record.preview = outcome.summary, outcome.preview
        record.status = "partial" if outcome.partial else "completed"
        record.state = _step_state(step, _local_id(step.id), record, outcome)
        self._remember(record, outcome)
        record.finished_at = _now()
        event = {"type": "step_partial" if outcome.partial else "step_completed", "step_id": step.id,
                 "summary": record.summary, "preview": record.preview, "reused_from": record.reused_from}
        if outcome.partial:
            event["warning"] = "This step's data is incomplete (for example truncated discovery)."
        await self.emit(event)

    async def _run_agent_tool(self, record: StepRecord) -> StepOutcome | None:
        before = len(self.agent_context.layers)
        result = await asyncio.wait_for(
            execute_tool(record.step.tool, record.step.arguments, self.agent_context),
            timeout=max(self.context.remaining(), 0.001),
        )
        record.layers = self.agent_context.layers[before:]
        if result.status != "completed":
            record.error = result.error
            return None
        partial = bool(result.result and result.result.get("truncated"))
        return StepOutcome(summary=result.summary, result=result.result or {}, preview={}, partial=partial)

    def _reuse(self, record: StepRecord) -> StepOutcome | None:
        """Reuse an identical earlier service discovery instead of a new request."""
        step = record.step
        if step.tool != "discover_services":
            return None
        args = step.arguments
        key = _discovery_key(self.location, args["category"], args["radius_km"], args["limit"])
        if key not in self.discoveries:
            return None
        source, found = self.discoveries[key]
        record.reused_from = source
        summary = (f"{found['returned']} {found['label'].lower()} within {found['search_radius_km']:g} km "
                   f"(reused from step {source}, no new request)")
        return StepOutcome(
            summary=summary,
            result=found,
            preview={k: found[k] for k in ("label", "search_radius_km", "total_found", "returned", "truncated")},
            partial=found["truncated"],
        )

    def _remember(self, record: StepRecord, outcome: StepOutcome) -> None:
        step, args = record.step, record.step.arguments
        if step.tool == "discover_services":
            key = _discovery_key(self.location, args["category"], args["radius_km"], args["limit"])
            self.discoveries.setdefault(key, (step.id, outcome.result))
        elif step.tool == "analyse_area":
            found = outcome.result["found"]
            location = self.context.locations.get(args["area"])
            key = _discovery_key(location, found["category"], args["search_radius_km"], args["limit"])
            self.discoveries.setdefault(key, (step.id, found))

    async def _set(self, record: StepRecord, status: str, event: str, error: str | None = None) -> None:
        record.status, record.error, record.finished_at = status, error, _now()
        # Dependants still see it, as with the existing executor (e.g. the
        # comparison reports a failed area's error instead of zero).
        record.state = _step_state(record.step, _local_id(record.step.id), record, None)
        await self.emit({"type": event, "step_id": record.step.id, "reason" if status in ("blocked", "skipped") else "error": error})

    def _cancel_remaining(self) -> None:
        for record in self.execution.records.values():
            if record.status in ("pending", "running"):
                record.status, record.finished_at = "cancelled", _now()
                record.error = "Cancelled before this step finished."

    # Results

    def _results(self) -> list[dict[str, Any]]:
        results = []
        for capability in research_planner.CAPABILITY_ORDER:
            records = [r for r in self.execution.records.values() if r.step.capability_id == capability]
            aliased = [
                (alias, r) for r in self.execution.records.values() for alias in r.step.aliases
                if alias.split(".", 1)[0] == capability
            ]
            if not records and not aliased:
                continue
            if capability in WORKFLOW_CAPABILITIES:
                results.append(self._workflow_result(capability, records, aliased))
            else:
                results.append(self._tool_result(capability, records))
        return results

    def _workflow_result(self, capability, records, aliased) -> dict[str, Any]:
        states = []
        for record in records:
            states.append(record.state or _step_state(record.step, _local_id(record.step.id), record, None))
        for alias, record in aliased:
            state = copy.copy(record.state or _step_state(record.step, _local_id(alias), record, None))
            state.step = state.step.model_copy(update={"id": _local_id(alias)})
            states.append(state)

        report = next((s for s in states if s.step.id == "report"), None)
        stop = self.stopped.get(capability)
        if report is None or (report.status != "completed" and not stop):
            outcome = "failed"
        elif any(r.status != "completed" for r in records) or any(s.outcome and s.outcome.partial for s in states):
            outcome = "partial"
        else:
            outcome = "completed"
        run = WorkflowRun(outcome=outcome, steps=states, stop_reason=stop)

        if capability == "nearby_count":
            workflow, layers = catalog.serialize(run, self.location)
        elif capability == "coverage":
            workflow, layers = catalog.serialize_coverage(run, self.location)
        elif capability == "comparison":
            workflow, layers = catalog.serialize_comparison(run)
        else:
            workflow, layers = catalog.serialize_suitability(run)
        return {
            "capability_id": capability,
            "title": catalog.CAPABILITIES[capability].title,
            "outcome": outcome,
            "message": catalog.answer_text(run),
            "workflow": workflow,
            "layers": layers,
        }

    def _tool_result(self, capability, records) -> dict[str, Any]:
        failed = [r for r in records if not r.succeeded]
        lines = [r.summary or f"{r.step.title}: {r.error}" for r in records]
        return {
            "capability_id": capability,
            "title": catalog.CAPABILITIES[capability].title,
            "outcome": "completed" if not failed else ("failed" if len(failed) == len(records) else "partial"),
            "message": "\n".join(lines),
            "workflow": None,
            "layers": [layer for r in records for layer in r.layers],
        }

    def _finish_status(self, results: list[dict[str, Any]]) -> None:
        execution = self.execution
        execution.finished_at = _now()
        outcomes = [r["outcome"] for r in results]
        statuses = [r.status for r in execution.records.values()]
        if not outcomes or all(o == "failed" for o in outcomes):
            execution.status = "failed"
        elif any(o == "failed" for o in outcomes) or any(s in ("failed", "blocked") for s in statuses):
            execution.status = "partial"
        elif any(o == "partial" for o in outcomes) or execution.warnings:
            execution.status = "completed_with_warnings"
        else:
            execution.status = "completed"
        execution.errors = [f"{r.step.title}: {r.error}" for r in execution.records.values()
                            if r.status in ("failed", "blocked") and r.error]

    def _final(self, results: list[dict[str, Any]]) -> dict[str, Any]:
        """Final payload: bounded layers plus the light state used for look-ups."""
        budget = MAX_RESULT_BYTES
        for result in results:
            kept = []
            for layer in result["layers"]:
                size = len(json.dumps(layer, default=str))
                if size > budget:
                    self.execution.warnings.append(
                        f"The layer '{layer['name']}' was omitted to keep the response within size limits."
                    )
                    continue
                budget -= size
                kept.append(layer)
            result["layers"] = kept
        self.execution.summaries = [
            {k: r[k] for k in ("capability_id", "title", "outcome", "message")} | {"layer_count": len(r["layers"])}
            for r in results
        ]
        try:
            self.execution.digest = research_evidence.build_digest(self.execution.plan, self.execution.public(), results)
        except Exception:  # noqa: BLE001 - synthesis is optional; never fail the run
            logger.exception("Evidence digest failed for %s", self.execution.id)
            self.execution.digest = None
        return {**self.execution.public(), "results": results}


def execution_budget(plan: ResearchPlan, per_workflow_seconds: float) -> float:
    workflows = {s.capability_id for s in plan.steps if s.capability_id in WORKFLOW_CAPABILITIES}
    return min(per_workflow_seconds * max(len(workflows), 1), MAX_EXECUTION_SECONDS)


async def run_execution(execution: Execution, emit: Emit, budget_seconds: float) -> None:
    await Orchestrator(execution, emit, budget_seconds).run()
