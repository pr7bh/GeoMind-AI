from typing import Any

from pydantic import BaseModel, Field


class PolygonAreaRequest(BaseModel):
    coordinates: list[list[float]] = Field(..., min_length=4)


class BufferRequest(BaseModel):
    geometry_type: str
    coordinates: list
    distance_metres: float = Field(gt=0, le=100000)


class PointInPolygonRequest(BaseModel):
    polygon_coordinates: list[list[float]] = Field(..., min_length=4)
    points: list[list[float]]


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


class NearestFeatureRequest(BaseModel):
    coordinates: list[float] = Field(..., min_length=2, max_length=2)
    features: list[dict]


class TopNearestFeaturesRequest(BaseModel):
    coordinates: list[float]
    features: list[dict[str, Any]]
    limit: int = Field(default=5, ge=1, le=100)