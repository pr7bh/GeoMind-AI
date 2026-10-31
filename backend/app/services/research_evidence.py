"""Evidence digest: compact, bounded facts kept from a research execution.

When an execution ends its GIS payloads (features, cells) are released. This
module first copies the measurements needed for synthesis out of the
serialised workflow results: metrics, rankings, top candidates, data-quality
flags and provenance (step ids). No geometry is kept and nothing is
recalculated, except one lookup: which coverage cell contains each top
suitability candidate, read from the coverage grid of the same study area.
"""

import json
from typing import Any

from shapely.geometry import Point, shape

from app.schemas.research import ResearchPlan

TOP_CANDIDATES = 10
TOP_RANKED = 10
MAX_DIGEST_BYTES = 96 * 1024
MESSAGE_CHARS = 1500

SUITABILITY_KEYS = (
    "facility", "facility_label", "centre", "radius_km", "cell_size_m", "candidate_count", "scored_count",
    "unscored_count", "excluded_by_constraint", "normalization", "weights", "requested_weights",
    "weight_total", "top_comparison", "existing_count", "pharmacy_count", "data_quality", "complete",
)
AREA_KEYS = (
    "centre", "radius_km", "cell_size_m", "total_cells", "percentages", "services_in_area", "density_per_km2",
    "average_distance_m", "max_distance_m", "truncated", "density_complete", "coverage_complete",
)


def _step_ids(plan: ResearchPlan, capability: str) -> dict[str, str]:
    """Local step id → actual research step id (merged steps via aliases)."""
    ids = {}
    for step in plan.steps:
        if step.id.startswith(capability + "."):
            ids[step.id.split(".", 1)[1]] = step.id
        for alias in step.aliases:
            if alias.startswith(capability + "."):
                ids[alias.split(".", 1)[1]] = step.id
    return ids


def _coverage_cells(layers: list[dict[str, Any]], area: str | None = None) -> list[tuple[Any, str]]:
    cells = []
    for layer in layers:
        if layer.get("style") != "coverage" or layer.get("area") != area:
            continue
        for feature in layer["geojson"]["features"]:
            cells.append((shape(feature["geometry"]), feature["properties"]["coverage_class"]))
    return cells


def _class_at(cells: list[tuple[Any, str]], lon: float, lat: float) -> str | None:
    point = Point(lon, lat)
    return next((cls for polygon, cls in cells if polygon.covers(point)), None)


def build_digest(plan: ResearchPlan, execution_public: dict[str, Any], results: list[dict[str, Any]]) -> dict[str, Any]:
    areas = {a.id: a.coordinates for a in plan.selected_areas}
    digest: dict[str, Any] = {
        "question": plan.original_question,
        "plan_id": plan.id,
        "assumptions": plan.assumptions,
        "plan_limitations": plan.limitations,
        "areas": areas,
        "execution": {
            "status": execution_public["status"],
            "warnings": execution_public["warnings"][:20],
            "errors": execution_public["errors"][:20],
            "steps": [{k: s[k] for k in ("id", "capability_id", "status", "error")} for s in execution_public["steps"]],
        },
        "capabilities": {},
        "cross": {},
    }

    coverage_cells: dict[str, list] = {}
    for result in results:
        capability = result["capability_id"]
        entry: dict[str, Any] = {
            "title": result["title"],
            "outcome": result["outcome"],
            "message": result["message"][:MESSAGE_CHARS],
            "steps": _step_ids(plan, capability),
        }
        analysis = (result.get("workflow") or {}).get("analysis") or {}

        if capability == "coverage" and analysis.get("coverage"):
            entry["summary"] = analysis["coverage"]
            entry["services"] = analysis.get("services")
            coverage_cells["coverage"] = _coverage_cells(result["layers"])
        elif capability == "comparison" and analysis.get("areas"):
            entry["metrics"] = analysis.get("metrics", [])
            entry["complete"] = analysis.get("complete")
            entry["areas"] = {
                key: {
                    "metrics": {k: area["metrics"][k] for k in AREA_KEYS} if area.get("metrics") else None,
                    "error": area.get("error"),
                }
                for key, area in analysis["areas"].items()
            }
            entry["services"] = analysis.get("services", {})
            entry["thresholds"] = {
                step.arguments["area"]: {
                    "well_covered_m": step.arguments["well_covered_m"],
                    "moderate_m": step.arguments["moderate_m"],
                    "radius_km": step.arguments["radius_km"],
                    "cell_size_m": step.arguments["cell_size_m"],
                }
                for step in plan.steps if step.tool == "analyse_area"
            }
            coverage_cells["comparison_a"] = _coverage_cells(result["layers"], "a")
        elif capability == "suitability" and analysis.get("suitability"):
            data = analysis["suitability"]
            entry.update({k: data.get(k) for k in SUITABILITY_KEYS})
            entry["criteria"] = [
                {k: c[k] for k in ("id", "name", "status", "weight", "unit", "higher_is_better", "note", "method", "saturation")}
                for c in data["criteria"]
            ]
            top_score = data["ranked"][0]["score"] if data["ranked"] else None
            entry["tied_at_top"] = sum(1 for c in data["ranked"] if c["score"] == top_score)
            entry["top"] = [
                {k: c[k] for k in ("id", "rank", "tied", "score", "lon", "lat", "criteria", "strengths", "weaknesses")}
                for c in data["ranked"][:TOP_CANDIDATES]
            ]
            entry["unscored_reasons"] = [c["reason"] for c in data["unscored"][:5]]
            entry["internal_coverage"] = {
                k: data["coverage"][k] for k in ("percentages", "thresholds_m", "radius_km", "cell_size_m")
            } if data.get("coverage") else None
        elif capability == "nearby_count" and analysis.get("sources"):
            entry["sources"] = analysis["sources"]
            entry["nearby"] = analysis.get("nearby")
            entry["complete"] = analysis.get("complete")
            ranking = analysis.get("ranking", [])
            entry["ranking_size"] = len(ranking)
            entry["ranking"] = [
                {k: r[k] for k in ("rank", "tied", "id", "name", "nearby_count", "count_is_lower_bound", "nearest_m")}
                for r in ranking[:TOP_RANKED]
            ]
            entry["lowest"] = [
                {k: r[k] for k in ("rank", "tied", "id", "name", "nearby_count", "count_is_lower_bound")}
                for r in ranking[-3:]
            ] if len(ranking) > TOP_RANKED else []
            entry["unranked"] = [{"name": u["name"], "reason": u["reason"]} for u in analysis.get("unranked", [])[:10]]
        elif result.get("workflow") is None:
            # Single agent tools: discovered feature layers.
            entry["layers"] = []
            for layer in result["layers"]:
                features = layer["geojson"]["features"]
                nearest = sorted(
                    (f["properties"].get("distance_km"), f["properties"].get("display_name") or f["properties"].get("name"))
                    for f in features if f["properties"].get("distance_km") is not None
                )[:5]
                entry["layers"].append({
                    # "discovery": OSM features; "analysis": geometry GeoMind calculated (e.g. a buffer).
                    "kind": layer.get("kind", "discovery"),
                    "name": layer["name"],
                    "feature_count": layer["feature_count"],
                    "nearest": [{"name": n, "distance_km": d} for d, n in nearest],
                })
        digest["capabilities"][capability] = entry

    # Cross-workflow evidence: coverage class of the cell containing each
    # top candidate, only when the grid covers the same study centre.
    suit = digest["capabilities"].get("suitability")
    if suit and suit.get("top"):
        source, cells = None, None
        cover = digest["capabilities"].get("coverage")
        if cover and coverage_cells.get("coverage") and cover["summary"]["centre"] == suit["centre"]:
            source, cells = "coverage", coverage_cells["coverage"]
        elif coverage_cells.get("comparison_a") and areas.get("a") == suit["centre"]:
            source, cells = "comparison_a", coverage_cells["comparison_a"]
        if cells:
            digest["cross"]["candidate_coverage"] = {
                "source": source,
                "classes": {c["id"]: _class_at(cells, c["lon"], c["lat"]) for c in suit["top"]},
            }

    _bound(digest)
    return digest


def _bound(digest: dict[str, Any]) -> None:
    """Trim long lists until the digest fits its size budget."""
    while len(json.dumps(digest, default=str)) > MAX_DIGEST_BYTES:
        trimmed = False
        for entry in digest["capabilities"].values():
            for key in ("top", "ranking", "metrics"):
                if isinstance(entry.get(key), list) and len(entry[key]) > 3:
                    entry[key] = entry[key][: len(entry[key]) // 2]
                    trimmed = True
            if isinstance(entry.get("message"), str) and len(entry["message"]) > 300:
                entry["message"] = entry["message"][:300]
                trimmed = True
        if not trimmed:
            break
