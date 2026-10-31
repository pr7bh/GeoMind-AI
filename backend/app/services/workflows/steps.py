"""Workflow step tools.

Coordinates never come from plan arguments: the first search uses the
user's selected map location and later searches use real OSM results.
"""

import asyncio
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.services import comparison, coverage, osm_discovery, suitability
from app.services.workflows import analysis
from app.services.workflows.plan import (
    StepError,
    StepOutcome,
    StopWorkflow,
    WorkflowContext,
    WorkflowTool,
)

MAX_SOURCES = 30
MAX_PER_SOURCE = 30
MAX_TOTAL_NEARBY = 500
MAX_NEAR_RADIUS_KM = 2.0
# Normally all sources go in one combined Overpass request. If it fails,
# failed sources are retried in sequential batches of this size, but only
# while at least FALLBACK_MIN_SECONDS of the workflow budget remain.
BATCH_SIZE = 10
FALLBACK_MIN_SECONDS = 15.0
# Do not start any Overpass request with less time than this left.
MIN_BATCH_SECONDS = 5.0


def _label(category: str) -> str:
    return osm_discovery.OSM_CATEGORIES[category]["label"]


# discover_features: sources around the selected location

class DiscoverStepArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str = Field(..., min_length=1, max_length=50)
    radius_km: float = Field(..., gt=0, le=osm_discovery.MAX_RADIUS_KM)
    limit: int = Field(MAX_SOURCES, ge=1, le=MAX_SOURCES)


async def _discover(args: DiscoverStepArgs, context: WorkflowContext, _inputs) -> StepOutcome:
    if context.location is None:
        raise StepError("No map location is selected.")

    try:
        data = await osm_discovery.discover_features(
            coordinates=list(context.location),
            category=args.category,
            radius_km=args.radius_km,
            limit=args.limit,
        )
    except ValueError as exc:
        raise StepError(str(exc)) from exc
    except osm_discovery.OverpassError as exc:
        raise StepError(str(exc)) from exc

    meta = data["metadata"]
    result = {
        "category": meta["category"],
        "label": meta["label"],
        "radius_km": meta["radius_km"],
        "total_found": meta["total_found"],
        "returned": meta["returned"],
        "truncated": meta["truncated"],
        "coverage_note": meta["coverage_note"],
        "source": meta["source"],
        "osm_base": meta["osm_base"],
        "features": data["features"],
    }
    preview = {k: result[k] for k in ("label", "radius_km", "total_found", "returned", "truncated")}
    summary = f"{meta['returned']} {meta['label'].lower()} within {meta['radius_km']:g} km"

    if meta["returned"] == 0:
        outcome = StepOutcome(summary=summary, result=result, preview=preview)
        raise StopWorkflow(
            f"No {meta['label'].lower()} are mapped in OpenStreetMap within "
            f"{meta['radius_km']:g} km, so there is nothing to analyse.",
            outcome,
        )

    if meta["truncated"]:
        summary += f" (nearest {meta['returned']} of {meta['total_found']})"

    return StepOutcome(summary=summary, result=result, preview=preview, partial=False)


# discover_near_features: nearby features around each source

class NearStepArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_step: str = Field(..., min_length=1, max_length=32)
    category: str = Field(..., min_length=1, max_length=50)
    radius_km: float = Field(..., gt=0, le=MAX_NEAR_RADIUS_KM)
    per_source_limit: int = Field(MAX_PER_SOURCE, ge=1, le=MAX_PER_SOURCE)
    max_total: int = Field(MAX_TOTAL_NEARBY, ge=1, le=MAX_TOTAL_NEARBY)


async def _discover_near(args: NearStepArgs, context: WorkflowContext, inputs) -> StepOutcome:
    try:
        category = osm_discovery.normalize_category(args.category)
    except ValueError as exc:
        raise StepError(str(exc)) from exc

    radius_m = args.radius_km * 1000
    sources = analysis.prepare_sources(inputs[args.source_step].outcome.result["features"])
    searchable = [s for s in sources if s.status == "pending"]
    candidates: list[dict[str, Any]] = []
    osm_base = None

    requests = 0

    async def search(batch: list[analysis.Source]) -> None:
        """One Overpass request for a group of sources; marks each source."""
        nonlocal osm_base, requests

        if context.remaining() < MIN_BATCH_SECONDS:
            for source in batch:
                source.status, source.reason = "failed", "Not searched: workflow time limit reached."
            return

        # Each circle keeps its own radius, widened by the source's own extent;
        # exact distances to the real geometry are applied in analysis.relate().
        centres = [
            (s.point[0], s.point[1], int(radius_m + s.extent_m) + 1)
            for s in batch
        ]
        requests += 1
        try:
            data = await asyncio.wait_for(
                osm_discovery.discover_features_near(centres, category),
                timeout=context.remaining() - 1,
            )
        except osm_discovery.OverpassError as exc:
            for source in batch:
                source.status, source.reason = "failed", f"Search failed: {exc}"
            return
        except asyncio.TimeoutError:
            for source in batch:
                source.status, source.reason = "failed", "Search failed: workflow time limit reached."
            return
        except ValueError as exc:  # invalid search area; retrying cannot help
            raise StepError(str(exc)) from exc

        candidates.extend(data["features"])
        osm_base = osm_base or data["osm_base"]
        for source in batch:
            source.status, source.reason = "searched", None
            # A truncated reply may be missing features near any source in it.
            source.truncated = data["server_limit_reached"]

    # One combined request covering every source's own search circle.
    strategy = "combined"
    if searchable:
        await search(searchable)

    # Bounded fallback: retry failed sources in smaller sequential batches.
    retry = [s for s in searchable if s.status == "failed"]
    # Kept for transparency; per-source reasons are replaced by the retry.
    combined_error = retry[0].reason if retry else None
    if retry and context.remaining() >= FALLBACK_MIN_SECONDS:
        strategy = "combined+batches"
        for start in range(0, len(retry), BATCH_SIZE):
            await search(retry[start:start + BATCH_SIZE])

    if searchable and not any(s.status == "searched" for s in searchable):
        reasons = {s.reason for s in searchable if s.reason}
        raise StepError("All searches failed. " + " ".join(sorted(reasons)))

    retained, global_limit = analysis.relate(
        sources, candidates, radius_m, args.per_source_limit, args.max_total
    )
    failed = [s for s in sources if s.status == "failed"]
    skipped = [s for s in sources if s.status == "skipped"]
    truncated = any(s.truncated for s in sources)
    per_source_limit = any(s.limit_reached for s in sources)

    result = {
        "category": category,
        "label": _label(category),
        "radius_km": args.radius_km,
        "sources": sources,
        "features": retained,
        "distinct_count": len(retained),
        "relationship_count": sum(len(s.matches) for s in sources),
        "searched_count": sum(1 for s in sources if s.status == "searched"),
        "failed_count": len(failed),
        "skipped_count": len(skipped),
        "server_truncated": truncated,
        "per_source_limit_reached": per_source_limit,
        "global_limit_reached": global_limit,
        "osm_base": osm_base,
        "overpass_requests": requests,
        "strategy": strategy,
        "combined_error": combined_error,
    }
    preview = {
        k: result[k]
        for k in (
            "label", "radius_km", "distinct_count", "relationship_count", "searched_count",
            "failed_count", "skipped_count", "server_truncated",
            "per_source_limit_reached", "global_limit_reached",
            "overpass_requests", "strategy", "combined_error",
        )
    }
    summary = (
        f"{len(retained)} distinct {_label(category).lower()} within {args.radius_km:g} km "
        f"of {result['searched_count']} searched"
    )
    if failed:
        summary += f"; {len(failed)} search{'es' if len(failed) != 1 else ''} failed"

    return StepOutcome(
        summary=summary,
        result=result,
        preview=preview,
        partial=bool(failed or skipped or truncated or per_source_limit or global_limit),
    )


# rank_by_nearby_count

class RankStepArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nearby_step: str = Field(..., min_length=1, max_length=32)


async def _rank(args: RankStepArgs, _context: WorkflowContext, inputs) -> StepOutcome:
    near = inputs[args.nearby_step].outcome.result
    sources: list[analysis.Source] = near["sources"]
    ranking = analysis.rank(sources)
    unranked = [
        {"id": s.id, "name": s.name, "status": s.status, "reason": s.reason}
        for s in sources
        if s.status != "searched"
    ]
    complete = not unranked and not (
        near["server_truncated"] or near["per_source_limit_reached"] or near["global_limit_reached"]
    )

    top = ranking[0] if ranking else None
    summary = (
        f"Ranked {len(ranking)}; top: {top['name']} with {top['nearby_count']}"
        if top
        else "Nothing could be ranked"
    )

    return StepOutcome(
        summary=summary,
        result={"ranking": ranking, "unranked": unranked, "complete": complete},
        preview={
            "ranked": len(ranking),
            "unranked": len(unranked),
            "complete": complete,
            "top": [
                {"rank": r["rank"], "name": r["name"], "nearby_count": r["nearby_count"]}
                for r in ranking[:3]
            ],
        },
        partial=not complete,
    )


# report_findings: deterministic, grounded summary of the earlier steps

class ReportStepArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ranking_step: str = Field(..., min_length=1, max_length=32)


MAX_RANKED_LINES = 10


def _distance(metres: float | None) -> str:
    if metres is None:
        return "n/a"
    return f"{metres:.0f} m" if metres < 1000 else f"{metres / 1000:.2f} km"


async def _report(args: ReportStepArgs, context: WorkflowContext, inputs) -> StepOutcome:
    by_tool = {state.step.tool: state.outcome.result for state in inputs.values()}
    found = by_tool.get("discover_features")
    near = by_tool.get("discover_near_features")
    ranked = inputs[args.ranking_step].outcome.result

    if not (found and near):
        raise StepError("The report needs the discovery and nearby-search steps.")

    sources, targets = found["label"].lower(), near["label"].lower()
    # Category ids are singular ("hospital", "pharmacy").
    source_one = found["category"].replace("_", " ")
    target_one = near["category"].replace("_", " ")
    location = (
        f" ({context.location[1]:.5f}, {context.location[0]:.5f})" if context.location else ""
    )
    lines = [
        f"Analysed {found['returned']} {sources} within {found['radius_km']:g} km of the "
        f"selected location{location}.",
        f"Found {near['distinct_count']} distinct {targets} within {near['radius_km']:g} km of "
        f"at least one of them ({near['relationship_count']} {source_one}–{target_one} pairs; "
        f"a {target_one} near several {sources} appears once in the distinct total).",
    ]

    if ranked["ranking"]:
        lines.append(f"Ranked by distinct {targets} within {near['radius_km']:g} km:")
        for entry in ranked["ranking"][:MAX_RANKED_LINES]:
            bound = "+" if entry["count_is_lower_bound"] else ""
            tie = " (tie)" if entry["tied"] else ""
            nearest = f", nearest {_distance(entry['nearest_m'])}" if entry["nearest_m"] is not None else ""
            lines.append(f"{entry['rank']}. {entry['name']} — {entry['nearby_count']}{bound}{tie}{nearest}")
        if len(ranked["ranking"]) > MAX_RANKED_LINES:
            lines.append(f"…and {len(ranked['ranking']) - MAX_RANKED_LINES} more in the full results.")

    for entry in ranked["unranked"]:
        lines.append(f"Not ranked: {entry['name']} — {entry['reason']}")

    caveats = []
    if not ranked["complete"]:
        caveats.append("The ranking is incomplete; see the notes above and below.")
    if near["failed_count"]:
        caveats.append(
            f"{near['failed_count']} search(es) failed; those {sources} are not counted as zero."
        )
    if near["server_truncated"]:
        caveats.append("OpenStreetMap returned a truncated result for at least one search.")
    if near["per_source_limit_reached"]:
        caveats.append(
            f"Counts marked + reached the {MAX_PER_SOURCE}-per-{source_one} cap and are lower bounds."
        )
    if near["global_limit_reached"]:
        caveats.append(f"Only the nearest {MAX_TOTAL_NEARBY} distinct {targets} were kept.")
    if found["truncated"]:
        caveats.append(
            f"Only the nearest {found['returned']} of {found['total_found']} {sources} were analysed."
        )
    caveats.append(
        f"Counts reflect what is mapped in OpenStreetMap, not opening hours or whether {targets} are operating. "
        + found["coverage_note"]
    )

    text = "\n".join(lines) + "\n\nCaveats:\n" + "\n".join(f"- {c}" for c in caveats)
    return StepOutcome(
        summary="Findings written",
        result={"text": text, "caveats": caveats},
        preview={"caveats": len(caveats)},
    )


# Service coverage gap analysis

# Point-like services where "distance to the nearest one" is meaningful.
COVERAGE_CATEGORIES = frozenset({
    "hospital", "clinic", "doctors", "dentist", "pharmacy", "healthcare",
    "school", "university", "college", "kindergarten", "education",
    "police", "fire_station", "park", "bank", "atm", "post_office",
    "bus_stop", "railway_station", "fuel", "government",
}) & frozenset(osm_discovery.OSM_CATEGORIES)
MAX_SERVICES = 500
MAX_WELL_COVERED_M = 10_000
MAX_MODERATE_M = 15_000


class ServicesStepArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str = Field(..., min_length=1, max_length=50)
    radius_km: float = Field(
        ..., gt=0, le=coverage.MAX_STUDY_RADIUS_KM + MAX_MODERATE_M / 1000,
        description="Search radius: study radius plus the moderate threshold.",
    )
    limit: int = Field(MAX_SERVICES, ge=1, le=MAX_SERVICES)


async def discover_service_features(
    location: tuple[float, float],
    category: str,
    radius_km: float,
    limit: int,
) -> dict[str, Any]:
    """Coverage service discovery for one location (shared by M6 and M7)."""
    try:
        category = osm_discovery.normalize_category(category)
    except ValueError as exc:
        raise StepError(str(exc)) from exc

    if category not in COVERAGE_CATEGORIES:
        raise StepError(
            f"Coverage analysis supports service categories only: {', '.join(sorted(COVERAGE_CATEGORIES))}."
        )

    try:
        data = await osm_discovery.discover_features(
            coordinates=list(location),
            category=category,
            radius_km=radius_km,
            limit=limit,
        )
    except ValueError as exc:
        raise StepError(str(exc)) from exc
    except osm_discovery.OverpassError as exc:
        # A failed search is not "no services": the caller fails here.
        raise StepError(str(exc)) from exc

    meta = data["metadata"]
    return {
        "category": category,
        "label": meta["label"],
        "search_radius_km": meta["radius_km"],
        "total_found": meta["total_found"],
        "returned": meta["returned"],
        "truncated": meta["truncated"],
        "coverage_note": meta["coverage_note"],
        "attribution": meta["attribution"],
        "source": meta["source"],
        "osm_base": meta["osm_base"],
        "features": data["features"],
    }


async def _discover_services(args: ServicesStepArgs, context: WorkflowContext, _inputs) -> StepOutcome:
    if context.location is None:
        raise StepError("No map location is selected.")

    result = await discover_service_features(context.location, args.category, args.radius_km, args.limit)
    summary = f"{result['returned']} {result['label'].lower()} within {result['search_radius_km']:g} km"
    if result["truncated"]:
        summary += f" (nearest {result['returned']} of {result['total_found']})"

    return StepOutcome(
        summary=summary,
        result=result,
        preview={k: result[k] for k in ("label", "search_radius_km", "total_found", "returned", "truncated")},
        partial=result["truncated"],
    )


class CoverageStepArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    services_step: str = Field(..., min_length=1, max_length=32)
    radius_km: float = Field(..., gt=0, le=coverage.MAX_STUDY_RADIUS_KM)
    cell_size_m: float | None = Field(None, ge=coverage.MIN_CELL_SIZE_M, le=coverage.MAX_CELL_SIZE_M)
    well_covered_m: float = Field(coverage.DEFAULT_WELL_COVERED_M, gt=0, le=MAX_WELL_COVERED_M)
    moderate_m: float = Field(coverage.DEFAULT_MODERATE_M, gt=0, le=MAX_MODERATE_M)


async def coverage_for_area(
    location: tuple[float, float],
    found: dict[str, Any],
    radius_km: float,
    cell_size_m: float | None,
    well_covered_m: float,
    moderate_m: float,
) -> dict[str, Any]:
    """Run the coverage engine for one location (shared by M6 and M7)."""
    try:
        # CPU-bound but bounded (<= 500 cells, <= 500 services).
        data = await asyncio.to_thread(
            coverage.analyse,
            location,
            radius_km,
            found["features"],
            cell_size_m,
            well_covered_m,
            moderate_m,
        )
    except coverage.CoverageError as exc:
        raise StepError(str(exc)) from exc

    summary = data["summary"]
    # Classes are exact only where the search reached past the study edge by
    # at least the moderate threshold; the catalog plan guarantees this.
    margin_m = (found["search_radius_km"] - radius_km) * 1000
    summary["search_radius_km"] = found["search_radius_km"]
    summary["search_margin_sufficient"] = margin_m >= moderate_m
    summary["discovery_truncated"] = found["truncated"]
    summary["partial"] = found["truncated"] or not summary["search_margin_sufficient"]
    return data


def coverage_summary_line(summary: dict[str, Any]) -> str:
    pct = summary["percentages"]
    return (
        f"{summary['total_cells']} cells of {summary['cell_size_m']} m: "
        f"{pct['well_covered']}% well covered, {pct['moderate']}% moderate, "
        f"{pct['underserved']}% underserved"
        + (f", {pct['no_service_found']}% no service found" if summary["counts"]["no_service_found"] else "")
    )


async def _analyse_coverage(args: CoverageStepArgs, context: WorkflowContext, inputs) -> StepOutcome:
    if context.location is None:
        raise StepError("No map location is selected.")

    data = await coverage_for_area(
        context.location,
        inputs[args.services_step].outcome.result,
        args.radius_km,
        args.cell_size_m,
        args.well_covered_m,
        args.moderate_m,
    )
    summary = data["summary"]

    return StepOutcome(
        summary=coverage_summary_line(summary),
        result=data,
        preview={
            "total_cells": summary["total_cells"],
            "cell_size_m": summary["cell_size_m"],
            "services_count": summary["services_count"],
            **{f"{name}_pct": value for name, value in summary["percentages"].items()},
        },
        partial=summary["partial"],
    )


class CoverageReportArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    coverage_step: str = Field(..., min_length=1, max_length=32)


def _km(metres: float | None) -> str:
    return "n/a" if metres is None else f"{metres / 1000:.2f} km"


async def _report_coverage(args: CoverageReportArgs, _context: WorkflowContext, inputs) -> StepOutcome:
    by_tool = {state.step.tool: state.outcome.result for state in inputs.values()}
    found = by_tool.get("discover_services")
    if not found:
        raise StepError("The report needs the service discovery step.")

    summary = inputs[args.coverage_step].outcome.result["summary"]
    label = found["label"].lower()
    singular = found["category"].replace("_", " ")
    counts, pct, thresholds = summary["counts"], summary["percentages"], summary["thresholds_m"]
    well, moderate = _km(thresholds["well_covered"]), _km(thresholds["moderate"])

    lines = [
        f"Coverage of {label} within {summary['radius_km']:g} km of the selected location "
        f"({summary['centre'][1]:.5f}, {summary['centre'][0]:.5f}), using {summary['total_cells']} "
        f"grid cells of {summary['cell_size_m']} m"
        + (" (cell size enlarged to stay within 500 cells)" if summary["cell_size_adjusted"] else "")
        + ".",
    ]
    if summary["services_count"] == 0:
        lines.append(
            f"No {label} are mapped in OpenStreetMap within {found['search_radius_km']:g} km, so all "
            f"{summary['total_cells']} cells are marked 'no service found'. No distances were calculated."
        )
    else:
        lines += [
            f"- Well covered (nearest {singular} ≤ {well}): {counts['well_covered']} cells ({pct['well_covered']}%)",
            f"- Moderate ({well}–{moderate}): {counts['moderate']} cells ({pct['moderate']}%)",
            f"- Underserved (> {moderate}): {counts['underserved']} cells ({pct['underserved']}%)",
            f"Nearest-{singular} distance across cells: average {_km(summary['average_distance_m'])}, "
            f"maximum {_km(summary['max_distance_m'])}. Based on {summary['services_count']} {label} "
            f"found within {found['search_radius_km']:g} km.",
        ]

    caveats = [
        "Straight-line distance from each cell's centroid to the nearest mapped service; "
        "not travel time, road access or population coverage.",
    ]
    if found["truncated"]:
        caveats.append(
            f"Discovery was truncated to the nearest {found['returned']} of {found['total_found']} {label}; "
            "cells near the edge may be closer to services that were not returned, so results may be incomplete."
        )
    if not summary["search_margin_sufficient"]:
        caveats.append("The search did not extend far enough beyond the study area; edge cells may be misclassified.")
    if summary["invalid_services"]:
        caveats.append(f"{summary['invalid_services']} services without usable geometry were ignored.")
    caveats.append(found["coverage_note"])

    text = "\n".join(lines) + "\n\nCaveats:\n" + "\n".join(f"- {c}" for c in caveats)
    return StepOutcome(
        summary="Findings written",
        result={"text": text, "caveats": caveats},
        preview={"caveats": len(caveats)},
    )


# Area A vs Area B comparison

AREA_LABELS = {"a": "Area A", "b": "Area B"}


class AreaStepArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Which user-selected centre to use; the plan never carries coordinates.
    area: Literal["a", "b"]
    category: str = Field(..., min_length=1, max_length=50)
    radius_km: float = Field(..., gt=0, le=coverage.MAX_STUDY_RADIUS_KM)
    search_radius_km: float = Field(..., gt=0, le=coverage.MAX_STUDY_RADIUS_KM + MAX_MODERATE_M / 1000)
    cell_size_m: float = Field(..., ge=coverage.MIN_CELL_SIZE_M, le=coverage.MAX_CELL_SIZE_M)
    well_covered_m: float = Field(coverage.DEFAULT_WELL_COVERED_M, gt=0, le=MAX_WELL_COVERED_M)
    moderate_m: float = Field(coverage.DEFAULT_MODERATE_M, gt=0, le=MAX_MODERATE_M)
    limit: int = Field(MAX_SERVICES, ge=1, le=MAX_SERVICES)


async def _analyse_area(args: AreaStepArgs, context: WorkflowContext, _inputs) -> StepOutcome:
    label = AREA_LABELS[args.area]
    location = context.locations.get(args.area)
    if location is None:
        raise StepError(f"{label} is not selected.")

    found = await discover_service_features(location, args.category, args.search_radius_km, args.limit)
    data = await coverage_for_area(
        location, found, args.radius_km, args.cell_size_m, args.well_covered_m, args.moderate_m
    )
    within = await asyncio.to_thread(coverage.services_within, location, args.radius_km, found["features"])
    metrics = comparison.area_metrics(found, data["summary"], within)

    return StepOutcome(
        summary=(
            f"{label}: {metrics['services_in_area']} {found['label'].lower()} in the study area; "
            f"{metrics['well_covered_pct']}% well covered, {metrics['underserved_pct']}% underserved"
        ),
        result={"area": args.area, "found": found, "coverage": data, "metrics": metrics},
        preview={
            "services_in_area": metrics["services_in_area"],
            "density_per_km2": metrics["density_per_km2"],
            "well_covered_pct": metrics["well_covered_pct"],
            "underserved_pct": metrics["underserved_pct"],
            "truncated": found["truncated"],
        },
        partial=data["summary"]["partial"],
    )


class CompareStepArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    area_a_step: str = Field(..., min_length=1, max_length=32)
    area_b_step: str = Field(..., min_length=1, max_length=32)


def _area_input(inputs, step_id: str) -> tuple[dict[str, Any] | None, str | None]:
    state = inputs[step_id]
    if state.status == "completed":
        return state.outcome.result["metrics"], None
    return None, state.error or "The analysis did not run."


async def _compare_areas(args: CompareStepArgs, _context: WorkflowContext, inputs) -> StepOutcome:
    metrics_a, error_a = _area_input(inputs, args.area_a_step)
    metrics_b, error_b = _area_input(inputs, args.area_b_step)

    if metrics_a is None and metrics_b is None:
        raise StepError(f"Both areas failed. Area A: {error_a} Area B: {error_b}")

    result = comparison.compare(metrics_a, metrics_b)
    result["areas"] = {
        "a": {"metrics": metrics_a, "error": error_a},
        "b": {"metrics": metrics_b, "error": error_b},
    }
    decided = sum(1 for row in result["metrics"] if row["better"] in ("a", "b"))

    return StepOutcome(
        summary=(
            f"Compared {len(result['metrics'])} metrics"
            + ("" if metrics_a and metrics_b else "; one area unavailable")
            + ("" if result["complete"] else " (indicative)")
        ),
        result=result,
        preview={"metrics": len(result["metrics"]), "decided": decided, "complete": result["complete"]},
        partial=not result["complete"],
    )


class ComparisonReportArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    comparison_step: str = Field(..., min_length=1, max_length=32)


def _format(value: float | None, unit: str) -> str:
    if value is None:
        return "n/a"
    if unit == "m":
        return f"{value / 1000:.2f} km"
    if unit == "%":
        return f"{value:g}%"
    if unit == "per km²":
        return f"{value:.3f}/km²"
    return f"{value:g}"


async def _report_comparison(args: ComparisonReportArgs, _context: WorkflowContext, inputs) -> StepOutcome:
    result = inputs[args.comparison_step].outcome.result
    areas = {
        state.outcome.result["area"]: state.outcome.result
        for state in inputs.values()
        if state.step.tool == "analyse_area" and state.status == "completed"
    }
    reference = next(iter(areas.values()))
    found, summary = reference["found"], reference["coverage"]["summary"]
    label = found["label"].lower()
    thresholds = summary["thresholds_m"]

    lines = [
        f"Compared {label} within {summary['radius_km']:g} km of each area, using identical "
        f"{summary['cell_size_m']} m grids and thresholds (well covered ≤ {thresholds['well_covered'] / 1000:g} km, "
        f"underserved > {thresholds['moderate'] / 1000:g} km).",
    ]
    for key in ("a", "b"):
        metrics, error = result["areas"][key]["metrics"], result["areas"][key]["error"]
        if metrics is None:
            lines.append(f"{AREA_LABELS[key]} could not be analysed: {error} Its metrics are unavailable, not zero.")
        else:
            lat, lon = metrics["centre"][1], metrics["centre"][0]
            lines.append(f"{AREA_LABELS[key]} centre: {lat:.5f}, {lon:.5f}.")

    lines.append("Metric by metric:")
    for row in result["metrics"]:
        if row["better"] is None:
            lines.append(f"- {row['label']}: not comparable (missing data).")
            continue
        difference = _format(abs(row["difference"]), row["unit"]) if row["unit"] != "%" else f"{abs(row['difference']):g} percentage points"
        verdict = (
            "equal"
            if row["better"] == "tie"
            else f"{AREA_LABELS[row['better']]} is better ({difference} difference"
            + (f", {abs(row['relative_difference_pct']):g}% relative" if row["relative_difference_pct"] is not None and row["unit"] != "%" else "")
            + ")"
        )
        note = "" if row["definitive"] else " — indicative only (incomplete data)"
        lines.append(
            f"- {row['label']}: A {_format(row['a'], row['unit'])}, B {_format(row['b'], row['unit'])}; {verdict}{note}."
        )
    lines.append("There is no single overall winner; each metric is compared separately.")

    caveats = [
        "Straight-line distance from cell centroids to mapped services; not travel time, road access or population coverage.",
        "Density counts services intersecting each identical study circle.",
    ]
    for key, area in areas.items():
        if area["found"]["truncated"]:
            caveats.append(
                f"{AREA_LABELS[key]}: discovery was truncated ({area['found']['returned']} of "
                f"{area['found']['total_found']}); differences may reflect incomplete data."
            )
        if area["coverage"]["summary"]["invalid_services"]:
            caveats.append(f"{AREA_LABELS[key]}: {area['coverage']['summary']['invalid_services']} services without usable geometry were ignored.")
    if not result["complete"]:
        caveats.append("The comparison is potentially incomplete and should not be read as a definitive ranking.")
    caveats.append(found["coverage_note"])

    text = "\n".join(lines) + "\n\nCaveats:\n" + "\n".join(f"- {c}" for c in caveats)
    return StepOutcome(summary="Findings written", result={"text": text, "caveats": caveats}, preview={"caveats": len(caveats)})


# Site suitability (MCDA)

class SuitabilityStepArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    existing_step: str = Field(..., min_length=1, max_length=32)
    # Density/pharmacy search; None when the facility's own search is reused.
    context_step: str | None = Field(None, min_length=1, max_length=32)
    facility: Literal["hospital", "school", "pharmacy", "police", "fire_station"]
    radius_km: float = Field(..., gt=0, le=coverage.MAX_STUDY_RADIUS_KM)
    weights: dict[str, float] = Field(..., min_length=1, max_length=10)
    pharmacy_direction: Literal["closer", "farther"] | None = None
    existing_saturation_m: float = Field(
        suitability.DEFAULT_EXISTING_SATURATION_M,
        ge=suitability.MIN_EXISTING_SATURATION_M,
        le=suitability.DEFAULT_EXISTING_SATURATION_M,
    )
    normalization: Literal["saturating", "minmax"] = "saturating"
    max_candidates: int = Field(suitability.MAX_CANDIDATES, ge=suitability.MIN_CANDIDATES, le=suitability.MAX_CANDIDATES)


async def _score_suitability(args: SuitabilityStepArgs, context: WorkflowContext, inputs) -> StepOutcome:
    if context.location is None:
        raise StepError("No map location is selected.")

    existing = inputs[args.existing_step].outcome.result
    context_result, context_error = None, None
    if args.context_step:
        state = inputs[args.context_step]
        if state.status == "completed":
            context_result = state.outcome.result
        else:
            context_error = f"The context search failed: {state.error or 'it did not run.'}"

    try:
        # CPU-bound but bounded (<= 100 candidates, <= 500 cells and features).
        result = await asyncio.to_thread(
            suitability.analyse,
            context.location,
            args.facility,
            args.radius_km,
            existing,
            context_result,
            args.weights,
            args.pharmacy_direction,
            args.existing_saturation_m,
            args.normalization,
            args.max_candidates,
            context_error,
        )
    except (suitability.SuitabilityError, coverage.CoverageError) as exc:
        raise StepError(str(exc)) from exc

    top = result["ranked"][0] if result["ranked"] else None
    return StepOutcome(
        summary=(
            f"Scored {result['scored_count']} of {result['candidate_count']} candidates"
            + (f"; highest {top['score']:g}/100 ({top['id']})" if top else "")
            + (f"; {result['unscored_count']} unscored" if result["unscored_count"] else "")
        ),
        result=result,
        preview={
            "candidates": result["candidate_count"],
            "scored": result["scored_count"],
            "unscored": result["unscored_count"],
            "top_score": top["score"] if top else None,
            "criteria_used": sum(1 for c in result["criteria"] if c["status"] == "used"),
        },
        partial=not result["complete"],
    )


class SuitabilityReportArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    suitability_step: str = Field(..., min_length=1, max_length=32)
    unsupported: list[Literal[tuple(suitability.UNSUPPORTED_CRITERIA)]] = Field(default_factory=list, max_length=10)


MAX_REPORTED_CANDIDATES = 3


async def _report_suitability(args: SuitabilityReportArgs, _context: WorkflowContext, inputs) -> StepOutcome:
    result = inputs[args.suitability_step].outcome.result
    label = result["facility_label"].lower()
    lat, lon = result["centre"][1], result["centre"][0]
    used = [c for c in result["criteria"] if c["status"] == "used"]

    lines = [
        f"Site suitability for a new {label} within {result['radius_km']:g} km of ({lat:.5f}, {lon:.5f}): "
        f"{result['candidate_count']} analytical candidate points on a {result['cell_size_m']} m grid, "
        f"scored 0–100 on " + ", ".join(f"{c['name'].lower()} ({c['weight'] * 100:.0f}%)" for c in used) + ".",
    ]
    ranked = result["ranked"]
    if ranked:
        top = ranked[0]
        lines.append(
            f"Highest-scoring analytical candidate: {top['id']} at ({top['lat']:.5f}, {top['lon']:.5f}), "
            f"score {top['score']:g}/100" + (" (tied)" if top["tied"] else "") + "."
        )
        for entry in ranked[1:MAX_REPORTED_CANDIDATES]:
            lines.append(f"- #{entry['rank']} {entry['id']}: {entry['score']:g}/100")
        if top["strengths"]:
            lines.append("Why it ranks highly: " + "; ".join(top["strengths"]) + ".")
        if result["top_comparison"]:
            lines.append(result["top_comparison"]["text"])
    if result["unscored_count"]:
        lines.append(f"{result['unscored_count']} candidates could not be scored because data was missing; they are listed separately.")

    caveats = [
        "Candidates are analytical grid points, not available land parcels; check land, zoning and access separately.",
        "All distances are straight-line to mapped OpenStreetMap features; not travel time or service capacity.",
    ]
    caveats += result["data_quality"]
    note = suitability.unsupported_note(args.unsupported)
    if note:
        caveats.append(note)

    text = "\n".join(lines) + "\n\nCaveats:\n" + "\n".join(f"- {c}" for c in caveats)
    return StepOutcome(
        summary="Findings written",
        result={"text": text, "caveats": caveats},
        preview={"caveats": len(caveats)},
    )


WORKFLOW_TOOLS: dict[str, WorkflowTool] = {
    tool.name: tool
    for tool in (
        WorkflowTool("discover_features", DiscoverStepArgs, _discover),
        WorkflowTool(
            "discover_near_features",
            NearStepArgs,
            _discover_near,
            step_refs=(("source_step", frozenset({"discover_features"})),),
        ),
        WorkflowTool(
            "rank_by_nearby_count",
            RankStepArgs,
            _rank,
            step_refs=(("nearby_step", frozenset({"discover_near_features"})),),
        ),
        WorkflowTool(
            "report_findings",
            ReportStepArgs,
            _report,
            step_refs=(("ranking_step", frozenset({"rank_by_nearby_count"})),),
        ),
        WorkflowTool("discover_services", ServicesStepArgs, _discover_services),
        WorkflowTool(
            "analyse_coverage",
            CoverageStepArgs,
            _analyse_coverage,
            step_refs=(("services_step", frozenset({"discover_services"})),),
        ),
        WorkflowTool(
            "report_coverage",
            CoverageReportArgs,
            _report_coverage,
            step_refs=(("coverage_step", frozenset({"analyse_coverage"})),),
        ),
        WorkflowTool("analyse_area", AreaStepArgs, _analyse_area),
        WorkflowTool(
            "compare_areas",
            CompareStepArgs,
            _compare_areas,
            step_refs=(
                ("area_a_step", frozenset({"analyse_area"})),
                ("area_b_step", frozenset({"analyse_area"})),
            ),
        ),
        WorkflowTool(
            "report_comparison",
            ComparisonReportArgs,
            _report_comparison,
            step_refs=(("comparison_step", frozenset({"compare_areas"})),),
        ),
        WorkflowTool(
            "score_suitability",
            SuitabilityStepArgs,
            _score_suitability,
            step_refs=(
                ("existing_step", frozenset({"discover_services"})),
                ("context_step", frozenset({"discover_services"})),
            ),
        ),
        WorkflowTool(
            "report_suitability",
            SuitabilityReportArgs,
            _report_suitability,
            step_refs=(("suitability_step", frozenset({"score_suitability"})),),
        ),
    )
}
