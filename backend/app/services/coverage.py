"""Deterministic service coverage gap analysis.

Geometric proximity only: each grid cell's centroid is compared with the
nearest mapped OpenStreetMap service. This is not travel time, road access
or population coverage.

All metric work happens in an azimuthal equidistant projection centred on
the study point (exact distances from the centre, negligible distortion
within the 10 km study area). Output GeoJSON is EPSG:4326.
"""

import math
from dataclasses import dataclass
from typing import Any

from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import Point, box, mapping, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform

MAX_STUDY_RADIUS_KM = 10.0
DEFAULT_STUDY_RADIUS_KM = 5.0
MAX_CELLS = 500
MIN_CELL_SIZE_M = 250
MAX_CELL_SIZE_M = 5000
CELL_SIZE_STEP_M = 50

DEFAULT_WELL_COVERED_M = 2000
DEFAULT_MODERATE_M = 5000

CLASSES = ("well_covered", "moderate", "underserved", "no_service_found")


class CoverageError(ValueError):
    """Invalid coverage request; the message is safe to show to users."""


@dataclass(frozen=True)
class LocalProjection:
    """Forward/backward transforms for a projection centred on (lon, lat)."""

    to_local: Transformer
    to_wgs84: Transformer

    @classmethod
    def centred_on(cls, lon: float, lat: float) -> "LocalProjection":
        local = f"+proj=aeqd +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m"
        return cls(
            to_local=Transformer.from_crs("EPSG:4326", local, always_xy=True),
            to_wgs84=Transformer.from_crs(local, "EPSG:4326", always_xy=True),
        )

    def project(self, geometry: BaseGeometry) -> BaseGeometry:
        return transform(self.to_local.transform, geometry)

    def unproject(self, geometry: BaseGeometry) -> BaseGeometry:
        return transform(self.to_wgs84.transform, geometry)


def study_area(radius_m: float) -> BaseGeometry:
    """Study circle in local metres (centre at the origin)."""
    return Point(0, 0).buffer(radius_m, quad_segs=32)


def _estimated_cells(radius_m: float, cell_size_m: float) -> int:
    return math.ceil(math.pi * radius_m**2 / cell_size_m**2)


def choose_cell_size(radius_m: float, requested_m: float | None) -> tuple[int, bool]:
    """Smallest allowed cell size (>= the request) that keeps cells <= MAX_CELLS.

    Returns (cell_size_m, adjusted).
    """
    if requested_m is not None and not (MIN_CELL_SIZE_M <= requested_m <= MAX_CELL_SIZE_M):
        raise CoverageError(
            f"Cell size must be between {MIN_CELL_SIZE_M} and {MAX_CELL_SIZE_M} metres."
        )

    size = requested_m or MIN_CELL_SIZE_M
    # Start from the analytic bound, then confirm against the real grid.
    size = max(size, radius_m * math.sqrt(math.pi / MAX_CELLS))
    size = math.ceil(size / CELL_SIZE_STEP_M) * CELL_SIZE_STEP_M

    while len(build_grid(radius_m, size)) > MAX_CELLS:
        size += CELL_SIZE_STEP_M
        if size > MAX_CELL_SIZE_M:
            raise CoverageError("This study area cannot be covered within the cell limit.")

    adjusted = requested_m is not None and size != requested_m
    return int(size), adjusted


def build_grid(radius_m: float, cell_size_m: float) -> list[tuple[str, BaseGeometry]]:
    """Square cells clipped to the study circle, with stable row/column ids.

    The grid is anchored at the study centre, so the same radius and cell
    size always yield the same ids. Cells outside the circle are dropped.
    """
    area = study_area(radius_m)
    half = math.ceil(radius_m / cell_size_m)
    cells = []

    for row in range(-half, half):
        for col in range(-half, half):
            square = box(
                col * cell_size_m,
                row * cell_size_m,
                (col + 1) * cell_size_m,
                (row + 1) * cell_size_m,
            )
            if not square.intersects(area):
                continue
            clipped = square.intersection(area)
            if clipped.is_empty or clipped.area <= 0:
                continue
            cells.append((f"r{row + half}c{col + half}", clipped))

    return cells


def project_services(
    features: list[dict[str, Any]],
    projection: LocalProjection,
) -> tuple[list[dict[str, Any]], list[BaseGeometry], int]:
    """Valid, de-duplicated service geometries in local metres.

    Returns (features, projected geometries, invalid count). Identity is the
    OSM element ("node/123").
    """
    kept, geometries, invalid = [], [], 0
    seen: set[str] = set()

    for feature in features:
        key = str(feature.get("id") or "")
        if not key:
            invalid += 1
            continue
        if key in seen:
            continue
        seen.add(key)

        try:
            geometry = shape(feature["geometry"])
        except (KeyError, TypeError, ValueError, AttributeError):
            invalid += 1
            continue

        if geometry.is_empty or not geometry.is_valid:
            invalid += 1
            continue

        kept.append(feature)
        geometries.append(projection.project(geometry))

    return kept, geometries, invalid


def classify(distance_m: float | None, well_covered_m: float, moderate_m: float) -> str:
    if distance_m is None:
        return "no_service_found"
    if distance_m <= well_covered_m:
        return "well_covered"
    if distance_m <= moderate_m:
        return "moderate"
    return "underserved"


def analyse(
    centre: tuple[float, float],
    radius_km: float,
    services: list[dict[str, Any]],
    cell_size_m: float | None = None,
    well_covered_m: float = DEFAULT_WELL_COVERED_M,
    moderate_m: float = DEFAULT_MODERATE_M,
) -> dict[str, Any]:
    """Grid the study area and classify each cell by nearest-service distance."""
    if not (0 < radius_km <= MAX_STUDY_RADIUS_KM):
        raise CoverageError(f"Study radius must be greater than 0 and at most {MAX_STUDY_RADIUS_KM:g} km.")
    if not (0 < well_covered_m < moderate_m):
        raise CoverageError("Thresholds must satisfy 0 < well covered < moderate.")

    radius_m = radius_km * 1000
    size, adjusted = choose_cell_size(radius_m, cell_size_m)
    projection = LocalProjection.centred_on(*centre)
    grid = build_grid(radius_m, size)

    if not grid:
        raise CoverageError("The study area produced no grid cells.")

    kept, geometries, invalid = project_services(services, projection)
    centroids = [cell.centroid for _, cell in grid]

    if geometries:
        tree = STRtree(geometries)
        (_, nearest_index), distances = tree.query_nearest(centroids, return_distance=True)
        nearest = [(kept[int(i)], float(d)) for i, d in zip(nearest_index, distances)]
    else:
        nearest = [(None, None)] * len(grid)

    cells = []
    for (cell_id, polygon), (service, distance) in zip(grid, nearest):
        props = service["properties"] if service else {}
        cells.append({
            "type": "Feature",
            "id": cell_id,
            "geometry": mapping(projection.unproject(polygon)),
            "properties": {
                "cell_id": cell_id,
                "coverage_class": classify(distance, well_covered_m, moderate_m),
                "nearest_distance_m": round(distance, 1) if distance is not None else None,
                "nearest_service_id": service["id"] if service else None,
                "nearest_service_name": props.get("display_name") if service else None,
                "cell_area_km2": round(polygon.area / 1e6, 4),
            },
        })

    measured = [d for _, d in nearest if d is not None]
    counts = {name: 0 for name in CLASSES}
    for cell in cells:
        counts[cell["properties"]["coverage_class"]] += 1

    total = len(cells)
    return {
        "cells": cells,
        "services": kept,
        "summary": {
            "centre": list(centre),
            "radius_km": radius_km,
            "cell_size_m": size,
            "cell_size_adjusted": adjusted,
            "total_cells": total,
            "counts": counts,
            "percentages": {name: round(100 * count / total, 1) for name, count in counts.items()},
            "average_distance_m": round(sum(measured) / len(measured), 1) if measured else None,
            "max_distance_m": round(max(measured), 1) if measured else None,
            "services_count": len(kept),
            "invalid_services": invalid,
            "thresholds_m": {"well_covered": well_covered_m, "moderate": moderate_m},
        },
    }


def services_within(
    centre: tuple[float, float],
    radius_km: float,
    services: list[dict[str, Any]],
) -> dict[str, Any]:
    """Unique valid services intersecting the study circle, and its area.

    Used for density, so both compared areas use the identical circle area.
    """
    projection = LocalProjection.centred_on(*centre)
    area = study_area(radius_km * 1000)
    _, geometries, _ = project_services(services, projection)
    count = sum(1 for geometry in geometries if geometry.intersects(area))
    return {"count": count, "area_km2": round(area.area / 1e6, 4)}
