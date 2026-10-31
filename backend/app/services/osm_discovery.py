"""Real-world feature discovery from OpenStreetMap via the Overpass API."""

import asyncio
import logging
import os
from typing import Any

import httpx
from shapely import make_valid
from shapely.geometry import LineString, MultiLineString, Point, Polygon, mapping
from shapely.geometry.base import BaseGeometry
from shapely.ops import polygonize, unary_union

from app.services.spatial_analysis import _feature_distances, _validate_origin

logger = logging.getLogger(__name__)

# Public Overpass instances, tried in order when one is unreachable or busy.
# OVERPASS_URL may override this with one URL or a comma-separated list.
# (Mirrors that accept connections but then hang are left out: a hang costs
# the full read timeout and is not retried elsewhere.)
DEFAULT_OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
)


def parse_overpass_urls(value: str | None) -> tuple[str, ...]:
    return tuple(url.strip() for url in (value or "").split(",") if url.strip()) or DEFAULT_OVERPASS_URLS


OVERPASS_URLS = parse_overpass_urls(os.getenv("OVERPASS_URL"))
USER_AGENT = "GeoMind-AI/0.2"
REQUEST_TIMEOUT_SECONDS = 55.0
# Unreachable instances fail fast so the next one can be tried.
CONNECT_TIMEOUT_SECONDS = 10.0
# Public instances are often briefly saturated: when every instance is busy
# or unreachable, pause and try them all again (bounded; slow queries that
# time out are never repeated).
BUSY_RETRY_DELAYS = (2.0, 5.0)
QUERY_TIMEOUT_SECONDS = 30
# Hard cap on elements Overpass may return for one query.
MAX_ELEMENTS = 3000
MAX_RADIUS_KM = 50.0

SOURCE = "OpenStreetMap (Overpass API)"
ATTRIBUTION = "© OpenStreetMap contributors, ODbL"
COVERAGE_NOTE = (
    "Only features mapped in OpenStreetMap are included. "
    "Coverage varies by region and may be incomplete."
)


def _category(
    label: str,
    group: str,
    selectors: list[str],
    max_radius_km: float = MAX_RADIUS_KM,
) -> dict[str, Any]:
    return {
        "label": label,
        "group": group,
        "selectors": selectors,
        "max_radius_km": max_radius_km,
    }


# Each selector is an Overpass element filter; "nwr" = nodes, ways, relations.
OSM_CATEGORIES: dict[str, dict[str, Any]] = {
    # Healthcare
    "hospital": _category("Hospitals", "healthcare", [
        'nwr["amenity"="hospital"]', 'nwr["healthcare"="hospital"]',
    ]),
    "clinic": _category("Clinics", "healthcare", [
        'nwr["amenity"="clinic"]', 'nwr["healthcare"="clinic"]',
    ]),
    "doctors": _category("Doctors", "healthcare", [
        'nwr["amenity"="doctors"]', 'nwr["healthcare"="doctor"]',
    ]),
    "dentist": _category("Dentists", "healthcare", [
        'nwr["amenity"="dentist"]', 'nwr["healthcare"="dentist"]',
    ]),
    "pharmacy": _category("Pharmacies", "healthcare", [
        'nwr["amenity"="pharmacy"]', 'nwr["healthcare"="pharmacy"]',
    ]),
    "healthcare": _category("All healthcare facilities", "healthcare", [
        'nwr["amenity"~"^(hospital|clinic|doctors|dentist|pharmacy)$"]',
        'nwr["healthcare"]',
    ]),
    # Education
    "school": _category("Schools", "education", ['nwr["amenity"="school"]']),
    "university": _category(
        "Universities", "education", ['nwr["amenity"="university"]']
    ),
    "college": _category("Colleges", "education", ['nwr["amenity"="college"]']),
    "kindergarten": _category(
        "Kindergartens", "education", ['nwr["amenity"="kindergarten"]']
    ),
    "education": _category("All education facilities", "education", [
        'nwr["amenity"~"^(school|university|college|kindergarten)$"]',
    ]),
    # Transportation
    "bus_stop": _category("Bus stops", "transportation", [
        'node["highway"="bus_stop"]',
    ], max_radius_km=10),
    "railway_station": _category("Railway stations", "transportation", [
        'nwr["railway"~"^(station|halt)$"]',
    ]),
    "airport": _category("Airports", "transportation", [
        'nwr["aeroway"="aerodrome"]',
    ]),
    "fuel": _category("Fuel stations", "transportation", [
        'nwr["amenity"="fuel"]',
    ]),
    "parking": _category("Parking", "transportation", [
        'nwr["amenity"="parking"]',
    ], max_radius_km=10),
    "road": _category("Roads", "transportation", [
        (
            'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|'
            'unclassified|residential|living_street|service|'
            '(motorway|trunk|primary|secondary|tertiary)_link)$"]'
        ),
    ], max_radius_km=5),
    "major_road": _category("Major roads", "transportation", [
        'way["highway"~"^(motorway|trunk|primary|secondary)(_link)?$"]',
    ], max_radius_km=20),
    # Built environment
    "building": _category("Buildings", "built_environment", [
        'way["building"]', 'relation["building"]',
    ], max_radius_km=2),
    "government": _category("Government facilities", "built_environment", [
        'nwr["office"="government"]',
        'nwr["amenity"~"^(townhall|courthouse)$"]',
    ]),
    "post_office": _category("Post offices", "built_environment", [
        'nwr["amenity"="post_office"]',
    ]),
    # Emergency services
    "police": _category("Police stations", "emergency", [
        'nwr["amenity"="police"]',
    ]),
    "fire_station": _category("Fire stations", "emergency", [
        'nwr["amenity"="fire_station"]',
    ]),
    # Food, lodging and finance
    "restaurant": _category("Restaurants", "food", [
        'nwr["amenity"="restaurant"]',
    ], max_radius_km=20),
    "cafe": _category("Cafés", "food", ['nwr["amenity"="cafe"]'], max_radius_km=20),
    "fast_food": _category("Fast food", "food", [
        'nwr["amenity"="fast_food"]',
    ], max_radius_km=20),
    "hotel": _category("Hotels and lodging", "tourism", [
        'nwr["tourism"~"^(hotel|motel|guest_house|hostel)$"]',
    ]),
    "bank": _category("Banks", "finance", ['nwr["amenity"="bank"]']),
    "atm": _category("ATMs", "finance", ['nwr["amenity"="atm"]'], max_radius_km=20),
    # Tourism
    "tourism": _category("Tourist attractions", "tourism", [
        'nwr["tourism"~"^(attraction|museum|viewpoint|zoo|theme_park|gallery)$"]',
    ]),
    # Utilities
    "utilities": _category("Utilities", "utilities", [
        'nwr["power"~"^(plant|substation)$"]',
        'nwr["man_made"~"^(water_tower|water_works|wastewater_plant)$"]',
    ]),
    "power_line": _category("Power lines", "utilities", [
        'way["power"~"^(line|minor_line)$"]',
    ], max_radius_km=20),
    # Nature and land use
    "park": _category("Parks", "nature", ['nwr["leisure"="park"]']),
    "forest": _category("Forests and woodland", "nature", [
        'nwr["landuse"="forest"]', 'nwr["natural"="wood"]',
    ], max_radius_km=20),
    "river": _category("Rivers and canals", "water", [
        'way["waterway"~"^(river|canal)$"]',
        'relation["waterway"~"^(river|canal)$"]',
    ], max_radius_km=30),
    "stream": _category("Streams", "water", [
        'way["waterway"="stream"]',
    ], max_radius_km=10),
    "lake": _category("Lakes and water bodies", "water", [
        'nwr["natural"="water"]',
    ], max_radius_km=30),
    "landuse": _category("Land use", "land_use", [
        'way["landuse"]', 'relation["landuse"]',
    ], max_radius_km=5),
}

CATEGORY_ALIASES = {
    "hospitals": "hospital",
    "health": "healthcare",
    "health_facility": "healthcare",
    "medical": "healthcare",
    "doctor": "doctors",
    "pharmacies": "pharmacy",
    "chemist": "pharmacy",
    "schools": "school",
    "universities": "university",
    "colleges": "college",
    "station": "railway_station",
    "stations": "railway_station",
    "train_station": "railway_station",
    "train_stations": "railway_station",
    "railway_stations": "railway_station",
    "bus_stops": "bus_stop",
    "airports": "airport",
    "gas_station": "fuel",
    "petrol_station": "fuel",
    "roads": "road",
    "street": "road",
    "streets": "road",
    "highway": "major_road",
    "highways": "major_road",
    "buildings": "building",
    "government_office": "government",
    "police_station": "police",
    "police_stations": "police",
    "fire_stations": "fire_station",
    "restaurants": "restaurant",
    "cafes": "cafe",
    "hotels": "hotel",
    "lodging": "hotel",
    "banks": "bank",
    "atms": "atm",
    "tourist_attraction": "tourism",
    "tourist_attractions": "tourism",
    "attractions": "tourism",
    "utility": "utilities",
    "parks": "park",
    "forests": "forest",
    "woods": "forest",
    "woodland": "forest",
    "rivers": "river",
    "canal": "river",
    "streams": "stream",
    "lakes": "lake",
    "water": "lake",
    "water_body": "lake",
    "land_use": "landuse",
}

# Tags that make a closed way an area, even when it also carries a linear
# tag (e.g. a park with barrier=wall). Closed ways without one, such as
# highway roundabouts, stay lines.
AREA_KEYS = {
    "building", "landuse", "leisure", "natural", "amenity", "aeroway",
    "tourism", "shop", "office", "healthcare", "historic", "man_made",
    "military", "place", "public_transport", "water", "sport",
}
LINEAR_NATURAL = {"coastline", "tree_row", "cliff", "ridge"}


class OverpassError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def normalize_category(category: str) -> str:
    value = "_".join(category.lower().replace("-", " ").split())
    candidates = [value, CATEGORY_ALIASES.get(value, value)]

    if value.endswith("ies"):
        candidates.append(value[:-3] + "y")
    if value.endswith("es"):
        candidates.append(value[:-2])
    if value.endswith("s"):
        candidates.append(value[:-1])

    for candidate in candidates:
        if candidate in OSM_CATEGORIES:
            return candidate

    raise ValueError(
        f"Unsupported category: {category}. "
        f"Available categories: {', '.join(OSM_CATEGORIES)}"
    )


def list_categories() -> list[dict[str, Any]]:
    return [
        {
            "id": name,
            "label": spec["label"],
            "group": spec["group"],
            "max_radius_km": spec["max_radius_km"],
        }
        for name, spec in OSM_CATEGORIES.items()
    ]


def build_overpass_query(
    latitude: float,
    longitude: float,
    radius_metres: int,
    category: str,
) -> str:
    return build_union_query([(longitude, latitude, radius_metres)], category)


def build_union_query(
    centres: list[tuple[float, float, int]],
    category: str,
) -> str:
    """One query for features within each (lon, lat, radius_m) circle."""
    statements = "".join(
        f"{selector}(around:{radius},{lat},{lon});"
        for lon, lat, radius in centres
        for selector in OSM_CATEGORIES[category]["selectors"]
    )

    return (
        f"[out:json][timeout:{QUERY_TIMEOUT_SECONDS}];"
        f"({statements});"
        f"out geom {MAX_ELEMENTS};"
    )


def _coords(points: list[dict[str, float] | None] | None) -> list[tuple[float, float]]:
    # Overpass emits null for nodes it could not resolve.
    return [(p["lon"], p["lat"]) for p in points or [] if p]


def _is_area(tags: dict[str, str], coords: list[tuple[float, float]]) -> bool:
    if len(coords) < 4 or coords[0] != coords[-1]:
        return False

    if tags.get("area") in ("yes", "no"):
        return tags["area"] == "yes"

    if tags.get("natural") in LINEAR_NATURAL:
        return False

    if tags.get("waterway") in ("riverbank", "dock"):
        return True

    return any(key in tags for key in AREA_KEYS)


def _relation_geometry(element: dict[str, Any]) -> BaseGeometry | None:
    outer: list[LineString] = []
    inner: list[LineString] = []

    for member in element.get("members", []):
        coords = _coords(member.get("geometry"))

        if member.get("type") != "way" or len(coords) < 2:
            continue

        (inner if member.get("role") == "inner" else outer).append(
            LineString(coords)
        )

    if not outer:
        return None

    if element.get("tags", {}).get("type") in ("multipolygon", "boundary"):
        polygons = list(polygonize(unary_union(outer)))

        if polygons:
            geometry = unary_union(polygons)

            if inner:
                holes = list(polygonize(unary_union(inner)))
                geometry = geometry.difference(unary_union(holes))

            return geometry

    return MultiLineString(outer + inner)


def _element_geometry(element: dict[str, Any]) -> BaseGeometry | None:
    element_type = element.get("type")

    if element_type == "node":
        if "lat" not in element or "lon" not in element:
            return None
        return Point(element["lon"], element["lat"])

    if element_type == "way":
        coords = _coords(element.get("geometry"))

        if len(coords) < 2:
            return None

        if _is_area(element.get("tags", {}), coords):
            return Polygon(coords)

        return LineString(coords)

    if element_type == "relation":
        return _relation_geometry(element)

    return None


def _clean_geometry(geometry: BaseGeometry) -> BaseGeometry | None:
    if not geometry.is_valid:
        geometry = make_valid(geometry)

    # make_valid can produce mixed collections; keep the highest dimension.
    if geometry.geom_type == "GeometryCollection":
        for wanted in (("Polygon", "MultiPolygon"), ("LineString", "MultiLineString")):
            parts = [g for g in geometry.geoms if g.geom_type in wanted]
            if parts:
                geometry = unary_union(parts)
                break
        else:
            return None

    return None if geometry.is_empty else geometry


def _format_address(tags: dict[str, str]) -> str | None:
    street = " ".join(
        part for part in (tags.get("addr:housenumber"), tags.get("addr:street")) if part
    )
    locality = " ".join(
        part for part in (tags.get("addr:city"), tags.get("addr:postcode")) if part
    )
    address = ", ".join(part for part in (street, locality) if part)

    return address or tags.get("addr:full")


def _to_feature(element: dict[str, Any], category: str) -> dict[str, Any] | None:
    geometry = _element_geometry(element)

    if geometry is None:
        return None

    geometry = _clean_geometry(geometry)

    if geometry is None:
        return None

    tags = element.get("tags", {})
    name = tags.get("name") or tags.get("name:en")
    osm_type = element["type"]
    osm_id = element["id"]

    return {
        "type": "Feature",
        "id": f"{osm_type}/{osm_id}",
        "geometry": mapping(geometry),
        "properties": {
            "name": name,
            "display_name": name or f"Unnamed {category.replace('_', ' ')}",
            "category": category,
            "address": _format_address(tags),
            "osm_type": osm_type,
            "osm_id": osm_id,
            "osm_url": f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
            "source": SOURCE,
            # Raw OSM tags, kept separate so none are overwritten.
            "tags": tags,
        },
    }


async def _post_with_fallback(client: httpx.AsyncClient, query: str) -> httpx.Response:
    """POST to each Overpass instance in turn until one answers.

    Falls over only when an instance is unreachable or busy (429/502-504);
    if all of them are, waits briefly and tries them all again. A read
    timeout is not retried: the query itself is too heavy.
    """
    error: OverpassError | None = None

    for attempt, delay in enumerate((0.0, *BUSY_RETRY_DELAYS)):
        if delay:
            logger.warning("All Overpass instances busy; retrying in %.0f s", delay)
            await asyncio.sleep(delay)
        for url in OVERPASS_URLS:
            try:
                response = await client.post(url, data={"data": query})
            except httpx.ConnectTimeout as exc:
                error = OverpassError("Unable to connect to the Overpass API.", 502)
                error.__cause__ = exc
            except httpx.TimeoutException as exc:
                raise OverpassError(
                    "OpenStreetMap discovery timed out. Try a smaller radius.", 504
                ) from exc
            except httpx.RequestError as exc:
                error = OverpassError("Unable to connect to the Overpass API.", 502)
                error.__cause__ = exc
            else:
                # 429 is rate limiting; 502-504 mean the instance is overloaded.
                if response.status_code not in (429, 502, 503, 504):
                    return response
                error = OverpassError("The Overpass API is busy. Please retry in a moment.", 503)

            logger.warning("Overpass instance %s failed (%s, attempt %d)", httpx.URL(url).host, error, attempt + 1)

    assert error is not None
    raise error


async def _fetch_overpass(
    query: str,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    owns_client = client is None
    client = client or httpx.AsyncClient(
        timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=CONNECT_TIMEOUT_SECONDS),
        headers={"User-Agent": USER_AGENT},
    )

    try:
        response = await _post_with_fallback(client, query)
    finally:
        if owns_client:
            await client.aclose()

    if response.status_code >= 400:
        raise OverpassError(
            f"The Overpass API rejected the request ({response.status_code}).", 502
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise OverpassError("The Overpass API returned an invalid response.", 502) from exc

    # Server-side failures arrive as HTTP 200 with partial data and a remark.
    remark = data.get("remark") or ""
    if "runtime error" in remark.lower():
        logger.warning("Overpass runtime error: %s", remark)
        raise OverpassError(
            "OpenStreetMap could not complete this query. Try a smaller radius.", 504
        )

    return data


def _elements_to_features(
    elements: list[dict[str, Any]],
    category: str,
) -> tuple[list[dict[str, Any]], int]:
    """Convert Overpass elements, dropping duplicates and unusable geometry."""
    features = []
    seen: set[tuple[str, int]] = set()
    skipped = 0

    for element in elements:
        key = (element.get("type"), element.get("id"))

        if key in seen:
            continue
        seen.add(key)

        feature = _to_feature(element, category)

        if feature is None:
            skipped += 1
            continue

        features.append(feature)

    return features, skipped


async def discover_features_near(
    centres: list[tuple[float, float, int]],
    category: str,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Features of one category near several points, in a single request.

    Distances are left to the caller, which knows what each point stands for.
    """
    category = normalize_category(category)

    for lon, lat, radius in centres:
        _validate_origin([lon, lat])
        if not (0 < radius <= OSM_CATEGORIES[category]["max_radius_km"] * 1000):
            raise ValueError("Search radius is out of range for this category.")

    osm_data = await _fetch_overpass(build_union_query(centres, category), client)
    elements = osm_data.get("elements", [])
    features, skipped = _elements_to_features(elements, category)

    return {
        "features": features,
        "server_limit_reached": len(elements) >= MAX_ELEMENTS,
        "skipped_without_geometry": skipped,
        "osm_base": osm_data.get("osm3s", {}).get("timestamp_osm_base"),
    }


async def discover_features(
    coordinates: list[float],
    category: str,
    radius_km: float = 5,
    limit: int = 200,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    longitude, latitude = _validate_origin(coordinates)
    category = normalize_category(category)
    spec = OSM_CATEGORIES[category]

    if not (0 < radius_km <= spec["max_radius_km"]):
        raise ValueError(
            f"Radius for {category} must be greater than 0 and at most "
            f"{spec['max_radius_km']:g} km."
        )

    query = build_overpass_query(
        latitude, longitude, int(radius_km * 1000), category
    )
    osm_data = await _fetch_overpass(query, client)
    elements = osm_data.get("elements", [])
    features, skipped = _elements_to_features(elements, category)

    distances = {
        index: distance
        for distance, index, _ in _feature_distances([longitude, latitude], features)
    }

    for index, feature in enumerate(features):
        distance = distances.get(index)
        feature["properties"]["distance_km"] = (
            None if distance is None else round(distance / 1000, 3)
        )

    features.sort(
        key=lambda f: (
            f["properties"]["distance_km"] is None,
            f["properties"]["distance_km"] or 0,
        )
    )
    returned = features[:limit]
    server_limit_reached = len(elements) >= MAX_ELEMENTS

    logger.info(
        "Discovered %d %s features within %.2f km of %.5f,%.5f",
        len(features), category, radius_km, latitude, longitude,
    )

    return {
        "type": "FeatureCollection",
        "features": returned,
        "metadata": {
            "category": category,
            "label": spec["label"],
            "center": [longitude, latitude],
            "radius_km": radius_km,
            "total_found": len(features),
            "returned": len(returned),
            "truncated": server_limit_reached or len(features) > limit,
            "server_limit_reached": server_limit_reached,
            "skipped_without_geometry": skipped,
            "geometry_types": sorted({f["geometry"]["type"] for f in returned}),
            "source": SOURCE,
            "attribution": ATTRIBUTION,
            "osm_base": osm_data.get("osm3s", {}).get("timestamp_osm_base"),
            "coverage_note": COVERAGE_NOTE,
        },
    }
