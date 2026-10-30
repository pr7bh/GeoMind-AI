
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
import httpx
from app.schemas.analysis import MAX_FEATURES
from app.services import spatial_analysis

router = APIRouter(prefix="/api/agent", tags=["GIS Agent"])

# Use an environment variable for deployment if needed.
ROUTING_API_URL = "http://127.0.0.1:8000/api/routing/route"


class AgentRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    start: list[float] | None = None
    destination: list[float] | None = None

    coordinates: list[float] | None = None
    features: list[dict] | None = Field(default=None, max_length=MAX_FEATURES)
    limit: int = Field(default=5, ge=1, le=100)


class AgentResponse(BaseModel):
    success: bool
    intent: str
    message: str
    tool: str | None = None
    parameters: dict = Field(default_factory=dict)
    needs_input: list[str] = Field(default_factory=list)


GIS_TOOLS = {
    "route": {
        "keywords": [
            "route",
            "directions",
            "driving distance",
            "road distance",
        ],
        "description": "Calculate a driving route.",
    },
    "nearest_features": {
        "keywords": ["nearest", "closest", "nearby"],
        "description": "Find the nearest geographical features.",
    },
    "buffer": {
        "keywords": ["buffer", "within a radius", "within radius"],
        "description": "Create a geographical buffer.",
    },
    "heatmap": {
        "keywords": ["heatmap", "heat map", "density analysis"],
        "description": "Visualize geographical point density.",
    },
    "spatial_query": {
        "keywords": [
            "spatial query",
            "intersect",
            "intersection",
            "within polygon",
        ],
        "description": "Query features using spatial relationships.",
    },
}


def identify_intent(message: str):
    normalized = " ".join(message.lower().split())
    matches = []

    for name, tool in GIS_TOOLS.items():
        for keyword in tool["keywords"]:
            if keyword in normalized:
                matches.append((len(keyword), name, keyword))

    if not matches:
        return None, None

    _, intent, keyword = max(matches)
    return intent, keyword



@router.post("/chat", response_model=AgentResponse)
def chat_with_agent(request: AgentRequest):
    intent, matched_keyword = identify_intent(request.message)

    if intent is None:
        return AgentResponse(
            success=True,
            intent="unknown",
            message=(
                "I can help with driving routes, nearest features, "
                "buffer analysis, heatmaps, and spatial queries."
            ),
        )

    if intent == "route":
        missing = []

        if request.start is None:
            missing.append("start")

        if request.destination is None:
            missing.append("destination")

        if missing:
            return AgentResponse(
                success=True,
                intent=intent,
                tool="calculate_route",
                message="Please provide the start and destination coordinates.",
                needs_input=missing,
            )

        for point in (request.start, request.destination):
            lon, lat = point

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

        try:
            response = httpx.post(
                ROUTING_API_URL,
                json={
                    "start": request.start,
                    "destination": request.destination,
                },
                timeout=25.0,
            )
            response.raise_for_status()
            route_data = response.json()

        except httpx.TimeoutException as exc:
            raise HTTPException(
                status_code=504,
                detail="Routing service timed out. Please try again.",
            ) from exc

        except httpx.HTTPStatusError as exc:
            raise HTTPException(
                status_code=502,
                detail="The routing service could not calculate the route.",
            ) from exc

        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=502,
                detail="Unable to connect to the routing service.",
            ) from exc

        return AgentResponse(
            success=True,
            intent="route",
            tool="calculate_route",
            message=(
                f"Route calculated: {route_data['distance_km']} km, "
                f"approximately "
                f"{route_data['estimated_duration_minutes']} minutes."
            ),
            parameters={
                "start": request.start,
                "destination": request.destination,
                "result": route_data,
            },
        )

    if intent == "nearest_features":
        missing = []

        if request.coordinates is None:
            missing.append("coordinates")

        if request.features is None:
            missing.append("features")

        if missing:
            return AgentResponse(
                success=True,
                intent=intent,
                tool="nearest_features",
                message=(
                    "Please provide the reference coordinates "
                    "and geographical features to search."
                ),
                parameters={
                    "matched_keyword": matched_keyword,
                    "limit": request.limit,
                },
                needs_input=missing,
            )

        if len(request.coordinates) != 2:
            raise HTTPException(
                status_code=422,
                detail="Coordinates must contain longitude and latitude.",
            )

        lon, lat = request.coordinates

        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise HTTPException(
                status_code=422,
                detail="Invalid longitude or latitude.",
            )

        try:
            result = spatial_analysis.find_top_nearest_features(
                coordinates=request.coordinates,
                features=request.features,
                limit=request.limit,
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=str(exc),
            ) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Nearest-features analysis failed: {exc}",
            ) from exc

        return AgentResponse(
            success=True,
            intent=intent,
            tool="nearest_features",
            message="Nearest-features analysis completed successfully.",
            parameters={
                "matched_keyword": matched_keyword,
                "coordinates": request.coordinates,
                "limit": request.limit,
                "result": result,
            },
        )

    # Other intents are recognized but not executed yet.
    return AgentResponse(
        success=True,
        intent=intent,
        tool=intent,
        message=(
            f"Recognized {intent.replace('_', ' ')}. "
            "Execution for this tool has not been connected yet."
        ),
        parameters={"matched_keyword": matched_keyword},
    )
