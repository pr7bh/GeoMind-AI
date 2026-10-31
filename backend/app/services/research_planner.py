"""Research planner: natural-language GIS questions → validated research plans.

Planning only. Nothing here runs a GIS step or contacts Overpass. Steps are
built by the existing workflow plan builders (and validated by the same
`validate_plan`), or are single agent tools, so a later executor can run
them unchanged.

Interpretation is deterministic (the existing request matchers). When the
rules find nothing and an LLM is configured, the model may propose intents,
but only through a strict schema: capability ids from the catalog, OSM
categories that normalise, bounded radii, and never coordinates. Anything
else is rejected and never becomes a plan.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.schemas.research import (
    CapabilityUse,
    MissingInput,
    ResearchPlan,
    ResearchPlanRequest,
    ResearchStep,
    SelectedArea,
)
from app.services import coverage, osm_discovery, suitability
from app.services.agent.runner import parse_discovery_request
from app.services.agent.tools import TOOLS as AGENT_TOOLS
from app.services.llm.base import LLMError, LLMProvider
from app.services.workflows import catalog
from app.services.workflows.plan import PlanError, validate_plan
from app.services.workflows.steps import WORKFLOW_TOOLS

logger = logging.getLogger(__name__)

MAX_INTENTS = 4
DEFAULT_DISCOVERY_RADIUS_KM = 5.0
LLM_TIMEOUT_MARGIN_SECONDS = 2.0

# Order in which capabilities run when several are planned together:
# shared study areas first, recommendations last.
CAPABILITY_ORDER = (
    "comparison", "coverage", "nearby_count", "discover_features",
    "find_nearest_features", "create_buffer", "spatial_query", "suitability",
)

# Every capability is a real agent tool or workflow type.
_WORKFLOW_TYPES = {"nearby_count", "coverage", "comparison", "suitability"}
assert set(catalog.CAPABILITIES) == (set(AGENT_TOOLS) - {"analyse_service_coverage"}) | _WORKFLOW_TYPES
assert set(CAPABILITY_ORDER) == set(catalog.CAPABILITIES)


@dataclass(frozen=True)
class StepInfo:
    title: str
    outputs: tuple[str, ...]
    inputs: tuple[str, ...] = ()


# What each existing tool contributes to a plan (workflow step tools and
# agent tools share the "discover_features" name and meaning).
STEP_INFO: dict[str, StepInfo] = {
    "discover_features": StepInfo("Discover features", ("Mapped OpenStreetMap features (map layer)", "Truncation flag"), ("location",)),
    "discover_near_features": StepInfo("Find nearby features per result", ("Nearby features within the radius of each result",)),
    "rank_by_nearby_count": StepInfo("Rank by nearby count", ("Ranking with tied ranks; failed searches listed separately",)),
    "report_findings": StepInfo("Summarise ranking", ("Findings and caveats",)),
    "discover_services": StepInfo("Discover existing services", ("Existing services (features)", "Truncation flag"), ("location",)),
    "analyse_coverage": StepInfo("Calculate service coverage", ("Grid cells classified by nearest-service distance", "Coverage metrics"), ("location",)),
    "report_coverage": StepInfo("Identify underserved cells", ("Underserved share and coverage summary", "Caveats")),
    "analyse_area": StepInfo("Analyse study area", ("Coverage grid and metrics for the area",)),
    "compare_areas": StepInfo("Compare areas metric by metric", ("Per-metric differences (no overall winner)",)),
    "report_comparison": StepInfo("Summarise comparison", ("Comparison summary and caveats",)),
    "score_suitability": StepInfo("Score candidate sites", ("Ranked analytical candidates (0–100)", "Unscored candidates"), ("location",)),
    "report_suitability": StepInfo("Summarise site suitability", ("Highest-scoring candidate, reasons and caveats",)),
    "find_nearest_features": StepInfo("Rank nearest features", ("Features ranked by geodesic distance",), ("location",)),
    "create_buffer": StepInfo("Create buffer", ("Buffer polygon around the study location",), ("location",)),
    "spatial_query": StepInfo("Filter features by buffer", ("Features inside the buffer",)),
}
assert set(WORKFLOW_TOOLS) <= set(STEP_INFO) and set(catalog.CAPABILITIES) & set(AGENT_TOOLS) <= set(STEP_INFO)

INPUT_LABELS = {
    "location": ("Study location (Area A)", "pick_location"),
    "compare_location": ("Second study area (Area B)", "pick_compare_location"),
    "category": ("Service category", "edit_question"),
    "facility": ("Facility type", "edit_question"),
}
CLARIFICATIONS = {
    "location": "Select a location on the map to define the study area.",
    "compare_location": "Select the second area on the map.",
    "category": "Which service should be analysed (for example hospitals, schools or pharmacies)?",
    "facility": "Which facility should sites be found for: hospital, school, pharmacy, police station or fire station?",
}
SUGGESTIONS = (
    "Find hospitals within 5 km",
    "Identify areas with poor hospital coverage around this location",
    "Compare hospital coverage between two areas",
    "Find suitable locations for a new hospital",
)
SUPPORTED_ALTERNATIVES = (
    "Supported criteria instead: distance to existing facilities, nearby service gap, "
    "facility density and pharmacy proximity."
)

_NEAREST = re.compile(r"\b(nearest|closest)\b", re.IGNORECASE)
_BUFFER = re.compile(r"\bbuffer\b", re.IGNORECASE)
_DISTANCE = re.compile(r"(\d+(?:\.\d+)?)\s*(km|kms|kilomet(?:er|re)s?|m|met(?:er|re)s?)\b", re.IGNORECASE)
_FIND = re.compile(r"\b(find|show|list|locate|where\s+are|discover|map)\b", re.IGNORECASE)


class ResearchPlanError(ValueError):
    """The assembled plan is not valid; the message is safe to show."""


@dataclass
class Intent:
    capability: str
    interpretation: str
    objective: str
    # Raw sub-plan steps: dicts with id/tool/description/arguments/
    # depends_on/optional_depends_on (local ids), or [] when not buildable.
    steps: list[dict[str, Any]] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    invalid: str | None = None


def _label(category: str) -> str:
    return osm_discovery.OSM_CATEGORIES[category]["label"].lower()


def _singular(category: str) -> str:
    return category.replace("_", " ")


def _category_in(text: str) -> str | None:
    lowered = text.lower()
    return next((cat for phrase, cat in catalog._TERMS if re.search(rf"\b{re.escape(phrase)}\b", lowered)), None)


def _radius_km(text: str, default: float) -> float:
    match = catalog._COVERAGE_RADIUS.search(text)
    return catalog._km(match[1], match[2]) if match else default


# Intent builders (shared by the rules and the validated LLM path)

def _workflow_steps(plan: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate a workflow sub-plan with the existing validator."""
    states = validate_plan(plan, WORKFLOW_TOOLS)
    return [
        {
            "id": s.step.id,
            "tool": s.step.tool,
            "description": s.step.description,
            "arguments": s.args.model_dump(),
            "depends_on": list(s.step.depends_on),
            "optional_depends_on": list(s.step.optional_depends_on),
        }
        for s in states
    ]


def _tool_step(step_id: str, tool: str, description: str, arguments: dict[str, Any], depends_on=()) -> dict[str, Any]:
    args = AGENT_TOOLS[tool].args_model.model_validate(arguments)  # raises ValidationError
    return {
        "id": step_id, "tool": tool, "description": description,
        "arguments": args.model_dump(), "depends_on": list(depends_on), "optional_depends_on": [],
    }


def _limit_error(capability: str, radius_km: float) -> str | None:
    if radius_km > coverage.MAX_STUDY_RADIUS_KM:
        name = catalog.CAPABILITIES[capability].title
        return f"{name} is limited to a {coverage.MAX_STUDY_RADIUS_KM:g} km radius; the question asks for {radius_km:g} km."
    return None


def discovery_intent(category: str, radius_km: float) -> Intent:
    label = _label(category)
    intent = Intent(
        "discover_features",
        f"Feature discovery: {label} within {radius_km:g} km of the study location.",
        f"find {label} within {radius_km:g} km of the study location",
    )
    max_km = osm_discovery.OSM_CATEGORIES[category]["max_radius_km"]
    if radius_km > max_km:
        intent.invalid = f"Discovery of {label} is limited to {max_km:g} km; the question asks for {radius_km:g} km."
        return intent
    intent.steps = [_tool_step("discover", "discover_features", f"Find {label} within {radius_km:g} km",
                               {"category": category, "radius_km": radius_km})]
    return intent


def nearest_intent(category: str, radius_km: float) -> Intent:
    intent = discovery_intent(category, radius_km)
    if intent.invalid:
        intent.capability = "find_nearest_features"
        return intent
    label = _label(category)
    return Intent(
        "find_nearest_features",
        f"Nearest features: the {label} closest to the study location (searched within {radius_km:g} km).",
        f"rank the nearest {label} to the study location",
        steps=intent.steps + [_tool_step("rank", "find_nearest_features", f"Rank {label} by distance", {}, ["discover"])],
    )


def buffer_intent(distance_m: float, category: str | None) -> Intent:
    steps = [_tool_step("buffer", "create_buffer", f"Create a {distance_m:g} m buffer", {"distance_metres": distance_m})]
    if category is None:
        return Intent("create_buffer", f"Buffer: {distance_m:g} m around the study location.",
                      f"create a {distance_m:g} m buffer around the study location", steps)
    label = _label(category)
    radius_km = max(distance_m / 1000, 0.1)
    steps += [
        _tool_step("discover", "discover_features", f"Find {label} within {radius_km:g} km", {"category": category, "radius_km": radius_km}),
        _tool_step("select", "spatial_query", f"Keep {label} within the buffer", {"operation": "within"}, ["buffer", "discover"]),
    ]
    return Intent("spatial_query", f"Spatial query: {label} within {distance_m:g} m of the study location.",
                  f"select {label} within {distance_m:g} m of the study location", steps)


def nearby_count_intent(request: catalog.NearbyCountRequest) -> Intent:
    source, target = _label(request.source_category), _label(request.target_category)
    return Intent(
        "nearby_count",
        f"Nearby-count ranking: {source} within {request.source_radius_km:g} km ranked by {target} within "
        f"{request.target_radius_km:g} km of each.",
        f"rank {source} by the number of {target} within {request.target_radius_km:g} km",
        steps=_workflow_steps(catalog.build_plan(request)),
    )


def coverage_intent(request: catalog.CoverageRequest) -> Intent:
    label = _label(request.category)
    intent = Intent(
        "coverage",
        f"Service coverage: {label} within {request.radius_km:g} km, classifying grid cells and identifying underserved areas.",
        f"measure {_singular(request.category)} coverage within {request.radius_km:g} km and identify underserved areas",
    )
    intent.invalid = _limit_error("coverage", request.radius_km)
    if not intent.invalid:
        intent.steps = _workflow_steps(catalog.build_coverage_plan(request))
    return intent


def comparison_intent(request: catalog.ComparisonRequest) -> Intent:
    if request.category is None:
        return Intent("comparison", "Area comparison: the service to compare was not named.",
                      "compare two study areas", missing=["category"])
    label = _label(request.category)
    intent = Intent(
        "comparison",
        f"Area comparison: {_singular(request.category)} coverage in Area A and Area B ({request.radius_km:g} km each, identical settings).",
        f"compare {_singular(request.category)} coverage between Area A and Area B",
    )
    intent.invalid = _limit_error("comparison", request.radius_km)
    if not intent.invalid:
        intent.steps = _workflow_steps(catalog.build_comparison_plan(request))
    return intent


def suitability_intent(request: catalog.SuitabilityRequest) -> Intent:
    if request.facility is None:
        return Intent("suitability", "Site suitability: the facility type was not named.",
                      "recommend candidate sites", missing=["facility"])
    label = suitability.FACILITIES[request.facility].label.lower()
    weights = {suitability.DENSITY: 1.0} if request.low_density else None
    settings = catalog.SuitabilitySettings(weights=suitability.validate_weights(request.facility, weights, None))
    intent = Intent(
        "suitability",
        f"Site suitability: analytical candidate points for a new {label} within {request.radius_km:g} km"
        + (", ranked by lowest facility density." if request.low_density else ", scored on the default weighted criteria."),
        f"recommend candidate locations for a new {label}",
    )
    intent.invalid = _limit_error("suitability", request.radius_km)
    if not intent.invalid:
        intent.steps = _workflow_steps(catalog.build_suitability_plan(request, settings))
    return intent


# Deterministic interpretation

def rule_intents(question: str) -> tuple[list[Intent], list[str]]:
    """Intents found by the existing matchers, with overlap removed."""
    assumptions: list[str] = []
    nearby = catalog.match_workflow(question)
    compare = catalog.match_comparison(question)
    cover = catalog.match_coverage(question)
    suit = catalog.match_suitability(question)

    # The comparison computes coverage for both areas: a coverage question
    # about the same service is answered by it, not planned twice.
    if compare and cover:
        if compare.category is None:
            compare = catalog.ComparisonRequest(cover.category, compare.radius_km)
        if compare.category == cover.category and compare.radius_km == cover.radius_km:
            assumptions.append(
                "Underserved areas are identified from the comparison's coverage grids for both areas, "
                "so no separate coverage analysis is planned."
            )
            cover = None

    intents: list[Intent] = []
    if compare:
        intents.append(comparison_intent(compare))
    if cover:
        intents.append(coverage_intent(cover))
    if nearby:
        intents.append(nearby_count_intent(nearby))
    if suit:
        intents.append(suitability_intent(suit))
        if compare:
            assumptions.append("Site suitability uses Area A as its study area.")

    if not intents:
        fast = parse_discovery_request(question)
        category = fast[0] if fast else _category_in(question)
        if category and _BUFFER.search(question) and (distance := _DISTANCE.search(question)):
            metres = float(distance[1]) * (1000 if distance[2].lower().startswith("k") else 1)
            intents.append(buffer_intent(metres, category))
        elif category and _NEAREST.search(question):
            radius = _radius_km(question, DEFAULT_DISCOVERY_RADIUS_KM)
            intents.append(nearest_intent(category, radius))
        elif fast:
            intents.append(discovery_intent(*fast))
        elif category and _FIND.search(question):
            intents.append(discovery_intent(category, DEFAULT_DISCOVERY_RADIUS_KM))
            assumptions.append(f"No radius was given, so the default {DEFAULT_DISCOVERY_RADIUS_KM:g} km is used.")
        elif _BUFFER.search(question) and (distance := _DISTANCE.search(question)):
            metres = float(distance[1]) * (1000 if distance[2].lower().startswith("k") else 1)
            intents.append(buffer_intent(metres, None))

    for intent in intents:
        if intent.capability in ("coverage", "comparison", "suitability") and not catalog._COVERAGE_RADIUS.search(question):
            assumptions.append(
                f"No study radius was given, so the default {coverage.DEFAULT_STUDY_RADIUS_KM:g} km is used."
            )
            break

    return intents[:MAX_INTENTS], assumptions


# Optional LLM interpretation (validated; never trusted as-is)

class LLMIntent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    capability_id: Literal[tuple(catalog.CAPABILITIES)]
    category: str | None = Field(None, max_length=50)
    target_category: str | None = Field(None, max_length=50)
    facility: Literal[tuple(suitability.FACILITIES)] | None = None
    radius_km: float | None = Field(None, gt=0, le=osm_discovery.MAX_RADIUS_KM)
    target_radius_km: float | None = Field(None, gt=0, le=2)
    distance_metres: float | None = Field(None, gt=0, le=50_000)


class LLMProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    objective: str = Field(..., min_length=1, max_length=300)
    intents: list[LLMIntent] = Field(..., min_length=1, max_length=MAX_INTENTS)


PROPOSE_TOOL = {
    "type": "function",
    "function": {
        "name": "propose_research_plan",
        "description": "Propose which GeoMind capabilities answer the question. Do not include coordinates.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["objective", "intents"],
            "properties": {
                "objective": {"type": "string", "maxLength": 300},
                "intents": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_INTENTS,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["capability_id"],
                        "properties": {
                            "capability_id": {"type": "string", "enum": list(catalog.CAPABILITIES)},
                            "category": {"type": "string", "description": "OpenStreetMap category, e.g. hospital"},
                            "target_category": {"type": "string", "description": "nearby_count only"},
                            "facility": {"type": "string", "enum": list(suitability.FACILITIES)},
                            "radius_km": {"type": "number"},
                            "target_radius_km": {"type": "number"},
                            "distance_metres": {"type": "number", "description": "buffer distance"},
                        },
                    },
                },
            },
        },
    },
}


def _system_prompt() -> str:
    lines = [
        "You map geographic research questions to GeoMind capabilities. Call propose_research_plan once.",
        "Use only these capability ids:",
        *(f"- {c.id}: {c.summary}" for c in catalog.CAPABILITIES.values()),
        "Never invent coordinates, datasets or results. Population, land, zoning, cost, traffic and "
        "travel-time data are not available. If nothing fits, propose nothing.",
    ]
    return "\n".join(lines)


def _intent_from_llm(item: LLMIntent) -> Intent:
    """Convert one validated LLM intent through the normal builders."""
    def category(value: str | None) -> str:
        if value is None:
            raise ValueError("missing category")
        return osm_discovery.normalize_category(value)  # raises ValueError

    radius = item.radius_km or coverage.DEFAULT_STUDY_RADIUS_KM
    match item.capability_id:
        case "discover_features":
            return discovery_intent(category(item.category), item.radius_km or DEFAULT_DISCOVERY_RADIUS_KM)
        case "find_nearest_features":
            return nearest_intent(category(item.category), item.radius_km or DEFAULT_DISCOVERY_RADIUS_KM)
        case "create_buffer" | "spatial_query":
            if item.distance_metres is None:
                raise ValueError("missing buffer distance")
            return buffer_intent(item.distance_metres, category(item.category) if item.category else None)
        case "nearby_count":
            return nearby_count_intent(catalog.NearbyCountRequest(
                category(item.category), item.radius_km or DEFAULT_DISCOVERY_RADIUS_KM,
                category(item.target_category), item.target_radius_km or 1.0,
            ))
        case "coverage":
            cat = category(item.category)
            if cat not in catalog.COVERAGE_CATEGORIES:
                raise ValueError("not a coverage category")
            return coverage_intent(catalog.CoverageRequest(cat, radius))
        case "comparison":
            cat = category(item.category)
            if cat not in catalog.COVERAGE_CATEGORIES:
                raise ValueError("not a coverage category")
            return comparison_intent(catalog.ComparisonRequest(cat, radius))
        case "suitability":
            return suitability_intent(catalog.SuitabilityRequest(item.facility, radius))
    raise ValueError("unknown capability")


async def llm_intents(question: str, context: str | None, provider: LLMProvider, timeout: float) -> list[Intent]:
    """Ask the model for intents; raises ValueError for anything invalid."""
    user = question if not context else f"{question}\n\nContext: {context}"
    response = await asyncio.wait_for(
        provider.chat([{"role": "system", "content": _system_prompt()}, {"role": "user", "content": user}], [PROPOSE_TOOL]),
        timeout=timeout,
    )
    calls = [c for c in response.tool_calls if c.name == "propose_research_plan"]
    if len(calls) != 1 or calls[0].arguments is None:
        raise ValueError("The model did not return one valid plan proposal.")
    try:
        proposal = LLMProposal.model_validate(calls[0].arguments)
        return [_intent_from_llm(item) for item in proposal.intents]
    except (ValidationError, PlanError, suitability.SuitabilityError) as exc:
        raise ValueError(f"The model's proposal failed validation: {exc}") from exc


# Plan assembly and validation

def _assemble(intents: list[Intent]) -> list[dict[str, Any]]:
    """Prefix step ids, merge identical steps, and order by dependencies."""
    ordered = sorted(intents, key=lambda i: CAPABILITY_ORDER.index(i.capability))
    steps: list[dict[str, Any]] = []
    by_key: dict[str, str] = {}

    for intent in ordered:
        rename: dict[str, str] = {}
        for raw in intent.steps:
            step_id = f"{intent.capability}.{raw['id']}"
            refs = dict(WORKFLOW_TOOLS[raw["tool"]].step_refs) if raw["tool"] in WORKFLOW_TOOLS else {}
            arguments = {
                k: (rename.get(v, f"{intent.capability}.{v}") if k in refs and v else v)
                for k, v in raw["arguments"].items()
            }
            key = json.dumps([raw["tool"], arguments, _inputs(raw["tool"], arguments)], sort_keys=True)
            if key in by_key and not raw["depends_on"] and not raw["optional_depends_on"]:
                rename[raw["id"]] = by_key[key]  # identical independent step: reuse it
                next(s for s in steps if s["id"] == by_key[key])["aliases"].append(step_id)
                continue
            rename[raw["id"]] = step_id
            by_key[key] = step_id
            steps.append({
                **raw,
                "id": step_id,
                "capability_id": intent.capability,
                "arguments": arguments,
                "depends_on": [rename[d] for d in raw["depends_on"]],
                "optional_depends_on": [rename[d] for d in raw["optional_depends_on"] if d in rename],
                "aliases": [],
            })
    return steps


def _inputs(tool: str, arguments: dict[str, Any]) -> list[str]:
    if tool == "analyse_area":
        return ["location"] if arguments.get("area") == "a" else ["compare_location"]
    return list(STEP_INFO[tool].inputs)


def validate_research_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Check ids, capabilities, tools and the dependency graph; return in execution order."""
    ids = [s["id"] for s in steps]
    if len(ids) != len(set(ids)):
        raise ResearchPlanError("Step ids must be unique.")
    known = set(ids)
    for step in steps:
        if step["capability_id"] not in catalog.CAPABILITIES:
            raise ResearchPlanError(f"Unknown capability '{step['capability_id']}'.")
        if step["tool"] not in WORKFLOW_TOOLS and step["tool"] not in AGENT_TOOLS:
            raise ResearchPlanError(f"Unknown tool '{step['tool']}'.")
        for dep in step["depends_on"] + step["optional_depends_on"]:
            if dep == step["id"]:
                raise ResearchPlanError(f"Step '{step['id']}' depends on itself.")
            if dep not in known:
                raise ResearchPlanError(f"Step '{step['id']}' depends on unknown step '{dep}'.")

    # Stable topological order: always take the earliest step whose
    # dependencies are done, so each capability's steps stay together.
    ordered, done, remaining = [], set(), list(steps)
    while remaining:
        step = next((s for s in remaining if all(d in done for d in s["depends_on"] + s["optional_depends_on"])), None)
        if step is None:
            raise ResearchPlanError("The plan has a circular dependency.")
        ordered.append(step)
        done.add(step["id"])
        remaining.remove(step)
    return ordered


def _plan_id(question: str, areas: list[SelectedArea], steps: list[dict[str, Any]]) -> str:
    payload = json.dumps(
        {
            "q": " ".join(question.lower().split()),
            "areas": [[round(c, 6) for c in a.coordinates] if a.coordinates else None for a in areas],
            "steps": [[s["id"], s["tool"], s["arguments"]] for s in steps],
        },
        sort_keys=True,
    )
    return "rp-" + hashlib.sha256(payload.encode()).hexdigest()[:12]


def build_plan(
    request: ResearchPlanRequest,
    intents: list[Intent],
    assumptions: list[str],
    interpreter: Literal["rules", "llm"],
    notes: list[str] | None = None,
) -> ResearchPlan:
    question = request.question.strip()
    location = request.coordinates
    compare = request.compare_coordinates
    limitations: list[str] = list(notes or [])

    unsupported = catalog.unsupported_criteria(question)
    if unsupported:
        limitations.append(suitability.unsupported_note(unsupported) + " " + SUPPORTED_ALTERNATIVES)

    invalid = [i.invalid for i in intents if i.invalid]
    status: str
    steps: list[dict[str, Any]] = []
    error: str | None = None
    if invalid:
        error = " ".join(invalid)
    else:
        try:
            steps = validate_research_steps(_assemble([i for i in intents if not i.missing]))
        except ResearchPlanError as exc:
            error = str(exc)

    available = {"location": location is not None, "compare_location": compare is not None}
    missing_ids: list[str] = []
    for intent in intents:
        missing_ids += [m for m in intent.missing if m not in missing_ids]
    for step in steps:
        for needed in _inputs(step["tool"], step["arguments"]):
            if not available.get(needed, True) and needed not in missing_ids:
                missing_ids.append(needed)
    missing_ids.sort(key=list(INPUT_LABELS).index)

    # Step status: blocked by a missing input or a blocked dependency;
    # otherwise ready when it has no dependencies, planned when it waits.
    statuses: dict[str, str] = {}
    research_steps: list[ResearchStep] = []
    for order, step in enumerate(steps, start=1):
        needs = _inputs(step["tool"], step["arguments"])
        blocked = any(not available.get(n, True) for n in needs) or any(
            statuses[d] == "blocked" for d in step["depends_on"]
        )
        has_deps = bool(step["depends_on"] or step["optional_depends_on"])
        statuses[step["id"]] = "blocked" if blocked else ("planned" if has_deps else "ready")
        info = STEP_INFO[step["tool"]]
        title = info.title
        if step["tool"] == "analyse_area":
            title = f"Analyse Area {step['arguments']['area'].upper()}"
        research_steps.append(ResearchStep(
            id=step["id"],
            capability_id=step["capability_id"],
            tool=step["tool"],
            title=title,
            description=step["description"],
            execution_order=order,
            dependencies=step["depends_on"],
            optional_dependencies=step["optional_depends_on"],
            arguments=step["arguments"],
            aliases=step.get("aliases", []),
            required_inputs=needs,
            expected_outputs=list(info.outputs),
            status=statuses[step["id"]],
        ))

    if error:
        status = "invalid"
    elif not intents:
        status = "unsupported"
    elif missing_ids:
        status = "needs_input"
    else:
        status = "ready"

    capabilities_used = [c for c in CAPABILITY_ORDER if any(i.capability == c for i in intents)]
    needs_b = "comparison" in capabilities_used
    areas = [
        SelectedArea(id="a", label="Area A (selected location)", coordinates=location, required=bool(intents)),
        SelectedArea(id="b", label="Area B (comparison area)", coordinates=compare, required=needs_b),
    ]

    if status == "unsupported":
        objective = "No supported GIS capability matches this question."
        clarifications = ["Try a question such as: " + "; ".join(f"“{s}”" for s in SUGGESTIONS) + "."]
        if unsupported:
            clarifications.insert(0, "The requested criteria cannot currently be estimated with GeoMind's data.")
    else:
        phrases = [i.objective for i in sorted(intents, key=lambda i: CAPABILITY_ORDER.index(i.capability))]
        objective = "; then ".join(phrases)
        objective = objective[0].upper() + objective[1:] + "."
        clarifications = [CLARIFICATIONS[m] for m in missing_ids]
    if error:
        clarifications.append(error)

    plan_steps = [s.model_dump() for s in research_steps]
    plan = ResearchPlan(
        id=_plan_id(question, areas, plan_steps),
        title=" → ".join(catalog.CAPABILITIES[c].title for c in capabilities_used) or "Unsupported request",
        original_question=question,
        objective=objective,
        status=status,
        interpretation=[i.interpretation for i in sorted(intents, key=lambda i: CAPABILITY_ORDER.index(i.capability))],
        selected_areas=areas,
        assumptions=assumptions,
        limitations=limitations,
        missing_inputs=[
            MissingInput(id=m, label=INPUT_LABELS[m][0], reason=CLARIFICATIONS[m], action=INPUT_LABELS[m][1])
            for m in missing_ids
        ],
        clarification_questions=clarifications,
        capabilities=[
            CapabilityUse(id=c, title=catalog.CAPABILITIES[c].title, reason=catalog.CAPABILITIES[c].summary)
            for c in capabilities_used
        ],
        steps=research_steps,
        interpreter=interpreter,
        created_at=datetime.now(timezone.utc),
    )
    plan.signature = sign_plan(plan)
    return plan


# Plan signatures: execution only accepts plans this server produced, unchanged.
# The key lives in memory unless RESEARCH_PLAN_SECRET is set, so plans expire
# when the (single-instance) server restarts.
_PLAN_KEY = (os.getenv("RESEARCH_PLAN_SECRET") or secrets.token_hex(32)).encode()


def _canonical(value: Any) -> Any:
    """JSON-stable form: integral floats become ints (JSON clients drop ".0")."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _canonical(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_canonical(v) for v in value]
    return value


def sign_plan(plan: ResearchPlan) -> str:
    payload = json.dumps(
        _canonical(plan.model_dump(mode="json", exclude={"signature"})), sort_keys=True, separators=(",", ":")
    )
    return hmac.new(_PLAN_KEY, payload.encode(), hashlib.sha256).hexdigest()


def verify_plan(plan: ResearchPlan) -> bool:
    return bool(plan.signature) and hmac.compare_digest(plan.signature, sign_plan(plan))


async def plan_research(
    request: ResearchPlanRequest,
    provider: LLMProvider | None,
    llm_timeout_seconds: float,
    provider_note: str | None = None,
) -> ResearchPlan:
    """Interpret the question (rules first, then an optional LLM) and build the plan."""
    intents, assumptions = rule_intents(request.question)
    notes = [provider_note] if provider_note else []

    if intents or request.interpreter == "rules" or provider is None:
        return build_plan(request, intents, assumptions, "rules", notes)

    try:
        proposed = await llm_intents(
            request.question, request.context, provider, llm_timeout_seconds + LLM_TIMEOUT_MARGIN_SECONDS
        )
    except (ValueError, LLMError, asyncio.TimeoutError) as exc:
        reason = "it timed out" if isinstance(exc, asyncio.TimeoutError) else str(exc)
        logger.info("LLM research interpretation rejected: %s", reason)
        notes.append(f"The AI interpreter could not produce a valid plan ({reason}); only rule-based planning was used.")
        return build_plan(request, [], assumptions, "rules", notes)

    return build_plan(request, proposed, assumptions, "llm", notes)
