import { useState } from "react";
import type { ToolProps } from "./types";

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
    <section
      className={`rounded-xl border p-4 ${
        isDark ? "border-white/10 bg-white/[0.03]" : "border-gray-200 bg-gray-50"
      }`}
    >
      <div className="mb-3">
        <h3 className="text-sm font-semibold">Heatmap & Density</h3>
        <p className="mt-1 text-xs text-neutral-500">
          Visualize concentrations of geographic points.
        </p>
      </div>

      <label className="mb-1 block text-xs font-medium">Source layer</label>

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
        className={`mt-4 w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
          enabled
            ? "border border-rose-500/30 bg-rose-500/10 text-rose-500"
            : "bg-emerald-600 text-white hover:bg-emerald-500"
        }`}
      >
        {enabled ? "Disable Heatmap" : "Enable Heatmap"}
      </button>

      {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}
    </section>
  );
}
