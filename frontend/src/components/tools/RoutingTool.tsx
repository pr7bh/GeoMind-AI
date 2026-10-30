import { useState } from "react";
import { postJSON } from "../../lib/api";
import { formatDistanceMetres } from "../../lib/format";
import { useRequest } from "../../lib/useRequest";
import PickField from "../map/PickField";
import { ErrorNote, ResultCard, RunButton } from "./ToolUI";
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
  const request = useRequest();

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
        request.cancel();
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

    setError("");

    try {
      const data = await request.run((signal) =>
        postJSON<RouteResult>(
          "/api/routing/route",
          { start, destination },
          "Road routing failed.",
          { signal },
        ),
      );

      if (!data) return;

      mapRef.current?.showRoadRoute(data.geometry);
      setRoadRoute(data);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to calculate the road route.",
      );
    }
  }

  function handleClearResults() {
    mapRef.current?.clearRouteDistance();
    setDistance(null);
    setRoadRoute(null);
    setError("");
  }

  function handleClear() {
    request.cancel();
    picker.cancel("routing");
    picker.setMarker("routing", "start", null);
    picker.setMarker("routing", "destination", null);
    onStartChange(null);
    onDestinationChange(null);
    handleClearResults();
  }

  const ready = Boolean(start && destination) && pickTarget === null;
  const hasResult = distance !== null || roadRoute !== null;

  return (
    <div className="space-y-4">
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

      <div className="space-y-2">
        <RunButton
          isDark={isDark}
          color="violet"
          label="Calculate Road Route"
          loadingLabel="Requesting driving route…"
          loading={request.loading}
          disabled={!ready}
          onRun={handleCalculateRoadRoute}
          onCancel={request.cancel}
        />
        <button
          type="button"
          onClick={handleCalculateDistance}
          disabled={!ready}
          className={`min-h-10 w-full rounded-xl border px-3 py-2 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
            isDark
              ? "border-white/10 bg-white/5 hover:border-emerald-400/30"
              : "border-gray-200 bg-white/60 hover:border-emerald-500/30"
          }`}
        >
          Calculate Straight-line Distance
        </button>
      </div>

      {error && <ErrorNote message={error} />}

      {hasResult && (
        <ResultCard
          isDark={isDark}
          title="Route"
          value={
            roadRoute
              ? `${roadRoute.distance_km.toFixed(2)} km`
              : distance !== null
                ? formatDistanceMetres(distance)
                : undefined
          }
          stale={Boolean(error)}
          onZoom={() =>
            mapRef.current?.fitToGeoJSON(
              roadRoute
                ? [roadRoute.geometry]
                : start && destination
                  ? [{ type: "LineString", coordinates: [start, destination] }]
                  : [],
            )
          }
          onClear={handleClearResults}
        >
          <dl className="grid grid-cols-2 gap-2 text-xs">
            {roadRoute && (
              <>
                <div>
                  <dt className="text-neutral-500">Driving distance</dt>
                  <dd className="font-medium">
                    {roadRoute.distance_km.toFixed(2)} km
                  </dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Estimated time</dt>
                  <dd className="font-medium">
                    {roadRoute.estimated_duration_minutes} min
                  </dd>
                </div>
              </>
            )}
            {distance !== null && (
              <div>
                <dt className="text-neutral-500">Straight-line</dt>
                <dd className="font-medium">{formatDistanceMetres(distance)}</dd>
              </div>
            )}
          </dl>
          <p className="text-[11px] text-neutral-500">
            {roadRoute
              ? "Driving route: OSRM on OpenStreetMap data."
              : "Straight-line distance is great-circle (spherical Earth)."}
          </p>
        </ResultCard>
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
        Clear Route
      </button>
    </div>
  );
}
