from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import osm_discovery

router = APIRouter(prefix="/api/discovery", tags=["Feature Discovery"])


class DiscoveryRequest(BaseModel):
    coordinates: list[float] = Field(
        ...,
        min_length=2,
        max_length=2,
        description="Search centre as [longitude, latitude]",
    )
    category: str = Field(..., min_length=1, max_length=50)
    radius_km: float = Field(default=5, gt=0, le=osm_discovery.MAX_RADIUS_KM)
    limit: int = Field(default=200, ge=1, le=2000)


@router.get("/categories")
def list_categories():
    return {"categories": osm_discovery.list_categories()}


@router.post("/features")
async def discover_features(request: DiscoveryRequest):
    try:
        return await osm_discovery.discover_features(
            coordinates=request.coordinates,
            category=request.category,
            radius_km=request.radius_km,
            limit=request.limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except osm_discovery.OverpassError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
