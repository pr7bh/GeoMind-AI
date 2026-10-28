from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pyproj import Geod, Transformer
from shapely.geometry import LineString, Point, Polygon, mapping, shape
from shapely.ops import transform as shapely_transform

app = FastAPI(
    title="GeoMind AI API",
    description="Spatial analysis APIs for GeoMind AI",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

geod = Geod(ellps="WGS84")


class PolygonAreaRequest(BaseModel):
    coordinates: list[list[float]] = Field(
        ...,
        description="Polygon coordinates as [longitude, latitude] pairs",
        min_length=4,
    )


class PointInPolygonRequest(BaseModel):
    polygon_coordinates: list[list[float]] = Field(
        ...,
        min_length=4,
        description="Polygon outer ring as [longitude, latitude] pairs",
    )
    points: list[list[float]] = Field(
        ...,
        description="Points as [longitude, latitude] pairs",
    )


class SpatialQueryRequest(BaseModel):
    features: list[dict]
    target_geometry: dict
    operation: str


class ClipRequest(BaseModel):
    features: list[dict]
    clip_geometry: dict

class SpatialIntersectionRequest(BaseModel):
    layer_a_features: list[dict]
    layer_b_features: list[dict]


@app.get("/")
def health_check():
    return {"message": "GeoMind AI API is running"}


@app.post("/api/analysis/polygon-area")
def calculate_polygon_area(request: PolygonAreaRequest):
    try:
        polygon = Polygon(request.coordinates)

        if polygon.is_empty or not polygon.is_valid:
            raise HTTPException(
                status_code=400,
                detail="Invalid polygon. Check its coordinates and boundaries.",
            )

        if polygon.geom_type != "Polygon":
            raise HTTPException(
                status_code=400,
                detail="Only polygon geometries are supported.",
            )

        area_m2, _ = geod.geometry_area_perimeter(polygon)
        area_m2 = abs(area_m2)

        return {
            "geometry_type": "Polygon",
            "area_square_metres": round(area_m2, 2),
            "area_square_kilometres": round(area_m2 / 1_000_000, 6),
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Unable to calculate polygon area: {exc}",
        ) from exc


class BufferRequest(BaseModel):
    geometry_type: str
    coordinates: list
    distance_metres: float = Field(gt=0, le=100000)


@app.post("/api/analysis/buffer")
def create_buffer(request: BufferRequest):
    try:
        if request.geometry_type == "Point":
            geometry = Point(request.coordinates)
        elif request.geometry_type == "LineString":
            geometry = LineString(request.coordinates)
        else:
            raise HTTPException(
                status_code=400,
                detail="Only Point and LineString geometries are supported.",
            )

        if geometry.is_empty or not geometry.is_valid:
            raise HTTPException(
                status_code=400,
                detail="Invalid geometry coordinates.",
            )

        # Convert longitude/latitude into a metric projection.
        lon, lat = geometry.centroid.x, geometry.centroid.y
        zone = int((lon + 180) // 6) + 1
        epsg = (32600 if lat >= 0 else 32700) + zone

        to_metric = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
        to_wgs84 = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)

        projected = shapely_transform(to_metric.transform, geometry)
        buffered = projected.buffer(request.distance_metres)
        result = shapely_transform(to_wgs84.transform, buffered)

        return {
            "geometry_type": "Polygon",
            "distance_metres": request.distance_metres,
            "geojson": {
                "type": "Feature",
                "geometry": mapping(result),
                "properties": {"buffer_distance_metres": request.distance_metres},
            },
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Unable to create buffer: {exc}",
        ) from exc


@app.post("/api/analysis/point-in-polygon")
def analyze_points_in_polygon(request: PointInPolygonRequest):
    try:
        polygon = Polygon(request.polygon_coordinates)

        if polygon.is_empty or not polygon.is_valid:
            raise HTTPException(
                status_code=400,
                detail="Invalid polygon coordinates.",
            )

        matches = []

        for index, coordinates in enumerate(request.points):
            if len(coordinates) != 2:
                raise HTTPException(
                    status_code=400,
                    detail=f"Point at index {index} must contain longitude and latitude.",
                )

            point = Point(coordinates)

            if polygon.covers(point):
                matches.append(
                    {
                        "index": index,
                        "coordinates": coordinates,
                    }
                )

        return {
            "total_points": len(request.points),
            "points_inside_count": len(matches),
            "points_outside_count": len(request.points) - len(matches),
            "points_inside": matches,
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Unable to analyze points: {exc}",
        ) from exc


@app.post("/api/analysis/spatial-query")
def spatial_query(request: SpatialQueryRequest):
    supported_operations = {"intersects", "within", "contains"}

    operation = request.operation.lower().strip()

    if operation not in supported_operations:
        raise HTTPException(
            status_code=400,
            detail="Unsupported operation. Use intersects, within, or contains.",
        )

    try:
        target = shape(request.target_geometry)

        if target.is_empty or not target.is_valid:
            raise HTTPException(
                status_code=400,
                detail="Target geometry is empty or invalid.",
            )

        matching_features = []

        for index, feature_data in enumerate(request.features):
            try:
                geometry = shape(feature_data["geometry"])

                if geometry.is_empty or not geometry.is_valid:
                    continue

                if operation == "intersects":
                    matches = geometry.intersects(target)
                elif operation == "within":
                    matches = geometry.within(target)
                else:
                    matches = geometry.contains(target)

                if matches:
                    matching_features.append(
                        {
                            "index": index,
                            "feature": feature_data,
                        }
                    )

            except (KeyError, TypeError, ValueError):
                continue

        return {
            "operation": operation,
            "total_features": len(request.features),
            "matched_count": len(matching_features),
            "results": matching_features,
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Spatial query failed: {exc!s}",
        ) from exc


@app.post("/api/analysis/clip")
def clip_features(request: ClipRequest):
    from shapely.errors import GEOSException
    from shapely.geometry import mapping, shape

    try:
        clip_boundary = shape(request.clip_geometry)

        if clip_boundary.is_empty or not clip_boundary.is_valid:
            raise HTTPException(
                status_code=400,
                detail="The clip boundary is empty or invalid.",
            )

        if clip_boundary.geom_type not in ("Polygon", "MultiPolygon"):
            raise HTTPException(
                status_code=400,
                detail="The clip boundary must be a Polygon or MultiPolygon.",
            )

        clipped_features = []
        skipped_count = 0

        for index, feature in enumerate(request.features):
            geometry_data = feature.get("geometry")

            if not geometry_data:
                skipped_count += 1
                continue

            try:
                input_geometry = shape(geometry_data)

                if input_geometry.is_empty or not input_geometry.is_valid:
                    skipped_count += 1
                    continue

                if not input_geometry.intersects(clip_boundary):
                    continue

                clipped_geometry = input_geometry.intersection(clip_boundary)

                if clipped_geometry.is_empty:
                    continue

                clipped_features.append(
                    {
                        "type": "Feature",
                        "id": feature.get("id", index),
                        "properties": feature.get("properties") or {},
                        "geometry": mapping(clipped_geometry),
                    }
                )

            except (ValueError, TypeError, GEOSException):
                skipped_count += 1

        return {
            "operation": "clip",
            "input_count": len(request.features),
            "result_count": len(clipped_features),
            "skipped_count": skipped_count,
            "result": {
                "type": "FeatureCollection",
                "features": clipped_features,
            },
        }

    except HTTPException:
        raise
    except (ValueError, TypeError, GEOSException) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Unable to perform clipping: {exc}",
        ) from exc

@app.post("/api/analysis/intersection")
def spatial_intersection(request: SpatialIntersectionRequest):
    from shapely.errors import GEOSException
    from shapely.geometry import mapping, shape

    results = []
    skipped_count = 0

    try:
        layer_b_geometries = []

        for feature in request.layer_b_features:
            geometry_data = feature.get("geometry")

            if not geometry_data:
                skipped_count += 1
                continue

            try:
                geometry = shape(geometry_data)

                if geometry.is_empty or not geometry.is_valid:
                    skipped_count += 1
                    continue

                layer_b_geometries.append(
                    (feature, geometry)
                )

            except (ValueError, TypeError, GEOSException):
                skipped_count += 1

        for index_a, feature_a in enumerate(request.layer_a_features):
            geometry_a_data = feature_a.get("geometry")

            if not geometry_a_data:
                skipped_count += 1
                continue

            try:
                geometry_a = shape(geometry_a_data)

                if geometry_a.is_empty or not geometry_a.is_valid:
                    skipped_count += 1
                    continue

                for feature_b, geometry_b in layer_b_geometries:
                    if not geometry_a.intersects(geometry_b):
                        continue

                    intersection = geometry_a.intersection(geometry_b)

                    if intersection.is_empty:
                        continue

                    results.append(
                        {
                            "type": "Feature",
                            "properties": {
                                "layer_a_index": index_a,
                                "layer_a_properties": feature_a.get("properties") or {},
                                "layer_b_properties": feature_b.get("properties") or {},
                            },
                            "geometry": mapping(intersection),
                        }
                    )

            except (ValueError, TypeError, GEOSException):
                skipped_count += 1

        return {
            "operation": "intersection",
            "layer_a_count": len(request.layer_a_features),
            "layer_b_count": len(request.layer_b_features),
            "result_count": len(results),
            "skipped_count": skipped_count,
            "result": {
                "type": "FeatureCollection",
                "features": results,
            },
        }

    except GEOSException as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Unable to perform spatial intersection: {exc}",
        ) from exc