"""Supported multi-step workflows: request matching, plans and results.

The first workflow ranks features of one category (e.g. hospitals) by how
many distinct features of another (e.g. pharmacies) lie nearby. Plans are
built deterministically, then go through the same validation as any plan.
"""

import asyncio
import copy
import re
from dataclasses import dataclass
from typing import Any

from app.services import coverage, osm_discovery
from app.services.workflows.plan import (
    Emit,
    WorkflowContext,
    WorkflowRun,
    execute_plan,
    validate_plan,
)
from app.services.workflows.steps import (
    COVERAGE_CATEGORIES,
    MAX_SERVICES,
    MAX_SOURCES,
    WORKFLOW_TOOLS,
)

_UNIT = r"(?:km|kms|kilomet(?:er|re)s?|m|met(?:er|re)s?)"
_NEARBY_COUNT_PATTERN = re.compile(
    r"\b(?:find|show|list|get|locate|discover)\s+(?:me\s+)?(?:all\s+|the\s+|any\s+)?"
    r"(?P<source>[a-z][a-z \-]{1,40}?)\s+within\s+(?P<source_radius>\d+(?:\.\d+)?)\s*(?P<source_unit>" + _UNIT + r")\b"
    r".*?\b(?:the\s+)?(?:most|highest number of|largest number of|number of|count of|how many)\s+"
    r"(?P<target>[a-z][a-z \-]{1,40}?)\s+(?:within|in)\s+(?P<target_radius>\d+(?:\.\d+)?)\s*(?P<target_unit>" + _UNIT + r")\b",
    re.IGNORECASE | re.DOTALL,
)


@dataclass(frozen=True)
class NearbyCountRequest:
    source_category: str
    source_radius_km: float
    target_category: str
    target_radius_km: float


def _km(value: str, unit: str) -> float:
    radius = float(value)
    return radius if unit.lower().startswith("k") else radius / 1000


def match_workflow(message: str) -> NearbyCountRequest | None:
    match = _NEARBY_COUNT_PATTERN.search(message)
    if not match:
        return None

    try:
        source = osm_discovery.normalize_category(match["source"])
        target = osm_discovery.normalize_category(match["target"])
    except ValueError:
        return None

    return NearbyCountRequest(
        source_category=source,
        source_radius_km=_km(match["source_radius"], match["source_unit"]),
        target_category=target,
        target_radius_km=_km(match["target_radius"], match["target_unit"]),
    )


def build_plan(request: NearbyCountRequest) -> list[dict[str, Any]]:
    source = osm_discovery.OSM_CATEGORIES[request.source_category]["label"].lower()
    target = osm_discovery.OSM_CATEGORIES[request.target_category]["label"].lower()

    return [
        {
            "id": "find_sources",
            "tool": "discover_features",
            "description": f"Find {source} within {request.source_radius_km:g} km of the selected location",
            "arguments": {
                "category": request.source_category,
                "radius_km": request.source_radius_km,
                "limit": MAX_SOURCES,
            },
        },
        {
            "id": "find_nearby",
            "tool": "discover_near_features",
            "description": f"Find {target} within {request.target_radius_km:g} km of each result",
            "arguments": {
                "source_step": "find_sources",
                "category": request.target_category,
                "radius_km": request.target_radius_km,
            },
            "depends_on": ["find_sources"],
        },
        {
            "id": "rank",
            "tool": "rank_by_nearby_count",
            "description": f"Rank {source} by distinct {target} nearby",
            "arguments": {"nearby_step": "find_nearby"},
            "depends_on": ["find_nearby"],
        },
        {
            "id": "report",
            "tool": "report_findings",
            "description": "Summarise the findings and caveats",
            "arguments": {"ranking_step": "rank"},
            "depends_on": ["find_sources", "find_nearby", "rank"],
        },
    ]


async def run_nearby_count_workflow(
    request: NearbyCountRequest,
    location: tuple[float, float],
    timeout_seconds: float,
    emit: Emit,
) -> WorkflowRun:
    """Validate the plan (raises PlanError) and execute it within the time limit."""
    states = validate_plan(build_plan(request), WORKFLOW_TOOLS)
    context = WorkflowContext(
        location=location,
        deadline=asyncio.get_running_loop().time() + timeout_seconds,
    )
    return await execute_plan(states, WORKFLOW_TOOLS, context, emit)


def answer_text(run: WorkflowRun) -> str:
    report = run.step("report")
    if report and report.status == "completed":
        return report.outcome.result["text"]

    if run.stop_reason:
        found = run.step("find_sources")
        note = found.outcome.result["coverage_note"] if found and found.outcome else ""
        return f"{run.stop_reason} {note}".strip()

    failed = next((s for s in run.steps if s.status == "failed"), None)
    if failed:
        return f"The analysis could not be completed: {failed.step.description} failed — {failed.error}"

    return "The analysis did not complete."


def serialize(run: WorkflowRun, location: tuple[float, float]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Public workflow result and map layers (bounded by the step limits)."""
    found = run.step("find_sources")
    near = run.step("find_nearby")
    ranked = run.step("rank")
    found_result = found.outcome.result if found and found.outcome else None
    near_result = near.outcome.result if near and near.outcome else None
    rank_result = ranked.outcome.result if ranked and ranked.outcome else None

    analysis: dict[str, Any] = {"location": list(location)}
    layers: list[dict[str, Any]] = []

    if found_result:
        analysis["sources"] = {
            k: found_result[k]
            for k in ("category", "label", "radius_km", "total_found", "returned", "truncated", "coverage_note", "source")
        }

    if near_result:
        analysis["nearby"] = {
            k: near_result[k]
            for k in (
                "category", "label", "radius_km", "distinct_count", "relationship_count",
                "searched_count", "failed_count", "skipped_count", "server_truncated",
                "per_source_limit_reached", "global_limit_reached",
            )
        }

    if rank_result:
        analysis["ranking"] = rank_result["ranking"]
        analysis["unranked"] = rank_result["unranked"]
        analysis["complete"] = rank_result["complete"]

    if found_result and found_result["features"]:
        status = {s.id: s for s in near_result["sources"]} if near_result else {}
        sources_out = []
        for feature in found_result["features"]:
            feature = copy.deepcopy(feature)
            source = status.get(str(feature.get("id")))
            if source is not None and near_result:
                feature["properties"]["nearby_search"] = source.status
                if source.status == "searched":
                    feature["properties"][f"{near_result['category']}_within_{near_result['radius_km']:g}_km"] = len(source.matches)
                elif source.reason:
                    feature["properties"]["nearby_search_note"] = source.reason
            sources_out.append(feature)

        layers.append({
            "kind": "discovery",
            "name": f"{found_result['label']} · {found_result['radius_km']:g} km",
            "feature_count": len(sources_out),
            "geojson": {"type": "FeatureCollection", "features": sources_out},
        })

    if near_result and near_result["features"]:
        related: dict[str, int] = {}
        for source in near_result["sources"]:
            for match in source.matches:
                related[match["id"]] = related.get(match["id"], 0) + 1

        targets_out = []
        for feature in near_result["features"]:
            feature = copy.deepcopy(feature)
            feature["properties"]["distance_km"] = None  # distance to the selected point is not meaningful here
            feature["properties"][f"near_{found_result['category'] if found_result else 'source'}_count"] = related.get(str(feature.get("id")), 0)
            targets_out.append(feature)

        layers.append({
            "kind": "discovery",
            "name": f"{near_result['label']} near {found_result['label'].lower() if found_result else 'results'}",
            "feature_count": len(targets_out),
            "geojson": {"type": "FeatureCollection", "features": targets_out},
        })

    workflow = {
        "type": "nearby_count",
        "outcome": run.outcome,
        "stop_reason": run.stop_reason,
        "plan": [state.public() for state in run.steps],
        "analysis": analysis,
    }
    return workflow, layers


# Service coverage gap analysis

_COVERAGE_INTENT = re.compile(
    r"\b(under-?served|coverage|gaps?|far\s+(?:away\s+)?from|poorly\s+served|"
    r"lack(?:s|ing)?\s+(?:of\s+)?access|access\s+to)\b",
    re.IGNORECASE,
)
_COVERAGE_RADIUS = re.compile(
    r"(\d+(?:\.\d+)?)\s*(km|kms|kilomet(?:er|re)s?|m|met(?:er|re)s?)\b",
    re.IGNORECASE,
)


def _coverage_terms() -> list[tuple[str, str]]:
    """(phrase, category) pairs, longest phrases first."""
    terms: dict[str, str] = {}
    for category in COVERAGE_CATEGORIES:
        name = category.replace("_", " ")
        terms[name] = category
        terms[name + "s"] = category
        terms[osm_discovery.OSM_CATEGORIES[category]["label"].lower()] = category
    for alias, category in osm_discovery.CATEGORY_ALIASES.items():
        if category in COVERAGE_CATEGORIES:
            terms[alias.replace("_", " ")] = category
    return sorted(terms.items(), key=lambda item: -len(item[0]))


_TERMS = _coverage_terms()


@dataclass(frozen=True)
class CoverageRequest:
    category: str
    radius_km: float


def match_coverage(message: str) -> CoverageRequest | None:
    """Coverage-gap questions naming a supported service category."""
    if not _COVERAGE_INTENT.search(message):
        return None

    text = message.lower()
    category = next(
        (cat for phrase, cat in _TERMS if re.search(rf"\b{re.escape(phrase)}\b", text)),
        None,
    )
    if category is None:
        return None

    radius = _COVERAGE_RADIUS.search(message)
    radius_km = _km(radius[1], radius[2]) if radius else coverage.DEFAULT_STUDY_RADIUS_KM
    return CoverageRequest(category=category, radius_km=radius_km)


def build_coverage_plan(request: CoverageRequest) -> list[dict[str, Any]]:
    label = osm_discovery.OSM_CATEGORIES[request.category]["label"].lower()
    # Search past the study edge by the moderate threshold so edge cells see
    # nearby services outside the circle (clamped to the category's maximum).
    search_km = min(
        request.radius_km + coverage.DEFAULT_MODERATE_M / 1000,
        osm_discovery.OSM_CATEGORIES[request.category]["max_radius_km"],
    )

    return [
        {
            "id": "find_services",
            "tool": "discover_services",
            "description": f"Find {label} within {search_km:g} km (study area plus margin)",
            "arguments": {"category": request.category, "radius_km": search_km, "limit": MAX_SERVICES},
        },
        {
            "id": "analyse",
            "tool": "analyse_coverage",
            "description": f"Grid the {request.radius_km:g} km study area and measure nearest {label}",
            "arguments": {"services_step": "find_services", "radius_km": request.radius_km},
            "depends_on": ["find_services"],
        },
        {
            "id": "report",
            "tool": "report_coverage",
            "description": "Summarise coverage and caveats",
            "arguments": {"coverage_step": "analyse"},
            "depends_on": ["find_services", "analyse"],
        },
    ]


async def run_coverage_workflow(
    request: CoverageRequest,
    location: tuple[float, float],
    timeout_seconds: float,
    emit: Emit,
) -> WorkflowRun:
    """Validate the plan (raises PlanError) and execute it within the time limit."""
    states = validate_plan(build_coverage_plan(request), WORKFLOW_TOOLS)
    context = WorkflowContext(
        location=location,
        deadline=asyncio.get_running_loop().time() + timeout_seconds,
    )
    return await execute_plan(states, WORKFLOW_TOOLS, context, emit)


COVERAGE_METHODOLOGY = [
    "The study area is a circle around the selected location, gridded into square cells "
    "(at most 500) in a local azimuthal equidistant projection; cells are clipped to the circle.",
    "Each cell is represented by its centroid; its distance is the straight-line (geodesic-scale) "
    "distance to the nearest mapped service geometry, found with a spatial index.",
    "Services are searched beyond the study edge by the moderate threshold, so edge cells can "
    "match services just outside the circle.",
    "Classes: well covered ≤ first threshold, moderate ≤ second threshold, underserved beyond it; "
    "'no service found' when no services were discovered at all.",
    "This is proximity to mapped OpenStreetMap services, not travel time, road access, "
    "service capacity or population coverage.",
]


def serialize_coverage(run: WorkflowRun, location: tuple[float, float]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    found = run.step("find_services")
    analysed = run.step("analyse")
    found_result = found.outcome.result if found and found.outcome else None
    data = analysed.outcome.result if analysed and analysed.outcome else None

    analysis: dict[str, Any] = {"location": list(location), "methodology": COVERAGE_METHODOLOGY}
    layers: list[dict[str, Any]] = []

    if found_result:
        analysis["services"] = {
            k: found_result[k]
            for k in (
                "category", "label", "search_radius_km", "total_found", "returned",
                "truncated", "coverage_note", "attribution", "osm_base",
            )
        }

    if data:
        analysis["coverage"] = data["summary"]
        label = found_result["label"] if found_result else "Service"
        layers.append({
            "kind": "analysis",
            "style": "coverage",
            "name": f"{label} coverage · {data['summary']['radius_km']:g} km",
            "feature_count": len(data["cells"]),
            "geojson": {"type": "FeatureCollection", "features": data["cells"]},
        })

    if found_result and found_result["features"]:
        layers.append({
            "kind": "discovery",
            "name": f"{found_result['label']} · {found_result['search_radius_km']:g} km",
            "feature_count": len(found_result["features"]),
            "geojson": {"type": "FeatureCollection", "features": found_result["features"]},
        })

    workflow = {
        "type": "coverage",
        "outcome": run.outcome,
        "stop_reason": run.stop_reason,
        "plan": [state.public() for state in run.steps],
        "analysis": analysis,
    }
    return workflow, layers


# Area A vs Area B comparison

_COMPARE_INTENT = re.compile(
    r"\b(compare|comparison|compared|versus|vs\.?|which\s+(?:area|location)s?|"
    r"(?:both|two|these\s+two)\s+(?:areas|locations|places)|area\s+[ab])\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ComparisonRequest:
    # None when the question names no supported service category.
    category: str | None
    radius_km: float


def match_comparison(message: str) -> ComparisonRequest | None:
    if not _COMPARE_INTENT.search(message):
        return None

    text = message.lower()
    category = next(
        (cat for phrase, cat in _TERMS if re.search(rf"\b{re.escape(phrase)}\b", text)),
        None,
    )
    radius = _COVERAGE_RADIUS.search(message)
    radius_km = _km(radius[1], radius[2]) if radius else coverage.DEFAULT_STUDY_RADIUS_KM
    return ComparisonRequest(category=category, radius_km=radius_km)


def build_comparison_plan(request: ComparisonRequest) -> list[dict[str, Any]]:
    label = osm_discovery.OSM_CATEGORIES[request.category]["label"].lower()
    search_km = min(
        request.radius_km + coverage.DEFAULT_MODERATE_M / 1000,
        osm_discovery.OSM_CATEGORIES[request.category]["max_radius_km"],
    )
    # One cell size and one set of thresholds for both areas: a fair comparison.
    cell_size_m, _ = coverage.choose_cell_size(request.radius_km * 1000, None)
    shared = {
        "category": request.category,
        "radius_km": request.radius_km,
        "search_radius_km": search_km,
        "cell_size_m": cell_size_m,
        "well_covered_m": coverage.DEFAULT_WELL_COVERED_M,
        "moderate_m": coverage.DEFAULT_MODERATE_M,
        "limit": MAX_SERVICES,
    }

    return [
        {
            "id": "area_a",
            "tool": "analyse_area",
            "description": f"Analyse {label} coverage around Area A",
            "arguments": {"area": "a", **shared},
        },
        {
            # Sequential after Area A (never two Overpass requests at once),
            # but Area A failing must not prevent Area B from running.
            "id": "area_b",
            "tool": "analyse_area",
            "description": f"Analyse {label} coverage around Area B",
            "arguments": {"area": "b", **shared},
            "optional_depends_on": ["area_a"],
        },
        {
            "id": "compare",
            "tool": "compare_areas",
            "description": "Compare the two areas metric by metric",
            "arguments": {"area_a_step": "area_a", "area_b_step": "area_b"},
            "optional_depends_on": ["area_a", "area_b"],
        },
        {
            "id": "report",
            "tool": "report_comparison",
            "description": "Summarise differences and data completeness",
            "arguments": {"comparison_step": "compare"},
            "depends_on": ["compare"],
            "optional_depends_on": ["area_a", "area_b"],
        },
    ]


async def run_comparison_workflow(
    request: ComparisonRequest,
    area_a: tuple[float, float],
    area_b: tuple[float, float],
    timeout_seconds: float,
    emit: Emit,
) -> WorkflowRun:
    """Validate the plan (raises PlanError) and execute it within the time limit."""
    states = validate_plan(build_comparison_plan(request), WORKFLOW_TOOLS)
    context = WorkflowContext(
        location=area_a,
        deadline=asyncio.get_running_loop().time() + timeout_seconds,
        locations={"a": area_a, "b": area_b},
    )
    return await execute_plan(states, WORKFLOW_TOOLS, context, emit)


COMPARISON_METHODOLOGY = COVERAGE_METHODOLOGY + [
    "Both areas use the same service category, study radius, cell size and thresholds.",
    "Density = services intersecting the study circle ÷ the circle's area (identical for both areas).",
    "Difference = A − B; relative difference = (A − B) ÷ B × 100, left blank when B is zero or missing. "
    "Percentages are compared in percentage points.",
    "Metrics are compared one by one; no combined score or overall winner is produced.",
]


def serialize_comparison(run: WorkflowRun) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    compared = run.step("compare")
    analysis: dict[str, Any] = {"methodology": COMPARISON_METHODOLOGY}
    layers: list[dict[str, Any]] = []

    if compared and compared.outcome:
        result = compared.outcome.result
        analysis.update({
            "metrics": result["metrics"],
            "complete": result["complete"],
            "overall_winner": result["overall_winner"],
            "areas": result["areas"],
        })
    else:
        analysis["areas"] = {
            key: {"metrics": None, "error": (run.step(f"area_{key}").error if run.step(f"area_{key}") else None)}
            for key in ("a", "b")
        }

    for key, name in (("a", "Area A"), ("b", "Area B")):
        state = run.step(f"area_{key}")
        if not state or state.status != "completed":
            continue  # never create layers for a failed area
        area = state.outcome.result
        found, cells = area["found"], area["coverage"]["cells"]
        analysis.setdefault("services", {})[key] = {
            k: found[k] for k in ("label", "search_radius_km", "total_found", "returned", "truncated", "attribution", "osm_base")
        }
        layers.append({
            "kind": "analysis",
            "style": "coverage",
            "area": key,
            "name": f"{name} · {found['label']} coverage · {area['metrics']['radius_km']:g} km",
            "feature_count": len(cells),
            "geojson": {"type": "FeatureCollection", "features": cells},
        })
        if found["features"]:
            layers.append({
                "kind": "discovery",
                "area": key,
                "name": f"{name} · {found['label']}",
                "feature_count": len(found["features"]),
                "geojson": {"type": "FeatureCollection", "features": found["features"]},
            })

    workflow = {
        "type": "comparison",
        "outcome": run.outcome,
        "stop_reason": run.stop_reason,
        "plan": [state.public() for state in run.steps],
        "analysis": analysis,
    }
    return workflow, layers
