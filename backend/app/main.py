
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.routers.analysis import router as analysis_router
from app.routers.routing import router as routing_router
from app.routers.agent import router as agent_router
from app.routers.discovery import router as discovery_router
from app.routers.research import router as research_router

app = FastAPI(
    title="GeoMind AI API",
    description="Spatial analysis APIs for GeoMind AI",
    version="0.2.0",
)

MAX_BODY_BYTES = 25 * 1024 * 1024


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    content_length = request.headers.get("content-length")

    if content_length and content_length.isdigit() and int(content_length) > MAX_BODY_BYTES:
        return JSONResponse(
            status_code=413,
            content={"detail": "Request body is too large (max 25 MB)."},
        )

    return await call_next(request)


# Added last so it wraps every response, including 413s.
app.add_middleware(
    CORSMiddleware,
    # Comma-separated CORS_ORIGINS, e.g. your Vercel URL; defaults to local Vite.
    allow_origins=list(get_settings().cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def health_check():
    return {"message": "GeoMind AI API is running"}


app.include_router(analysis_router)
app.include_router(routing_router)
app.include_router(agent_router)
app.include_router(discovery_router)
app.include_router(research_router)
