from fastapi import APIRouter, HTTPException

from app.schemas.analysis import (
    BufferRequest,
    ClipRequest,
    NearestFeatureRequest,
    PointInPolygonRequest,
    PolygonAreaRequest,
    SpatialIntersectionRequest,
    SpatialQueryRequest,
    TopNearestFeaturesRequest,
)
from app.services import spatial_analysis as service

router = APIRouter(prefix="/api/analysis", tags=["Spatial Analysis"])


def execute(operation, *args):
    try:
        return operation(*args)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Spatial analysis failed: {exc}",
        ) from exc


@router.post("/polygon-area")
def calculate_polygon_area(request: PolygonAreaRequest):
    return execute(service.polygon_area, request.coordinates)


@router.post("/buffer")
def create_buffer(request: BufferRequest):
    return execute(
        service.create_buffer,
        request.geometry_type,
        request.coordinates,
        request.distance_metres,
    )


@router.post("/point-in-polygon")
def analyze_points_in_polygon(request: PointInPolygonRequest):
    return execute(
        service.point_in_polygon,
        request.polygon_coordinates,
        request.points,
    )


@router.post("/spatial-query")
def run_spatial_query(request: SpatialQueryRequest):
    return execute(
        service.spatial_query,
        request.features,
        request.target_geometry,
        request.operation,
    )


@router.post("/clip")
def clip(request: ClipRequest):
    return execute(
        service.clip_features,
        request.features,
        request.clip_geometry,
    )


@router.post("/intersection")
def intersection(request: SpatialIntersectionRequest):
    return execute(
        service.spatial_intersection,
        request.layer_a_features,
        request.layer_b_features,
    )


@router.post("/nearest-feature")
def find_nearest_feature(request: NearestFeatureRequest):
    return execute(
        service.nearest_feature,
        request.coordinates,
        request.features,
    )

@router.post("/nearest-features")
def nearest_features(request: TopNearestFeaturesRequest):
    try:
        return service.find_top_nearest_features(
            coordinates=request.coordinates,
            features=request.features,
            limit=request.limit,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc