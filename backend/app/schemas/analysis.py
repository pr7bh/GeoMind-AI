from typing import Any

from pydantic import BaseModel, Field

MAX_FEATURES = 50_000
MAX_POINTS = 100_000
MAX_COORDINATES = 100_000


class PolygonAreaRequest(BaseModel):
    coordinates: list[list[float]] = Field(
        ..., min_length=4, max_length=MAX_COORDINATES
    )


class BufferRequest(BaseModel):
    geometry_type: str
    coordinates: list = Field(..., max_length=MAX_COORDINATES)
    distance_metres: float = Field(gt=0, le=100000)


class PointInPolygonRequest(BaseModel):
    polygon_coordinates: list[list[float]] = Field(
        ..., min_length=4, max_length=MAX_COORDINATES
    )
    points: list[list[float]] = Field(..., max_length=MAX_POINTS)


class SpatialQueryRequest(BaseModel):
    features: list[dict] = Field(..., max_length=MAX_FEATURES)
    target_geometry: dict
    operation: str


class ClipRequest(BaseModel):
    features: list[dict] = Field(..., max_length=MAX_FEATURES)
    clip_geometry: dict


class SpatialIntersectionRequest(BaseModel):
    layer_a_features: list[dict] = Field(..., max_length=MAX_FEATURES)
    layer_b_features: list[dict] = Field(..., max_length=MAX_FEATURES)


class NearestFeatureRequest(BaseModel):
    coordinates: list[float] = Field(..., min_length=2, max_length=2)
    features: list[dict] = Field(..., max_length=MAX_FEATURES)


class TopNearestFeaturesRequest(BaseModel):
    coordinates: list[float]
    features: list[dict[str, Any]] = Field(..., max_length=MAX_FEATURES)
    limit: int = Field(default=5, ge=1, le=100)