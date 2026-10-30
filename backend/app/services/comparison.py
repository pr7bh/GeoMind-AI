"""Deterministic Area A vs Area B comparison of coverage results.

Each metric is compared on its own. There is deliberately no overall
winner: an area can have more services but worse geographic coverage.
"""

from typing import Any

# key, label, unit, higher is better, completeness flag that governs it
METRICS: tuple[tuple[str, str, str, bool, str], ...] = (
    ("services_in_area", "Services in study area", "count", True, "density_complete"),
    ("density_per_km2", "Service density", "per km²", True, "density_complete"),
    ("well_covered_pct", "Well-covered cells", "%", True, "coverage_complete"),
    ("underserved_pct", "Underserved cells", "%", False, "coverage_complete"),
    ("average_distance_m", "Average nearest-service distance", "m", False, "coverage_complete"),
)


def area_metrics(
    found: dict[str, Any],
    summary: dict[str, Any],
    within: dict[str, Any],
) -> dict[str, Any]:
    """Metrics for one area from its discovery, coverage summary and density count."""
    distances = [
        f["properties"].get("distance_km")
        for f in found["features"]
        if f["properties"].get("distance_km") is not None
    ]
    # Discovery keeps the nearest services. If even the farthest kept one lies
    # beyond the study circle, every service inside the circle was kept.
    density_complete = not found["truncated"] or (
        bool(distances) and max(distances) >= summary["radius_km"]
    )
    area_km2 = within["area_km2"]
    pct = summary["percentages"]

    return {
        "centre": summary["centre"],
        "radius_km": summary["radius_km"],
        "cell_size_m": summary["cell_size_m"],
        "total_cells": summary["total_cells"],
        "counts": summary["counts"],
        "percentages": pct,
        "services_discovered": found["returned"],
        "services_total_found": found["total_found"],
        "unique_services": summary["services_count"],
        "services_in_area": within["count"],
        "study_area_km2": area_km2,
        "density_per_km2": round(within["count"] / area_km2, 4) if area_km2 > 0 else None,
        "well_covered_pct": pct["well_covered"],
        "moderate_pct": pct["moderate"],
        "underserved_pct": pct["underserved"],
        "no_service_found_pct": pct["no_service_found"],
        "average_distance_m": summary["average_distance_m"],
        "max_distance_m": summary["max_distance_m"],
        "truncated": found["truncated"],
        "density_complete": density_complete,
        "coverage_complete": not summary["partial"],
        "invalid_services": summary["invalid_services"],
        "osm_base": found["osm_base"],
    }


def _difference(a: float | None, b: float | None) -> tuple[float | None, float | None]:
    """(A - B, (A - B) / B * 100); None where undefined, never divide by zero."""
    if a is None or b is None:
        return None, None
    difference = round(a - b, 4)
    relative = round((a - b) / b * 100, 1) if b != 0 else None
    return difference, relative


def _better(a: float | None, b: float | None, higher_is_better: bool) -> str | None:
    if a is None or b is None:
        return None
    if a == b:
        return "tie"
    return "a" if (a > b) == higher_is_better else "b"


def compare(a: dict[str, Any] | None, b: dict[str, Any] | None) -> dict[str, Any]:
    """Per-metric comparison. Missing areas give null values, never zeros."""
    rows = []
    for key, label, unit, higher_is_better, flag in METRICS:
        value_a = a[key] if a else None
        value_b = b[key] if b else None
        difference, relative = _difference(value_a, value_b)
        rows.append({
            "key": key,
            "label": label,
            "unit": unit,
            "higher_is_better": higher_is_better,
            "a": value_a,
            "b": value_b,
            "difference": difference,
            "relative_difference_pct": relative,
            "better": _better(value_a, value_b, higher_is_better),
            # Only definitive when both areas' underlying data is complete.
            "definitive": bool(a and b and a[flag] and b[flag]),
        })

    return {
        "metrics": rows,
        "complete": bool(a and b and all(area[flag] for area in (a, b) for *_, flag in METRICS)),
        # Deliberately no single score: metrics can disagree.
        "overall_winner": None,
    }
