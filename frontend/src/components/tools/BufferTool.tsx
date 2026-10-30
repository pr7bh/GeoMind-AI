import { useState } from "react";
import type { Feature as GeoJSONFeature } from "geojson";
import { postJSON } from "../../lib/api";
import PickField from "../map/PickField";
import type { MapPickProps, ToolProps } from "./types";

const MAX_DISTANCE_METRES = 100_000;

interface BufferToolProps extends Omit<ToolProps, "importedLayers">, MapPickProps {
  onLayersChanged: () => void;
}

export default function BufferTool({
  theme,
  mapRef,
  picker,
  onLayersChanged,
}: BufferToolProps) {
  const isDark = theme === "dark";
  const picking = picker.isPicking("buffer", "center");

  const [center, setCenter] = useState<[number, number] | null>(null);
  const [distance, setDistance] = useState(500);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<number | null>(null);

  const distanceValid = distance > 0 && distance <= MAX_DISTANCE_METRES;

  async function handleRun() {
    if (!center) {
      setError("Pick a centre point on the map first.");
      return;
    }

    if (!distanceValid) {
      setError(`Distance must be between 1 and ${MAX_DISTANCE_METRES} metres.`);
      return;
    }

    try {
      setLoading(true);
      setError("");

      const data = await postJSON<{ geojson: GeoJSONFeature }>(
        "/api/analysis/buffer",
        {
          geometry_type: "Point",
          coordinates: center,
          distance_metres: distance,
        },
        "Buffer creation failed.",
      );

      mapRef.current?.addClipResultGeoJSON(
        JSON.stringify({ type: "FeatureCollection", features: [data.geojson] }),
        "Buffer",
      );
      onLayersChanged();
      setCreated(distance);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Buffer creation failed.");
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    picker.cancel("buffer");
    picker.setMarker("buffer", "center", null);
    mapRef.current
      ?.getImportedLayers()
      .filter((layer) => layer.kind === "analysis" && layer.name.startsWith("Buffer"))
      .forEach((layer) => mapRef.current?.removeImportedLayer(layer.id));
    onLayersChanged();
    setCenter(null);
    setCreated(null);
    setError("");
  }

  return (
    <div className="space-y-4">
      <PickField
        isDark={isDark}
        label="Centre point"
        value={center}
        picking={picking}
        markerClass="bg-amber-500"
        onPick={() => {
          setError("");
          picker.pickPoint(
            "buffer",
            "center",
            "Click the map to set the buffer centre",
            setCenter,
          );
        }}
        onCancel={() => picker.cancel("buffer")}
        onClear={() => {
          setCenter(null);
          picker.setMarker("buffer", "center", null);
        }}
      />

      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Distance (metres)
        </label>
        <input
          type="number"
          min={1}
          max={MAX_DISTANCE_METRES}
          step={50}
          value={distance}
          onChange={(event) => setDistance(Number(event.target.value))}
          className={`mt-1.5 w-full rounded-xl border p-2.5 text-sm outline-none transition-all focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/10 ${
            isDark
              ? "border-white/10 bg-neutral-900/60 text-white"
              : "border-gray-200 bg-white/60 text-black"
          }`}
        />
        {!distanceValid && (
          <p className="mt-1 text-[11px] text-red-400">
            Enter a distance between 1 and {MAX_DISTANCE_METRES.toLocaleString()} m.
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={handleRun}
        disabled={loading || !center || picking || !distanceValid}
        className="w-full rounded-xl border border-emerald-400/30 bg-emerald-500 px-3 py-2.5 text-sm font-semibold text-black transition-all hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Creating buffer..." : "Create Buffer"}
      </button>

      {error && (
        <p className="break-words rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-400">
          {error}
        </p>
      )}

      {created !== null && (
        <div
          className={`rounded-xl border p-3 ${
            isDark
              ? "border-emerald-400/20 bg-emerald-400/5"
              : "border-emerald-500/20 bg-emerald-500/5"
          }`}
        >
          <p className="text-xs text-neutral-500">Buffer created</p>
          <p className="mt-1 text-lg font-semibold text-emerald-500">
            {created >= 1000 ? `${created / 1000} km` : `${created} m`} radius
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Added to Data Layers.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={handleClear}
        className={`w-full rounded-xl border px-3 py-2 text-sm transition-all ${
          isDark
            ? "border-white/10 bg-white/5 hover:border-red-400/25 hover:text-red-300"
            : "border-gray-200 bg-white/60 hover:border-red-500/25 hover:text-red-600"
        }`}
      >
        Clear Buffers
      </button>
    </div>
  );
}
