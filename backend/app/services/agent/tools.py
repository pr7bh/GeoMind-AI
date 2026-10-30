"""Agent tool registry.

Every tool wraps an existing, tested service. The model never supplies
coordinates: location comes from the user's selected map point, so the
model cannot invent or redirect a query.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.services import coverage, osm_discovery, spatial_analysis
from app.services.workflows import catalog as workflows
from app.services.workflows.steps import COVERAGE_CATEGORIES

# Bounds on what one run may produce or send back to the model.
MAX_DISCOVERY_FEATURES = 200
MAX_CONTEXT_FEATURES = 5000
MAX_LISTED_FEATURES = 10


class ToolError(Exception):
    """A tool failure whose message is safe to show to the user and model."""


@dataclass
class AgentContext:
    location: tuple[float, float] | None
    features: list[dict[str, Any]] = field(default_factory=list)
    features_label: str | None = None
    buffer_geometry: dict[str, Any] | None = None
    # Map-ready outputs returned to the frontend.
    layers: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class AgentTool:
    name: str
    description: str
    args_model: type[BaseModel]
    run: Callable[[Any, AgentContext], Awaitable[dict[str, Any]]]

    def spec(self) -> dict[str, Any]:
        schema = self.args_model.model_json_schema()
        schema.pop("title", None)
        for prop in schema.get("properties", {}).values():
            prop.pop("title", None)
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": schema,
            },
        }


def _require_location(context: AgentContext) -> tuple[float, float]:
    if context.location is None:
        raise ToolError(
            "No map location is selected. Ask the user to pick a location on the map."
        )
    return context.location


def _feature_name(feature: dict[str, Any], index: int) -> str:
    props = feature.get("properties") or {}
    return str(
        props.get("display_name") or props.get("name") or props.get("Name") or f"Feature {index + 1}"
    )


# discover_features

class DiscoverArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str = Field(
        ...,
        min_length=1,
        max_length=50,
        description="OpenStreetMap category, e.g. hospital, school, restaurant, park, pharmacy, police, river.",
    )
    radius_km: float = Field(..., gt=0, le=osm_discovery.MAX_RADIUS_KM, description="Search radius in kilometres.")
    limit: int = Field(50, ge=1, le=MAX_DISCOVERY_FEATURES, description="Maximum features to return.")


async def _discover(args: DiscoverArgs, context: AgentContext) -> dict[str, Any]:
    location = _require_location(context)

    try:
        data = await osm_discovery.discover_features(
            coordinates=list(location),
            category=args.category,
            radius_km=args.radius_km,
            limit=args.limit,
        )
    except ValueError as exc:
        message = str(exc)
        if "Unsupported category" in message:
            message = (
                f"Unsupported category '{args.category}'. Examples: "
                + ", ".join(list(osm_discovery.OSM_CATEGORIES)[:20])
            )
        raise ToolError(message) from exc
    except osm_discovery.OverpassError as exc:
        raise ToolError(str(exc)) from exc

    meta = data["metadata"]
    features = data["features"]
    context.features = features
    context.features_label = meta["label"]

    if features:
        context.layers.append({
            "kind": "discovery",
            "name": f"{meta['label']} · {meta['radius_km']:g} km",
            "feature_count": len(features),
            "geojson": {"type": "FeatureCollection", "features": features},
        })

    return {
        "category": meta["category"],
        "label": meta["label"],
        "radius_km": meta["radius_km"],
        "total_found": meta["total_found"],
        "returned": meta["returned"],
        "truncated": meta["truncated"],
        "unnamed_count": sum(1 for f in features if not f["properties"].get("name")),
        "nearest": [
            {
                "name": f["properties"]["display_name"],
                "distance_km": f["properties"]["distance_km"],
                "osm_id": f["id"],
            }
            for f in features[:MAX_LISTED_FEATURES]
        ],
        "source": meta["source"],
        "coverage_note": meta["coverage_note"],
    }


# find_nearest_features

class NearestArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    limit: int = Field(5, ge=1, le=MAX_LISTED_FEATURES, description="How many nearest features to rank.")


async def _nearest(args: NearestArgs, context: AgentContext) -> dict[str, Any]:
    location = _require_location(context)

    if not context.features:
        raise ToolError(
            "There are no features to rank. Run discover_features first."
        )

    try:
        result = spatial_analysis.find_top_nearest_features(
            coordinates=list(location),
            features=context.features[:MAX_CONTEXT_FEATURES],
            limit=args.limit,
        )
    except ValueError as exc:
        raise ToolError(str(exc)) from exc

    return {
        "features_from": context.features_label,
        "checked": result["valid_features_checked"],
        "nearest": [
            {
                "name": _feature_name(item["feature"], item["feature_index"]),
                "distance_metres": item["distance_metres"],
            }
            for item in result["results"]
        ],
    }


# create_buffer

class BufferArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    distance_metres: float = Field(..., gt=0, le=50_000, description="Buffer radius in metres.")


async def _buffer(args: BufferArgs, context: AgentContext) -> dict[str, Any]:
    location = _require_location(context)

    try:
        result = spatial_analysis.create_buffer("Point", list(location), args.distance_metres)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc

    feature = result["geojson"]
    context.buffer_geometry = feature["geometry"]
    context.layers.append({
        "kind": "analysis",
        "name": f"Buffer {args.distance_metres:g} m",
        "feature_count": 1,
        "geojson": {"type": "FeatureCollection", "features": [feature]},
    })

    return {"distance_metres": args.distance_metres, "centre": list(location)}


# spatial_query

class SpatialQueryArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation: Literal["intersects", "within"] = Field(
        "intersects",
        description="How features must relate to the buffer.",
    )


async def _spatial_query(args: SpatialQueryArgs, context: AgentContext) -> dict[str, Any]:
    if context.buffer_geometry is None:
        raise ToolError("No buffer exists yet. Run create_buffer first.")
    if not context.features:
        raise ToolError("There are no features to query. Run discover_features first.")

    try:
        result = spatial_analysis.spatial_query(
            context.features[:MAX_CONTEXT_FEATURES],
            context.buffer_geometry,
            args.operation,
        )
    except ValueError as exc:
        raise ToolError(str(exc)) from exc

    return {
        "operation": result["operation"],
        "features_from": context.features_label,
        "total_features": result["total_features"],
        "matched_count": result["matched_count"],
        "matched": [
            _feature_name(item["feature"], item["index"])
            for item in result["results"][:MAX_LISTED_FEATURES]
        ],
    }


# analyse_service_coverage

COVERAGE_WORKFLOW_SECONDS = 60


class CoverageArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str = Field(
        ..., min_length=1, max_length=50,
        description="Service category, e.g. hospital, school, police, pharmacy, park.",
    )
    radius_km: float = Field(
        coverage.DEFAULT_STUDY_RADIUS_KM, gt=0, le=coverage.MAX_STUDY_RADIUS_KM,
        description="Study radius in kilometres (max 10).",
    )


async def _coverage(args: CoverageArgs, context: AgentContext) -> dict[str, Any]:
    location = _require_location(context)

    try:
        category = osm_discovery.normalize_category(args.category)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    if category not in COVERAGE_CATEGORIES:
        raise ToolError(f"Coverage analysis supports: {', '.join(sorted(COVERAGE_CATEGORIES))}.")

    async def _quiet(_: dict[str, Any]) -> None:
        return None

    run = await workflows.run_coverage_workflow(
        workflows.CoverageRequest(category=category, radius_km=args.radius_km),
        location,
        COVERAGE_WORKFLOW_SECONDS,
        _quiet,
    )
    workflow, layers = workflows.serialize_coverage(run, location)

    if run.outcome == "failed":
        raise ToolError(workflows.answer_text(run))

    context.layers.extend(layers)
    summary = workflow["analysis"]["coverage"]
    # The model only sees calculated values; it must not compute its own.
    return {
        "category": category,
        "radius_km": summary["radius_km"],
        "cell_size_m": summary["cell_size_m"],
        "total_cells": summary["total_cells"],
        "counts": summary["counts"],
        "percentages": summary["percentages"],
        "average_distance_m": summary["average_distance_m"],
        "max_distance_m": summary["max_distance_m"],
        "services_count": summary["services_count"],
        "thresholds_m": summary["thresholds_m"],
        "partial": summary["partial"],
        "report": workflows.answer_text(run),
    }


TOOLS: dict[str, AgentTool] = {
    tool.name: tool
    for tool in (
        AgentTool(
            "discover_features",
            "Find real OpenStreetMap features of one category within a radius of "
            "the user's selected map location. Returns counts, the nearest names "
            "with distances, and coverage caveats.",
            DiscoverArgs,
            _discover,
        ),
        AgentTool(
            "find_nearest_features",
            "Rank the most recently discovered features by geodesic distance from "
            "the selected location.",
            NearestArgs,
            _nearest,
        ),
        AgentTool(
            "create_buffer",
            "Create a circular buffer around the selected map location.",
            BufferArgs,
            _buffer,
        ),
        AgentTool(
            "analyse_service_coverage",
            "Deterministic coverage gap analysis: grid the area around the selected "
            "location and classify cells by distance to the nearest mapped service "
            "(well covered / moderate / underserved). Returns calculated statistics "
            "and caveats; report them as given.",
            CoverageArgs,
            _coverage,
        ),
        AgentTool(
            "spatial_query",
            "Filter the most recently discovered features by their relationship "
            "to the most recent buffer.",
            SpatialQueryArgs,
            _spatial_query,
        ),
    )
}
