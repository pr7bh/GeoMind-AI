import { useEffect, useRef, useState } from "react";
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
  const [isResearchOpen, setIsResearchOpen] = useState(true);
  const [isLayersOpen, setIsLayersOpen] = useState(false);
  const [isBaseLayerVisible, setIsBaseLayerVisible] = useState(true);
  const [baseMap, setBaseMap] = useState<BaseMapType>("dark");
  const [drawingMode, setDrawingMode] = useState<DrawingMode>("none");
  const [selectedFeature, setSelectedFeature] =
    useState<SelectedFeatureInfo | null>(null);
  const mapRef = useRef<GeoMapHandle>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);

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
            isDark
              ? "border-neutral-800 bg-black"
              : "border-gray-200 bg-white"
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
        <Sidebar
          theme={theme}
          onOpenResearch={() => setIsResearchOpen(true)}
        />

        {/* Map and its floating controls */}
        <section className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="absolute inset-0 z-0">
            <GeoMap ref={mapRef} />
          </div>

          {/* Search: centered at the top */}
          
{/* Premium GIS location search */}
<div className="pointer-events-none absolute left-1/2 top-4 z-30 w-[min(28rem,calc(100%_-_2rem))] -translate-x-1/2">
  <div
    className={`pointer-events-auto rounded-2xl border shadow-2xl backdrop-blur-xl transition-all duration-200 ${
      isDark
        ? "border-white/10 bg-neutral-950/90 shadow-black/40"
        : "border-gray-200/80 bg-white/95 shadow-gray-900/10"
    }`}
  >
    <LocationSearch
      theme={theme}
      onSelectLocation={(longitude, latitude) => {
        mapRef.current?.goToLocation(longitude, latitude);
      }}
    />
  </div>

</div>


          {/* Map navigation controls: top-right */}
          <div className="pointer-events-none absolute right-4 top-4 z-20 max-w-[calc(100%_-_2rem)]">
            <div className="pointer-events-auto [&>*]:!static [&>*]:!inset-auto [&>*]:!m-0 [&>*]:!transform-none">
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
          <div className="pointer-events-none absolute bottom-4 left-4 z-10 max-w-[calc(100%_-_2rem)]">
            <div className="pointer-events-auto [&>*]:!static [&>*]:!inset-auto [&>*]:!m-0 [&>*]:!transform-none">
              <WorkspaceStatus theme={theme} />
            </div>
          </div>

          {/* Drawing controls: bottom-center */}
          <div className="pointer-events-none absolute bottom-4 right-0 z-20 w-max max-w-[calc(100%_-_2rem)] -translate-x-1/2">
            <div className="pointer-events-auto [&>*]:!static [&>*]:!inset-auto [&>*]:!m-0 [&>*]:!transform-none">
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

          {/* Selected feature details: right side */}
          {selectedFeature && (
            <aside className="pointer-events-none absolute right-4 top-1/2 z-20 w-[min(21rem,calc(100%_-_2rem))] -translate-y-1/2">
              <div className="pointer-events-auto max-h-[calc(100vh_-_9rem)] overflow-y-auto [&>*]:!static [&>*]:!inset-auto [&>*]:!m-0 [&>*]:!w-full [&>*]:!transform-none">
                <FeatureInspector
                  theme={theme}
                  feature={selectedFeature}
                  onClose={() => {
                    setSelectedFeature(null);
                    mapRef.current?.clearFeatureSelection();
                  }}
                  onCreateBuffer={handleCreateBuffer}
                />
              </div>
            </aside>
          )}

          {/* Layer chooser: aligned below the map controls */}
          {isLayersOpen && (
            <aside
              className={`absolute right-16 top-[4.5rem] z-30 max-h-[calc(100%_-_6rem)] w-72 max-w-[calc(100%_-_2rem)] overflow-y-auto rounded-xl border p-4 shadow-2xl backdrop-blur-xl ${
                isDark
                  ? "border-neutral-800 bg-neutral-950/95 text-white"
                  : "border-gray-200 bg-white/95 text-black"
              }`}
            >
              <h3 className="text-sm font-semibold">Base map</h3>
              <p
                className={`mt-1 text-xs ${
                  isDark ? "text-neutral-500" : "text-gray-500"
                }`}
              >
                Choose your map appearance
              </p>

              <div className="mt-4 flex flex-col gap-2">
                {(
                  [
                    { value: "light", label: "Light", detail: "OpenStreetMap" },
                    { value: "dark", label: "Dark", detail: "CARTO Dark" },
                    {
                      value: "satellite",
                      label: "Satellite",
                      detail: "Coming later",
                    },
                  ] as const
                ).map((option) => {
                  const isSelected = baseMap === option.value;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={option.value === "satellite"}
                      onClick={() => {
                        setBaseMap(option.value);
                        mapRef.current?.setBaseMap(option.value);
                      }}
                      className={`flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                        isSelected
                          ? "border-emerald-500 bg-emerald-500/10"
                          : isDark
                            ? "border-neutral-800 hover:bg-neutral-900"
                            : "border-gray-200 hover:bg-gray-50"
                      } ${
                        option.value === "satellite"
                          ? "cursor-not-allowed opacity-40"
                          : ""
                      }`}
                    >
                      <span>
                        <span className="block text-sm font-medium">
                          {option.label}
                        </span>
                        <span
                          className={`mt-1 block text-xs ${
                            isDark ? "text-neutral-500" : "text-gray-500"
                          }`}
                        >
                          {option.detail}
                        </span>
                      </span>

                      {isSelected && (
                        <span
                          className="text-emerald-500"
                          aria-label="Selected"
                        >
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div
                className={`mt-4 border-t pt-3 ${
                  isDark ? "border-neutral-800" : "border-gray-200"
                }`}
              >
                <label className="flex cursor-pointer items-center gap-3 text-sm">
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

              <div
                className={`mt-4 border-t pt-4 ${
                  isDark ? "border-neutral-800" : "border-gray-200"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Layers size={16} className="shrink-0 text-emerald-500" />
                  <h3 className="text-sm font-semibold">Imported Layers</h3>
                  <span className="ml-auto text-xs text-neutral-500">
                    {importedLayers.length}
                  </span>
                </div>

                {importedLayers.length === 0 ? (
                  <p
                    className={`mt-3 text-xs leading-relaxed ${
                      isDark ? "text-neutral-500" : "text-gray-500"
                    }`}
                  >
                    No imported layers yet. Upload a GeoJSON file to get
                    started.
                  </p>
                ) : (
                  <div className="mt-3 flex max-h-64 flex-col gap-2 overflow-y-auto">
                    {importedLayers.map((layer) => (
                      <div
                        key={layer.id}
                        className={`rounded-lg border p-2 ${
                          isDark
                            ? "border-neutral-800 bg-neutral-900/50"
                            : "border-gray-200 bg-gray-50"
                        }`}
                      >
                        <div className="flex items-center gap-2">
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
                            className="rounded p-1 text-emerald-500 hover:bg-emerald-500/10"
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
                            className={`rounded p-1 ${
                              isDark
                                ? "text-neutral-300 hover:bg-neutral-800"
                                : "text-gray-600 hover:bg-gray-100"
                            }`}
                          >
                            <Maximize2 size={15} />
                          </button>

                          <button
                            type="button"
                            title="Remove layer"
                            aria-label={`Remove ${layer.name}`}
                            onClick={() => {
                              mapRef.current?.removeImportedLayer(layer.id);
                              refreshImportedLayers();
                            }}
                            className="rounded p-1 text-red-500 hover:bg-red-500/10"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>

                        <p
                          className={`mt-1 text-xs ${
                            isDark ? "text-neutral-500" : "text-gray-500"
                          }`}
                        >
                          {layer.count} features
                        </p>

                        <div className="mt-2 flex flex-wrap gap-1">
                          {layer.geometryTypes.map((type) => (
                            <span
                              key={type}
                              className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-500"
                            >
                              {type}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </aside>
          )}

          {/* Reopen research when the panel is closed */}
          {!isResearchOpen && (
            <button
              type="button"
              onClick={() => setIsResearchOpen(true)}
              className="absolute bottom-4 right-4 z-20 rounded-lg border border-emerald-500/30 bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-lg shadow-emerald-950/20 transition-colors hover:bg-emerald-500"
            >
              Open Research Agent
            </button>
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
