import { useState } from "react";
import type { FeatureCollection as GeoJSONFeatureCollection } from "geojson";
import { postJSON } from "../../lib/api";
import { useRequest } from "../../lib/useRequest";
import LayerSelect from "./LayerSelect";
import { readLayerFeatures } from "./readLayerFeatures";
import { EmptyNote, ErrorNote, FeatureList, ResultCard, RunButton } from "./ToolUI";
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
  const [result, setResult] = useState<{
    data: IntersectionResult;
    layerId: string | null;
    names: [string, string];
  } | null>(null);
  const [error, setError] = useState("");
  const request = useRequest();

  const nameOf = (id: string) =>
    importedLayers.find((layer) => layer.id === id)?.name ?? "layer";

  async function handleRun() {
    if (!layerAId || !layerBId) {
      setError("Select both Layer A and Layer B.");
      return;
    }

    if (layerAId === layerBId) {
      setError("Select two different layers.");
      return;
    }

    setError("");

    try {
      const layerA = readLayerFeatures(mapRef, layerAId);
      const layerB = readLayerFeatures(mapRef, layerBId);
      const data = await request.run((signal) =>
        postJSON<IntersectionResult>(
          "/api/analysis/intersection",
          { layer_a_features: layerA, layer_b_features: layerB },
          "Failed to run spatial intersection.",
          { signal },
        ),
      );

      if (!data) return;

      const layerId =
        data.result_count > 0
          ? (mapRef.current?.addClipResultGeoJSON(
              JSON.stringify(data.result),
              "Intersection Result",
            ) ?? null)
          : null;

      setResult({ data, layerId, names: [nameOf(layerAId), nameOf(layerBId)] });
      onLayersChanged();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Something went wrong while running intersection.",
      );
    }
  }

  function handleClear() {
    request.cancel();
    mapRef.current
      ?.getImportedLayers()
      .filter((layer) => layer.name.startsWith("Intersection Result"))
      .forEach((layer) => mapRef.current?.removeImportedLayer(layer.id));

    onLayersChanged();
    setResult(null);
    setError("");
  }

  return (
    <div className="space-y-4">
      <LayerSelect
        isDark={isDark}
        label="Layer A"
        placeholder="Select first layer"
        value={layerAId}
        layers={importedLayers}
        onChange={setLayerAId}
      />

      <LayerSelect
        isDark={isDark}
        label="Layer B"
        placeholder="Select second layer"
        value={layerBId}
        layers={importedLayers}
        onChange={setLayerBId}
      />

      {layerAId && layerAId === layerBId && (
        <p className="text-[11px] text-amber-500">Choose two different layers.</p>
      )}

      <RunButton
        isDark={isDark}
        label="Run Intersection"
        loadingLabel="Computing overlaps…"
        loading={request.loading}
        disabled={!layerAId || !layerBId || layerAId === layerBId}
        onRun={handleRun}
        onCancel={request.cancel}
      />

      {error && <ErrorNote message={error} />}

      {result && (
        <ResultCard
          isDark={isDark}
          title="Intersection results"
          value={result.data.result_count}
          stale={Boolean(error)}
          onZoom={
            result.layerId
              ? () => mapRef.current?.zoomToImportedLayer(result.layerId!)
              : undefined
          }
          onClear={handleClear}
        >
          <p className="text-xs text-neutral-500">
            {result.names[0]} ({result.data.layer_a_count}) ×{" "}
            {result.names[1]} ({result.data.layer_b_count})
          </p>
          {result.data.skipped_count > 0 && (
            <p className="text-xs text-amber-500">
              {result.data.skipped_count} invalid features skipped.
            </p>
          )}
          {result.data.result_count === 0 ? (
            <EmptyNote>No overlapping features were found.</EmptyNote>
          ) : (
            <FeatureList
              isDark={isDark}
              items={result.data.result.features}
              getKey={(_, index) => String(index)}
              getName={(feature, index) =>
                String(
                  (feature.properties?.layer_a_properties as Record<string, unknown>)
                    ?.name ?? `Overlap ${index + 1}`,
                )
              }
              getDetail={(feature) => feature.geometry?.type ?? ""}
              onSelect={(feature) => mapRef.current?.fitToGeoJSON([feature])}
            />
          )}
        </ResultCard>
      )}
    </div>
  );
}
