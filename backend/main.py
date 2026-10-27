
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from pyproj import Geod
from shapely.geometry import Polygon
from fastapi.middleware.cors import CORSMiddleware
from shapely.geometry import Point, LineString, mapping
from pyproj import Transformer
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

        to_metric = Transformer.from_crs(
            "EPSG:4326", f"EPSG:{epsg}", always_xy=True
        )
        to_wgs84 = Transformer.from_crs(
            f"EPSG:{epsg}", "EPSG:4326", always_xy=True
        )

        projected = shapely_transform(to_metric.transform, geometry)
        buffered = projected.buffer(request.distance_metres)
        result = shapely_transform(to_wgs84.transform, buffered)

        return {
            "geometry_type": "Polygon",
            "distance_metres": request.distance_metres,
            "geojson": {
                "type": "Feature",
                "geometry": mapping(result),
                "properties": {
                    "buffer_distance_metres": request.distance_metres
                },
            },
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Unable to create buffer: {exc}",
        ) from exc
