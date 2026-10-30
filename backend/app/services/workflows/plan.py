"""Validated multi-step plans and their bounded, dependency-ordered execution."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

logger = logging.getLogger(__name__)

MAX_PLAN_STEPS = 5
STEP_ID_PATTERN = r"^[a-z][a-z0-9_]{0,31}$"

Emit = Callable[[dict[str, Any]], Awaitable[None]]


class PlanError(ValueError):
    """The plan is not valid and must not be executed."""


class StepError(Exception):
    """A step failed; the message is safe to show to users."""


class StopWorkflow(Exception):
    """A step completed, but later steps have nothing to work on."""

    def __init__(self, reason: str, outcome: "StepOutcome"):
        super().__init__(reason)
        self.reason = reason
        self.outcome = outcome


class PlanStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., pattern=STEP_ID_PATTERN)
    tool: str = Field(..., min_length=1, max_length=50)
    description: str = Field(..., min_length=1, max_length=200)
    arguments: dict[str, Any] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list, max_length=MAX_PLAN_STEPS)
    # Steps whose output is used if available; their failure does not block.
    optional_depends_on: list[str] = Field(default_factory=list, max_length=MAX_PLAN_STEPS)

    @property
    def all_dependencies(self) -> list[str]:
        return self.depends_on + self.optional_depends_on


@dataclass
class StepOutcome:
    summary: str
    result: dict[str, Any]
    # Small, bounded view of the result for progress events.
    preview: dict[str, Any] = field(default_factory=dict)
    partial: bool = False


@dataclass
class WorkflowContext:
    location: tuple[float, float] | None
    deadline: float
    # Named user-selected locations (e.g. comparison areas "a" and "b").
    locations: dict[str, tuple[float, float]] = field(default_factory=dict)

    def remaining(self) -> float:
        return self.deadline - asyncio.get_running_loop().time()


@dataclass(frozen=True)
class WorkflowTool:
    name: str
    args_model: type[BaseModel]
    run: Callable[[Any, WorkflowContext, dict[str, "StepState"]], Awaitable[StepOutcome]]
    # Arguments naming earlier steps, with the tools allowed to produce them.
    step_refs: tuple[tuple[str, frozenset[str]], ...] = ()


@dataclass
class StepState:
    step: PlanStep
    args: BaseModel
    status: str = "pending"  # pending | running | completed | failed | skipped
    summary: str = ""
    error: str | None = None
    outcome: StepOutcome | None = None

    def public(self) -> dict[str, Any]:
        return {
            "id": self.step.id,
            "tool": self.step.tool,
            "description": self.step.description,
            "depends_on": self.step.depends_on,
            "optional_depends_on": self.step.optional_depends_on,
            "arguments": self.args.model_dump(),
            "status": self.status,
            "summary": self.summary,
            "error": self.error,
            "partial": bool(self.outcome and self.outcome.partial),
            "preview": self.outcome.preview if self.outcome else {},
        }


@dataclass
class WorkflowRun:
    outcome: str  # completed | partial | failed
    steps: list[StepState]
    stop_reason: str | None = None

    def step(self, step_id: str) -> StepState | None:
        return next((s for s in self.steps if s.step.id == step_id), None)


def validate_plan(
    raw_steps: list[dict[str, Any] | PlanStep],
    tools: dict[str, WorkflowTool],
) -> list[StepState]:
    """Validate a plan and return its steps in dependency order."""
    if not raw_steps:
        raise PlanError("The plan has no steps.")
    if len(raw_steps) > MAX_PLAN_STEPS:
        raise PlanError(f"Plans may have at most {MAX_PLAN_STEPS} steps.")

    steps: list[PlanStep] = []
    for raw in raw_steps:
        try:
            steps.append(raw if isinstance(raw, PlanStep) else PlanStep.model_validate(raw))
        except ValidationError as exc:
            raise PlanError(f"Invalid plan step: {exc.errors()[0]['msg']}") from exc

    by_id = {step.id: step for step in steps}
    if len(by_id) != len(steps):
        raise PlanError("Step ids must be unique.")

    states: dict[str, StepState] = {}
    for step in steps:
        tool = tools.get(step.tool)
        if tool is None:
            raise PlanError(f"Unknown tool '{step.tool}' in step '{step.id}'.")

        for dependency in step.all_dependencies:
            if dependency == step.id:
                raise PlanError(f"Step '{step.id}' depends on itself.")
            if dependency not in by_id:
                raise PlanError(f"Step '{step.id}' depends on missing step '{dependency}'.")

        try:
            args = tool.args_model.model_validate(step.arguments)
        except ValidationError as exc:
            error = exc.errors()[0]
            raise PlanError(
                f"Invalid arguments for step '{step.id}': "
                f"{'.'.join(str(p) for p in error['loc'])}: {error['msg']}"
            ) from exc

        states[step.id] = StepState(step=step, args=args)

    # Steps referenced by arguments must be declared dependencies of the right kind.
    for step in steps:
        for arg_name, producers in tools[step.tool].step_refs:
            ref = getattr(states[step.id].args, arg_name)
            if ref not in step.all_dependencies:
                raise PlanError(f"Step '{step.id}' uses '{ref}' without depending on it.")
            if by_id[ref].tool not in producers:
                raise PlanError(
                    f"Step '{step.id}' needs output from {', '.join(sorted(producers))}, "
                    f"not '{by_id[ref].tool}'."
                )

    # Topological order (Kahn), stable with respect to the given order.
    ordered: list[StepState] = []
    done: set[str] = set()
    remaining = list(steps)
    while remaining:
        ready = [s for s in remaining if all(d in done for d in s.all_dependencies)]
        if not ready:
            raise PlanError("The plan has a circular dependency.")
        for step in ready:
            ordered.append(states[step.id])
            done.add(step.id)
        remaining = [s for s in remaining if s.id not in done]

    return ordered


async def _noop(_: dict[str, Any]) -> None:
    return None


async def execute_plan(
    states: list[StepState],
    tools: dict[str, WorkflowTool],
    context: WorkflowContext,
    emit: Emit = _noop,
) -> WorkflowRun:
    """Run validated steps in order. Never runs a step whose inputs failed."""
    by_id = {state.step.id: state for state in states}
    stop_reason: str | None = None

    await emit({"type": "plan_created", "plan": [state.public() for state in states]})

    for state in states:
        step_id = state.step.id
        dependencies = [by_id[d] for d in state.step.all_dependencies]
        blocked = [by_id[d].step.id for d in state.step.depends_on if by_id[d].status != "completed"]

        if stop_reason or blocked:
            state.status = "skipped"
            state.error = stop_reason or f"Skipped because step {', '.join(blocked)} did not complete."
            await emit({"type": "step_skipped", "step_id": step_id, "reason": state.error})
            continue

        if context.remaining() <= 0:
            state.status = "failed"
            state.error = "The workflow time limit was reached before this step."
            await emit({"type": "step_failed", "step_id": step_id, "error": state.error})
            continue

        state.status = "running"
        await emit({"type": "step_started", "step_id": step_id})

        try:
            outcome = await asyncio.wait_for(
                tools[state.step.tool].run(
                    state.args,
                    context,
                    {d.step.id: d for d in dependencies},
                ),
                timeout=max(context.remaining(), 0.001),
            )
        except StopWorkflow as stop:
            outcome = stop.outcome
            stop_reason = stop.reason
        except StepError as exc:
            outcome = None
            state.error = str(exc)
        except asyncio.TimeoutError:
            outcome = None
            state.error = "The workflow time limit was reached during this step."
        except Exception:  # noqa: BLE001 - never leak internals
            logger.exception("Workflow step %s failed", step_id)
            outcome = None
            state.error = "The step failed unexpectedly."

        if outcome is None:
            state.status = "failed"
            await emit({"type": "step_failed", "step_id": step_id, "error": state.error})
            continue

        state.status = "completed"
        state.outcome = outcome
        state.summary = outcome.summary
        await emit({
            "type": "step_completed",
            "step_id": step_id,
            "summary": outcome.summary,
            "partial": outcome.partial,
            "preview": outcome.preview,
        })

    final = states[-1]
    if final.status != "completed" and not stop_reason:
        result = "failed"
    elif any(s.status == "failed" or (s.outcome and s.outcome.partial) for s in states):
        result = "partial"
    else:
        result = "completed"

    await emit({"type": f"workflow_{result}", "stop_reason": stop_reason})
    return WorkflowRun(outcome=result, steps=states, stop_reason=stop_reason)
