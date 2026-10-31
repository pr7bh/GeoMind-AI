import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from shapely.geometry import shape

from app.main import app
from app.services import osm_discovery as od

CENTER = [77.2090, 28.6139]  # [lon, lat]


def node(osm_id, lon, lat, **tags):
    return {"type": "node", "id": osm_id, "lon": lon, "lat": lat, "tags": tags}


def way(osm_id, coords, **tags):
    return {
        "type": "way",
        "id": osm_id,
        "geometry": [{"lon": x, "lat": y} for x, y in coords],
        "tags": tags,
    }


def ring(x0, y0, size):
    return [(x0, y0), (x0 + size, y0), (x0 + size, y0 + size), (x0, y0 + size), (x0, y0)]


def overpass_client(payload=None, status=200, exc=None, captured=None):
    def handler(request: httpx.Request):
        if captured is not None:
            captured.append(request)
        if exc:
            raise exc
        body = payload if isinstance(payload, (bytes, str)) else json.dumps(payload or {})
        return httpx.Response(status, content=body)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def discover(elements, category="hospital", **kwargs):
    payload = {"osm3s": {"timestamp_osm_base": "2026-10-30T00:00:00Z"}, "elements": elements}
    return asyncio.run(
        od.discover_features(CENTER, category, client=overpass_client(payload), **kwargs)
    )


# Categories and queries

@pytest.mark.parametrize("raw,expected", [
    ("Hospitals", "hospital"),
    ("pharmacies", "pharmacy"),
    ("police stations", "police"),
    ("fire-stations", "fire_station"),
    ("train station", "railway_station"),
    ("Rivers", "river"),
    ("woods", "forest"),
    ("land use", "landuse"),
    ("restaurants", "restaurant"),
])
def test_normalize_category(raw, expected):
    assert od.normalize_category(raw) == expected


def test_unknown_category_lists_available_options():
    with pytest.raises(ValueError, match="Available categories"):
        od.normalize_category('hospital"];out;')


def test_every_category_builds_a_query():
    for name in od.OSM_CATEGORIES:
        query = od.build_overpass_query(28.6, 77.2, 1000, name)
        assert query.startswith("[out:json]")
        assert "(around:1000,28.6,77.2)" in query
        assert query.endswith(f"out geom {od.MAX_ELEMENTS};")


def test_query_sent_to_overpass_uses_category_selectors():
    captured = []
    client = overpass_client({"elements": []}, captured=captured)
    asyncio.run(od.discover_features(CENTER, "school", radius_km=2, client=client))

    sent = httpx.QueryParams(captured[0].content.decode())["data"]
    assert 'nwr["amenity"="school"](around:2000,28.6139,77.209);' in sent


# Geometry conversion

def test_node_becomes_point_and_tags_are_preserved():
    result = discover([node(1, 77.21, 28.62, amenity="hospital", source="survey")])
    feature = result["features"][0]

    assert feature["id"] == "node/1"
    assert feature["geometry"] == {"type": "Point", "coordinates": (77.21, 28.62)}
    assert feature["properties"]["tags"] == {"amenity": "hospital", "source": "survey"}
    assert feature["properties"]["source"] == od.SOURCE
    assert feature["properties"]["osm_url"] == "https://www.openstreetmap.org/node/1"


def test_unnamed_feature_without_address():
    props = discover([node(1, 77.21, 28.62, amenity="hospital")])["features"][0]["properties"]

    assert props["name"] is None
    assert props["display_name"] == "Unnamed hospital"
    assert props["address"] is None


def test_address_and_english_name_fallback():
    props = discover([node(
        1, 77.21, 28.62,
        **{"name:en": "City Hospital", "addr:housenumber": "12", "addr:street": "Ring Road",
           "addr:city": "Delhi", "addr:postcode": "110001"},
    )])["features"][0]["properties"]

    assert props["name"] == "City Hospital"
    assert props["address"] == "12 Ring Road, Delhi 110001"


def test_open_way_is_line_and_closed_building_is_polygon():
    result = discover([
        way(10, [(77.20, 28.61), (77.21, 28.62)], highway="primary"),
        way(11, ring(77.21, 28.61, 0.001), building="yes"),
    ], category="road")
    types = {f["id"]: f["geometry"]["type"] for f in result["features"]}

    assert types == {"way/10": "LineString", "way/11": "Polygon"}


def test_closed_roundabout_stays_a_line_unless_area_yes():
    result = discover([
        way(20, ring(77.21, 28.61, 0.001), highway="primary"),
        way(21, ring(77.22, 28.61, 0.001), highway="pedestrian", area="yes"),
    ], category="road")
    types = {f["id"]: f["geometry"]["type"] for f in result["features"]}

    assert types == {"way/20": "LineString", "way/21": "Polygon"}


def test_walled_park_is_polygon_despite_barrier_tag():
    feature = discover(
        [way(22, ring(77.21, 28.61, 0.001), leisure="park", barrier="wall")],
        category="park",
    )["features"][0]

    assert feature["geometry"]["type"] == "Polygon"


def test_multipolygon_relation_assembles_split_outer_ring_with_hole():
    outer = ring(77.20, 28.60, 0.02)
    relation = {
        "type": "relation",
        "id": 30,
        "tags": {"type": "multipolygon", "landuse": "forest"},
        "members": [
            {"type": "way", "role": "outer", "geometry": [{"lon": x, "lat": y} for x, y in outer[:3]]},
            {"type": "way", "role": "outer", "geometry": [{"lon": x, "lat": y} for x, y in outer[2:]]},
            {"type": "way", "role": "inner", "geometry": [{"lon": x, "lat": y} for x, y in ring(77.205, 28.605, 0.005)]},
            {"type": "node", "role": "", "lon": 77.2, "lat": 28.6},
        ],
    }
    geometry = shape(discover([relation], category="forest")["features"][0]["geometry"])

    assert geometry.geom_type == "Polygon"
    assert len(geometry.interiors) == 1
    assert geometry.area == pytest.approx(0.02**2 - 0.005**2)


def test_waterway_relation_becomes_multilinestring():
    relation = {
        "type": "relation",
        "id": 40,
        "tags": {"type": "waterway", "waterway": "river", "name": "Yamuna"},
        "members": [
            {"type": "way", "role": "main_stream", "geometry": [{"lon": 77.2, "lat": 28.6}, {"lon": 77.21, "lat": 28.62}]},
            {"type": "way", "role": "main_stream", "geometry": [{"lon": 77.21, "lat": 28.62}, {"lon": 77.22, "lat": 28.64}]},
        ],
    }
    feature = discover([relation], category="river")["features"][0]

    assert feature["geometry"]["type"] == "MultiLineString"
    assert feature["properties"]["name"] == "Yamuna"


def test_self_intersecting_polygon_is_repaired():
    bowtie = [(77.20, 28.60), (77.21, 28.61), (77.21, 28.60), (77.20, 28.61), (77.20, 28.60)]
    feature = discover([way(50, bowtie, leisure="park")], category="park")["features"][0]

    assert shape(feature["geometry"]).is_valid
    assert feature["geometry"]["type"] in ("Polygon", "MultiPolygon")


def test_elements_without_geometry_are_skipped_and_counted():
    result = discover([
        {"type": "node", "id": 1, "tags": {}},
        {"type": "way", "id": 2, "geometry": [None, {"lon": 77.2, "lat": 28.6}]},
        {"type": "relation", "id": 3, "tags": {"type": "multipolygon"}, "members": []},
        node(4, 77.21, 28.62, amenity="hospital"),
    ])

    assert result["metadata"]["returned"] == 1
    assert result["metadata"]["skipped_without_geometry"] == 3


# Results and metadata

def test_duplicates_removed_and_sorted_by_distance():
    result = discover([
        node(1, 77.30, 28.70, amenity="hospital"),
        node(2, 77.2091, 28.6140, amenity="hospital"),
        node(1, 77.30, 28.70, amenity="hospital"),
    ])
    ids = [f["id"] for f in result["features"]]
    distances = [f["properties"]["distance_km"] for f in result["features"]]

    assert ids == ["node/2", "node/1"]
    assert distances == sorted(distances)
    assert distances[0] < 0.05


def test_polygon_distance_is_to_nearest_edge():
    # Origin inside the building footprint.
    result = discover([way(5, ring(77.208, 28.613, 0.002), building="yes")], category="building", radius_km=1)

    assert result["features"][0]["properties"]["distance_km"] == 0


def test_empty_result_has_honest_metadata():
    result = discover([])

    assert result["features"] == []
    assert result["metadata"]["total_found"] == 0
    assert result["metadata"]["truncated"] is False
    assert result["metadata"]["coverage_note"] == od.COVERAGE_NOTE
    assert result["metadata"]["osm_base"] == "2026-10-30T00:00:00Z"


def test_limit_and_server_cap_mark_results_truncated(monkeypatch):
    monkeypatch.setattr(od, "MAX_ELEMENTS", 5)
    elements = [node(i, 77.2 + i * 0.001, 28.6, amenity="hospital") for i in range(5)]
    result = discover(elements, limit=2)

    assert result["metadata"]["total_found"] == 5
    assert result["metadata"]["returned"] == 2
    assert result["metadata"]["truncated"] is True
    assert result["metadata"]["server_limit_reached"] is True


def test_large_result_set_returns_valid_geojson():
    elements = [node(i, 77.2 + (i % 100) * 1e-4, 28.6 + (i // 100) * 1e-4, amenity="hospital")
                for i in range(2500)]
    result = discover(elements, limit=2000)

    assert result["metadata"]["returned"] == 2000
    assert all(shape(f["geometry"]).is_valid for f in result["features"])
    json.dumps(result)


# Validation and errors

@pytest.mark.parametrize("coords", [[200, 0], [0, 95], [1]])
def test_invalid_coordinates_rejected(coords):
    with pytest.raises(ValueError):
        asyncio.run(od.discover_features(coords, "hospital", client=overpass_client({})))


def test_radius_above_category_limit_rejected():
    with pytest.raises(ValueError, match="at most 2 km"):
        asyncio.run(od.discover_features(CENTER, "building", radius_km=3, client=overpass_client({})))


@pytest.mark.parametrize("kwargs,status", [
    ({"exc": httpx.ReadTimeout("slow")}, 504),
    ({"exc": httpx.ConnectError("down")}, 502),
    ({"status": 429}, 503),
    ({"status": 502}, 503),
    ({"status": 504}, 503),
    ({"status": 400}, 502),
    ({"payload": b"<html>error</html>"}, 502),
    ({"payload": {"elements": [], "remark": "runtime error: Query timed out in \"query\""}}, 504),
])
def test_overpass_failures_raise_overpass_error(kwargs, status):
    with pytest.raises(od.OverpassError) as info:
        asyncio.run(od.discover_features(CENTER, "hospital", client=overpass_client(**kwargs)))

    assert info.value.status_code == status


# API

client = TestClient(app)


def test_categories_endpoint():
    categories = client.get("/api/discovery/categories").json()["categories"]

    assert {c["id"] for c in categories} == set(od.OSM_CATEGORIES)


def test_features_endpoint_success_and_errors(monkeypatch):
    async def fake_fetch(query, client=None):
        if "police" in query:
            raise od.OverpassError("busy", 503)
        return {"elements": [node(1, 77.21, 28.62, amenity="hospital")]}

    monkeypatch.setattr(od, "_fetch_overpass", fake_fetch)
    post = lambda **body: client.post("/api/discovery/features", json={"coordinates": CENTER, **body})

    ok = post(category="hospitals", radius_km=3)
    assert ok.status_code == 200
    assert ok.json()["metadata"]["category"] == "hospital"

    assert post(category="unicorns").status_code == 400
    assert post(category="building", radius_km=10).status_code == 400
    assert post(category="hospital", radius_km=500).status_code == 422
    assert post(category="police").status_code == 503


# Overpass instance fallback

MIRRORS = ("https://a.example/api/interpreter", "https://b.example/api/interpreter")


def mirror_client(behaviour, calls):
    def handler(request):
        host = request.url.host
        calls.append(host)
        outcome = behaviour[host]
        if isinstance(outcome, Exception):
            raise outcome
        if isinstance(outcome, int):
            return httpx.Response(outcome)
        return httpx.Response(200, json=outcome)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


OK = {"osm3s": {"timestamp_osm_base": "2026-10-30T00:00:00Z"}, "elements": [
    {"type": "node", "id": 1, "lat": CENTER[1] + 0.001, "lon": CENTER[0], "tags": {"amenity": "hospital"}},
]}


@pytest.mark.parametrize("first", [httpx.ConnectError("refused"), httpx.ConnectTimeout("slow"), 429, 502, 503, 504])
def test_unreachable_or_busy_instance_falls_back(monkeypatch, first):
    monkeypatch.setattr(od, "OVERPASS_URLS", MIRRORS)
    calls = []
    data = asyncio.run(od.discover_features(CENTER, "hospital", client=mirror_client({"a.example": first, "b.example": OK}, calls)))
    assert calls == ["a.example", "b.example"] and data["metadata"]["returned"] == 1


def test_all_instances_failing_reports_last_error(monkeypatch):
    monkeypatch.setattr(od, "OVERPASS_URLS", MIRRORS)
    calls = []
    client = mirror_client({"a.example": httpx.ConnectError("refused"), "b.example": 503}, calls)
    with pytest.raises(od.OverpassError) as info:
        asyncio.run(od.discover_features(CENTER, "hospital", client=client))
    assert calls == ["a.example", "b.example"] and info.value.status_code == 503


@pytest.mark.parametrize("first,status", [(httpx.ReadTimeout("heavy"), 504), (400, 502)])
def test_query_problems_are_not_retried_elsewhere(monkeypatch, first, status):
    monkeypatch.setattr(od, "OVERPASS_URLS", MIRRORS)
    calls = []
    with pytest.raises(od.OverpassError) as info:
        asyncio.run(od.discover_features(CENTER, "hospital", client=mirror_client({"a.example": first, "b.example": OK}, calls)))
    assert calls == ["a.example"] and info.value.status_code == status


def test_overpass_url_env_accepts_a_list():
    assert od.parse_overpass_urls(" https://x.example/api , https://y.example/api ") == (
        "https://x.example/api", "https://y.example/api",
    )
    assert od.parse_overpass_urls("") == od.DEFAULT_OVERPASS_URLS
    assert od.parse_overpass_urls(None) == od.DEFAULT_OVERPASS_URLS
