import { useState } from "react";
import type { Feature as GeoJSONFeature } from "geojson";
import { postJSON } from "../../lib/api";
import { formatDistanceMetres } from "../../lib/format";
import { useRequest } from "../../lib/useRequest";
import PickField from "../map/PickField";
import LayerSelect from "./LayerSelect";
import { readLayerFeatures } from "./readLayerFeatures";
import { ErrorNote, FeatureList, ResultCard, RunButton } from "./ToolUI";
import type { MapPickProps, ToolProps } from "./types";

interface NearestResult {
  results: {
    feature_index: number;
    feature: GeoJSONFeature;
    distance_metres: number;
    distance_kilometres: number;
  }[];
  valid_features_checked: number;
}

function featureName(feature: GeoJSONFeature, index: number) {
  return String(
    feature.properties?.display_name ??
      feature.properties?.name ??
      feature.properties?.Name ??
      `Feature ${index + 1}`,
  );
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
  const [limit, setLimit] = useState(3);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    data: NearestResult;
    origin: [number, number];
    layerName: string;
  } | null>(null);
  const request = useRequest();

  function handlePickOrigin() {
    setError("");
    picker.pickPoint(
      "nearest",
      "reference",
      "Click the map to set the reference point",
      setOrigin,
    );
  }

  async function handleRun() {
    if (!layerId) {
      setError("Select a source layer.");
      return;
    }

    if (!origin) {
      setError("Pick a reference point on the map first.");
      return;
    }

    setError("");

    try {
      const features = readLayerFeatures(mapRef, layerId);
      const data = await request.run((signal) =>
        postJSON<NearestResult>(
          "/api/analysis/nearest-features",
          { coordinates: origin, features, limit },
          "Nearest feature analysis failed.",
          { signal },
        ),
      );

      if (!data) return;

      setResult({
        data,
        origin,
        layerName:
          importedLayers.find((layer) => layer.id === layerId)?.name ?? "layer",
      });
      mapRef.current?.highlightNearestFeatures(
        origin,
        data.results.map((item) => item.feature),
      );
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Nearest feature analysis failed.",
      );
    }
  }

  function handleClearResult() {
    mapRef.current?.clearNearestFeatureHighlight();
    setResult(null);
    setError("");
  }

  function handleReset() {
    request.cancel();
    picker.cancel("nearest");
    picker.setMarker("nearest", "reference", null);
    handleClearResult();
    setOrigin(null);
  }

  const nearest = result?.data.results[0];

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

      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Number of results
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
          <option value={1}>Nearest only</option>
          <option value={3}>Top 3</option>
          <option value={5}>Top 5</option>
          <option value={10}>Top 10</option>
        </select>
      </div>

      <RunButton
        isDark={isDark}
        color="sky"
        label={limit === 1 ? "Find Nearest Feature" : `Find Top ${limit} Features`}
        loadingLabel="Measuring distances…"
        loading={request.loading}
        disabled={!layerId || !origin || pickActive}
        onRun={handleRun}
        onCancel={request.cancel}
      />

      {error && <ErrorNote message={error} />}

      {result && nearest && (
        <ResultCard
          isDark={isDark}
          title="Nearest feature distance"
          value={formatDistanceMetres(nearest.distance_metres)}
          stale={Boolean(error)}
          onZoom={() =>
            mapRef.current?.fitToGeoJSON([
              { type: "Point", coordinates: result.origin },
              ...result.data.results.map((item) => item.feature),
            ])
          }
          onClear={handleClearResult}
        >
          <p className="text-xs text-neutral-500">
            {result.data.results.length} of {result.data.valid_features_checked}{" "}
            valid features in {result.layerName}, measured geodesically from the
            reference point.
          </p>
          <FeatureList
            isDark={isDark}
            items={result.data.results}
            getKey={(item, index) => `${item.feature_index}-${index}`}
            getName={(item, index) => `#${index + 1} ${featureName(item.feature, item.feature_index)}`}
            getDetail={(item) => formatDistanceMetres(item.distance_metres)}
            onSelect={(item) => mapRef.current?.fitToGeoJSON([item.feature])}
          />
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
