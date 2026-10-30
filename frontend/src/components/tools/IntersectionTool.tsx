import { useState } from "react";
import type { FeatureCollection as GeoJSONFeatureCollection } from "geojson";
import { postJSON } from "../../lib/api";
import LayerSelect from "./LayerSelect";
import { readLayerFeatures } from "./readLayerFeatures";
import type { ToolProps } from "./types";

interface IntersectionResult {
  layer_a_count: number;
  layer_b_count: number;
  result_count: number;
  skipped_count: number;
  result: GeoJSONFeatureCollection;
}

interface IntersectionToolProps extends ToolProps {
  onLayersChanged: () => void;
}

export default function IntersectionTool({
  theme,
  mapRef,
  importedLayers,
  onLayersChanged,
}: IntersectionToolProps) {
  const isDark = theme === "dark";

  const [layerAId, setLayerAId] = useState("");
  const [layerBId, setLayerBId] = useState("");
  const [result, setResult] = useState<IntersectionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleRun() {
    if (!layerAId || !layerBId) {
      setError("Please select both Layer A and Layer B.");
      return;
    }

    if (layerAId === layerBId) {
      setError("Please select two different layers.");
      return;
    }

    setLoading(true);
    setError("");
    setResult(null);

    try {
      const data = await postJSON<IntersectionResult>(
        "/api/analysis/intersection",
        {
          layer_a_features: readLayerFeatures(mapRef, layerAId),
          layer_b_features: readLayerFeatures(mapRef, layerBId),
        },
        "Failed to run spatial intersection.",
      );

      setResult(data);

      if (data.result_count > 0) {
        mapRef.current?.addClipResultGeoJSON(
          JSON.stringify(data.result),
          "Intersection Result",
        );
        onLayersChanged();
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Something went wrong while running intersection.",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    mapRef.current
      ?.getImportedLayers()
      .filter((layer) => layer.name.startsWith("Intersection Result"))
      .forEach((layer) => mapRef.current?.removeImportedLayer(layer.id));

    onLayersChanged();
    setResult(null);
    setError("");
  }

  function selectLayer(setter: (layerId: string) => void) {
    return (layerId: string) => {
      setter(layerId);
      setResult(null);
      setError("");
    };
  }

  return (
    <div className="space-y-3">
      <LayerSelect
        isDark={isDark}
        label="Layer A"
        placeholder="Select first layer"
        value={layerAId}
        layers={importedLayers}
        onChange={selectLayer(setLayerAId)}
      />

      <LayerSelect
        isDark={isDark}
        label="Layer B"
        placeholder="Select second layer"
        value={layerBId}
        layers={importedLayers}
        onChange={selectLayer(setLayerBId)}
      />

      <button
        type="button"
        onClick={handleRun}
        disabled={loading || !layerAId || !layerBId}
        className="w-full rounded-xl border border-emerald-400/30 bg-emerald-500 px-3 py-2.5 text-sm font-semibold text-black shadow-lg shadow-emerald-950/10 transition-all duration-200 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Running intersection..." : "Run Intersection"}
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
            Intersection results
          </p>

          <p className="mt-1 text-2xl font-semibold tracking-tight text-emerald-500">
            {result.result_count}
          </p>

          <p className="mt-1 wrap-break-word text-xs leading-relaxed text-neutral-500">
            Layer A: {result.layer_a_count} features
            {" · "}
            Layer B: {result.layer_b_count} features
          </p>

          {result.skipped_count > 0 && (
            <p className="mt-2 text-xs text-amber-500">
              {result.skipped_count} features skipped
            </p>
          )}

          {result.result_count === 0 && (
            <p className="mt-2 text-xs text-neutral-500">
              No overlapping features were found.
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={handleClear}
        className={`w-full rounded-xl border px-3 py-2 text-sm transition-all duration-200 ${
          isDark
            ? "border-white/10 bg-white/2.5 text-neutral-300 hover:border-red-400/25 hover:bg-red-400/6 hover:text-red-300"
            : "border-gray-200/80 bg-white/40 text-gray-700 hover:border-red-500/25 hover:bg-red-500/4 hover:text-red-600"
        }`}
      >
        Clear Intersection Results
      </button>
    </div>
  );
}
