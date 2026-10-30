
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers.analysis import router as analysis_router
from app.routers.routing import router as routing_router
from app.routers.agent import router as agent_router

app = FastAPI(
    title="GeoMind AI API",
    description="Spatial analysis APIs for GeoMind AI",
    version="0.2.0",
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


@app.get("/")
def health_check():
    return {"message": "GeoMind AI API is running"}


app.include_router(analysis_router)
app.include_router(routing_router)
app.include_router(agent_router)
