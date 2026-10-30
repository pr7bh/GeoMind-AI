import { useEffect, useState } from "react";
import type { FeatureCollection, Geometry } from "geojson";
import { getJSON, postJSON } from "../../lib/api";
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
  mapPick,
  onBeginMapPick,
  onEndMapPick,
  onLayersChanged,
}: DiscoveryToolProps) {
  const isDark = theme === "dark";
  const pickActive = mapPick === "discovery";

  const [categories, setCategories] = useState<DiscoveryCategory[]>([]);
  const [categoryId, setCategoryId] = useState("hospital");
  const [radiusKm, setRadiusKm] = useState(2);
  const [center, setCenter] = useState<[number, number] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<DiscoveryResponse["metadata"] | null>(
    null,
  );

  const category = categories.find((item) => item.id === categoryId);
  const maxRadius = category?.max_radius_km ?? 50;
  const discoveryLayerCount = importedLayers.filter(
    (layer) => layer.kind === "discovery",
  ).length;

  useEffect(() => {
    getJSON<{ categories: DiscoveryCategory[] }>(
      "/api/discovery/categories",
      "Unable to load discovery categories.",
    )
      .then((data) => setCategories(data.categories))
      .catch((error: unknown) =>
        setError(
          error instanceof Error
            ? error.message
            : "Unable to load discovery categories.",
        ),
      );
  }, []);

  const groups = [...new Set(categories.map((item) => item.group))];

  function handleCategoryChange(nextId: string) {
    setCategoryId(nextId);
    setSummary(null);

    const next = categories.find((item) => item.id === nextId);

    if (next && radiusKm > next.max_radius_km) {
      setRadiusKm(next.max_radius_km);
    }
  }

  function handlePickCenter() {
    setError("");
    onBeginMapPick("discovery");

    mapRef.current?.setNearestFeaturePickMode((coordinates) => {
      setCenter(coordinates);
      onEndMapPick();
    });
  }

  function handleUseMapCenter() {
    if (pickActive) {
      mapRef.current?.setNearestFeaturePickMode(null);
      onEndMapPick();
    }

    const viewCenter = mapRef.current?.getViewCenter();

    if (viewCenter) {
      setCenter(viewCenter);
      setError("");
    }
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

    try {
      setLoading(true);
      setError("");
      setSummary(null);

      const data = await postJSON<DiscoveryResponse>(
        "/api/discovery/features",
        {
          coordinates: center,
          category: categoryId,
          radius_km: radiusKm,
        },
        "Feature discovery failed.",
      );

      setSummary(data.metadata);

      if (data.features.length === 0) return;

      mapRef.current?.addDiscoveryLayer(
        data,
        `${data.metadata.label} · ${radiusKm} km`,
      );
      onLayersChanged();
    } catch (error) {
      setSummary(null);
      setError(
        error instanceof Error ? error.message : "Feature discovery failed.",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleClearLayers() {
    mapRef.current?.clearDiscoveryLayers();
    onLayersChanged();
    setSummary(null);
  }

  const inputClass = `mt-1.5 w-full rounded-xl border p-2.5 text-sm outline-none backdrop-blur-md transition-all focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/10 ${
    isDark
      ? "border-white/10 bg-neutral-900/60 text-white hover:border-white/20"
      : "border-white/80 bg-white/50 text-black hover:border-emerald-500/30"
  }`;

  return (
    <section
      className={`rounded-xl border p-4 ${
        isDark ? "border-white/10 bg-white/[0.03]" : "border-gray-200 bg-gray-50"
      }`}
    >
      <div className="mb-3">
        <h4 className="text-sm font-semibold">Discover OSM Features</h4>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          Load real features from OpenStreetMap around a location.
        </p>
      </div>

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

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={handlePickCenter}
          className={`rounded-xl border px-3 py-2.5 text-xs font-medium transition-all ${
            pickActive
              ? "border-amber-400/40 bg-amber-400/10 text-amber-500"
              : isDark
                ? "border-white/10 bg-white/5 hover:border-emerald-400/30"
                : "border-gray-200 bg-white/60 hover:border-emerald-500/30"
          }`}
        >
          {pickActive ? "Click the map..." : "Pick on Map"}
        </button>
        <button
          type="button"
          onClick={handleUseMapCenter}
          className={`rounded-xl border px-3 py-2.5 text-xs font-medium transition-all ${
            isDark
              ? "border-white/10 bg-white/5 hover:border-emerald-400/30"
              : "border-gray-200 bg-white/60 hover:border-emerald-500/30"
          }`}
        >
          Use Map Centre
        </button>
      </div>

      {center && (
        <p className="mt-2 break-all text-xs text-neutral-500">
          Centre: {center[1].toFixed(5)}, {center[0].toFixed(5)}
        </p>
      )}

      <button
        type="button"
        onClick={handleDiscover}
        disabled={loading || !center || pickActive || categories.length === 0}
        className="mt-3 w-full rounded-xl border border-emerald-400/30 bg-emerald-500 px-3 py-2.5 text-sm font-semibold text-black transition-all hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Querying OpenStreetMap..." : "Discover Features"}
      </button>

      {error && (
        <p className="mt-3 break-words rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-400">
          {error}
        </p>
      )}

      {summary && (
        <div
          className={`mt-3 rounded-xl border p-3 ${
            isDark
              ? "border-emerald-400/20 bg-emerald-400/5"
              : "border-emerald-500/20 bg-emerald-500/5"
          }`}
        >
          <p className="text-xs text-neutral-500">{summary.label}</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-500">
            {summary.returned}
            {summary.total_found > summary.returned && (
              <span className="ml-1 text-sm font-medium text-neutral-500">
                of {summary.total_found}
              </span>
            )}
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            {summary.returned === 0
              ? `No features found within ${summary.radius_km} km.`
              : `Within ${summary.radius_km} km · ${summary.geometry_types.join(", ")}`}
          </p>
          {summary.truncated && (
            <p className="mt-2 text-xs text-amber-500">
              Results were truncated. Reduce the radius for complete results.
            </p>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
            {summary.coverage_note}
          </p>
          <p className="mt-1 text-[11px] text-neutral-500">
            {summary.attribution}
            {summary.osm_base &&
              ` · data as of ${new Date(summary.osm_base).toLocaleDateString()}`}
          </p>
        </div>
      )}

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
    </section>
  );
}
