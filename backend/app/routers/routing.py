
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
import httpx

router = APIRouter(prefix="/api/routing", tags=["Routing"])

OSRM_URL = "https://router.project-osrm.org"


class RouteRequest(BaseModel):
    start: list[float] = Field(
        ...,
        min_length=2,
        max_length=2,
        description="[longitude, latitude]",
    )
    destination: list[float] = Field(
        ...,
        min_length=2,
        max_length=2,
        description="[longitude, latitude]",
    )


@router.post("/route")
def calculate_route(request: RouteRequest):
    start_lon, start_lat = request.start
    end_lon, end_lat = request.destination

    for lon, lat in (
        (start_lon, start_lat),
        (end_lon, end_lat),
    ):
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise HTTPException(
                status_code=422,
                detail="Invalid longitude or latitude.",
            )

    if request.start == request.destination:
        raise HTTPException(
            status_code=422,
            detail="Start and destination must be different.",
        )

    # OSRM requires longitude,latitude coordinate order.
    coordinates = (
        f"{start_lon},{start_lat};{end_lon},{end_lat}"
    )

    url = f"{OSRM_URL}/route/v1/driving/{coordinates}"

    try:
        response = httpx.get(
            url,
            params={
                "overview": "full",
                "geometries": "geojson",
                "steps": "false",
            },
            timeout=20.0,
        )
        response.raise_for_status()
        result = response.json()

    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail="Routing service timed out. Please retry.",
        ) from exc

    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail="Unable to connect to the routing service.",
        ) from exc

    if result.get("code") != "Ok" or not result.get("routes"):
        raise HTTPException(
            status_code=404,
            detail="No driving route found between these locations.",
        )

    route = result["routes"][0]
    distance_meters = route["distance"]
    duration_seconds = route["duration"]

    return {
        "geometry": route["geometry"],
        "distance_meters": round(distance_meters, 2),
        "distance_km": round(distance_meters / 1000, 2),
        "estimated_duration_minutes": round(
            duration_seconds / 60
        ),
        "route_type": "driving",
    }
