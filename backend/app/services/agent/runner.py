"""Bounded tool-calling loop and the deterministic fast path."""

import json
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from app.services import osm_discovery
from app.services.agent.tools import TOOLS, AgentContext, AgentTool, ToolError
from app.services.llm.base import LLMError, LLMProvider, ToolCall

logger = logging.getLogger(__name__)

MAX_CALLS_PER_TURN = 3
MAX_TOOL_RESULT_CHARS = 6000
MAX_ANSWER_CHARS = 4000

Emit = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class AgentStep:
    tool: str
    arguments: dict[str, Any] | None
    status: str  # "completed" | "failed"
    summary: str
    error: str | None = None
    result: dict[str, Any] | None = None

    def public(self) -> dict[str, Any]:
        return {
            "tool": self.tool,
            "arguments": self.arguments,
            "status": self.status,
            "summary": self.summary,
            "error": self.error,
        }


@dataclass
class AgentRunResult:
    answer: str
    steps: list[AgentStep] = field(default_factory=list)
    layers: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    error_code: str | None = None
    hit_iteration_limit: bool = False


async def _noop(_: dict[str, Any]) -> None:
    return None


def system_prompt(context: AgentContext) -> str:
    if context.location:
        location = (
            f"The user has selected a map location at longitude {context.location[0]:.5f}, "
            f"latitude {context.location[1]:.5f}. Tools use it automatically."
        )
    else:
        location = (
            "The user has NOT selected a map location. If the request needs one, "
            "do not call location tools; ask the user to pick a location on the map."
        )

    return (
        "You are GeoMind AI, a GIS assistant. Answer using only results returned "
        "by tools. Never invent places, counts, coordinates or distances. If a tool "
        "fails, say so plainly and do not claim the operation succeeded. Mention "
        "coverage or truncation caveats returned by tools. Be concise.\n"
        f"{location}"
    )


def _summarise(tool: str, result: dict[str, Any]) -> str:
    if tool == "discover_features":
        text = f"{result['returned']} {result['label'].lower()} within {result['radius_km']:g} km"
        return text + (" (truncated)" if result["truncated"] else "")
    if tool == "find_nearest_features":
        return f"Ranked {len(result['nearest'])} nearest of {result['checked']}"
    if tool == "create_buffer":
        return f"Buffer of {result['distance_metres']:g} m"
    if tool == "analyse_service_coverage":
        pct = result["percentages"]
        return (
            f"{result['total_cells']} cells: {pct['underserved']}% underserved"
            + (" (partial)" if result["partial"] else "")
        )
    if tool == "spatial_query":
        return f"{result['matched_count']} of {result['total_features']} features {result['operation']} the buffer"
    return "Completed"


async def execute_tool(
    name: str,
    arguments: dict[str, Any] | None,
    context: AgentContext,
    tools: dict[str, AgentTool] = TOOLS,
) -> AgentStep:
    tool = tools.get(name)

    if tool is None:
        return AgentStep(name or "(unnamed)", arguments, "failed", "Unknown tool",
                         f"Unknown tool '{name}'. Available: {', '.join(tools)}.")

    if arguments is None:
        return AgentStep(name, None, "failed", "Invalid arguments",
                         "Tool arguments were not a valid JSON object.")

    try:
        args = tool.args_model.model_validate(arguments)
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(p) for p in err['loc']) or 'arguments'}: {err['msg']}"
            for err in exc.errors()[:5]
        )
        return AgentStep(name, arguments, "failed", "Invalid arguments", problems)

    try:
        result = await tool.run(args, context)
    except ToolError as exc:
        return AgentStep(name, args.model_dump(), "failed", "Tool failed", str(exc))
    except Exception:  # noqa: BLE001 - never leak internals to the model or user
        logger.exception("Agent tool %s failed", name)
        return AgentStep(name, args.model_dump(), "failed", "Tool failed",
                         "The tool failed unexpectedly.")

    return AgentStep(name, args.model_dump(), "completed", _summarise(name, result), result=result)


def _tool_message(call: ToolCall, step: AgentStep) -> dict[str, Any]:
    payload = (
        {"ok": True, "result": step.result}
        if step.status == "completed"
        else {"ok": False, "error": step.error}
    )
    content = json.dumps(payload, default=str)
    if len(content) > MAX_TOOL_RESULT_CHARS:
        content = content[:MAX_TOOL_RESULT_CHARS] + "…(truncated)"
    return {"role": "tool", "tool_call_id": call.id, "content": content}


def _fallback_answer(steps: list[AgentStep]) -> str:
    if not steps:
        return "The model did not return an answer."
    lines = [
        f"- {step.tool}: {step.summary}" + (f" ({step.error})" if step.error else "")
        for step in steps
    ]
    return "The model did not return a final answer. Tool results:\n" + "\n".join(lines)


async def run_agent(
    message: str,
    context: AgentContext,
    provider: LLMProvider,
    max_iterations: int,
    emit: Emit = _noop,
    tools: dict[str, AgentTool] = TOOLS,
) -> AgentRunResult:
    """Ask the model, run requested tools, and stop after max_iterations rounds.

    At most max_iterations tool rounds plus one final answer call are made.
    """
    specs = [tool.spec() for tool in tools.values()]
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt(context)},
        {"role": "user", "content": message},
    ]
    steps: list[AgentStep] = []

    def finish(answer: str, **extra: Any) -> AgentRunResult:
        return AgentRunResult(
            answer=(answer or _fallback_answer(steps))[:MAX_ANSWER_CHARS],
            steps=steps,
            layers=context.layers,
            **extra,
        )

    try:
        for _ in range(max_iterations):
            await emit({"type": "thinking"})
            response = await provider.chat(messages, specs)

            if not response.tool_calls:
                return finish(response.content)

            calls = response.tool_calls[:MAX_CALLS_PER_TURN]
            messages.append({
                "role": "assistant",
                "content": response.content or "",
                "tool_calls": [
                    {
                        "id": call.id,
                        "type": "function",
                        # Echo valid JSON only; strict providers reject malformed
                        # arguments in history (the tool result explains the error).
                        "function": {
                            "name": call.name,
                            "arguments": json.dumps(call.arguments) if call.arguments is not None else "{}",
                        },
                    }
                    for call in calls
                ],
            })

            for call in calls:
                await emit({"type": "tool_started", "tool": call.name, "arguments": call.arguments})
                step = await execute_tool(call.name, call.arguments, context, tools)
                steps.append(step)
                await emit({"type": "tool_finished", "step": step.public()})
                messages.append(_tool_message(call, step))

        # Iteration budget spent: one last call without tools for the answer.
        await emit({"type": "thinking"})
        # A user turn, not a system message: several providers only accept
        # system messages at the start of the conversation.
        messages.append({
            "role": "user",
            "content": "Tool limit reached. Answer now using only the tool results above.",
        })
        response = await provider.chat(messages, None)
        return finish(response.content, hit_iteration_limit=True)

    except LLMError as exc:
        return finish(
            str(exc) if not steps else f"{exc} Partial tool results:\n{_fallback_answer(steps)}",
            error=str(exc),
            error_code=exc.code,
        )


# Deterministic fast path: "find hospitals within 5 km" needs no LLM call.

_FAST_PATTERN = re.compile(
    r"^\s*(?:please\s+)?(?:find|show|list|get|locate|search(?:\s+for)?|discover)\s+"
    r"(?:me\s+)?(?:all\s+|the\s+|any\s+)?(?P<category>[a-z][a-z \-]{1,40}?)\s+"
    r"(?:within|in|inside)\s+(?:a\s+)?(?P<radius>\d+(?:\.\d+)?)\s*"
    r"(?P<unit>km|kms|kilometers?|kilometres?|m|meters?|metres?)\b",
    re.IGNORECASE,
)


def parse_discovery_request(message: str) -> tuple[str, float] | None:
    """Return (category, radius_km) for simple, unambiguous discovery requests."""
    match = _FAST_PATTERN.match(message)

    if not match:
        return None

    try:
        category = osm_discovery.normalize_category(match["category"])
    except ValueError:
        return None

    radius = float(match["radius"])
    if not match["unit"].lower().startswith("k"):
        radius /= 1000  # metres

    return category, radius


def describe_discovery(result: dict[str, Any]) -> str:
    """Plain-language summary of a discover_features result (no LLM)."""
    label = result["label"].lower()
    radius = f"{result['radius_km']:g} km"

    if result["returned"] == 0:
        return (
            f"No {label} are mapped in OpenStreetMap within {radius} of the selected "
            f"location. {result['coverage_note']}"
        )

    lines = [
        f"- {item['name']} — {item['distance_km']:.2f} km"
        for item in result["nearest"][:5]
        if item["distance_km"] is not None
    ]
    text = f"Found {result['returned']} {label} within {radius}. Nearest:\n" + "\n".join(lines)

    if result["truncated"]:
        text += f"\nResults were truncated to {result['returned']} of {result['total_found']}."
    if result["unnamed_count"]:
        text += f"\n{result['unnamed_count']} have no name in OpenStreetMap."

    return f"{text}\n{result['coverage_note']} Source: {result['source']}."
