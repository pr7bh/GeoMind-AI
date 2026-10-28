import { useEffect, useRef, useState } from "react";
import type {
  Feature as GeoJSONFeature,
  FeatureCollection as GeoJSONFeatureCollection,
  Geometry as GeoJSONGeometry,
} from "geojson";
import FeatureInspector from "../workspace/FeatureInspector";
import type {
  SelectedFeatureInfo,
  ImportedLayerInfo,
} from "../workspace/GeoMap";
import {
  Moon,
  Sun,
  Eye,
  EyeOff,
  Trash2,
  Layers,
  Maximize2,
  Download,
} from "lucide-react";
import AppHeader from "./AppHeader";
import Sidebar from "./Sidebar";
import GeoMap from "../workspace/GeoMap";
import type { GeoMapHandle, BaseMapType } from "../workspace/GeoMap";
import MapToolbar from "../workspace/MapToolbar";
import WorkspaceStatus from "../workspace/WorkspaceStatus";
import ResearchPanel from "../workspace/ResearchPanel";
import LocationSearch from "../workspace/LocationSearch";
import DrawingToolbar from "../workspace/DrawingToolbar";
import type { DrawingMode } from "../workspace/DrawingToolbar";
import GeoJSONImport from "../workspace/GeoJSONImport";

type Theme = "light" | "dark";

export default function AppLayout() {
  const [theme, setTheme] = useState<Theme>(() => {
    const savedTheme = localStorage.getItem("geomind-theme");
    return savedTheme === "light" ? "light" : "dark";
  });
  const [importedLayers, setImportedLayers] = useState<ImportedLayerInfo[]>([]);
  const [isResearchOpen, setIsResearchOpen] = useState(false);
  const [isLayersOpen, setIsLayersOpen] = useState(false);
  const [isBaseLayerVisible, setIsBaseLayerVisible] = useState(true);
  const [baseMap, setBaseMap] = useState<BaseMapType>("dark");
  const [drawingMode, setDrawingMode] = useState<DrawingMode>("none");
  const [selectedFeature, setSelectedFeature] =
    useState<SelectedFeatureInfo | null>(null);
  const mapRef = useRef<GeoMapHandle>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [pointAnalysisResult, setPointAnalysisResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [spatialQueryLayerId, setSpatialQueryLayerId] = useState("");
  const [spatialQueryOperation, setSpatialQueryOperation] = useState<
    "intersects" | "within" | "contains"
  >("within");
  const [spatialQueryResult, setSpatialQueryResult] = useState<{
    operation: string;
    total_features: number;
    matched_count: number;
    results: {
      index: number;
      feature: GeoJSONFeature;
    }[];
  } | null>(null);
  const [spatialQueryLoading, setSpatialQueryLoading] = useState(false);
  const [spatialQueryError, setSpatialQueryError] = useState("");
  const [spatialQueryTargetReady, setSpatialQueryTargetReady] = useState(false);
  const [spatialQueryTargetGeometry, setSpatialQueryTargetGeometry] =
    useState<GeoJSONGeometry | null>(null);
  const [isSpatialQueryExpanded, setIsSpatialQueryExpanded] = useState(false);
  const [intersectionLayerAId, setIntersectionLayerAId] = useState("");
  const [intersectionLayerBId, setIntersectionLayerBId] = useState("");

  const [intersectionResult, setIntersectionResult] = useState<{
    layer_a_count: number;
    layer_b_count: number;
    result_count: number;
    skipped_count: number;
  } | null>(null);

  const [intersectionLoading, setIntersectionLoading] = useState(false);
  const [intersectionError, setIntersectionError] = useState("");
  const [isIntersectionExpanded, setIsIntersectionExpanded] = useState(false);

  const handleRunIntersection = async () => {
    if (!intersectionLayerAId || !intersectionLayerBId) {
      setIntersectionError("Please select both Layer A and Layer B.");
      return;
    }

    if (intersectionLayerAId === intersectionLayerBId) {
      setIntersectionError("Please select two different layers.");
      return;
    }

    setIntersectionLoading(true);
    setIntersectionError("");
    setIntersectionResult(null);

    try {
      const layerAGeoJSON =
        mapRef.current?.getImportedGeoJSON(intersectionLayerAId);
      const layerBGeoJSON =
        mapRef.current?.getImportedGeoJSON(intersectionLayerBId);

      if (!layerAGeoJSON || !layerBGeoJSON) {
        throw new Error("Unable to read the selected layers from the map.");
      }

      const layerA = JSON.parse(layerAGeoJSON);
      const layerB = JSON.parse(layerBGeoJSON);

      const response = await fetch(
        "http://127.0.0.1:8000/api/analysis/intersection",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            layer_a_features: layerA.features,
            layer_b_features: layerB.features,
          }),
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(
          errorData?.detail || "Failed to run spatial intersection.",
        );
      }

      const data = await response.json();

      setIntersectionResult({
        layer_a_count: data.layer_a_count,
        layer_b_count: data.layer_b_count,
        result_count: data.result_count,
        skipped_count: data.skipped_count,
      });

      if (data.result_count > 0) {
        mapRef.current?.addClipResultGeoJSON(
          JSON.stringify(data.result),
          "Intersection Result",
        );
        refreshImportedLayers();
      }
    } catch (error) {
      setIntersectionError(
        error instanceof Error
          ? error.message
          : "Something went wrong while running intersection.",
      );
    } finally {
      setIntersectionLoading(false);
    }
  };

  const handleClearIntersectionResults = () => {
    const intersectionLayers = mapRef.current
      ?.getImportedLayers()
      .filter((layer) => layer.name.startsWith("Intersection Result"));

    intersectionLayers?.forEach((layer) => {
      mapRef.current?.removeImportedLayer(layer.id);
    });

    refreshImportedLayers();
    setIntersectionResult(null);
    setIntersectionError("");
  };

  function handleExportDrawings() {
    const geojson = mapRef.current?.exportDrawings();

    if (!geojson) return;

    const blob = new Blob([geojson], {
      type: "application/geo+json",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `geomind-drawings-${new Date()
      .toISOString()
      .slice(0, 10)}.geojson`;

    link.click();
    URL.revokeObjectURL(url);
  }

  function handleExportLayer(layerId: string, layerName: string) {
    const geojson = mapRef.current?.getImportedGeoJSON(layerId);

    if (!geojson) {
      return;
    }

    const blob = new Blob([geojson], {
      type: "application/geo+json",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${layerName.replace(/[^a-zA-Z0-9-_]/g, "_")}.geojson`;

    link.click();
    URL.revokeObjectURL(url);
  }

  function refreshImportedLayers() {
    const layers = mapRef.current?.getImportedLayers();

    if (layers) {
      setImportedLayers(layers);
    }
  }
  async function handleCreateBuffer(
    geometryType: "Point" | "LineString",
    coordinates: number[] | number[][],
    distanceMetres: number,
  ) {
    const response = await fetch("http://127.0.0.1:8000/api/analysis/buffer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        geometry_type: geometryType,
        coordinates,
        distance_metres: distanceMetres,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail ?? "Buffer creation failed.");
    }

    if (!mapRef.current) {
      throw new Error("Map is not ready yet.");
    }

    mapRef.current.addBufferGeoJSON(JSON.stringify(data.geojson));
  }

  const handleAnalyzePointsInPolygon = async () => {
    if (!selectedFeature || selectedFeature.geometryType !== "Polygon") {
      return;
    }

    const importedLayers = mapRef.current?.getImportedPoints() ?? [];

    const points = importedLayers.flatMap((layer) =>
      layer.points.map((point) => point.coordinates),
    );

    if (points.length === 0) {
      setPointAnalysisResult({
        error: "Import a visible layer containing Point features first.",
      });
      return;
    }

    try {
      const coordinates = selectedFeature.coordinatesWGS84 as number[][][];

      const response = await fetch(
        "http://127.0.0.1:8000/api/analysis/point-in-polygon",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            polygon_coordinates: coordinates[0],
            points,
          }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail ?? "Point-in-polygon analysis failed.");
      }

      setPointAnalysisResult(data);

      mapRef.current?.highlightPointsInPolygon(
        data.points_inside.map(
          (point: { coordinates: [number, number] }) => point.coordinates,
        ),
      );
    } catch (error) {
      setPointAnalysisResult({
        error:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred.",
      });
    }
  };

  function handleClearPointAnalysis() {
    mapRef.current?.clearPointHighlights();
    setPointAnalysisResult(null);
  }

  const handleRunSpatialQuery = async () => {
    if (!spatialQueryLayerId || !mapRef.current) {
      setSpatialQueryError("Please select a layer.");
      return;
    }

    if (!spatialQueryTargetGeometry) {
      setSpatialQueryError("Draw a polygon and click Use Drawn Polygon first.");
      return;
    }

    if (spatialQueryTargetGeometry.type !== "Polygon") {
      setSpatialQueryError("The query boundary must be a polygon.");
      return;
    }

    const geoJSONText = mapRef.current.getImportedGeoJSON(spatialQueryLayerId);

    if (!geoJSONText) {
      setSpatialQueryError("Unable to read the selected layer.");
      return;
    }

    try {
      setSpatialQueryLoading(true);
      setSpatialQueryError("");
      setSpatialQueryResult(null);

      const response = await fetch(
        "http://127.0.0.1:8000/api/analysis/spatial-query",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            features: JSON.parse(geoJSONText).features,
            target_geometry: spatialQueryTargetGeometry,
            operation: spatialQueryOperation,
          }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Spatial query failed.");
      }

      setSpatialQueryResult(data);

      mapRef.current?.highlightSpatialQueryResults(
        data.results.map(
          (item: { index: number; feature: GeoJSONFeature }) => item.feature,
        ),
      );
    } catch (error) {
      setSpatialQueryError(
        error instanceof Error ? error.message : "Spatial query failed.",
      );
    } finally {
      setSpatialQueryLoading(false);
    }
  };

  const handleUseDrawnPolygon = () => {
    const drawings = mapRef.current?.exportDrawings();

    if (!drawings) {
      setSpatialQueryError("Unable to read map drawings.");
      return;
    }

    try {
      const collection = JSON.parse(drawings) as GeoJSONFeatureCollection;

      const polygonFeature = collection.features.find(
        (feature) => feature.geometry?.type === "Polygon",
      );

      if (!polygonFeature?.geometry) {
        setSpatialQueryError(
          "Draw a polygon on the map first using the Polygon tool.",
        );
        setSpatialQueryTargetReady(false);
        setSpatialQueryTargetGeometry(null);
        return;
      }

      setSpatialQueryTargetGeometry(polygonFeature.geometry);
      setSpatialQueryTargetReady(true);
      setSpatialQueryError("");
      setSpatialQueryResult(null);

      mapRef.current?.highlightSpatialQueryResults([]);
    } catch {
      setSpatialQueryError("Unable to read the drawn polygon.");
      setSpatialQueryTargetReady(false);
      setSpatialQueryTargetGeometry(null);
    }
  };

  async function handleRunClip() {
    if (!spatialQueryLayerId || !mapRef.current) {
      setSpatialQueryError("Please select a source layer.");
      return;
    }

    if (!spatialQueryTargetGeometry) {
      setSpatialQueryError(
        "Draw a polygon and select it as the boundary first.",
      );
      return;
    }

    if (spatialQueryTargetGeometry.type !== "Polygon") {
      setSpatialQueryError("The clip boundary must be a polygon.");
      return;
    }

    const geoJSONText = mapRef.current.getImportedGeoJSON(spatialQueryLayerId);

    if (!geoJSONText) {
      setSpatialQueryError("Unable to read the selected layer.");
      return;
    }

    try {
      setSpatialQueryLoading(true);
      setSpatialQueryError("");

      const response = await fetch("http://127.0.0.1:8000/api/analysis/clip", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          features: JSON.parse(geoJSONText).features,
          clip_geometry: spatialQueryTargetGeometry,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Clip operation failed.");
      }

      if (data.result_count === 0) {
        setSpatialQueryError("No features intersect the clipping boundary.");
        return;
      }

      mapRef.current.addClipResultGeoJSON(JSON.stringify(data.result));
      refreshImportedLayers();
    } catch (error) {
      setSpatialQueryError(
        error instanceof Error ? error.message : "Clip operation failed.",
      );
    } finally {
      setSpatialQueryLoading(false);
    }
  }

  useEffect(() => {
    const nextBaseMap = theme === "light" ? "light" : "dark";

    setBaseMap(nextBaseMap);
    mapRef.current?.setBaseMap(nextBaseMap);
  }, [theme]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("geomind-theme", theme);
  }, [theme]);

  useEffect(() => {
    mapRef.current?.setOnFeatureSelect(setSelectedFeature);
  }, []);

  const isDark = theme === "dark";

  return (
    <main
      className={`flex h-screen w-screen flex-col overflow-hidden ${
        isDark ? "bg-black text-white" : "bg-white text-black"
      }`}
    >
      {/* Application header */}
      <header className="z-40 flex h-16 shrink-0 items-center border-b border-neutral-800/70">
        <div className="min-w-0 flex-1">
          <AppHeader theme={theme} />
        </div>

        <div
          className={`flex h-full shrink-0 items-center border-l px-4 ${
            isDark ? "border-neutral-800 bg-black" : "border-gray-200 bg-white"
          }`}
        >
          <button
            type="button"
            onClick={() =>
              setTheme((current) => (current === "dark" ? "light" : "dark"))
            }
            aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
            title={`Switch to ${isDark ? "light" : "dark"} mode`}
            className={`rounded-lg border p-2 transition-colors ${
              isDark
                ? "border-neutral-700 text-neutral-200 hover:bg-neutral-800"
                : "border-gray-200 text-gray-700 hover:bg-gray-100"
            }`}
          >
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      {/* Main workspace */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar theme={theme} onOpenResearch={() => setIsResearchOpen(true)} />

        {/* Map and its floating controls */}
        <section className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="absolute inset-0 z-0">
            <GeoMap ref={mapRef} theme={theme} />
          </div>
          {/* Premium GIS location search */}

          <div className="pointer-events-none absolute left-1/2 top-4 z-50 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2">
            <div className="pointer-events-auto w-full">
              <LocationSearch
                theme={theme}
                onSelectLocation={(longitude, latitude) => {
                  mapRef.current?.goToLocation(longitude, latitude);
                }}
              />
            </div>
          </div>

          {/* Map navigation controls: top-right */}
          <div className="pointer-events-none absolute right-4 top-4 z-20 max-w-[calc(100%-2rem)]">
            <div className="pointer-events-auto *:static! *:inset-auto! *:m-0! *:transform-none!">
              <MapToolbar
                theme={theme}
                isLayersOpen={isLayersOpen}
                onZoomIn={() => mapRef.current?.zoomIn()}
                onZoomOut={() => mapRef.current?.zoomOut()}
                onReset={() => mapRef.current?.resetView()}
                onToggleLayers={() => setIsLayersOpen((open) => !open)}
              />
            </div>
          </div>

          {/* Workspace status: bottom-left */}
          <div className="pointer-events-none absolute bottom-4 left-4 z-10 max-w-[calc(100%-2rem)]">
            <div className="pointer-events-auto *:static! *:inset-auto! *:m-0! *:transform-none!">
              <WorkspaceStatus theme={theme} />
            </div>
          </div>

          {/* Drawing controls: bottom-center */}
          <div className="pointer-events-none absolute bottom-4 right-0 z-20 w-max max-w-[calc(100%-2rem)] -translate-x-1/2">
            <div className="pointer-events-auto *:static! *:inset-auto! *:m-0! *:transform-none!">
              <DrawingToolbar
                theme={theme}
                mode={drawingMode}
                onModeChange={(mode) => {
                  setDrawingMode(mode);
                  mapRef.current?.setDrawingMode(mode);
                }}
                onClear={() => mapRef.current?.clearDrawings()}
                onExport={handleExportDrawings}
                onImport={() => setIsImportOpen(true)}
              />
            </div>
          </div>
          {/* Spatial Query Builder */}

          {/* Spatial Query Builder — Glass UI */}
          <div
            className={`absolute left-4 top-4 z-20 flex w-80 max-h-[calc(100vh-9rem)] flex-col overflow-hidden rounded-2xl border p-[0.2rem] shadow-2xl backdrop-blur-2xl transition-all duration-300 ${
              isDark
                ? "border-white/10 bg-neutral-950/65 text-white shadow-black/30"
                : "border-white/70 bg-white/70 text-black shadow-gray-900/10"
            }`}
          >
            {/* Compact glass header */}
            <button
              type="button"
              onClick={() => setIsSpatialQueryExpanded((expanded) => !expanded)}
              aria-expanded={isSpatialQueryExpanded}
              className={`group flex w-full shrink-0 items-center gap-2.5 rounded-xl px-3 py-2 transition-all duration-200 ${
                isDark
                  ? "hover:bg-white/6 hover:shadow-[inset_0_0_18px_rgba(16,185,129,0.05)]"
                  : "hover:bg-white/60 hover:shadow-[inset_0_0_18px_rgba(16,185,129,0.08)]"
              }`}
            >
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-all duration-200 ${
                  isDark
                    ? "border-emerald-400/20 bg-emerald-400/10 group-hover:border-emerald-400/40 group-hover:bg-emerald-400/15"
                    : "border-emerald-500/20 bg-emerald-500/10 group-hover:bg-emerald-500/15"
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  className="h-4 w-4 text-emerald-500"
                >
                  <path d="M4 5h16M7 12h10M10 19h4" strokeLinecap="round" />
                  <circle cx="7" cy="5" r="1" fill="currentColor" />
                  <circle cx="17" cy="12" r="1" fill="currentColor" />
                </svg>
              </div>

              <div className="min-w-0 flex-1 text-left">
                <h3 className="text-xs font-semibold tracking-tight">
                  Spatial Query Builder
                </h3>
                <p className="mt-0.5 text-[10px] text-neutral-500">
                  {isSpatialQueryExpanded
                    ? "Query spatial relationships"
                    : spatialQueryResult
                      ? `${spatialQueryResult.matched_count} features matched`
                      : "Configure spatial analysis"}
                </p>
              </div>

              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`h-3.5 w-3.5 shrink-0 text-neutral-500 transition-all duration-200 group-hover:scale-110 group-hover:text-emerald-400 ${
                  isSpatialQueryExpanded ? "rotate-180" : ""
                }`}
              >
                <path
                  d="m6 9 6 6 6-6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {/* Expandable scroll area */}
            <div
              className={`grid min-h-0 transition-[grid-template-rows,opacity] duration-300 ease-in-out ${
                isSpatialQueryExpanded
                  ? "grid-rows-[1fr] opacity-100"
                  : "grid-rows-[0fr] opacity-0"
              }`}
              aria-hidden={!isSpatialQueryExpanded}
              inert={!isSpatialQueryExpanded}
            >
              <div className="min-h-0 overflow-hidden">
                <div
                  className={`max-h-[calc(100vh-13rem)] space-y-4 overflow-x-hidden overflow-y-auto overscroll-contain border-t p-4 ${
                    isDark
                      ? "border-white/10 scrollbar-thin-dark"
                      : "border-white/70 scrollbar-thin-light"
                  }`}
                >
                  <p className="text-xs leading-relaxed text-neutral-500">
                    Query imported features using a drawn polygon.
                  </p>

                  {/* Source layer */}
                  <div>
                    <label className="block text-xs font-medium text-neutral-500">
                      Source layer
                    </label>

                    <select
                      value={spatialQueryLayerId}
                      onChange={(event) =>
                        setSpatialQueryLayerId(event.target.value)
                      }
                      className={`mt-1.5 w-full rounded-xl border p-2.5 text-sm outline-none backdrop-blur-md transition-all focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/10 ${
                        isDark
                          ? "border-white/10 bg-neutral-900/60 text-white hover:border-white/20"
                          : "border-white/80 bg-white/50 text-black hover:border-emerald-500/30"
                      }`}
                    >
                      <option value="">Select imported layer</option>
                      {importedLayers.map((layer) => (
                        <option key={layer.id} value={layer.id}>
                          {layer.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Spatial operation */}
                  <div>
                    <label className="block text-xs font-medium text-neutral-500">
                      Spatial operation
                    </label>

                    <select
                      value={spatialQueryOperation}
                      onChange={(event) =>
                        setSpatialQueryOperation(
                          event.target.value as
                            | "intersects"
                            | "within"
                            | "contains",
                        )
                      }
                      className={`mt-1.5 w-full rounded-xl border p-2.5 text-sm outline-none backdrop-blur-md transition-all focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/10 ${
                        isDark
                          ? "border-white/10 bg-neutral-900/60 text-white hover:border-white/20"
                          : "border-white/80 bg-white/50 text-black hover:border-emerald-500/30"
                      }`}
                    >
                      <option value="intersects">Intersects</option>
                      <option value="within">Within</option>
                      <option value="contains">Contains</option>
                    </select>
                  </div>

                  {/* Use drawn polygon */}
                  <button
                    type="button"
                    onClick={handleUseDrawnPolygon}
                    className={`w-full rounded-xl border px-3 py-2.5 text-sm font-medium backdrop-blur-md transition-all duration-200 ${
                      isDark
                        ? "border-emerald-400/25 bg-emerald-400/4 hover:border-emerald-400/40 hover:bg-emerald-400/10"
                        : "border-emerald-500/25 bg-emerald-500/4 hover:bg-emerald-500/10"
                    }`}
                  >
                    Use Drawn Polygon
                  </button>

                  {/* Boundary status */}
                  <div
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                      isDark
                        ? "border-white/5 bg-white/2.5"
                        : "border-gray-200/60 bg-white/30"
                    }`}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        spatialQueryTargetReady
                          ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.65)]"
                          : "bg-neutral-500"
                      }`}
                    />
                    <span className="text-xs text-neutral-500">
                      {spatialQueryTargetReady
                        ? "Query boundary selected"
                        : "Draw a polygon to set the boundary"}
                    </span>
                  </div>

                  {/* Run spatial query */}
                  <button
                    type="button"
                    onClick={handleRunSpatialQuery}
                    disabled={spatialQueryLoading || !spatialQueryLayerId}
                    className="w-full rounded-xl border border-emerald-400/30 bg-emerald-500 px-3 py-2.5 text-sm font-semibold text-black shadow-lg shadow-emerald-950/10 transition-all duration-200 hover:bg-emerald-400 hover:shadow-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {spatialQueryLoading
                      ? "Running query..."
                      : "Run Spatial Query"}
                  </button>

                  {/* Clip */}
                  <button
                    type="button"
                    onClick={handleRunClip}
                    disabled={spatialQueryLoading || !spatialQueryLayerId}
                    className={`w-full rounded-xl border px-3 py-2.5 text-sm font-medium backdrop-blur-md transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
                      isDark
                        ? "border-white/10 bg-white/2.5 hover:border-emerald-400/30 hover:bg-emerald-400/6"
                        : "border-gray-200/80 bg-white/40 hover:border-emerald-500/30 hover:bg-emerald-500/5"
                    }`}
                  >
                    {spatialQueryLoading ? "Processing..." : "Clip Features"}
                  </button>

                  {/* Spatial Intersection */}
                  <div
                    className={`border-t pt-4 ${
                      isDark ? "border-white/10" : "border-gray-200/70"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setIsIntersectionExpanded((expanded) => !expanded)
                      }
                      aria-expanded={isIntersectionExpanded}
                      className={`group flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left backdrop-blur-md transition-all duration-200 ${
                        isDark
                          ? "border-white/10 bg-white/2.5 hover:border-emerald-400/25 hover:bg-white/5"
                          : "border-white/80 bg-white/40 hover:border-emerald-500/25 hover:bg-white/70"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">
                          Spatial Intersection
                        </span>
                        <span className="mt-1 block text-xs leading-relaxed text-neutral-500">
                          Find overlapping features between two layers
                        </span>
                      </span>

                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border text-sm text-emerald-500 transition-all duration-200 ${
                          isDark
                            ? "border-emerald-400/20 bg-emerald-400/6 group-hover:bg-emerald-400/15"
                            : "border-emerald-500/20 bg-emerald-500/5 group-hover:bg-emerald-500/10"
                        }`}
                      >
                        {isIntersectionExpanded ? "−" : "+"}
                      </span>
                    </button>

                    {isIntersectionExpanded && (
                      <div className="mt-3 space-y-3">
                        {/* Layer A */}
                        <div>
                          <label className="block text-xs font-medium text-neutral-500">
                            Layer A
                          </label>

                          <select
                            value={intersectionLayerAId}
                            onChange={(event) => {
                              setIntersectionLayerAId(event.target.value);
                              setIntersectionResult(null);
                              setIntersectionError("");
                            }}
                            className={`mt-1.5 w-full rounded-xl border p-2.5 text-sm outline-none backdrop-blur-md transition-all focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/10 ${
                              isDark
                                ? "border-white/10 bg-neutral-900/60 text-white hover:border-white/20"
                                : "border-white/80 bg-white/50 text-black hover:border-emerald-500/30"
                            }`}
                          >
                            <option value="">Select first layer</option>
                            {importedLayers.map((layer) => (
                              <option key={layer.id} value={layer.id}>
                                {layer.name}
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* Layer B */}
                        <div>
                          <label className="block text-xs font-medium text-neutral-500">
                            Layer B
                          </label>

                          <select
                            value={intersectionLayerBId}
                            onChange={(event) => {
                              setIntersectionLayerBId(event.target.value);
                              setIntersectionResult(null);
                              setIntersectionError("");
                            }}
                            className={`mt-1.5 w-full rounded-xl border p-2.5 text-sm outline-none backdrop-blur-md transition-all focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/10 ${
                              isDark
                                ? "border-white/10 bg-neutral-900/60 text-white hover:border-white/20"
                                : "border-white/80 bg-white/50 text-black hover:border-emerald-500/30"
                            }`}
                          >
                            <option value="">Select second layer</option>
                            {importedLayers.map((layer) => (
                              <option key={layer.id} value={layer.id}>
                                {layer.name}
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* Run intersection */}
                        <button
                          type="button"
                          onClick={handleRunIntersection}
                          disabled={
                            intersectionLoading ||
                            !intersectionLayerAId ||
                            !intersectionLayerBId
                          }
                          className="w-full rounded-xl border border-emerald-400/30 bg-emerald-500 px-3 py-2.5 text-sm font-semibold text-black shadow-lg shadow-emerald-950/10 transition-all duration-200 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {intersectionLoading
                            ? "Running intersection..."
                            : "Run Intersection"}
                        </button>

                        {/* Intersection error */}
                        {intersectionError && (
                          <p className="wrap-break-word rounded-xl border border-red-500/20 bg-red-500/6 p-3 text-xs leading-relaxed text-red-400 backdrop-blur-md">
                            {intersectionError}
                          </p>
                        )}

                        {/* Intersection results */}
                        {intersectionResult && (
                          <div
                            className={`rounded-xl border p-3 backdrop-blur-md ${
                              isDark
                                ? "border-emerald-400/20 bg-emerald-400/4.5"
                                : "border-emerald-500/20 bg-emerald-500/4"
                            }`}
                          >
                            <p className="text-xs font-medium text-neutral-500">
                              Intersection results
                            </p>

                            <p className="mt-1 text-2xl font-semibold tracking-tight text-emerald-500">
                              {intersectionResult.result_count}
                            </p>

                            <p className="mt-1 wrap-break-word text-xs leading-relaxed text-neutral-500">
                              Layer A: {intersectionResult.layer_a_count}{" "}
                              features
                              {" · "}
                              Layer B: {intersectionResult.layer_b_count}{" "}
                              features
                            </p>

                            {intersectionResult.skipped_count > 0 && (
                              <p className="mt-2 text-xs text-amber-500">
                                {intersectionResult.skipped_count} features
                                skipped
                              </p>
                            )}

                            {intersectionResult.result_count === 0 && (
                              <p className="mt-2 text-xs text-neutral-500">
                                No overlapping features were found.
                              </p>
                            )}
                          </div>
                        )}

                        {/* Clear intersection results */}
                        <button
                          type="button"
                          onClick={handleClearIntersectionResults}
                          className={`w-full rounded-xl border px-3 py-2 text-sm transition-all duration-200 ${
                            isDark
                              ? "border-white/10 bg-white/2.5 text-neutral-300 hover:border-red-400/25 hover:bg-red-400/6 hover:text-red-300"
                              : "border-gray-200/80 bg-white/40 text-gray-700 hover:border-red-500/25 hover:bg-red-500/4 hover:text-red-600"
                          }`}
                        >
                          Clear Intersection Results
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Spatial query error */}
                  {spatialQueryError && (
                    <p className="wrap-break-word rounded-xl border border-red-500/20 bg-red-500/6 p-3 text-xs leading-relaxed text-red-400 backdrop-blur-md">
                      {spatialQueryError}
                    </p>
                  )}

                  {/* Spatial query results */}
                  {spatialQueryResult && (
                    <div
                      className={`rounded-xl border p-3 backdrop-blur-md ${
                        isDark
                          ? "border-emerald-400/20 bg-emerald-400/4.5"
                          : "border-emerald-500/20 bg-emerald-500/4"
                      }`}
                    >
                      <p className="text-xs font-medium text-neutral-500">
                        Matching features
                      </p>

                      <p className="mt-1 text-2xl font-semibold text-emerald-500">
                        {spatialQueryResult.matched_count}
                      </p>

                      <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                        Matched {spatialQueryResult.matched_count} of{" "}
                        {spatialQueryResult.total_features} features
                      </p>

                      {spatialQueryResult.results.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {spatialQueryResult.results.map((item) => {
                            const properties = item.feature.properties ?? {};
                            const featureName =
                              properties.name ??
                              properties.Name ??
                              `Feature ${item.index + 1}`;

                            return (
                              <div
                                key={item.index}
                                className={`rounded-lg border p-2 backdrop-blur-sm ${
                                  isDark
                                    ? "border-white/10 bg-white/2.5"
                                    : "border-gray-200/70 bg-white/40"
                                }`}
                              >
                                <p className="truncate text-sm font-medium">
                                  {String(featureName)}
                                </p>

                                <p className="mt-1 text-xs text-neutral-500">
                                  {item.feature.geometry?.type ??
                                    "Unknown geometry"}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {spatialQueryResult.matched_count === 0 && (
                        <p className="mt-2 text-xs text-neutral-500">
                          No features matched this query.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Clear spatial query results */}
                  <button
                    type="button"
                    onClick={() => {
                      mapRef.current?.highlightSpatialQueryResults([]);
                      setSpatialQueryResult(null);
                      setSpatialQueryError("");
                    }}
                    className={`w-full rounded-xl border px-3 py-2 text-sm backdrop-blur-md transition-all duration-200 ${
                      isDark
                        ? "border-white/10 bg-white/2.5 hover:border-emerald-400/25 hover:bg-white/5"
                        : "border-gray-200/80 bg-white/40 hover:border-emerald-500/25 hover:bg-white/70"
                    }`}
                  >
                    Clear Results
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Selected feature details: right side */}
          {selectedFeature && (
            <div className="pointer-events-none absolute inset-0 z-20">
              <div className="pointer-events-auto absolute inset-0">
                <FeatureInspector
                  theme={theme}
                  feature={selectedFeature}
                  onClose={() => {
                    setSelectedFeature(null);
                    mapRef.current?.clearFeatureSelection();
                  }}
                  onCreateBuffer={handleCreateBuffer}
                  onAnalyzePointsInPolygon={handleAnalyzePointsInPolygon}
                  onClearPointAnalysis={handleClearPointAnalysis}
                  pointAnalysisResult={pointAnalysisResult}
                />
              </div>
            </div>
          )}

          {/* Layer chooser: aligned below the map controls */}
          {isLayersOpen && (
            <aside
              className={`absolute right-16 top-18 z-30 max-h-[calc(100%-6rem)] w-72 max-w-[calc(100%-2rem)] overflow-y-auto rounded-2xl border p-4 backdrop-blur-2xl backdrop-saturate-150 transition-all duration-300 ${
                isDark
                  ? "border-white/[0.14] bg-neutral-950/70 text-white shadow-[0_20px_55px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08)]"
                  : "border-white/80 bg-white/70 text-gray-900 shadow-[0_20px_55px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.85)]"
              }`}
            >
              {/* Base map */}
              <section>
                {/* <h3 className="text-sm font-semibold tracking-tight">
                  Base map
                </h3>

                <p
                  className={`mt-1 text-xs ${
                    isDark ? "text-neutral-400" : "text-gray-500"
                  }`}
                >
                  Choose your map appearance
                </p>

                <div className="mt-4 flex flex-col gap-2">
                  {(
                    [
                      {
                        value: "light",
                        label: "Light",
                        detail: "Light basemap",
                      },
                      { value: "dark", label: "Dark", detail: "Dark basemap" },
                      {
                        value: "satellite",
                        label: "Satellite",
                        detail: "Coming later",
                      },
                    ] as const
                  ).map((option) => {
                    const isSelected = baseMap === option.value;
                    const isDisabled = option.value === "satellite";

                    return (
                      <button
                        key={option.value}
                        type="button"
                        disabled={isDisabled}
                        onClick={() => {
                          if (isDisabled) return;

                          setBaseMap(option.value);
                          mapRef.current?.setBaseMap(option.value);
                        }}
                        className={`flex items-center justify-between rounded-xl border p-3 text-left transition-all duration-200 ${
                          isSelected
                            ? isDark
                              ? "border-emerald-400/35 bg-emerald-400/[0.12] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                              : "border-emerald-300/80 bg-emerald-50/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]"
                            : isDark
                              ? "border-white/[0.08] bg-white/[0.035] hover:border-white/20 hover:bg-white/[0.07]"
                              : "border-white/80 bg-white/40 hover:border-emerald-200/80 hover:bg-white/75"
                        } ${
                          isDisabled
                            ? "cursor-not-allowed opacity-40"
                            : "cursor-pointer"
                        }`}
                      >
                        <span>
                          <span className="block text-sm font-medium">
                            {option.label}
                          </span>

                          <span
                            className={`mt-1 block text-xs ${
                              isDark ? "text-neutral-400" : "text-gray-500"
                            }`}
                          >
                            {option.detail}
                          </span>
                        </span>

                        {isSelected && (
                          <span
                            className="text-sm font-semibold text-emerald-500"
                            aria-label="Selected"
                          >
                            ✓
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div> */}

                {/* Base map visibility */}
                <div
                >
                  <label
                    className={`flex cursor-pointer items-center gap-3 rounded-xl p-2 text-sm transition-colors ${
                      isDark ? "hover:bg-white/[0.05]" : "hover:bg-white/60"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isBaseLayerVisible}
                      onChange={(event) => {
                        const visible = event.target.checked;

                        mapRef.current?.toggleBaseLayer(visible);
                        setIsBaseLayerVisible(visible);
                      }}
                      className="accent-emerald-500"
                    />
                    Show base map
                  </label>
                </div>
              </section>

              {/* Imported layers */}
              <section
                className={`mt-4 border-t pt-4 ${
                  isDark ? "border-white/[0.09]" : "border-gray-200/70"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Layers size={16} className="shrink-0 text-emerald-500" />

                  <h3 className="text-sm font-semibold tracking-tight">
                    Imported Layers
                  </h3>

                  <span
                    className={`ml-auto rounded-lg border px-2 py-0.5 text-xs ${
                      isDark
                        ? "border-white/[0.08] bg-white/[0.04] text-neutral-400"
                        : "border-white/80 bg-white/60 text-gray-500"
                    }`}
                  >
                    {importedLayers.length}
                  </span>
                </div>

                {importedLayers.length === 0 ? (
                  <p
                    className={`mt-3 rounded-xl border border-dashed p-3 text-xs leading-relaxed ${
                      isDark
                        ? "border-white/[0.10] bg-white/[0.025] text-neutral-400"
                        : "border-gray-200/80 bg-white/45 text-gray-500"
                    }`}
                  >
                    No imported layers yet. Upload a GeoJSON file to get
                    started.
                  </p>
                ) : (
                  <div className="mt-3 flex max-h-64 flex-col gap-2 overflow-y-auto pr-0.5">
                    {importedLayers.map((layer) => (
                      <div
                        key={layer.id}
                        className={`rounded-xl border p-3 backdrop-blur-xl transition-all duration-200 ${
                          isDark
                            ? "border-white/[0.09] bg-white/[0.035] hover:bg-white/[0.06]"
                            : "border-white/85 bg-white/50 hover:bg-white/75"
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-xs font-medium">
                            {layer.name}
                          </span>

                          <button
                            type="button"
                            title={layer.visible ? "Hide layer" : "Show layer"}
                            aria-label={
                              layer.visible ? "Hide layer" : "Show layer"
                            }
                            onClick={() => {
                              mapRef.current?.setImportedLayerVisibility(
                                layer.id,
                                !layer.visible,
                              );
                              refreshImportedLayers();
                            }}
                            className={`rounded-lg p-1.5 transition-colors ${
                              layer.visible
                                ? "text-emerald-500 hover:bg-emerald-500/10"
                                : isDark
                                  ? "text-neutral-500 hover:bg-white/[0.08] hover:text-emerald-400"
                                  : "text-gray-400 hover:bg-emerald-50 hover:text-emerald-700"
                            }`}
                          >
                            {layer.visible ? (
                              <Eye size={15} />
                            ) : (
                              <EyeOff size={15} />
                            )}
                          </button>

                          <button
                            type="button"
                            title="Zoom to layer"
                            aria-label={`Zoom to ${layer.name}`}
                            onClick={() => {
                              mapRef.current?.zoomToImportedLayer(layer.id);
                            }}
                            className={`rounded-lg p-1.5 transition-colors ${
                              isDark
                                ? "text-neutral-300 hover:bg-white/[0.08] hover:text-white"
                                : "text-gray-500 hover:bg-white/80 hover:text-gray-900"
                            }`}
                          >
                            <Maximize2 size={15} />
                          </button>

                          <button
                            type="button"
                            title="Export GeoJSON"
                            aria-label={`Export ${layer.name} as GeoJSON`}
                            onClick={() =>
                              handleExportLayer(layer.id, layer.name)
                            }
                            className={`rounded-lg p-1.5 transition-colors ${
                              isDark
                                ? "text-neutral-300 hover:bg-white/[0.08] hover:text-emerald-400"
                                : "text-gray-500 hover:bg-emerald-50 hover:text-emerald-700"
                            }`}
                          >
                            <Download size={15} />
                          </button>

                          <button
                            type="button"
                            title="Remove layer"
                            aria-label={`Remove ${layer.name}`}
                            onClick={() => {
                              mapRef.current?.removeImportedLayer(layer.id);
                              refreshImportedLayers();
                            }}
                            className="rounded-lg p-1.5 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-500"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>

                        <p
                          className={`mt-2 text-xs ${
                            isDark ? "text-neutral-400" : "text-gray-500"
                          }`}
                        >
                          {layer.count} features
                        </p>

                        <div className="mt-2 flex flex-wrap gap-1">
                          {layer.geometryTypes.map((type) => (
                            <span
                              key={type}
                              className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
                                isDark
                                  ? "border-blue-400/15 bg-blue-400/[0.08] text-blue-300"
                                  : "border-blue-200/70 bg-blue-50/80 text-blue-600"
                              }`}
                            >
                              {type}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </aside>
          )}
        </section>

        {/* Research panel remains outside the map canvas */}
        {isResearchOpen && (
          <ResearchPanel
            theme={theme}
            onClose={() => setIsResearchOpen(false)}
          />
        )}

        {/* GeoJSON import dialog */}
        {isImportOpen && (
          <GeoJSONImport
            theme={theme}
            onClose={() => setIsImportOpen(false)}
            onImport={(content) => {
              const result = mapRef.current?.importGeoJSON(content);

              if (!result) {
                throw new Error("Map is not ready yet.");
              }

              refreshImportedLayers();
              return result;
            }}
          />
        )}
      </div>
    </main>
  );
}
