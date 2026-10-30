"""Source-to-nearby relationships (e.g. hospitals to pharmacies) and ranking.

Identity is the OSM element ("node/123"), so a pharmacy near several
hospitals is counted once in the distinct total but once per hospital in
the per-hospital relationship counts.
"""

from dataclasses import dataclass, field
from typing import Any

from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.ops import transform

from app.services.spatial_analysis import _feature_distances


@dataclass
class Source:
    id: str
    name: str
    feature: dict[str, Any]
    distance_km: float | None
    point: tuple[float, float] | None = None  # representative (lon, lat)
    extent_m: float = 0.0  # farthest geometry point from `point`
    status: str = "pending"  # pending | searched | failed | skipped
    reason: str | None = None
    truncated: bool = False
    matches: list[dict[str, Any]] = field(default_factory=list)
    limit_reached: bool = False


def feature_id(feature: dict[str, Any]) -> str | None:
    props = feature.get("properties") or {}
    if feature.get("id"):
        return str(feature["id"])
    if props.get("osm_type") and props.get("osm_id") is not None:
        return f"{props['osm_type']}/{props['osm_id']}"
    return None


def _name(feature: dict[str, Any]) -> str:
    props = feature.get("properties") or {}
    return str(props.get("display_name") or props.get("name") or "Unnamed")


def prepare_sources(features: list[dict[str, Any]]) -> list[Source]:
    """Representative point and extent for each source; unusable ones are skipped."""
    sources = []

    for index, feature in enumerate(features):
        source = Source(
            id=feature_id(feature) or f"source/{index}",
            name=_name(feature),
            feature=feature,
            distance_km=(feature.get("properties") or {}).get("distance_km"),
        )
        sources.append(source)

        try:
            geometry = shape(feature["geometry"]) if feature.get("geometry") else None
        except (KeyError, TypeError, ValueError):
            geometry = None

        if geometry is None or geometry.is_empty:
            source.status = "skipped"
            source.reason = "No usable geometry in OpenStreetMap."
            continue

        rep = geometry if geometry.geom_type == "Point" else geometry.representative_point()
        source.point = (rep.x, rep.y)

        if geometry.geom_type != "Point":
            to_local = Transformer.from_crs(
                "EPSG:4326",
                f"+proj=aeqd +lat_0={rep.y} +lon_0={rep.x} +datum=WGS84 +units=m",
                always_xy=True,
            )
            source.extent_m = Point(0, 0).hausdorff_distance(transform(to_local.transform, geometry))

    return sources


def relate(
    sources: list[Source],
    candidates: list[dict[str, Any]],
    radius_m: float,
    per_source_limit: int,
    max_total: int,
) -> tuple[list[dict[str, Any]], bool]:
    """Attach nearby candidates to searched sources.

    Distance is measured from each candidate's representative point to the
    source's actual geometry. Returns (retained distinct candidates,
    global_limit_reached).
    """
    searched = [s for s in sources if s.status == "searched"]
    unique: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        key = feature_id(candidate)
        if key and key not in unique:
            unique[key] = candidate

    pairs: list[tuple[float, str, Source]] = []
    for key, candidate in unique.items():
        try:
            geometry = shape(candidate["geometry"])
        except (KeyError, TypeError, ValueError):
            continue
        if geometry.is_empty:
            continue
        point = geometry if geometry.geom_type == "Point" else geometry.representative_point()
        for distance, index, _ in _feature_distances(
            [point.x, point.y], [s.feature for s in searched]
        ):
            if distance <= radius_m:
                pairs.append((distance, key, searched[index]))

    # Closest relationships first, so both caps keep the nearest candidates
    # and every retained candidate belongs to at least one source.
    pairs.sort(key=lambda pair: pair[0])
    retained: dict[str, dict[str, Any]] = {}
    global_limit_reached = False
    for distance, key, source in pairs:
        if len(source.matches) >= per_source_limit:
            source.limit_reached = True
            continue
        if key not in retained:
            if len(retained) >= max_total:
                global_limit_reached = True
                continue
            retained[key] = unique[key]
        source.matches.append({
            "id": key,
            "name": _name(unique[key]),
            "distance_m": round(distance, 1),
        })

    return list(retained.values()), global_limit_reached


def rank(sources: list[Source]) -> list[dict[str, Any]]:
    """Competition ranking ("1, 1, 3") by distinct nearby count."""
    searched = [s for s in sources if s.status == "searched"]
    counts = {s.id: len({m["id"] for m in s.matches}) for s in searched}
    ordered = sorted(
        searched,
        key=lambda s: (-counts[s.id], s.distance_km if s.distance_km is not None else 1e9, s.name),
    )

    ranking = []
    for source in ordered:
        count = counts[source.id]
        ranking.append({
            "rank": 1 + sum(1 for c in counts.values() if c > count),
            "tied": sum(1 for c in counts.values() if c == count) > 1,
            "id": source.id,
            "name": source.name,
            "distance_km": source.distance_km,
            "nearby_count": count,
            "relationship_count": len(source.matches),
            # Counts are lower bounds when a cap or server truncation applied.
            "count_is_lower_bound": source.limit_reached or source.truncated,
            "nearest_m": source.matches[0]["distance_m"] if source.matches else None,
            "nearby": source.matches,
        })

    return ranking
