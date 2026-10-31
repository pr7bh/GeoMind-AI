import { useState } from "react";
import type {
  Feature as GeoJSONFeature,
  FeatureCollection as GeoJSONFeatureCollection,
  Geometry as GeoJSONGeometry,
} from "geojson";
import { postJSON } from "../../lib/api";
import { useRequest } from "../../lib/useRequest";
import LayerSelect from "./LayerSelect";
import { readLayerFeatures } from "./readLayerFeatures";
import { EmptyNote, ErrorNote, FeatureList, ResultCard, RunButton } from "./ToolUI";
import type { MapPickProps, ToolProps } from "./types";

type SpatialOperation = "intersects" | "within" | "contains";

interface SpatialQueryResult {
  operation: string;
  total_features: number;
  matched_count: number;
  results: {
    index: number;
    feature: GeoJSONFeature;
  }[];
}

interface ClipResult {
  input_count: number;
  result_count: number;
  skipped_count: number;
  result: GeoJSONFeatureCollection;
}

type ToolResult =
  | { kind: "query"; data: SpatialQueryResult; layerName: string }
  | { kind: "clip"; data: ClipResult; layerId: string | null; layerName: string };

interface SpatialQueryToolProps extends ToolProps, MapPickProps {
  onLayersChanged: () => void;
}

const OPERATION_HELP: Record<SpatialOperation, string> = {
  intersects: "Features touching or overlapping the boundary.",
  within: "Features entirely inside the boundary.",
  contains: "Features that fully contain the boundary.",
};

export default function SpatialQueryTool({
  theme,
  mapRef,
  importedLayers,
  onLayersChanged,
  picker,
}: SpatialQueryToolProps) {
  const isDark = theme === "dark";
  const pickingPolygon = picker.isPicking("spatial-query", "polygon");

  const [layerId, setLayerId] = useState("");
  const [operation, setOperation] = useState<SpatialOperation>("within");
  const [result, setResult] = useState<ToolResult | null>(null);
  const [error, setError] = useState("");
  const [targetGeometry, setTargetGeometry] =
    useState<GeoJSONGeometry | null>(null);
  const request = useRequest();

  const layerName =
    importedLayers.find((layer) => layer.id === layerId)?.name ?? "layer";

  function validateInput() {
    if (!layerId) {
      setError("Select a source layer.");
      return false;
    }

    if (!targetGeometry) {
      setError("Select a boundary polygon on the map or use a drawn polygon.");
      return false;
    }

    return true;
  }

  async function handleRunQuery() {
    if (!validateInput()) return;

    setError("");

    try {
      const features = readLayerFeatures(mapRef, layerId);
      const data = await request.run((signal) =>
        postJSON<SpatialQueryResult>(
          "/api/analysis/spatial-query",
          { features, target_geometry: targetGeometry, operation },
          "Spatial query failed.",
          { signal },
        ),
      );

      if (!data) return;

      setResult({ kind: "query", data, layerName });
      mapRef.current?.highlightSpatialQueryResults(
        data.results.map((item) => item.feature),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Spatial query failed.");
    }
  }

  async function handleRunClip() {
    if (!validateInput()) return;

    setError("");

    try {
      const features = readLayerFeatures(mapRef, layerId);
      const data = await request.run((signal) =>
        postJSON<ClipResult>(
          "/api/analysis/clip",
          { features, clip_geometry: targetGeometry },
          "Clip operation failed.",
          { signal },
        ),
      );

      if (!data) return;

      const clipLayerId =
        data.result_count > 0
          ? (mapRef.current?.addClipResultGeoJSON(JSON.stringify(data.result)) ?? null)
          : null;

      mapRef.current?.highlightSpatialQueryResults([]);
      setResult({ kind: "clip", data, layerId: clipLayerId, layerName });
      onLayersChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Clip operation failed.");
    }
  }

  function handleUseDrawnPolygon() {
    const drawings = mapRef.current?.exportDrawings();

    if (!drawings) {
      setError("Unable to read map drawings.");
      return;
    }

    try {
      const collection = JSON.parse(drawings) as GeoJSONFeatureCollection;
      const polygonFeature = collection.features.find(
        (feature) => feature.geometry?.type === "Polygon",
      );

      if (!polygonFeature?.geometry) {
        setError("Draw a polygon on the map first using the Polygon tool.");
        return;
      }

      setTargetGeometry(polygonFeature.geometry);
      setError("");
    } catch {
      setError("Unable to read the drawn polygon.");
    }
  }

  function handleSelectPolygon() {
    setError("");
    picker.pickFeature(
      "spatial-query",
      "polygon",
      "Click a polygon on the map to use as the boundary",
      ["Polygon", "MultiPolygon"],
      (feature) => setTargetGeometry(feature.geometry),
    );
  }

  function handleClearResult() {
    mapRef.current?.highlightSpatialQueryResults([]);

    if (result?.kind === "clip" && result.layerId) {
      mapRef.current?.removeImportedLayer(result.layerId);
      onLayersChanged();
    }

    setResult(null);
    setError("");
  }

  function handleReset() {
    request.cancel();
    picker.cancel("spatial-query");
    handleClearResult();
    setTargetGeometry(null);
  }

  const secondaryButton = `min-h-10 rounded-xl border px-3 py-2.5 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
    isDark
      ? "border-white/10 bg-white/5 hover:border-emerald-400/30"
      : "border-gray-200 bg-white/60 hover:border-emerald-500/30"
  }`;

  return (
    <div className="space-y-4">
      <LayerSelect
        isDark={isDark}
        label="Source layer"
        placeholder="Select a layer"
        value={layerId}
        layers={importedLayers}
        onChange={setLayerId}
      />

      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Spatial relationship
        </label>
        <select
          value={operation}
          onChange={(event) => setOperation(event.target.value as SpatialOperation)}
          className={`gm-glass-field mt-1.5 w-full rounded-xl border p-2.5 text-sm outline-none transition-all focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/10 ${
            isDark
              ? "border-white/10 text-white hover:border-white/20"
              : "border-gray-200 text-black hover:border-emerald-500/30"
          }`}
        >
          <option value="intersects">Intersects</option>
          <option value="within">Within</option>
          <option value="contains">Contains</option>
        </select>
        <p className="mt-1 text-[11px] text-neutral-500">{OPERATION_HELP[operation]}</p>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-neutral-500">Boundary polygon</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={
              pickingPolygon ? () => picker.cancel("spatial-query") : handleSelectPolygon
            }
            className={
              pickingPolygon
                ? "min-h-10 rounded-xl border border-amber-400/50 bg-amber-400/10 px-3 py-2.5 text-xs font-medium text-amber-500"
                : secondaryButton
            }
          >
            {pickingPolygon ? "Cancel selection" : "Select on Map"}
          </button>
          <button type="button" onClick={handleUseDrawnPolygon} className={secondaryButton}>
            Use Drawn Polygon
          </button>
        </div>

        <div
          className={`mt-2 flex items-center gap-2 rounded-lg border px-3 py-2 ${
            isDark ? "border-white/5 bg-white/2.5" : "border-gray-200/60 bg-white/30"
          }`}
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              targetGeometry
                ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.65)]"
                : "bg-neutral-500"
            }`}
          />
          <span className="flex-1 text-xs text-neutral-500">
            {targetGeometry
              ? `Boundary selected (${targetGeometry.type})`
              : "No boundary selected"}
          </span>
          {targetGeometry && (
            <button
              type="button"
              onClick={() => mapRef.current?.fitToGeoJSON([targetGeometry])}
              className="text-[11px] font-medium text-emerald-500 hover:underline"
            >
              Zoom
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <RunButton
          isDark={isDark}
          label="Run Spatial Query"
          loadingLabel="Running spatial analysis…"
          loading={request.loading}
          disabled={!layerId || !targetGeometry || pickingPolygon}
          onRun={handleRunQuery}
          onCancel={request.cancel}
        />
        {!request.loading && (
          <button
            type="button"
            onClick={handleRunClip}
            disabled={!layerId || !targetGeometry || pickingPolygon}
            className={`w-full ${secondaryButton} text-sm`}
          >
            Clip Features to Boundary
          </button>
        )}
      </div>

      {error && <ErrorNote message={error} />}

      {result?.kind === "query" && (
        <ResultCard
          isDark={isDark}
          title="Matching features"
          value={result.data.matched_count}
          stale={Boolean(error)}
          onZoom={
            result.data.results.length > 0
              ? () =>
                  mapRef.current?.fitToGeoJSON(
                    result.data.results.map((item) => item.feature),
                  )
              : undefined
          }
          onClear={handleClearResult}
        >
          <p className="text-xs text-neutral-500">
            {result.data.operation} · {result.data.matched_count} of{" "}
            {result.data.total_features} features in {result.layerName}
          </p>
          {result.data.results.length > 0 ? (
            <FeatureList
              isDark={isDark}
              items={result.data.results}
              getKey={(item) => String(item.index)}
              getName={(item) =>
                String(
                  item.feature.properties?.display_name ??
                    item.feature.properties?.name ??
                    item.feature.properties?.Name ??
                    `Feature ${item.index + 1}`,
                )
              }
              getDetail={(item) => item.feature.geometry?.type ?? ""}
              onSelect={(item) => mapRef.current?.fitToGeoJSON([item.feature])}
            />
          ) : (
            <EmptyNote>No features match this relationship.</EmptyNote>
          )}
        </ResultCard>
      )}

      {result?.kind === "clip" && (
        <ResultCard
          isDark={isDark}
          title="Clipped features"
          value={result.data.result_count}
          stale={Boolean(error)}
          onZoom={
            result.layerId
              ? () => mapRef.current?.zoomToImportedLayer(result.layerId!)
              : undefined
          }
          onClear={handleClearResult}
        >
          {result.data.result_count > 0 ? (
            <p className="text-xs text-neutral-500">
              {result.data.result_count} of {result.data.input_count} features
              from {result.layerName} clipped into a new layer.
              {result.data.skipped_count > 0 &&
                ` ${result.data.skipped_count} invalid features skipped.`}
            </p>
          ) : (
            <EmptyNote>No features intersect the clipping boundary.</EmptyNote>
          )}
        </ResultCard>
      )}

      <button
        type="button"
        onClick={handleReset}
        className={`w-full rounded-xl border px-3 py-2 text-sm transition-all ${
          isDark
            ? "border-white/10 bg-white/5 hover:border-red-400/25 hover:text-red-300"
            : "border-gray-200 bg-white/60 hover:border-red-500/25 hover:text-red-600"
        }`}
      >
        Reset
      </button>
    </div>
  );
}
