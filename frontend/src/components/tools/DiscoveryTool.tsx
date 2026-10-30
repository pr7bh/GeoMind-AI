import { useEffect, useState } from "react";
import type { FeatureCollection, Geometry } from "geojson";
import { getJSON, isAbortError, postJSON } from "../../lib/api";
import { useRequest } from "../../lib/useRequest";
import { EmptyNote, ErrorNote, FeatureList, ResultCard, RunButton } from "./ToolUI";
import PickField from "../map/PickField";
import type { MapPickProps, ToolProps } from "./types";

export interface DiscoveryCategory {
  id: string;
  label: string;
  group: string;
  max_radius_km: number;
}

export interface DiscoveryFeatureProperties {
  name: string | null;
  display_name: string;
  category: string;
  address: string | null;
  osm_type: "node" | "way" | "relation";
  osm_id: number;
  osm_url: string;
  source: string;
  distance_km: number | null;
  tags: Record<string, string>;
}

export interface DiscoveryResponse
  extends FeatureCollection<Geometry, DiscoveryFeatureProperties> {
  metadata: {
    category: string;
    label: string;
    center: [number, number];
    radius_km: number;
    total_found: number;
    returned: number;
    truncated: boolean;
    server_limit_reached: boolean;
    skipped_without_geometry: number;
    geometry_types: string[];
    source: string;
    attribution: string;
    osm_base: string | null;
    coverage_note: string;
  };
}

interface DiscoveryToolProps extends ToolProps, MapPickProps {
  onLayersChanged: () => void;
}

function groupLabel(group: string) {
  return group
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export default function DiscoveryTool({
  theme,
  mapRef,
  importedLayers,
  picker,
  onLayersChanged,
}: DiscoveryToolProps) {
  const isDark = theme === "dark";
  const pickActive = picker.isPicking("discovery");

  const [categories, setCategories] = useState<DiscoveryCategory[]>([]);
  const [categoryId, setCategoryId] = useState("hospital");
  const [radiusKm, setRadiusKm] = useState(2);
  const [center, setCenter] = useState<[number, number] | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    data: DiscoveryResponse;
    layerId: string | null;
  } | null>(null);
  const request = useRequest();
  const summary = result?.data.metadata ?? null;

  const category = categories.find((item) => item.id === categoryId);
  const maxRadius = category?.max_radius_km ?? 50;
  const discoveryLayerCount = importedLayers.filter(
    (layer) => layer.kind === "discovery",
  ).length;

  useEffect(() => {
    const controller = new AbortController();

    getJSON<{ categories: DiscoveryCategory[] }>(
      "/api/discovery/categories",
      "Unable to load discovery categories.",
      { signal: controller.signal },
    )
      .then((data) => setCategories(data.categories))
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setError(
          error instanceof Error
            ? error.message
            : "Unable to load discovery categories.",
        );
      });

    return () => controller.abort();
  }, []);

  const groups = [...new Set(categories.map((item) => item.group))];

  function handleCategoryChange(nextId: string) {
    setCategoryId(nextId);

    const next = categories.find((item) => item.id === nextId);

    if (next && radiusKm > next.max_radius_km) {
      setRadiusKm(next.max_radius_km);
    }
  }

  function handlePickCenter() {
    setError("");
    picker.pickPoint(
      "discovery",
      "location",
      "Click the map to set the discovery search centre",
      setCenter,
    );
  }

  function handleUseMapCenter() {
    picker.cancel("discovery");

    const viewCenter = mapRef.current?.getViewCenter();

    if (viewCenter) {
      setCenter(viewCenter);
      picker.setMarker("discovery", "location", viewCenter);
      setError("");
    }
  }

  function handleClearCenter() {
    setCenter(null);
    picker.setMarker("discovery", "location", null);
  }

  async function handleDiscover() {
    if (!center) {
      setError("Choose a search location first.");
      return;
    }

    if (!(radiusKm > 0 && radiusKm <= maxRadius)) {
      setError(`Radius must be between 0 and ${maxRadius} km.`);
      return;
    }

    setError("");

    try {
      const data = await request.run((signal) =>
        postJSON<DiscoveryResponse>(
          "/api/discovery/features",
          {
            coordinates: center,
            category: categoryId,
            radius_km: radiusKm,
          },
          "Feature discovery failed.",
          { signal },
        ),
      );

      if (!data) return;

      const layer =
        data.features.length > 0
          ? mapRef.current?.addDiscoveryLayer(
              data,
              `${data.metadata.label} · ${radiusKm} km`,
            )
          : undefined;

      setResult({ data, layerId: layer?.id ?? null });
      onLayersChanged();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Feature discovery failed.",
      );
    }
  }

  function handleClearResult() {
    if (result?.layerId) {
      mapRef.current?.removeImportedLayer(result.layerId);
      onLayersChanged();
    }
    setResult(null);
    setError("");
  }

  function handleClearLayers() {
    mapRef.current?.clearDiscoveryLayers();
    onLayersChanged();
    setResult(null);
  }

  const inputClass = `mt-1.5 w-full rounded-xl border p-2.5 text-sm outline-none backdrop-blur-md transition-all focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/10 ${
    isDark
      ? "border-white/10 bg-neutral-900/60 text-white hover:border-white/20"
      : "border-white/80 bg-white/50 text-black hover:border-emerald-500/30"
  }`;

  return (
    <div>
      <label className="block text-xs font-medium text-neutral-500">
        Category
      </label>
      <select
        value={categoryId}
        onChange={(event) => handleCategoryChange(event.target.value)}
        disabled={categories.length === 0}
        className={inputClass}
      >
        {categories.length === 0 && <option value={categoryId}>Loading…</option>}
        {groups.map((group) => (
          <optgroup key={group} label={groupLabel(group)}>
            {categories
              .filter((item) => item.group === group)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>

      <label className="mt-3 block text-xs font-medium text-neutral-500">
        Search radius (km, max {maxRadius})
      </label>
      <input
        type="number"
        min={0.1}
        max={maxRadius}
        step={0.5}
        value={radiusKm}
        onChange={(event) => setRadiusKm(Number(event.target.value))}
        className={inputClass}
      />

      <div className="mt-3">
        <PickField
          isDark={isDark}
          label="Search centre"
          value={center}
          picking={pickActive}
          markerClass="bg-amber-500"
          onPick={handlePickCenter}
          onCancel={() => picker.cancel("discovery")}
          onClear={handleClearCenter}
        />
        <button
          type="button"
          onClick={handleUseMapCenter}
          className="mt-1.5 text-[11px] font-medium text-emerald-500 hover:underline"
        >
          Use current map centre
        </button>
      </div>

      <div className="mt-3 space-y-3">
        <RunButton
          isDark={isDark}
          label="Discover Features"
          loadingLabel="Querying OpenStreetMap…"
          loading={request.loading}
          disabled={!center || pickActive || categories.length === 0}
          onRun={handleDiscover}
          onCancel={request.cancel}
        />

        {error && <ErrorNote message={error} />}

        {summary && result && (
          <ResultCard
            isDark={isDark}
            title={summary.label}
            value={
              <>
                {summary.returned}
                {summary.total_found > summary.returned && (
                  <span className="ml-1 text-sm font-medium text-neutral-500">
                    of {summary.total_found}
                  </span>
                )}
              </>
            }
            stale={Boolean(error)}
            onZoom={
              result.layerId
                ? () => mapRef.current?.zoomToImportedLayer(result.layerId!)
                : undefined
            }
            onClear={handleClearResult}
          >
            {summary.returned === 0 ? (
              <EmptyNote>
                No {summary.label.toLowerCase()} are mapped in OpenStreetMap
                within {summary.radius_km} km of this point.
              </EmptyNote>
            ) : (
              <>
                <p className="text-xs text-neutral-500">
                  Within {summary.radius_km} km ·{" "}
                  {summary.geometry_types.join(", ")}
                </p>
                <FeatureList
                  isDark={isDark}
                  items={result.data.features}
                  getKey={(feature) => String(feature.id ?? feature.properties.osm_id)}
                  getName={(feature) => feature.properties.display_name}
                  getDetail={(feature) =>
                    feature.properties.distance_km === null
                      ? ""
                      : `${feature.properties.distance_km.toFixed(2)} km`
                  }
                  onSelect={(feature) => mapRef.current?.fitToGeoJSON([feature])}
                />
              </>
            )}
            {summary.truncated && (
              <p className="text-xs text-amber-500">
                Results were truncated. Reduce the radius for complete results.
              </p>
            )}
            <p className="text-[11px] leading-relaxed text-neutral-500">
              {summary.coverage_note}
            </p>
            <p className="text-[11px] text-neutral-500">
              Source: {summary.attribution}
              {summary.osm_base &&
                ` · data as of ${new Date(summary.osm_base).toLocaleDateString()}`}
            </p>
          </ResultCard>
        )}
      </div>

      {discoveryLayerCount > 0 && (
        <button
          type="button"
          onClick={handleClearLayers}
          className={`mt-3 w-full rounded-xl border px-3 py-2 text-sm transition-all ${
            isDark
              ? "border-white/10 bg-white/5 hover:border-red-400/25 hover:text-red-300"
              : "border-gray-200 bg-white/60 hover:border-red-500/25 hover:text-red-600"
          }`}
        >
          Clear {discoveryLayerCount} Discovery Layer
          {discoveryLayerCount === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
