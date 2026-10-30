import { useState } from "react";
import { postJSON } from "../../lib/api";
import PickField from "../map/PickField";
import type { MapPickProps, ToolProps } from "./types";

export interface RouteResult {
  geometry: {
    type: "LineString";
    coordinates: number[][];
  };
  distance_meters: number;
  distance_km: number;
  estimated_duration_minutes: number;
  route_type: string;
}

interface RoutingToolProps extends Omit<ToolProps, "importedLayers">, MapPickProps {
  start: [number, number] | null;
  destination: [number, number] | null;
  onStartChange: (point: [number, number] | null) => void;
  onDestinationChange: (point: [number, number] | null) => void;
}

export default function RoutingTool({
  theme,
  mapRef,
  picker,
  start,
  destination,
  onStartChange,
  onDestinationChange,
}: RoutingToolProps) {
  const isDark = theme === "dark";
  const pickTarget = picker.isPicking("routing", "start")
    ? "start"
    : picker.isPicking("routing", "destination")
      ? "destination"
      : null;

  const [distance, setDistance] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [roadRoute, setRoadRoute] = useState<RouteResult | null>(null);
  const [roadRouteLoading, setRoadRouteLoading] = useState(false);

  function handlePickPoint(target: "start" | "destination") {
    if (!mapRef.current) {
      setError("Map is not ready yet.");
      return;
    }

    setError("");

    picker.pickPoint(
      "routing",
      target,
      `Click the map to set the route ${target}`,
      (coordinates) => {
        // Results only go stale once a new point is actually chosen.
        setDistance(null);
        setRoadRoute(null);
        mapRef.current?.clearRouteDistance();
        (target === "start" ? onStartChange : onDestinationChange)(coordinates);
      },
    );
  }

  function handleCalculateDistance() {
    if (!start || !destination) {
      setError("Please select both a start point and a destination.");
      return;
    }

    try {
      const result = mapRef.current?.showRouteDistance(start, destination);

      if (result === undefined || !Number.isFinite(result)) {
        throw new Error("Unable to calculate the distance.");
      }

      setDistance(result);
      setError("");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to calculate route distance.",
      );
    }
  }

  async function handleCalculateRoadRoute() {
    if (!start || !destination) {
      setError("Please select both a start point and a destination.");
      return;
    }

    try {
      setRoadRouteLoading(true);
      setError("");
      setRoadRoute(null);

      const data = await postJSON<RouteResult>(
        "/api/routing/route",
        { start, destination },
        "Road routing failed.",
      );

      mapRef.current?.showRoadRoute(data.geometry);
      setRoadRoute(data);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to calculate the road route.",
      );
    } finally {
      setRoadRouteLoading(false);
    }
  }

  function handleClear() {
    mapRef.current?.clearRouteDistance();
    picker.cancel("routing");
    picker.setMarker("routing", "start", null);
    picker.setMarker("routing", "destination", null);
    onStartChange(null);
    onDestinationChange(null);
    setDistance(null);
    setError("");
    setRoadRoute(null);
  }

  return (
    <div>
      <div className="space-y-3">
        <PickField
          isDark={isDark}
          label="Start point"
          value={start}
          picking={pickTarget === "start"}
          markerClass="bg-emerald-500"
          onPick={() => handlePickPoint("start")}
          onCancel={() => picker.cancel("routing")}
          onClear={() => {
            onStartChange(null);
            picker.setMarker("routing", "start", null);
          }}
        />
        <PickField
          isDark={isDark}
          label="Destination"
          value={destination}
          picking={pickTarget === "destination"}
          markerClass="bg-violet-500"
          onPick={() => handlePickPoint("destination")}
          onCancel={() => picker.cancel("routing")}
          onClear={() => {
            onDestinationChange(null);
            picker.setMarker("routing", "destination", null);
          }}
        />
      </div>

      <button
        type="button"
        onClick={handleCalculateDistance}
        disabled={!start || !destination || pickTarget !== null}
        className="mt-4 w-full rounded-xl border border-emerald-400/30 bg-emerald-500 px-3 py-2.5 text-sm font-semibold text-black transition-all hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Calculate Distance
      </button>

      {distance !== null && (
        <div
          className={`mt-3 rounded-xl border p-3 ${
            isDark
              ? "border-violet-400/20 bg-violet-400/5"
              : "border-violet-500/20 bg-violet-500/5"
          }`}
        >
          <p className="text-xs text-neutral-500">Straight-line distance</p>
          <p className="mt-1 text-xl font-semibold text-violet-400">
            {distance >= 1000
              ? `${(distance / 1000).toFixed(3)} km`
              : `${distance.toFixed(2)} m`}
          </p>
        </div>
      )}

      {error && (
        <p className="mt-3 break-words rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-400">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleCalculateRoadRoute}
        disabled={
          roadRouteLoading || !start || !destination || pickTarget !== null
        }
        className="mt-2 w-full rounded-xl bg-violet-500 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {roadRouteLoading ? "Calculating road route..." : "Calculate Road Route"}
      </button>

      {roadRoute && (
        <div className="mt-3 rounded-xl border border-violet-500/20 bg-violet-500/5 p-3">
          <p className="text-xs text-neutral-500">Road distance</p>
          <p className="text-lg font-semibold">
            {roadRoute.distance_km.toFixed(2)} km
          </p>

          <p className="mt-2 text-xs text-neutral-500">Estimated driving time</p>
          <p className="text-sm font-medium">
            {roadRoute.estimated_duration_minutes} min
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={handleClear}
        className={`mt-3 w-full rounded-xl border px-3 py-2 text-sm transition-all ${
          isDark
            ? "border-white/10 bg-white/5 hover:border-red-400/25 hover:text-red-300"
            : "border-gray-200 bg-white/60 hover:border-red-500/25 hover:text-red-600"
        }`}
      >
        Clear Route
      </button>
    </div>
  );
}
