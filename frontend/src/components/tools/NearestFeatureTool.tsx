import { useState } from "react";
import type { Feature as GeoJSONFeature } from "geojson";
import { postJSON } from "../../lib/api";
import PickField from "../map/PickField";
import LayerSelect from "./LayerSelect";
import { readLayerFeatures } from "./readLayerFeatures";
import type { MapPickProps, ToolProps } from "./types";

interface NearestFeatureResult {
  nearest_feature: GeoJSONFeature;
  feature_index: number;
  distance_metres: number;
  distance_kilometres: number;
  valid_features_checked: number;
}

interface TopNearestResult {
  results: {
    feature_index: number;
    feature: GeoJSONFeature;
    distance_metres: number;
    distance_kilometres: number;
  }[];
  valid_features_checked: number;
}

export default function NearestFeatureTool({
  theme,
  mapRef,
  importedLayers,
  picker,
}: ToolProps & MapPickProps) {
  const isDark = theme === "dark";
  const pickActive = picker.isPicking("nearest");

  const [layerId, setLayerId] = useState("");
  const [origin, setOrigin] = useState<[number, number] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<NearestFeatureResult | null>(null);
  const [limit, setLimit] = useState(3);
  const [topResult, setTopResult] = useState<TopNearestResult | null>(null);

  function handlePickOrigin() {
    setResult(null);
    setTopResult(null);
    setError("");
    mapRef.current?.clearNearestFeatureHighlight();

    picker.pickPoint(
      "nearest",
      "reference",
      "Click the map to set the reference point",
      (coordinates) => {
        setOrigin(coordinates);
        setError("");
      },
    );
  }

  function validateInput() {
    if (!layerId || !mapRef.current) {
      setError("Please select a source layer.");
      return false;
    }

    if (!origin) {
      setError("Pick a location on the map first.");
      return false;
    }

    return true;
  }

  async function handleRunNearest() {
    if (!validateInput() || !origin) return;

    try {
      setLoading(true);
      setError("");
      setResult(null);

      const data = await postJSON<NearestFeatureResult>(
        "/api/analysis/nearest-feature",
        {
          coordinates: origin,
          features: readLayerFeatures(mapRef, layerId),
        },
        "Nearest feature analysis failed.",
      );

      setResult(data);
      mapRef.current?.highlightNearestFeature(origin, data.nearest_feature);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Nearest feature analysis failed.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleRunTopNearest() {
    if (!validateInput() || !origin) return;

    try {
      setLoading(true);
      setError("");
      setTopResult(null);

      const data = await postJSON<TopNearestResult>(
        "/api/analysis/nearest-features",
        {
          coordinates: origin,
          features: readLayerFeatures(mapRef, layerId),
          limit,
        },
        "Top nearest features analysis failed.",
      );

      setTopResult(data);
      mapRef.current?.highlightNearestFeatures(
        origin,
        data.results.map((item) => item.feature),
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Top nearest features analysis failed.",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    picker.cancel("nearest");
    picker.setMarker("nearest", "reference", null);
    mapRef.current?.clearNearestFeatureHighlight();
    setOrigin(null);
    setResult(null);
    setError("");
    setTopResult(null);
  }

  return (
    <div className="space-y-4">
      <LayerSelect
        isDark={isDark}
        label="Source layer"
        placeholder="Select imported layer"
        value={layerId}
        layers={importedLayers}
        onChange={setLayerId}
      />

      <div
        className={`border-t pt-4 ${
          isDark ? "border-white/10" : "border-gray-200/70"
        }`}
      >
        <div className="mb-3">
          <h4 className="text-sm font-semibold">Nearest Feature</h4>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            Find the closest feature in the selected layer.
          </p>
        </div>

        <PickField
          isDark={isDark}
          label="Reference point"
          value={origin}
          picking={pickActive}
          markerClass="bg-sky-500"
          onPick={handlePickOrigin}
          onCancel={() => picker.cancel("nearest")}
          onClear={() => {
            setOrigin(null);
            picker.setMarker("nearest", "reference", null);
          }}
        />

        <button
          type="button"
          onClick={handleRunNearest}
          disabled={loading || !layerId || !origin || pickActive}
          className="mt-3 w-full rounded-xl border border-emerald-400/30 bg-emerald-500 px-3 py-2.5 text-sm font-semibold text-black transition-all hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Finding nearest feature..." : "Find Nearest Feature"}
        </button>

        {error && (
          <p className="mt-3 break-words rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-400">
            {error}
          </p>
        )}

        {result && (
          <div
            className={`mt-3 rounded-xl border p-3 ${
              isDark
                ? "border-emerald-400/20 bg-emerald-400/5"
                : "border-emerald-500/20 bg-emerald-500/5"
            }`}
          >
            <p className="text-xs text-neutral-500">Nearest feature distance</p>

            <p className="mt-1 text-2xl font-semibold text-emerald-500">
              {result.distance_metres < 1000
                ? `${result.distance_metres.toFixed(2)} m`
                : `${result.distance_kilometres.toFixed(3)} km`}
            </p>

            <p className="mt-2 break-words text-xs text-neutral-500">
              {String(
                result.nearest_feature.properties?.name ??
                  result.nearest_feature.properties?.Name ??
                  `Feature ${result.feature_index + 1}`,
              )}
            </p>

            <p className="mt-1 text-xs text-neutral-500">
              {result.valid_features_checked} valid features checked
            </p>
          </div>
        )}
        <div
          className={`mt-4 border-t pt-4 ${
            isDark ? "border-white/10" : "border-gray-200/70"
          }`}
        >
          <h4 className="text-sm font-semibold">Top N Nearest Features</h4>

          <p className="mt-1 text-xs text-neutral-500">
            Rank the closest features to your selected location.
          </p>

          <label className="mt-3 block text-xs font-medium text-neutral-500">
            Number of features
          </label>

          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            className={`mt-1.5 w-full rounded-xl border p-2.5 text-sm ${
              isDark
                ? "border-white/10 bg-neutral-900 text-white"
                : "border-gray-200 bg-white text-black"
            }`}
          >
            <option value={3}>Top 3</option>
            <option value={5}>Top 5</option>
            <option value={10}>Top 10</option>
          </select>

          <button
            type="button"
            onClick={handleRunTopNearest}
            disabled={loading || !layerId || !origin || pickActive}
            className="mt-3 w-full rounded-xl bg-sky-500 px-3 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading
              ? "Finding nearest features..."
              : `Find Top ${limit} Features`}
          </button>

          {topResult && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-neutral-500">
                {topResult.results.length} features returned ·{" "}
                {topResult.valid_features_checked} checked
              </p>

              {topResult.results.map((item, index) => (
                <div
                  key={`${item.feature_index}-${index}`}
                  className={`rounded-xl border p-3 ${
                    isDark
                      ? "border-white/10 bg-white/5"
                      : "border-gray-200 bg-white/70"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold">
                      #{index + 1}{" "}
                      {String(
                        item.feature.properties?.name ??
                          item.feature.properties?.Name ??
                          `Feature ${item.feature_index + 1}`,
                      )}
                    </span>

                    <span className="shrink-0 text-xs font-semibold text-sky-500">
                      {item.distance_metres < 1000
                        ? `${item.distance_metres.toFixed(2)} m`
                        : `${item.distance_kilometres.toFixed(3)} km`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={handleClear}
          className={`mt-2 w-full rounded-xl border px-3 py-2 text-sm transition-all ${
            isDark
              ? "border-white/10 bg-white/5 hover:border-red-400/25 hover:text-red-300"
              : "border-gray-200 bg-white/60 hover:border-red-500/25 hover:text-red-600"
          }`}
        >
          Clear Nearest Feature
        </button>
      </div>
    </div>
  );
}
