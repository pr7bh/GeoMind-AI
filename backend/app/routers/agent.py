
import asyncio
import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.routers import routing
from app.schemas.analysis import MAX_FEATURES
from app.services import coverage, spatial_analysis
from app.services.agent.runner import (
    Emit,
    describe_discovery,
    execute_tool,
    parse_discovery_request,
    run_agent,
)
from app.services.agent.tools import MAX_CONTEXT_FEATURES, AgentContext
from app.services.llm.base import LLMConfigError
from app.services.workflows import catalog as workflows
from app.services.workflows.plan import PlanError
from app.services.llm.factory import create_provider, describe_provider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agent", tags=["GIS Agent"])


class AgentRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    start: list[float] | None = Field(default=None, min_length=2, max_length=2)
    destination: list[float] | None = Field(default=None, min_length=2, max_length=2)

    # The user's selected map location, [longitude, latitude].
    coordinates: list[float] | None = Field(default=None, min_length=2, max_length=2)
    # Area B for comparisons ("coordinates" is Area A), [longitude, latitude].
    compare_coordinates: list[float] | None = Field(default=None, min_length=2, max_length=2)
    features: list[dict] | None = Field(default=None, max_length=MAX_FEATURES)
    limit: int = Field(default=5, ge=1, le=100)


class AgentResponse(BaseModel):
    success: bool
    intent: str
    message: str
    tool: str | None = None
    parameters: dict = Field(default_factory=dict)
    needs_input: list[str] = Field(default_factory=list)
    # "keyword" (rule-based), "deterministic" (no LLM) or "llm".
    mode: str = "keyword"
    steps: list[dict] = Field(default_factory=list)
    layers: list[dict] = Field(default_factory=list)
    error_code: str | None = None
    # Multi-step workflows: plan, outcome and structured analysis.
    workflow: dict | None = None


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



def _valid_location(coordinates: list[float] | None) -> tuple[float, float] | None:
    if coordinates is None:
        return None

    lon, lat = coordinates

    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise HTTPException(status_code=422, detail="Invalid longitude or latitude.")

    return lon, lat


async def _noop(_: dict) -> None:
    return None


def _workflow_response(run, workflow: dict, layers: list[dict], intent: str = "workflow") -> AgentResponse:
    return AgentResponse(
        success=run.outcome != "failed",
        intent=intent,
        mode="workflow",
        message=workflows.answer_text(run),
        steps=[
            {
                "tool": step["tool"],
                "arguments": step["arguments"],
                "status": step["status"],
                "summary": step["summary"] or step["description"],
                "error": step["error"],
            }
            # Only steps that ran; skipped steps live in workflow.plan.
            for step in workflow["plan"]
            if step["status"] in ("completed", "failed")
        ],
        layers=layers,
        workflow=workflow,
    )


async def handle_chat(request: AgentRequest, emit: Emit = _noop) -> AgentResponse:
    intent, matched_keyword = identify_intent(request.message)
    location = _valid_location(request.coordinates)

    # 1. Rule-based tools that need no LLM.
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

        # Call the routing handler directly (no HTTP round trip to ourselves).
        route_data = await run_in_threadpool(
            routing.calculate_route,
            routing.RouteRequest(start=request.start, destination=request.destination),
        )

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

    if intent == "nearest_features" and request.features is not None:
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

    # 2. Hospital/pharmacy-style ranking workflow (deterministic, no LLM).
    #    Checked before the simple path, which matches the same opening words.
    workflow_request = workflows.match_workflow(request.message)

    if workflow_request is not None:
        if location is None:
            return AgentResponse(
                success=True,
                intent="workflow",
                mode="workflow",
                message="Select a location on the map first, then ask again.",
                needs_input=["coordinates"],
            )

        try:
            run = await workflows.run_nearby_count_workflow(
                workflow_request,
                location,
                get_settings().agent_timeout_seconds,
                emit,
            )
        except PlanError as exc:
            return AgentResponse(
                success=False,
                intent="workflow",
                mode="workflow",
                message=f"That analysis cannot be run: {exc}",
                error_code="invalid_plan",
            )

        return _workflow_response(run, *workflows.serialize(run, location))

    # 3. Area A vs Area B comparison (deterministic, no LLM). Before coverage,
    #    whose wording ("compare hospital coverage") it overlaps.
    comparison_request = workflows.match_comparison(request.message)

    if comparison_request is not None:
        area_b = _valid_location(request.compare_coordinates)
        missing = [
            name
            for name, value in (("coordinates", location), ("compare_coordinates", area_b))
            if value is None
        ]
        area_names = {"coordinates": "Area A", "compare_coordinates": "Area B"}

        if comparison_request.category is None:
            return AgentResponse(
                success=True,
                intent="comparison",
                mode="workflow",
                message=(
                    "Which service should I compare? For example: hospitals, schools, "
                    "pharmacies, police stations or parks."
                ),
                needs_input=["category"],
            )

        if missing:
            return AgentResponse(
                success=True,
                intent="comparison",
                mode="workflow",
                message=(
                    "Select "
                    + " and ".join(area_names[name] for name in missing)
                    + " on the map first, then ask again."
                ),
                needs_input=missing,
            )

        if comparison_request.radius_km > coverage.MAX_STUDY_RADIUS_KM:
            return AgentResponse(
                success=False,
                intent="comparison",
                mode="workflow",
                message=(
                    f"Comparisons are limited to a {coverage.MAX_STUDY_RADIUS_KM:g} km radius per area; "
                    f"you asked for {comparison_request.radius_km:g} km."
                ),
                error_code="invalid_plan",
            )

        try:
            run = await workflows.run_comparison_workflow(
                comparison_request,
                location,
                area_b,
                get_settings().agent_timeout_seconds,
                emit,
            )
        except PlanError as exc:
            return AgentResponse(
                success=False,
                intent="comparison",
                mode="workflow",
                message=f"That comparison cannot be run: {exc}",
                error_code="invalid_plan",
            )

        return _workflow_response(run, *workflows.serialize_comparison(run), intent="comparison")

    # 4. Service coverage gap analysis (deterministic, no LLM).
    coverage_request = workflows.match_coverage(request.message)

    if coverage_request is not None:
        if location is None:
            return AgentResponse(
                success=True,
                intent="coverage",
                mode="workflow",
                message="Select a location on the map first, then ask again.",
                needs_input=["coordinates"],
            )

        if coverage_request.radius_km > coverage.MAX_STUDY_RADIUS_KM:
            return AgentResponse(
                success=False,
                intent="coverage",
                mode="workflow",
                message=(
                    f"Coverage analysis is limited to a {coverage.MAX_STUDY_RADIUS_KM:g} km radius; "
                    f"you asked for {coverage_request.radius_km:g} km. Try a smaller radius."
                ),
                error_code="invalid_plan",
            )

        try:
            run = await workflows.run_coverage_workflow(
                coverage_request,
                location,
                get_settings().agent_timeout_seconds,
                emit,
            )
        except PlanError as exc:
            return AgentResponse(
                success=False,
                intent="coverage",
                mode="workflow",
                message=f"That analysis cannot be run: {exc}",
                error_code="invalid_plan",
            )

        return _workflow_response(run, *workflows.serialize_coverage(run, location), intent="coverage")

    # 5. Simple discovery requests ("find hospitals within 5 km") run directly.
    fast = parse_discovery_request(request.message)

    if fast is not None:
        category, radius_km = fast

        if location is None:
            return AgentResponse(
                success=True,
                intent="discover_features",
                tool="discover_features",
                mode="deterministic",
                message="Select a location on the map first, then ask again.",
                needs_input=["coordinates"],
            )

        context = AgentContext(location=location)
        arguments = {"category": category, "radius_km": radius_km}
        await emit({"type": "tool_started", "tool": "discover_features", "arguments": arguments})
        step = await execute_tool("discover_features", arguments, context)
        await emit({"type": "tool_finished", "step": step.public()})

        return AgentResponse(
            success=step.status == "completed",
            intent="discover_features",
            tool="discover_features",
            mode="deterministic",
            message=(
                describe_discovery(step.result)
                if step.result
                else f"Discovery failed: {step.error}"
            ),
            parameters={"category": category, "radius_km": radius_km},
            steps=[step.public()],
            layers=context.layers,
        )

    # 6. Open-ended requests go to the configured LLM, if any.
    settings = get_settings()

    try:
        provider = create_provider(settings)
    except LLMConfigError as exc:
        return AgentResponse(
            success=False,
            intent="agent",
            mode="llm",
            message=f"The AI assistant is misconfigured: {exc}",
            error_code=exc.code,
        )

    if provider is None:
        return AgentResponse(
            success=True,
            intent=intent or "unknown",
            tool=intent,
            message=(
                "The AI assistant is not configured, so only direct requests work, "
                "e.g. 'Find hospitals within 5 km' with a map location selected, "
                "or driving routes between picked points."
            ),
            parameters={"matched_keyword": matched_keyword} if matched_keyword else {},
            error_code="llm_not_configured",
        )

    context = AgentContext(
        location=location,
        features=(request.features or [])[:MAX_CONTEXT_FEATURES],
        features_label="visible map layers" if request.features else None,
    )

    try:
        result = await asyncio.wait_for(
            run_agent(
                request.message,
                context,
                provider,
                settings.agent_max_iterations,
                emit,
            ),
            timeout=settings.agent_timeout_seconds,
        )
    except asyncio.TimeoutError:
        return AgentResponse(
            success=False,
            intent="agent",
            mode="llm",
            message="The analysis took too long and was stopped. Try a smaller radius.",
            layers=context.layers,
            error_code="agent_timeout",
        )

    steps = [step.public() for step in result.steps]

    return AgentResponse(
        success=result.error is None,
        intent="agent",
        mode="llm",
        message=result.answer,
        steps=steps,
        layers=result.layers,
        parameters={"iteration_limit_reached": result.hit_iteration_limit},
        error_code=result.error_code,
    )


@router.post("/chat", response_model=AgentResponse)
async def chat_with_agent(request: AgentRequest):
    return await handle_chat(request)


@router.post("/chat/stream")
async def chat_with_agent_stream(request: AgentRequest, http_request: Request):
    """Same as /chat, streamed as newline-delimited JSON events.

    Events: thinking, tool_started, tool_finished, then result or error.
    """
    # Reject bad input with a real 422 before the 200 stream starts.
    _valid_location(request.coordinates)
    _valid_location(request.compare_coordinates)

    async def events() -> AsyncIterator[str]:
        queue: asyncio.Queue[dict | None] = asyncio.Queue()

        async def worker() -> None:
            try:
                response = await handle_chat(request, queue.put)
                await queue.put({"type": "result", "response": response.model_dump()})
            except HTTPException as exc:
                await queue.put({"type": "error", "status": exc.status_code, "detail": exc.detail})
            except Exception:  # noqa: BLE001
                logger.exception("Agent stream failed")
                await queue.put({"type": "error", "status": 500, "detail": "The agent failed unexpectedly."})
            finally:
                await queue.put(None)

        task = asyncio.create_task(worker())

        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    # Starlette only notices a disconnect on write; check while
                    # idle so a cancelled request stops its LLM/tool calls.
                    if await http_request.is_disconnected():
                        break
                    continue

                if event is None:
                    break

                yield json.dumps(event, default=str) + "\n"
        finally:
            # Client disconnected or finished: stop outstanding tool/LLM calls.
            task.cancel()

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        # Ask proxies not to buffer, so events reach the browser as they happen.
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/status")
def agent_status():
    """Whether an LLM is configured. Never includes URLs or keys."""
    return describe_provider(get_settings())
