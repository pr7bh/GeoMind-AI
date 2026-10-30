import { useEffect, useState } from "react";
import { getContext } from "ol/webgl";
import { ErrorNote, ResultCard } from "./ToolUI";
import type { ToolProps } from "./types";

// OpenLayers renders heatmaps with WebGL and fails at render time without it.
function supportsWebGL() {
  return getContext(document.createElement("canvas")) !== null;
}

export default function HeatmapTool({
  theme,
  mapRef,
  importedLayers,
}: ToolProps) {
  const isDark = theme === "dark";

  const [layerId, setLayerId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [radius, setRadius] = useState(18);
  const [blur, setBlur] = useState(15);
  const [error, setError] = useState("");
  const layer = importedLayers.find((item) => item.id === layerId);

  // A heatmap whose source layer was removed from Data Layers is switched off.
  useEffect(() => {
    if (enabled && !layer) {
      mapRef.current?.setHeatmap(null, radius, blur);
      setEnabled(false);
    }
  }, [enabled, layer, mapRef, radius, blur]);

  function updateHeatmap(nextLayerId: string, nextRadius: number, nextBlur: number) {
    if (!enabled || !nextLayerId) return;

    try {
      setError("");
      mapRef.current?.setHeatmap(nextLayerId, nextRadius, nextBlur);
    } catch (error) {
      setEnabled(false);
      setError(
        error instanceof Error ? error.message : "Unable to update heatmap.",
      );
    }
  }

  function handleToggle(nextEnabled: boolean) {
    try {
      setError("");

      if (!nextEnabled) {
        mapRef.current?.setHeatmap(null, radius, blur);
        setEnabled(false);
        return;
      }

      if (!layerId) {
        setError("Please select an imported layer.");
        return;
      }

      if (!supportsWebGL()) {
        setError("Heatmaps need WebGL, which this browser has disabled or does not support.");
        return;
      }

      mapRef.current?.setHeatmap(layerId, radius, blur);
      setEnabled(true);
    } catch (error) {
      setEnabled(false);
      setError(
        error instanceof Error ? error.message : "Unable to create heatmap.",
      );
    }
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-neutral-500">
        Point layer
      </label>

      <select
        value={layerId}
        onChange={(event) => {
          setLayerId(event.target.value);
          updateHeatmap(event.target.value, radius, blur);
        }}
        className={`w-full rounded-lg border p-2 text-sm ${
          isDark
            ? "border-white/10 bg-neutral-950 text-white"
            : "border-gray-200 bg-white text-gray-900"
        }`}
      >
        <option value="">Select imported layer</option>
        {importedLayers.map((layer) => (
          <option key={layer.id} value={layer.id}>
            {layer.name} ({layer.count} features)
          </option>
        ))}
      </select>

      <div className="mt-4">
        <div className="mb-2 flex justify-between text-xs">
          <label>Radius</label>
          <span>{radius}px</span>
        </div>

        <input
          type="range"
          min={5}
          max={50}
          value={radius}
          onChange={(event) => {
            const nextRadius = Number(event.target.value);
            setRadius(nextRadius);
            updateHeatmap(layerId, nextRadius, blur);
          }}
          className="w-full accent-emerald-500"
        />
      </div>

      <div className="mt-4">
        <div className="mb-2 flex justify-between text-xs">
          <label>Blur</label>
          <span>{blur}px</span>
        </div>

        <input
          type="range"
          min={0}
          max={40}
          value={blur}
          onChange={(event) => {
            const nextBlur = Number(event.target.value);
            setBlur(nextBlur);
            updateHeatmap(layerId, radius, nextBlur);
          }}
          className="w-full accent-emerald-500"
        />
      </div>

      <button
        type="button"
        onClick={() => handleToggle(!enabled)}
        className={`mt-4 min-h-10 w-full rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
          enabled
            ? "border border-rose-500/30 bg-rose-500/10 text-rose-500"
            : "bg-emerald-600 text-white hover:bg-emerald-500"
        }`}
      >
        {enabled ? "Disable Heatmap" : "Enable Heatmap"}
      </button>

      {error && (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      )}

      {enabled && layer && (
        <div className="mt-3">
          <ResultCard
            isDark={isDark}
            title="Heatmap active"
            value={layer.name}
            onZoom={() => mapRef.current?.zoomToImportedLayer(layer.id)}
            onClear={() => handleToggle(false)}
          >
            <p className="text-xs text-neutral-500">
              Density of point features in this layer ({layer.count} features
              total). Radius {radius}px · blur {blur}px. Rendered in the browser.
            </p>
          </ResultCard>
        </div>
      )}
    </div>
  );
}
