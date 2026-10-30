import { useState } from "react";
import type {
  Feature as GeoJSONFeature,
  FeatureCollection as GeoJSONFeatureCollection,
  Geometry as GeoJSONGeometry,
} from "geojson";
import { postJSON } from "../../lib/api";
import LayerSelect from "./LayerSelect";
import { readLayerFeatures } from "./readLayerFeatures";
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

interface SpatialQueryToolProps extends ToolProps, MapPickProps {
  onLayersChanged: () => void;
}

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
  const [result, setResult] = useState<SpatialQueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [targetGeometry, setTargetGeometry] =
    useState<GeoJSONGeometry | null>(null);

  function validateInput(boundaryName: string) {
    if (!layerId || !mapRef.current) {
      setError("Please select a source layer.");
      return false;
    }

    if (!targetGeometry) {
      setError("Draw a polygon and click Use Drawn Polygon first.");
      return false;
    }

    if (targetGeometry.type !== "Polygon" && targetGeometry.type !== "MultiPolygon") {
      setError(`The ${boundaryName} boundary must be a polygon.`);
      return false;
    }

    return true;
  }

  async function handleRunQuery() {
    if (!validateInput("query")) return;

    try {
      setLoading(true);
      setError("");
      setResult(null);

      const data = await postJSON<SpatialQueryResult>(
        "/api/analysis/spatial-query",
        {
          features: readLayerFeatures(mapRef, layerId),
          target_geometry: targetGeometry,
          operation,
        },
        "Spatial query failed.",
      );

      setResult(data);
      mapRef.current?.highlightSpatialQueryResults(
        data.results.map((item) => item.feature),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Spatial query failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRunClip() {
    if (!validateInput("clip")) return;

    try {
      setLoading(true);
      setError("");

      const data = await postJSON<{
        result_count: number;
        result: GeoJSONFeatureCollection;
      }>(
        "/api/analysis/clip",
        {
          features: readLayerFeatures(mapRef, layerId),
          clip_geometry: targetGeometry,
        },
        "Clip operation failed.",
      );

      if (data.result_count === 0) {
        setError("No features intersect the clipping boundary.");
        return;
      }

      mapRef.current?.addClipResultGeoJSON(JSON.stringify(data.result));
      onLayersChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Clip operation failed.");
    } finally {
      setLoading(false);
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
        setTargetGeometry(null);
        return;
      }

      setTargetGeometry(polygonFeature.geometry);
      setError("");
      setResult(null);

      mapRef.current?.highlightSpatialQueryResults([]);
    } catch {
      setError("Unable to read the drawn polygon.");
      setTargetGeometry(null);
    }
  }

  function handleSelectPolygon() {
    setError("");
    picker.pickFeature(
      "spatial-query",
      "polygon",
      "Click a polygon on the map to use as the boundary",
      ["Polygon", "MultiPolygon"],
      (feature) => {
        setTargetGeometry(feature.geometry);
        setResult(null);
        mapRef.current?.highlightSpatialQueryResults([]);
      },
    );
  }

  function handleClear() {
    mapRef.current?.highlightSpatialQueryResults([]);
    setResult(null);
    setError("");
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-neutral-500">
        Query imported features using a drawn polygon.
      </p>

      <LayerSelect
        isDark={isDark}
        label="Source layer"
        placeholder="Select imported layer"
        value={layerId}
        layers={importedLayers}
        onChange={setLayerId}
      />

      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Spatial operation
        </label>

        <select
          value={operation}
          onChange={(event) =>
            setOperation(event.target.value as SpatialOperation)
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

      <div>
        <p className="mb-1.5 text-xs font-medium text-neutral-500">Boundary polygon</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={
              pickingPolygon
                ? () => picker.cancel("spatial-query")
                : handleSelectPolygon
            }
            className={`rounded-xl border px-3 py-2.5 text-xs font-medium transition-all ${
              pickingPolygon
                ? "border-amber-400/50 bg-amber-400/10 text-amber-500"
                : isDark
                  ? "border-emerald-400/25 bg-emerald-400/4 hover:bg-emerald-400/10"
                  : "border-emerald-500/25 bg-emerald-500/4 hover:bg-emerald-500/10"
            }`}
          >
            {pickingPolygon ? "Cancel selection" : "Select on Map"}
          </button>
          <button
            type="button"
            onClick={handleUseDrawnPolygon}
            className={`rounded-xl border px-3 py-2.5 text-xs font-medium transition-all ${
              isDark
                ? "border-white/10 bg-white/5 hover:border-emerald-400/30"
                : "border-gray-200 bg-white/60 hover:border-emerald-500/30"
            }`}
          >
            Use Drawn Polygon
          </button>
        </div>
      </div>

      <div
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
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
        <span className="text-xs text-neutral-500">
          {targetGeometry
            ? "Query boundary selected"
            : "Draw a polygon to set the boundary"}
        </span>
      </div>

      <button
        type="button"
        onClick={handleRunQuery}
        disabled={loading || !layerId}
        className="w-full rounded-xl border border-emerald-400/30 bg-emerald-500 px-3 py-2.5 text-sm font-semibold text-black shadow-lg shadow-emerald-950/10 transition-all duration-200 hover:bg-emerald-400 hover:shadow-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Running query..." : "Run Spatial Query"}
      </button>

      <button
        type="button"
        onClick={handleRunClip}
        disabled={loading || !layerId}
        className={`w-full rounded-xl border px-3 py-2.5 text-sm font-medium backdrop-blur-md transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
          isDark
            ? "border-white/10 bg-white/2.5 hover:border-emerald-400/30 hover:bg-emerald-400/6"
            : "border-gray-200/80 bg-white/40 hover:border-emerald-500/30 hover:bg-emerald-500/5"
        }`}
      >
        {loading ? "Processing..." : "Clip Features"}
      </button>

      {error && (
        <p className="wrap-break-word rounded-xl border border-red-500/20 bg-red-500/6 p-3 text-xs leading-relaxed text-red-400 backdrop-blur-md">
          {error}
        </p>
      )}

      {result && (
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
            {result.matched_count}
          </p>

          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            Matched {result.matched_count} of {result.total_features} features
          </p>

          {result.results.length > 0 && (
            <div className="mt-3 space-y-2">
              {result.results.map((item) => {
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
                      {item.feature.geometry?.type ?? "Unknown geometry"}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {result.matched_count === 0 && (
            <p className="mt-2 text-xs text-neutral-500">
              No features matched this query.
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={handleClear}
        className={`w-full rounded-xl border px-3 py-2 text-sm backdrop-blur-md transition-all duration-200 ${
          isDark
            ? "border-white/10 bg-white/2.5 hover:border-emerald-400/25 hover:bg-white/5"
            : "border-gray-200/80 bg-white/40 hover:border-emerald-500/25 hover:bg-white/70"
        }`}
      >
        Clear Results
      </button>
    </div>
  );
}
