from pyproj import Geod, Transformer
from shapely.errors import GEOSException
from shapely.geometry import LineString, Point, Polygon, mapping, shape
from shapely.ops import transform as shapely_transform

geod = Geod(ellps="WGS84")


def polygon_area(coordinates):
    polygon = Polygon(coordinates)

    if polygon.is_empty or not polygon.is_valid:
        raise ValueError("Invalid polygon coordinates.")

    area, _ = geod.geometry_area_perimeter(polygon)

    return {
        "geometry_type": "Polygon",
        "area_square_metres": round(abs(area), 2),
        "area_square_kilometres": round(abs(area) / 1_000_000, 6),
    }


def create_buffer(geometry_type, coordinates, distance_metres):
    if geometry_type == "Point":
        geometry = Point(coordinates)
    elif geometry_type == "LineString":
        geometry = LineString(coordinates)
    else:
        raise ValueError("Only Point and LineString are supported.")

    if geometry.is_empty or not geometry.is_valid:
        raise ValueError("Invalid geometry coordinates.")

    lon, lat = geometry.centroid.x, geometry.centroid.y
    zone = min(60, max(1, int((lon + 180) // 6) + 1))
    epsg = (32600 if lat >= 0 else 32700) + zone

    forward = Transformer.from_crs(
        "EPSG:4326", f"EPSG:{epsg}", always_xy=True
    )
    backward = Transformer.from_crs(
        f"EPSG:{epsg}", "EPSG:4326", always_xy=True
    )

    projected = shapely_transform(forward.transform, geometry)
    result = shapely_transform(
        backward.transform,
        projected.buffer(distance_metres),
    )

    return {
        "geometry_type": "Polygon",
        "distance_metres": distance_metres,
        "geojson": {
            "type": "Feature",
            "geometry": mapping(result),
            "properties": {"buffer_distance_metres": distance_metres},
        },
    }


def point_in_polygon(polygon_coordinates, points):
    polygon = Polygon(polygon_coordinates)

    if polygon.is_empty or not polygon.is_valid:
        raise ValueError("Invalid polygon coordinates.")

    matches = []

    for index, coordinates in enumerate(points):
        if len(coordinates) != 2:
            raise ValueError(f"Point at index {index} must have two coordinates.")

        if polygon.covers(Point(coordinates)):
            matches.append({"index": index, "coordinates": coordinates})

    return {
        "total_points": len(points),
        "points_inside_count": len(matches),
        "points_outside_count": len(points) - len(matches),
        "points_inside": matches,
    }


def spatial_query(features, target_geometry, operation):
    operation = operation.lower().strip()

    if operation not in {"intersects", "within", "contains"}:
        raise ValueError("Use intersects, within, or contains.")

    target = shape(target_geometry)

    if target.is_empty or not target.is_valid:
        raise ValueError("Target geometry is empty or invalid.")

    results = []

    for index, feature in enumerate(features):
        try:
            geometry = shape(feature["geometry"])

            if geometry.is_empty or not geometry.is_valid:
                continue

            matched = {
                "intersects": geometry.intersects(target),
                "within": geometry.within(target),
                "contains": geometry.contains(target),
            }[operation]

            if matched:
                results.append({"index": index, "feature": feature})

        except (KeyError, TypeError, ValueError):
            continue

    return {
        "operation": operation,
        "total_features": len(features),
        "matched_count": len(results),
        "results": results,
    }


def clip_features(features, clip_geometry):
    boundary = shape(clip_geometry)

    if boundary.is_empty or not boundary.is_valid:
        raise ValueError("The clip boundary is empty or invalid.")

    if boundary.geom_type not in ("Polygon", "MultiPolygon"):
        raise ValueError("Clip boundary must be a Polygon or MultiPolygon.")

    results = []
    skipped = 0

    for index, feature in enumerate(features):
        try:
            if not feature.get("geometry"):
                skipped += 1
                continue

            geometry = shape(feature["geometry"])

            if geometry.is_empty or not geometry.is_valid:
                skipped += 1
                continue

            if not geometry.intersects(boundary):
                continue

            clipped = geometry.intersection(boundary)

            if clipped.is_empty:
                continue

            results.append({
                "type": "Feature",
                "id": feature.get("id", index),
                "properties": feature.get("properties") or {},
                "geometry": mapping(clipped),
            })

        except (KeyError, ValueError, TypeError, GEOSException):
            skipped += 1

    return {
        "operation": "clip",
        "input_count": len(features),
        "result_count": len(results),
        "skipped_count": skipped,
        "result": {"type": "FeatureCollection", "features": results},
    }


def spatial_intersection(layer_a_features, layer_b_features):
    results = []
    skipped = 0
    valid_b = []

    for feature in layer_b_features:
        try:
            if not feature.get("geometry"):
                skipped += 1
                continue

            geometry = shape(feature["geometry"])

            if geometry.is_empty or not geometry.is_valid:
                skipped += 1
                continue

            valid_b.append((feature, geometry))

        except (KeyError, ValueError, TypeError, GEOSException):
            skipped += 1

    for index_a, feature_a in enumerate(layer_a_features):
        try:
            if not feature_a.get("geometry"):
                skipped += 1
                continue

            geometry_a = shape(feature_a["geometry"])

            if geometry_a.is_empty or not geometry_a.is_valid:
                skipped += 1
                continue

            for feature_b, geometry_b in valid_b:
                if not geometry_a.intersects(geometry_b):
                    continue

                intersection = geometry_a.intersection(geometry_b)

                if intersection.is_empty:
                    continue

                results.append({
                    "type": "Feature",
                    "properties": {
                        "layer_a_index": index_a,
                        "layer_a_properties": feature_a.get("properties") or {},
                        "layer_b_properties": feature_b.get("properties") or {},
                    },
                    "geometry": mapping(intersection),
                })

        except (KeyError, ValueError, TypeError, GEOSException):
            skipped += 1

    return {
        "operation": "intersection",
        "layer_a_count": len(layer_a_features),
        "layer_b_count": len(layer_b_features),
        "result_count": len(results),
        "skipped_count": skipped,
        "result": {"type": "FeatureCollection", "features": results},
    }


def _validate_origin(coordinates):
    if len(coordinates) != 2:
        raise ValueError("Coordinates must contain longitude and latitude.")

    lon, lat = coordinates

    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise ValueError("Invalid longitude or latitude.")

    return lon, lat


def _feature_distances(coordinates, features):
    """Return (distance_metres, index, feature) for every valid feature.

    Uses an azimuthal equidistant projection centred on the origin, so
    distances measured from the origin are accurate anywhere on Earth.
    """
    lon, lat = _validate_origin(coordinates)

    transformer = Transformer.from_crs(
        "EPSG:4326",
        f"+proj=aeqd +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m",
        always_xy=True,
    )
    origin = Point(0, 0)

    candidates = []

    for index, feature in enumerate(features):
        try:
            if not feature.get("geometry"):
                continue

            geometry = shape(feature["geometry"])

            if geometry.is_empty or not geometry.is_valid:
                continue

            projected = shapely_transform(transformer.transform, geometry)
            candidates.append((origin.distance(projected), index, feature))

        except (AttributeError, KeyError, ValueError, TypeError, GEOSException):
            continue

    return candidates


def nearest_feature(coordinates, features):
    candidates = _feature_distances(coordinates, features)

    if not candidates:
        raise ValueError("No valid features were found.")

    distance, index, feature = min(candidates, key=lambda item: item[0])

    return {
        "origin": {"type": "Point", "coordinates": coordinates},
        "nearest_feature": feature,
        "feature_index": index,
        "distance_metres": round(distance, 2),
        "distance_kilometres": round(distance / 1000, 3),
        "valid_features_checked": len(candidates),
    }


def find_top_nearest_features(
    coordinates: list[float],
    features: list[dict],
    limit: int = 5,
):
    candidates = sorted(
        _feature_distances(coordinates, features),
        key=lambda item: item[0],
    )

    return {
        "origin": {
            "type": "Point",
            "coordinates": coordinates,
        },
        "results": [
            {
                "feature_index": index,
                "feature": feature,
                "distance_metres": round(distance, 2),
                "distance_kilometres": round(distance / 1000, 3),
            }
            for distance, index, feature in candidates[:limit]
        ],
        "valid_features_checked": len(candidates),
    }
