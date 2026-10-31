import { useState } from "react";
import type { Feature as GeoJSONFeature } from "geojson";
import { postJSON } from "../../lib/api";
import { formatDistanceMetres } from "../../lib/format";
import { useRequest } from "../../lib/useRequest";
import PickField from "../map/PickField";
import { ErrorNote, FeatureList, ResultCard, RunButton } from "./ToolUI";
import type { MapPickProps, ToolProps } from "./types";

const MAX_DISTANCE_METRES = 100_000;

interface BufferToolProps extends ToolProps, MapPickProps {
  onLayersChanged: () => void;
}

interface CreatedBuffer {
  layerId: string;
  center: [number, number];
  distance: number;
}

export default function BufferTool({
  theme,
  mapRef,
  importedLayers,
  picker,
  onLayersChanged,
}: BufferToolProps) {
  const isDark = theme === "dark";
  const picking = picker.isPicking("buffer", "center");

  const [center, setCenter] = useState<[number, number] | null>(null);
  const [distance, setDistance] = useState(500);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedBuffer[]>([]);
  const request = useRequest();

  const distanceValid = distance > 0 && distance <= MAX_DISTANCE_METRES;
  // Buffers removed from Data Layers drop out of this list too.
  const buffers = created.filter((item) =>
    importedLayers.some((layer) => layer.id === item.layerId),
  );
  const latest = buffers[buffers.length - 1];

  async function handleRun() {
    if (!center) {
      setError("Pick a centre point on the map first.");
      return;
    }

    if (!distanceValid) {
      setError(`Distance must be between 1 and ${MAX_DISTANCE_METRES} metres.`);
      return;
    }

    setError("");

    try {
      const data = await request.run((signal) =>
        postJSON<{ geojson: GeoJSONFeature }>(
          "/api/analysis/buffer",
          {
            geometry_type: "Point",
            coordinates: center,
            distance_metres: distance,
          },
          "Buffer creation failed.",
          { signal },
        ),
      );

      if (!data || !mapRef.current) return;

      const layerId = mapRef.current.addClipResultGeoJSON(
        JSON.stringify({ type: "FeatureCollection", features: [data.geojson] }),
        "Buffer",
      );
      onLayersChanged();
      setCreated((items) => [...items, { layerId, center, distance }]);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Buffer creation failed.");
    }
  }

  function handleClearResults() {
    buffers.forEach((item) => mapRef.current?.removeImportedLayer(item.layerId));
    onLayersChanged();
    setCreated([]);
    setError("");
  }

  function handleReset() {
    request.cancel();
    picker.cancel("buffer");
    picker.setMarker("buffer", "center", null);
    setCenter(null);
    handleClearResults();
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
        <label
          htmlFor="buffer-distance"
          className="block text-xs font-medium text-neutral-500"
        >
          Distance (metres)
        </label>
        <input
          id="buffer-distance"
          type="number"
          min={1}
          max={MAX_DISTANCE_METRES}
          step={50}
          value={distance}
          onChange={(event) => setDistance(Number(event.target.value))}
          className={`gm-glass-field mt-1.5 w-full rounded-xl border p-2.5 text-sm outline-none transition-all focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/10 ${
            isDark
              ? "border-white/10 text-white"
              : "border-gray-200 text-black"
          }`}
        />
        {!distanceValid && (
          <p className="mt-1 text-[11px] text-red-400">
            Enter a distance between 1 and {MAX_DISTANCE_METRES.toLocaleString()} m.
          </p>
        )}
      </div>

      <RunButton
        isDark={isDark}
        label="Create Buffer"
        loadingLabel="Creating buffer…"
        loading={request.loading}
        disabled={!center || picking || !distanceValid}
        onRun={handleRun}
        onCancel={request.cancel}
      />

      {error && <ErrorNote message={error} />}

      {latest && (
        <ResultCard
          isDark={isDark}
          title={buffers.length === 1 ? "Buffer created" : `${buffers.length} buffers`}
          value={`${formatDistanceMetres(latest.distance)} radius`}
          stale={Boolean(error)}
          onZoom={() => mapRef.current?.zoomToImportedLayer(latest.layerId)}
          onClear={handleClearResults}
        >
          <FeatureList
            isDark={isDark}
            items={buffers}
            getKey={(item) => item.layerId}
            getName={(item) =>
              `${item.center[0].toFixed(4)}, ${item.center[1].toFixed(4)}`
            }
            getDetail={(item) => formatDistanceMetres(item.distance)}
            onSelect={(item) => mapRef.current?.zoomToImportedLayer(item.layerId)}
          />
          <p className="text-[11px] text-neutral-500">
            Computed in a local UTM projection. Each buffer is a layer in Data
            Layers.
          </p>
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
