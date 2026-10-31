"""Site suitability for a new facility (deterministic MCDA).

Candidates are analytical grid points inside the study circle, not land
parcels. Each candidate is measured against mapped OpenStreetMap data in a
local azimuthal equidistant projection, then scored with `mcda`.

Measures (all straight-line, around each candidate point):
- distance_existing: distance to the nearest existing facility of the type.
- service_gap: mean M6 coverage gap of grid cells within 2 km (well covered
  0, moderate 50, underserved / no service 100).
- facility_density: related facilities within 2 km (lower is better).
- pharmacy_proximity: distance to the nearest pharmacy (direction chosen by
  the user; hospitals only).
- within_study_area: hard constraint; candidates outside are excluded.
"""

from dataclasses import dataclass
from typing import Any

from shapely import STRtree
from shapely.geometry import Point, mapping

from app.services import coverage, mcda

MAX_CANDIDATES = 100
MIN_CANDIDATES = 20
# Clipped edge cells smaller than this share of a full cell are not candidates.
MIN_CELL_FRACTION = 0.25
NEIGHBOURHOOD_M = 2000
# Searches extend past the study edge so edge candidates see nearby features.
EXISTING_MARGIN_KM = coverage.DEFAULT_MODERATE_M / 1000
CONTEXT_MARGIN_KM = NEIGHBOURHOOD_M / 1000

DEFAULT_EXISTING_SATURATION_M = 5000
MIN_EXISTING_SATURATION_M = 500
DENSITY_SATURATION = 20
PHARMACY_SATURATION_M = 2000
GAP_WEIGHTS = {"well_covered": 0, "moderate": 50, "underserved": 100, "no_service_found": 100}

DISTANCE = "distance_existing"
GAP = "service_gap"
DENSITY = "facility_density"
PHARMACY = "pharmacy_proximity"
CONSTRAINT = "within_study_area"


@dataclass(frozen=True)
class Facility:
    label: str
    existing: str  # OSM category of existing facilities
    density: str  # OSM category counted for density
    density_label: str
    criteria: tuple[str, ...]
    defaults: dict[str, float]


FACILITIES: dict[str, Facility] = {
    "hospital": Facility(
        "Hospital", "hospital", "healthcare", "healthcare facilities",
        (DISTANCE, GAP, DENSITY, PHARMACY), {DISTANCE: 0.35, GAP: 0.35, DENSITY: 0.30},
    ),
    "school": Facility(
        "School", "school", "education", "education facilities",
        (DISTANCE, GAP, DENSITY), {DISTANCE: 0.35, GAP: 0.35, DENSITY: 0.30},
    ),
    "pharmacy": Facility(
        "Pharmacy", "pharmacy", "healthcare", "healthcare facilities",
        (DISTANCE, GAP, DENSITY), {DISTANCE: 0.35, GAP: 0.35, DENSITY: 0.30},
    ),
    "police": Facility(
        "Police station", "police", "police", "police stations",
        (DISTANCE, GAP, DENSITY), {DISTANCE: 0.40, GAP: 0.40, DENSITY: 0.20},
    ),
    "fire_station": Facility(
        "Fire station", "fire_station", "fire_station", "fire stations",
        (DISTANCE, GAP, DENSITY), {DISTANCE: 0.40, GAP: 0.40, DENSITY: 0.20},
    ),
}

# Requested factors GeoMind has no data for. Never estimated.
UNSUPPORTED_CRITERIA = {
    "population": "population or demographic data",
    "land": "land availability, parcels or land use",
    "zoning": "zoning or planning regulations",
    "cost": "land or construction cost",
    "travel_time": "travel time or road-network access",
    "traffic": "traffic conditions",
    "demand": "service demand or utilisation",
}


class SuitabilityError(ValueError):
    """Invalid suitability request; the message is safe to show to users."""


def criteria_for(
    facility: str,
    pharmacy_direction: str | None = None,
    existing_saturation_m: float = DEFAULT_EXISTING_SATURATION_M,
    normalization: str = "saturating",
) -> dict[str, mcda.Criterion]:
    config = FACILITIES[facility]
    label = config.label.lower()
    method = normalization
    defs = {
        DISTANCE: mcda.Criterion(
            DISTANCE,
            f"Distance to nearest existing {label}",
            f"Straight-line distance from the candidate to the nearest mapped {label}. "
            f"Farther is better (fills a gap); saturates at {existing_saturation_m / 1000:g} km.",
            "m", True, method, existing_saturation_m,
        ),
        GAP: mcda.Criterion(
            GAP,
            "Nearby service gap",
            f"Mean coverage gap of grid cells within {NEIGHBOURHOOD_M / 1000:g} km (service coverage analysis "
            f"for existing {label}s): well covered 0, moderate 50, underserved or none 100. Higher is better.",
            "index", True, method, 100,
        ),
        DENSITY: mcda.Criterion(
            DENSITY,
            f"{config.density_label.capitalize()} within {NEIGHBOURHOOD_M / 1000:g} km",
            f"Number of mapped {config.density_label} within {NEIGHBOURHOOD_M / 1000:g} km. "
            f"Lower is better; saturates at {DENSITY_SATURATION}.",
            "count", False, method, DENSITY_SATURATION,
        ),
        PHARMACY: mcda.Criterion(
            PHARMACY,
            "Distance to nearest pharmacy",
            "Straight-line distance to the nearest mapped pharmacy. "
            + (
                "Closer is better" if pharmacy_direction == "closer"
                else "Farther is better" if pharmacy_direction == "farther"
                else "Direction must be chosen"
            )
            + f"; saturates at {PHARMACY_SATURATION_M / 1000:g} km.",
            "m", pharmacy_direction == "farther", method, PHARMACY_SATURATION_M,
        ),
    }
    return {cid: defs[cid] for cid in config.criteria}


def validate_weights(
    facility: str,
    weights: dict[str, Any] | None,
    pharmacy_direction: str | None,
) -> dict[str, float]:
    """Normalised weights for a facility; raises SuitabilityError."""
    if facility not in FACILITIES:
        raise SuitabilityError(
            f"Site suitability supports: {', '.join(f.label.lower() for f in FACILITIES.values())}."
        )
    config = FACILITIES[facility]
    raw = dict(config.defaults) if weights is None else dict(weights)

    if CONSTRAINT in raw:
        raise SuitabilityError("'within_study_area' is a hard constraint and cannot be weighted.")
    try:
        normalised = mcda.normalize_weights(raw, list(config.criteria))
    except mcda.MCDAError as exc:
        raise SuitabilityError(str(exc)) from exc

    if PHARMACY in normalised and pharmacy_direction not in ("closer", "farther"):
        raise SuitabilityError(
            "Choose whether being closer to or farther from pharmacies is better before enabling that criterion."
        )
    return normalised


def candidate_grid(radius_km: float, max_candidates: int) -> tuple[int, list[tuple[str, Any]], int]:
    """(cell size, [(candidate id, clipped cell in local metres)], dropped edge cells)."""
    radius_m = radius_km * 1000
    try:
        size, _ = coverage.choose_cell_size(radius_m, None, max_cells=max_candidates)
    except coverage.CoverageError as exc:
        raise SuitabilityError(str(exc)) from exc

    grid = coverage.build_grid(radius_m, size)
    minimum = MIN_CELL_FRACTION * size * size
    kept = [(f"c-{cell_id}", cell) for cell_id, cell in grid if cell.area >= minimum]
    return size, kept, len(grid) - len(kept)


def _is_pharmacy(feature: dict[str, Any]) -> bool:
    tags = (feature.get("properties") or {}).get("tags") or {}
    return tags.get("amenity") == "pharmacy" or tags.get("healthcare") == "pharmacy"


def _nearest(points: list[Point], geometries: list[Any]) -> list[float] | None:
    if not geometries:
        return None
    tree = STRtree(geometries)
    (_, _), distances = tree.query_nearest(points, return_distance=True, all_matches=False)
    return [float(d) for d in distances]


def _within_counts(points: list[Point], geometries: list[Any], distance_m: float) -> list[int]:
    counts = [0] * len(points)
    if not geometries:
        return counts
    tree = STRtree(geometries)
    point_index, _ = tree.query(points, predicate="dwithin", distance=distance_m)
    for i in point_index:
        counts[int(i)] += 1
    return counts


def analyse(
    centre: tuple[float, float],
    facility: str,
    radius_km: float,
    existing: dict[str, Any],
    context: dict[str, Any] | None,
    weights: dict[str, Any] | None = None,
    pharmacy_direction: str | None = None,
    existing_saturation_m: float = DEFAULT_EXISTING_SATURATION_M,
    normalization: str = "saturating",
    max_candidates: int = MAX_CANDIDATES,
    context_error: str | None = None,
) -> dict[str, Any]:
    """Measure, score and rank candidate points.

    `existing` / `context` are discovery results (features plus search
    metadata). `context` is None when that search failed; density (and
    pharmacy proximity) are then unavailable, never zero. When the density
    category is the facility's own, `existing` is used for both.
    """
    if not (0 < radius_km <= coverage.MAX_STUDY_RADIUS_KM):
        raise SuitabilityError(
            f"Study radius must be greater than 0 and at most {coverage.MAX_STUDY_RADIUS_KM:g} km."
        )
    if not (MIN_CANDIDATES <= max_candidates <= MAX_CANDIDATES):
        raise SuitabilityError(f"Candidates must be between {MIN_CANDIDATES} and {MAX_CANDIDATES}.")
    if not (MIN_EXISTING_SATURATION_M <= existing_saturation_m <= DEFAULT_EXISTING_SATURATION_M):
        raise SuitabilityError(
            f"The distance saturation must be between {MIN_EXISTING_SATURATION_M} and "
            f"{DEFAULT_EXISTING_SATURATION_M} metres."
        )
    if normalization not in ("saturating", "minmax"):
        raise SuitabilityError("Normalisation must be 'saturating' or 'minmax'.")

    requested = validate_weights(facility, weights, pharmacy_direction)
    config = FACILITIES[facility]
    criteria = criteria_for(facility, pharmacy_direction, existing_saturation_m, normalization)
    if config.density == config.existing:
        context, context_error = existing, None

    projection = coverage.LocalProjection.centred_on(*centre)
    radius_m = radius_km * 1000
    area = coverage.study_area(radius_m)
    cell_size, grid, dropped_cells = candidate_grid(radius_km, max_candidates)

    # Hard constraint: the representative point must lie in the study circle.
    candidates = []
    excluded = 0
    for cid, cell in grid:
        point = cell.representative_point() if not cell.centroid.within(area) else cell.centroid
        if not point.within(area):
            excluded += 1
            continue
        candidates.append((cid, cell, point))
    if not candidates:
        raise SuitabilityError("The study area produced no candidate points.")
    points = [point for _, _, point in candidates]

    kept, geometries, invalid = coverage.project_services(existing["features"], projection)
    existing_margin_m = (existing["search_radius_km"] - radius_km) * 1000
    quality: list[str] = []

    # distance_existing
    distances = _nearest(points, geometries)
    lower_bound = [False] * len(points)
    if distances is None:
        # Nothing mapped within the search: every candidate is at least the
        # search margin away. One uniform lower bound, never a guess.
        distances = [existing_margin_m] * len(points)
        lower_bound = [True] * len(points)
    else:
        for i, point in enumerate(points):
            to_edge = existing["search_radius_km"] * 1000 - point.distance(Point(0, 0))
            if distances[i] > to_edge:
                lower_bound[i] = True
    if existing_margin_m < existing_saturation_m:
        quality.append("The existing-facility search margin is smaller than the distance saturation.")

    # service_gap (reuses the M6 coverage engine for the same study area)
    coverage_data = coverage.analyse(centre, radius_km, existing["features"])
    cov_size = coverage_data["summary"]["cell_size_m"]
    cov_classes = {cell["properties"]["cell_id"]: cell["properties"]["coverage_class"] for cell in coverage_data["cells"]}
    cov_grid = coverage.build_grid(radius_m, cov_size)
    cov_points = [cell.centroid for _, cell in cov_grid]
    cov_weights = [GAP_WEIGHTS[cov_classes[cell_id]] for cell_id, _ in cov_grid]
    cov_tree = STRtree(cov_points)
    near_point, near_cell = cov_tree.query(points, predicate="dwithin", distance=NEIGHBOURHOOD_M)
    gap_sum, gap_n = [0.0] * len(points), [0] * len(points)
    for i, j in zip(near_point, near_cell):
        gap_sum[int(i)] += cov_weights[int(j)]
        gap_n[int(i)] += 1
    gaps = [round(s / n, 2) if n else None for s, n in zip(gap_sum, gap_n)]

    # facility_density and pharmacy_proximity need the context search
    densities: list[int | None] = [None] * len(points)
    pharmacy: list[float | None] = [None] * len(points)
    pharmacy_lower = [False] * len(points)
    context_features: list[dict[str, Any]] = []
    if context is not None:
        context_kept, context_geoms, _ = coverage.project_services(context["features"], projection)
        densities = _within_counts(points, context_geoms, NEIGHBOURHOOD_M)
        if PHARMACY in config.criteria:
            pharmacy_geoms = [g for f, g in zip(context_kept, context_geoms) if _is_pharmacy(f)]
            context_features = [f for f in context_kept if _is_pharmacy(f)]
            nearest = _nearest(points, pharmacy_geoms)
            margin = (context["search_radius_km"] - radius_km) * 1000
            if nearest is None:
                pharmacy, pharmacy_lower = [margin] * len(points), [True] * len(points)
            else:
                pharmacy = nearest
                for i, point in enumerate(points):
                    if nearest[i] > context["search_radius_km"] * 1000 - point.distance(Point(0, 0)):
                        pharmacy_lower[i] = True
        if context["truncated"]:
            quality.append(
                f"{context['label']} discovery was truncated ({context['returned']} of {context['total_found']}); "
                "density near the edge may be undercounted."
            )
    if existing["truncated"]:
        quality.append(
            f"{existing['label']} discovery was truncated ({existing['returned']} of {existing['total_found']}); "
            "distances near the edge may be overestimated."
        )

    rows = []
    for i, (cid, cell, point) in enumerate(candidates):
        values = {
            DISTANCE: round(distances[i], 1),
            GAP: gaps[i],
            DENSITY: densities[i],
            PHARMACY: None if pharmacy[i] is None else round(pharmacy[i], 1),
        }
        rows.append({"id": cid, "values": {k: v for k, v in values.items() if k in config.criteria}})

    try:
        scored = mcda.score_candidates(rows, criteria, requested)
    except mcda.MCDAError as exc:
        raise SuitabilityError(str(exc)) from exc

    geometry = {cid: (cell, point) for cid, cell, point in candidates}
    flags = {cid: {DISTANCE: lower_bound[i], PHARMACY: pharmacy_lower[i]} for i, (cid, _, _) in enumerate(candidates)}
    for entry in scored["ranked"] + scored["unscored"]:
        cell, point = geometry[entry["id"]]
        lon, lat = projection.unproject(point).coords[0]
        entry["lon"], entry["lat"] = round(lon, 6), round(lat, 6)
        entry["cell_area_km2"] = round(cell.area / 1e6, 4)
        for cid, part in entry["criteria"].items():
            part["lower_bound"] = flags[entry["id"]].get(cid, False)
    for entry in scored["ranked"]:
        entry["explanation"] = _explanation(entry, criteria)

    criteria_out = []
    for cid, criterion in criteria.items():
        status = (
            "unavailable" if cid in scored["dropped_criteria"]
            else "used" if cid in scored["weights"]
            else "disabled"
        )
        note = None
        if status == "unavailable":
            note = context_error or "No data was available for this criterion."
        elif cid in scored["normalization_notes"]:
            note = "All candidates had the same value, so this criterion does not separate them."
        criteria_out.append({
            **criterion.public(),
            "status": status,
            "weight": scored["weights"].get(cid, 0.0),
            "requested_weight": scored["requested_weights"].get(cid, 0.0),
            "note": note,
        })
    if scored["dropped_criteria"]:
        quality.append(
            "Unavailable criteria were removed and the remaining weights rescaled: "
            + ", ".join(criteria[c].name for c in scored["dropped_criteria"]) + "."
        )
    if invalid:
        quality.append(f"{invalid} existing facilities without usable geometry were ignored.")

    ranked = scored["ranked"]
    comparison = mcda.compare_pair(ranked[0], ranked[1], criteria) if len(ranked) >= 2 else None

    return {
        "facility": facility,
        "facility_label": config.label,
        "centre": list(centre),
        "radius_km": radius_km,
        "cell_size_m": cell_size,
        "candidate_count": len(candidates),
        "scored_count": len(ranked),
        "unscored_count": len(scored["unscored"]),
        "excluded_by_constraint": excluded,
        "small_edge_cells_dropped": dropped_cells,
        "normalization": normalization,
        "criteria": criteria_out,
        "constraint": {
            "id": CONSTRAINT,
            "name": "Inside the study area",
            "description": f"Hard constraint: candidate points must lie within {radius_km:g} km of the selected location.",
        },
        "weights": scored["weights"],
        "requested_weights": scored["requested_weights"],
        "weight_total": round(sum(scored["weights"].values()), 4),
        "ranked": ranked,
        "unscored": scored["unscored"],
        "top_comparison": comparison,
        "existing_count": len(kept),
        "pharmacy_count": len(context_features) if PHARMACY in config.criteria and context is not None else None,
        "coverage": coverage_data["summary"],
        "data_quality": quality,
        "complete": not quality and not scored["unscored"],
        "_geometry": geometry,
        "_projection": projection,
    }


def _explanation(entry: dict[str, Any], criteria: dict[str, mcda.Criterion]) -> str:
    parts = []
    for cid, part in entry["criteria"].items():
        raw = part["raw"]
        name = criteria[cid].name
        if criteria[cid].unit == "m":
            value = f"{raw / 1000:.2f} km" + ("+" if part["lower_bound"] else "")
        elif criteria[cid].unit == "count":
            value = f"{raw:g}"
        else:
            value = f"{raw:g}/100"
        parts.append(f"{name} {value} → {part['normalized']:g} × {part['weight']:.2f} = {part['contribution']:g}")
    return f"Score {entry['score']:g}: " + "; ".join(parts) + "."


def score_band(score: float | None) -> str:
    if score is None:
        return "unscored"
    if score >= 80:
        return "80-100"
    if score >= 60:
        return "60-80"
    if score >= 40:
        return "40-60"
    if score >= 20:
        return "20-40"
    return "0-20"


def layers(result: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(candidate cell polygons, candidate points) as WGS84 GeoJSON features."""
    projection = result["_projection"]
    cells, points = [], []
    for entry in result["ranked"] + result["unscored"]:
        cell, _ = result["_geometry"][entry["id"]]
        score = entry.get("score")
        props = {
            "candidate_id": entry["id"],
            "rank": entry.get("rank"),
            "suitability_score": score,
            "score_band": score_band(score),
            "scored": score is not None,
            **{
                f"{cid}_score": part["normalized"]
                for cid, part in entry["criteria"].items()
            },
            **{
                f"{cid}_value": part["raw"]
                for cid, part in entry["criteria"].items()
            },
        }
        if score is None:
            props["unscored_reason"] = entry["reason"]
        cells.append({
            "type": "Feature",
            "id": entry["id"],
            "geometry": mapping(projection.unproject(cell)),
            "properties": {**props, "display_name": f"Candidate {entry['id']}"},
        })
        points.append({
            "type": "Feature",
            "id": f"{entry['id']}-pt",
            "geometry": {"type": "Point", "coordinates": [entry["lon"], entry["lat"]]},
            "properties": {**props, "display_name": f"Candidate {entry['id']}"},
        })
    return cells, points


def config() -> dict[str, Any]:
    """Public configuration for the frontend panel."""
    facilities = {}
    for key, facility in FACILITIES.items():
        crit = criteria_for(key)
        facilities[key] = {
            "label": facility.label,
            "existing_category": facility.existing,
            "density_category": facility.density,
            "criteria": [
                {
                    **crit[cid].public(),
                    "default_weight": facility.defaults.get(cid, 0.0),
                    "enabled_by_default": cid in facility.defaults,
                    "direction_required": cid == PHARMACY,
                }
                for cid in facility.criteria
            ],
        }
    return {
        "facilities": facilities,
        "constraint": {
            "id": CONSTRAINT,
            "name": "Inside the study area",
            "description": "Hard constraint: candidates must lie inside the study circle.",
        },
        "limits": {
            "max_radius_km": coverage.MAX_STUDY_RADIUS_KM,
            "default_radius_km": coverage.DEFAULT_STUDY_RADIUS_KM,
            "max_candidates": MAX_CANDIDATES,
            "min_candidates": MIN_CANDIDATES,
            "max_criteria": mcda.MAX_CRITERIA,
            "existing_saturation_m": {
                "min": MIN_EXISTING_SATURATION_M,
                "max": DEFAULT_EXISTING_SATURATION_M,
                "default": DEFAULT_EXISTING_SATURATION_M,
            },
        },
        "normalizations": ["saturating", "minmax"],
        "unsupported_criteria": UNSUPPORTED_CRITERIA,
    }


def unsupported_note(keys: list[str]) -> str | None:
    if not keys:
        return None
    names = [UNSUPPORTED_CRITERIA[k] for k in keys]
    return (
        "Not considered, because GeoMind has no data for it: " + "; ".join(names)
        + ". These factors were not estimated."
    )


def clamp_search_radius(radius_km: float, margin_km: float, category_max_km: float, step_max_km: float) -> float:
    return round(min(radius_km + margin_km, category_max_km, step_max_km), 3)

