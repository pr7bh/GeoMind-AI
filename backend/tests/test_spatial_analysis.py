import math

import pytest
from fastapi.testclient import TestClient
from pyproj import Geod
from shapely.geometry import shape

from app.main import MAX_BODY_BYTES, app
from app.services import spatial_analysis as sa

geod = Geod(ellps="WGS84")


def point(lon, lat, **properties):
    return {
        "type": "Feature",
        "properties": properties,
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
    }


def square(x0, y0, size, **properties):
    ring = [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]
    return {
        "type": "Feature",
        "properties": properties,
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }


# polygon_area

def test_polygon_area_one_degree_square_at_equator():
    ring = square(0, 0, 1)["geometry"]["coordinates"][0]
    result = sa.polygon_area(ring)

    assert result["area_square_kilometres"] == pytest.approx(12_308.8, rel=1e-3)


def test_polygon_area_rejects_self_intersecting_ring():
    with pytest.raises(ValueError):
        sa.polygon_area([[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]])


# create_buffer

def test_point_buffer_area_matches_circle():
    result = sa.create_buffer("Point", [-0.1276, 51.5072], 1000)
    area, _ = geod.geometry_area_perimeter(shape(result["geojson"]["geometry"]))

    assert abs(area) == pytest.approx(math.pi * 1000**2, rel=0.01)


def test_buffer_rejects_unsupported_geometry():
    with pytest.raises(ValueError):
        sa.create_buffer("Polygon", [[0, 0], [1, 0], [1, 1], [0, 0]], 100)


# point_in_polygon

def test_point_in_polygon_counts_inside_and_boundary_points():
    ring = square(0, 0, 10)["geometry"]["coordinates"][0]
    result = sa.point_in_polygon(ring, [[5, 5], [0, 5], [20, 20]])

    assert result["points_inside_count"] == 2
    assert result["points_outside_count"] == 1
    assert [p["index"] for p in result["points_inside"]] == [0, 1]


# spatial_query

def test_spatial_query_within_and_intersects():
    target = square(0, 0, 10)["geometry"]
    features = [square(1, 1, 2), square(8, 8, 5), square(50, 50, 1)]

    within = sa.spatial_query(features, target, "within")
    intersects = sa.spatial_query(features, target, "Intersects ")

    assert [r["index"] for r in within["results"]] == [0]
    assert [r["index"] for r in intersects["results"]] == [0, 1]


def test_spatial_query_rejects_unknown_operation():
    with pytest.raises(ValueError):
        sa.spatial_query([], square(0, 0, 1)["geometry"], "touches")


# clip_features

def test_clip_cuts_line_to_boundary():
    line = {
        "type": "Feature",
        "properties": {"name": "road"},
        "geometry": {"type": "LineString", "coordinates": [[-5, 5], [15, 5]]},
    }
    result = sa.clip_features([line, {"geometry": None}], square(0, 0, 10)["geometry"])

    clipped = result["result"]["features"][0]["geometry"]
    assert clipped["coordinates"] == ((0.0, 5.0), (10.0, 5.0))
    assert result["skipped_count"] == 1


def test_clip_requires_polygon_boundary():
    with pytest.raises(ValueError):
        sa.clip_features([], {"type": "Point", "coordinates": [0, 0]})


# spatial_intersection

def test_intersection_returns_only_overlaps_in_layer_b_order():
    layer_a = [square(0, 0, 10, name="a")]
    layer_b = [
        square(5, 5, 10, name="b0"),
        square(100, 100, 1, name="far"),
        square(-5, -5, 10, name="b2"),
    ]
    result = sa.spatial_intersection(layer_a, layer_b)

    names = [
        f["properties"]["layer_b_properties"]["name"]
        for f in result["result"]["features"]
    ]
    assert names == ["b0", "b2"]
    assert shape(result["result"]["features"][0]["geometry"]).area == pytest.approx(25)


def test_intersection_counts_invalid_features_as_skipped():
    result = sa.spatial_intersection([{"geometry": None}], [square(0, 0, 1), {}])

    assert result["result_count"] == 0
    assert result["skipped_count"] == 2


# nearest_feature / find_top_nearest_features

ORIGIN_TARGET_PAIRS = [
    ([-0.1276, 51.5072], [2.3522, 48.8566]),       # London -> Paris
    ([151.2093, -33.8688], [174.7633, -36.8485]),  # Sydney -> Auckland
    ([-74.006, 40.7128], [-118.2437, 34.0522]),    # New York -> Los Angeles
    ([179.9, 0], [-179.9, 0]),                     # across the antimeridian
]


@pytest.mark.parametrize("origin,target", ORIGIN_TARGET_PAIRS)
def test_nearest_distances_match_geodesic_worldwide(origin, target):
    expected = geod.inv(*origin, *target)[2]
    features = [point(*target)]

    single = sa.nearest_feature(origin, features)
    top = sa.find_top_nearest_features(origin, features)

    assert single["distance_metres"] == pytest.approx(expected, rel=1e-4)
    assert top["results"][0]["distance_metres"] == pytest.approx(expected, rel=1e-4)


def test_top_nearest_sorts_limits_and_skips_invalid():
    features = [point(0, 3), {"geometry": None}, point(0, 1), point(0, 2)]
    result = sa.find_top_nearest_features([0, 0], features, limit=2)

    assert [r["feature_index"] for r in result["results"]] == [2, 3]
    assert result["valid_features_checked"] == 3


def test_nearest_to_polygon_measures_to_edge():
    result = sa.nearest_feature([0, 0], [square(1, -1, 2)])
    expected = geod.inv(0, 0, 1, 0)[2]

    assert result["distance_metres"] == pytest.approx(expected, rel=1e-3)


def test_nearest_rejects_invalid_origin_and_empty_input():
    with pytest.raises(ValueError):
        sa.nearest_feature([200, 0], [point(0, 0)])

    with pytest.raises(ValueError):
        sa.nearest_feature([0, 0], [{"geometry": None}])


# API payload limits

client = TestClient(app)


def test_oversized_body_is_rejected_with_413():
    response = client.post(
        "/api/analysis/clip",
        content=b"{}",
        headers={
            "content-type": "application/json",
            "content-length": str(MAX_BODY_BYTES + 1),
        },
    )

    assert response.status_code == 413


def test_too_many_features_is_rejected_with_422():
    from app.schemas import analysis

    payload = {"coordinates": [0, 0], "features": [point(0, 0)] * (analysis.MAX_FEATURES + 1)}
    response = client.post("/api/analysis/nearest-features", json=payload)

    assert response.status_code == 422
