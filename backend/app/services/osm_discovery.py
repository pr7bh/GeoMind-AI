
import httpx
import math

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Reusable OpenStreetMap category definitions.
OSM_CATEGORIES = {
    "hospital": [("amenity", "hospital")],
    "clinic": [("amenity", "clinic")],
    "pharmacy": [("amenity", "pharmacy")],
    "school": [("amenity", "school")],
    "university": [("amenity", "university")],
    "college": [("amenity", "college")],
    "restaurant": [("amenity", "restaurant")],
    "cafe": [("amenity", "cafe")],
    "bank": [("amenity", "bank")],
    "police": [("amenity", "police")],
    "fire_station": [("amenity", "fire_station")],
    "bus_stop": [("highway", "bus_stop")],
    "railway_station": [("railway", "station")],
    "airport": [("aeroway", "aerodrome")],
    "park": [("leisure", "park")],
    "forest": [("landuse", "forest"), ("natural", "wood")],
    "river": [("waterway", "river")],
    "lake": [("natural", "water")],
    "building": [("building", None)],
    "road": [("highway", None)],
}

CATEGORY_ALIASES = {
    "hospitals": "hospital",
    "clinics": "clinic",
    "pharmacies": "pharmacy",
    "schools": "school",
    "universities": "university",
    "colleges": "college",
    "restaurants": "restaurant",
    "cafes": "cafe",
    "banks": "bank",
    "police stations": "police",
    "fire stations": "fire_station",
    "bus stops": "bus_stop",
    "railway stations": "railway_station",
    "stations": "railway_station",
    "airports": "airport",
    "parks": "park",
    "forests": "forest",
    "rivers": "river",
    "lakes": "lake",
    "buildings": "building",
    "roads": "road",
}


def normalize_category(category: str) -> str:
    value = category.lower().strip().replace("-", "_")
    return CATEGORY_ALIASES.get(value, value)


def calculate_distance_km(
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
) -> float:
    earth_radius = 6371.0

    lat1, lon1, lat2, lon2 = map(
        math.radians,
        [lat1, lon1, lat2, lon2],
    )

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1)
        * math.cos(lat2)
        * math.sin(dlon / 2) ** 2
    )

    return earth_radius * 2 * math.atan2(
        math.sqrt(a),
        math.sqrt(1 - a),
    )


def build_overpass_query(
    latitude: float,
    longitude: float,
    radius_metres: int,
    category: str,
) -> str:
    category = normalize_category(category)

    if category not in OSM_CATEGORIES:
        raise ValueError(
            f"Unsupported category: {category}. "
            f"Available categories: {', '.join(OSM_CATEGORIES)}"
        )

    selectors = []

    for key, value in OSM_CATEGORIES[category]:
        tag_filter = f'["{key}"]' if value is None else f'["{key}"="{value}"]'

        selectors.append(
            f"node(around:{radius_metres},{latitude},{longitude}){tag_filter};"
        )
        selectors.append(
            f"way(around:{radius_metres},{latitude},{longitude}){tag_filter};"
        )
        selectors.append(
            f"relation(around:{radius_metres},{latitude},{longitude}){tag_filter};"
        )

    return f"""
    [out:json][timeout:30];
    (
        {"".join(selectors)}
    );
    out center tags;
    """


def discover_features(
    coordinates: list[float],
    category: str,
    radius_km: float = 5,
    limit: int = 500,
) -> dict:
    if len(coordinates) != 2:
        raise ValueError("Coordinates must contain longitude and latitude.")

    longitude, latitude = coordinates

    if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
        raise ValueError("Invalid longitude or latitude.")

    if not (0 < radius_km <= 100):
        raise ValueError("Radius must be greater than 0 and at most 100 km.")

    radius_metres = int(radius_km * 1000)

    query = build_overpass_query(
        latitude,
        longitude,
        radius_metres,
        category,
    )

    try:
        response = httpx.post(
            OVERPASS_URL,
            data={"data": query},
            timeout=40.0,
        )
        response.raise_for_status()
        osm_data = response.json()

    except httpx.TimeoutException as exc:
        raise RuntimeError("OpenStreetMap discovery timed out.") from exc

    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            "OpenStreetMap could not process the discovery request."
        ) from exc

    except httpx.RequestError as exc:
        raise RuntimeError(
            "Unable to connect to OpenStreetMap."
        ) from exc

    features = []

    for element in osm_data.get("elements", []):
        element_lat = element.get("lat")
        element_lon = element.get("lon")

        # Ways and relations can have center coordinates.
        if element_lat is None or element_lon is None:
            center = element.get("center", {})
            element_lat = center.get("lat")
            element_lon = center.get("lon")

        if element_lat is None or element_lon is None:
            continue

        distance_km = calculate_distance_km(
            latitude,
            longitude,
            element_lat,
            element_lon,
        )

        tags = element.get("tags", {})

        features.append({
            "type": "Feature",
            "id": f"{element['type']}/{element['id']}",
            "geometry": {
                "type": "Point",
                "coordinates": [element_lon, element_lat],
            },
            "properties": {
                **tags,
                "osm_id": element["id"],
                "osm_type": element["type"],
                "category": normalize_category(category),
                "name": tags.get("name") or tags.get("name:en"),
                "distance_km": round(distance_km, 3),
            },
        })

    features.sort(
        key=lambda feature: feature["properties"]["distance_km"]
    )

    features = features[:limit]

    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "category": normalize_category(category),
            "radius_km": radius_km,
            "total_found": len(features),
            "source": "OpenStreetMap",
            "center": coordinates,
        },
    }
