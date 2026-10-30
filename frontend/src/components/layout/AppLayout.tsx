import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
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
  Upload,
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
import DiscoveryTool from "../tools/DiscoveryTool";
import NearestFeatureTool from "../tools/NearestFeatureTool";
import HeatmapTool from "../tools/HeatmapTool";
import RoutingTool from "../tools/RoutingTool";
import SpatialQueryTool from "../tools/SpatialQueryTool";
import IntersectionTool from "../tools/IntersectionTool";
import BufferTool from "../tools/BufferTool";
import ToolPanel from "../tools/ToolPanel";
import { WORKSPACE_TOOLS } from "../tools/registry";
import type { WorkspaceToolId } from "../tools/registry";
import { useMapPicker } from "../map/useMapPicker";
import MapPickBanner from "../map/MapPickBanner";
import { postJSON } from "../../lib/api";

type Theme = "light" | "dark";

const LAYER_SOURCE_LABELS: Record<ImportedLayerInfo["kind"], string> = {
  discovery: "OpenStreetMap",
  imported: "Imported",
  analysis: "Analysis",
};

export default function AppLayout() {
  const [theme, setTheme] = useState<Theme>(() => {
    const savedTheme = localStorage.getItem("geomind-theme");
    return savedTheme === "light" ? "light" : "dark";
  });
  const [importedLayers, setImportedLayers] = useState<ImportedLayerInfo[]>([]);
  const [isResearchOpen, setIsResearchOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<WorkspaceToolId | null>(null);
  const [isBaseLayerVisible, setIsBaseLayerVisible] = useState(true);
  const [, setBaseMap] = useState<BaseMapType>("dark");
  const [drawingMode, setDrawingMode] = useState<DrawingMode>("none");
  const [selectedFeature, setSelectedFeature] =
    useState<SelectedFeatureInfo | null>(null);
    const [nearestFeatureDetails, setNearestFeatureDetails] =
  useState<{
    properties: Record<string, unknown>;
    distanceMetres: number;
  } | null>(null);
  const mapRef = useRef<GeoMapHandle>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [pointAnalysisResult, setPointAnalysisResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [routeStart, setRouteStart] = useState<[number, number] | null>(null);
  const [routeDestination, setRouteDestination] = useState<
    [number, number] | null
  >(null);

  function applyDrawingMode(mode: DrawingMode) {
    setDrawingMode(mode);
    mapRef.current?.setDrawingMode(mode);
  }

  const picker = useMapPicker(mapRef, {
    mode: drawingMode,
    setMode: applyDrawingMode,
  });

  function handleSelectTool(tool: WorkspaceToolId) {
    // A pending pick belongs to the panel being left; chosen points are kept.
    picker.cancel();
    setActiveTool((current) => (current === tool ? null : tool));
  }

  const toolProps = { theme, mapRef, importedLayers };

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
    const data = await postJSON<{ geojson: unknown }>(
      "/api/analysis/buffer",
      {
        geometry_type: geometryType,
        coordinates,
        distance_metres: distanceMetres,
      },
      "Buffer creation failed.",
    );

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

      const data = await postJSON<{
        points_inside: { coordinates: [number, number] }[];
      }>(
        "/api/analysis/point-in-polygon",
        {
          polygon_coordinates: coordinates[0],
          points,
        },
        "Point-in-polygon analysis failed.",
      );

      setPointAnalysisResult(data);

      mapRef.current?.highlightPointsInPolygon(
        data.points_inside.map((point) => point.coordinates),
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
  mapRef.current?.setOnFeatureSelect((feature) => {
    setSelectedFeature(feature);
    setNearestFeatureDetails(null);
  });
}, []);

  const isDark = theme === "dark";

  const toolContent: Record<WorkspaceToolId, ReactNode> = {
    discovery: (
      <DiscoveryTool
        {...toolProps}
        picker={picker}
        onLayersChanged={refreshImportedLayers}
      />
    ),
    routing: (
      <RoutingTool
        theme={theme}
        mapRef={mapRef}
        picker={picker}
        start={routeStart}
        destination={routeDestination}
        onStartChange={setRouteStart}
        onDestinationChange={setRouteDestination}
      />
    ),
    nearest: <NearestFeatureTool {...toolProps} picker={picker} />,
    buffer: (
      <BufferTool
        {...toolProps}
        picker={picker}
        onLayersChanged={refreshImportedLayers}
      />
    ),
    "spatial-query": (
      <SpatialQueryTool
        {...toolProps}
        picker={picker}
        onLayersChanged={refreshImportedLayers}
      />
    ),
    intersection: (
      <IntersectionTool {...toolProps} onLayersChanged={refreshImportedLayers} />
    ),
    heatmap: <HeatmapTool {...toolProps} />,
    layers: (
      <>
              <button
                type="button"
                onClick={() => setIsImportOpen(true)}
                className={`mb-4 flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                  isDark
                    ? "border-emerald-400/25 text-emerald-400 hover:bg-emerald-400/10"
                    : "border-emerald-500/30 text-emerald-700 hover:bg-emerald-50"
                }`}
              >
                <Upload size={15} />
                Import GeoJSON
              </button>
              {/* Imported layers */}
              <section>
                <div className="flex items-center gap-2">
                  <Layers size={16} className="shrink-0 text-emerald-500" />

                  <h3 className="text-sm font-semibold tracking-tight">
                    Map Layers
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
                    No layers yet. Upload a GeoJSON file or discover OSM
                    features to get started.
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
                          {layer.color && (
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: layer.color }}
                            />
                          )}
                          <span
                            className="min-w-0 flex-1 truncate text-xs font-medium"
                            title={layer.name}
                          >
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
                          {layer.count} feature{layer.count === 1 ? "" : "s"}
                        </p>

                        <div className="mt-2 flex flex-wrap gap-1">
                          <span
                            className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                              layer.kind === "discovery"
                                ? isDark
                                  ? "border-amber-400/20 bg-amber-400/10 text-amber-300"
                                  : "border-amber-200 bg-amber-50 text-amber-700"
                                : layer.kind === "analysis"
                                  ? isDark
                                    ? "border-violet-400/20 bg-violet-400/10 text-violet-300"
                                    : "border-violet-200 bg-violet-50 text-violet-700"
                                  : isDark
                                    ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                                    : "border-emerald-200 bg-emerald-50 text-emerald-700"
                            }`}
                          >
                            {LAYER_SOURCE_LABELS[layer.kind]}
                          </span>
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

                {importedLayers.some((layer) => layer.kind === "discovery") && (
                  <button
                    type="button"
                    onClick={() => {
                      mapRef.current?.clearDiscoveryLayers();
                      refreshImportedLayers();
                    }}
                    className={`mt-3 w-full rounded-xl border px-3 py-2 text-xs transition-all ${
                      isDark
                        ? "border-white/10 bg-white/5 hover:border-red-400/25 hover:text-red-300"
                        : "border-gray-200 bg-white/60 hover:border-red-500/25 hover:text-red-600"
                    }`}
                  >
                    Clear Discovery Layers
                  </button>
                )}
              </section>
      </>
    ),
    settings: (
      <>
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
                <div>
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
              {/* Appearance */}
              <section
                className={`mt-4 border-t pt-4 ${
                  isDark ? "border-white/[0.09]" : "border-gray-200/70"
                }`}
              >
                <h3 className="text-sm font-semibold tracking-tight">Appearance</h3>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {(["dark", "light"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setTheme(option)}
                      aria-pressed={theme === option}
                      className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium capitalize transition-colors ${
                        theme === option
                          ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-500"
                          : isDark
                            ? "border-white/10 hover:bg-white/5"
                            : "border-gray-200 hover:bg-gray-50"
                      }`}
                    >
                      {option === "dark" ? <Moon size={14} /> : <Sun size={14} />}
                      {option}
                    </button>
                  ))}
                </div>
              </section>
      </>
    ),
  };

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
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <Sidebar
          theme={theme}
          activeTool={activeTool}
          isResearchOpen={isResearchOpen}
          onSelectTool={handleSelectTool}
          onToggleResearch={() => setIsResearchOpen((open) => !open)}
        />

        {/* Map and its floating controls */}
        <section className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="absolute inset-0 z-0">
            <GeoMap ref={mapRef} theme={theme} />
          </div>
          {/* Premium GIS location search */}

          <div className="pointer-events-none absolute left-1/2 top-4 z-50 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 max-[900px]:left-2 max-[900px]:w-[calc(100%-4.5rem)] max-[900px]:translate-x-0">
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
                isLayersOpen={activeTool === "layers"}
                onZoomIn={() => mapRef.current?.zoomIn()}
                onZoomOut={() => mapRef.current?.zoomOut()}
                onReset={() => mapRef.current?.resetView()}
                onToggleLayers={() => handleSelectTool("layers")}
              />
            </div>
          </div>

          {/* Workspace status: bottom-left */}
          <div className="pointer-events-none absolute bottom-4 left-4 z-10 max-w-[calc(100%-2rem)] max-[900px]:hidden">
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
                  picker.cancel();
                  applyDrawingMode(mode);
                }}
                onClear={() => mapRef.current?.clearDrawings()}
                onExport={handleExportDrawings}
                onImport={() => setIsImportOpen(true)}
              />
            </div>
          </div>

          {/* Map-pick instruction */}
          {picker.active && (
            <div className="pointer-events-none absolute left-1/2 top-20 z-50 -translate-x-1/2 max-[900px]:left-2 max-[900px]:right-16 max-[900px]:translate-x-0">
              <MapPickBanner
                isDark={isDark}
                pick={picker.active}
                onCancel={() => picker.cancel()}
              />
            </div>
          )}

          {/* Active tool panel. All panels stay mounted so selections survive switching. */}
          <div className="pointer-events-none absolute bottom-16 left-4 top-4 z-30 flex items-start max-[900px]:bottom-2 max-[900px]:left-2 max-[900px]:right-16 max-[900px]:top-auto max-[900px]:items-end">
            {WORKSPACE_TOOLS.map((tool) => (
              <ToolPanel
                key={tool.id}
                isDark={isDark}
                tool={tool}
                hidden={activeTool !== tool.id}
                onClose={() => handleSelectTool(tool.id)}
              >
                {toolContent[tool.id]}
              </ToolPanel>
            ))}
          </div>

          {/* Selected feature details: right side */}
          {selectedFeature && (
            <div className="pointer-events-none absolute inset-0 z-20">
              {/* Drag bounds only (right of the tool panel, below the search bar);
                  the inspector itself re-enables pointer events. */}
              <div
                className={`pointer-events-none absolute bottom-0 right-16 top-20 max-[900px]:bottom-auto max-[900px]:left-2 max-[900px]:right-16 max-[900px]:top-[4.5rem] ${
                  activeTool
                    ? "left-[21.5rem] max-[900px]:h-[36vh]"
                    : "left-0 max-[900px]:h-[60vh]"
                }`}
              >
                <FeatureInspector
                  theme={theme}
                  feature={selectedFeature}
                  onClose={() => {
                    setSelectedFeature(null);
setNearestFeatureDetails(null);
mapRef.current?.clearFeatureSelection();
                  }}
                  onCreateBuffer={handleCreateBuffer}
                  onAnalyzePointsInPolygon={handleAnalyzePointsInPolygon}
                  onClearPointAnalysis={handleClearPointAnalysis}
                  pointAnalysisResult={pointAnalysisResult}
                  nearestFeatureDetails={nearestFeatureDetails}
                />
              </div>
            </div>
          )}

        </section>

        {/* Research panel remains outside the map canvas */}
        {isResearchOpen && (
          <ResearchPanel
            theme={theme}
            onClose={() => setIsResearchOpen(false)}
            routeStart={routeStart}
            routeDestination={routeDestination}
            onRouteResult={(route) => {
              mapRef.current?.showRoadRoute(route.geometry);
            }}
            getNearestFeaturesInput={() =>
              mapRef.current?.getNearestFeaturesInput() ?? null
            }
            onNearestFeaturesResult={(origin, features) => {
              mapRef.current?.highlightNearestFeatures(origin, features);
            }}
            onNearestFeatureSelect={(origin, feature, distanceMetres) => {
  mapRef.current?.highlightNearestFeature(origin, feature);

  const geometry = feature.geometry;

  if (!geometry) return;

  setSelectedFeature({
    id: String(
      feature.id ??
        feature.properties?.name ??
        feature.properties?.Name ??
        "Nearest feature",
    ),
    geometryType: geometry.type,
    coordinates: "coordinates" in geometry ? geometry.coordinates : null,
    coordinatesWGS84: "coordinates" in geometry ? geometry.coordinates : null,
  });

  setNearestFeatureDetails({
    properties: feature.properties ?? {},
    distanceMetres,
  });
}}
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
