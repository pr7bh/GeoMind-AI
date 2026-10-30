import type { SelectedFeatureInfo } from "./GeoMap";
import { Rnd } from "react-rnd";
import {
  MapPin,
  Ruler,
  Pentagon,
  X,
  Copy,
  Calculator,
  Database,
  FlaskConical,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { postJSON } from "../../lib/api";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../../lib/useMediaQuery";

interface FeatureInspectorProps {
  theme: "light" | "dark";
  feature: SelectedFeatureInfo | null;
  onClose: () => void;
  onCreateBuffer: (
    geometryType: "Point" | "LineString",
    coordinates: number[] | number[][],
    distanceMetres: number,
  ) => Promise<void>;
  onAnalyzePointsInPolygon: () => void;
  pointAnalysisResult: Record<string, any> | null;
  onClearPointAnalysis: () => void;
  nearestFeatureDetails: {
    properties: Record<string, unknown>;
    distanceMetres: number;
  } | null;
}

interface InspectorSectionProps {
  isDark: boolean;
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}

function InspectorSection({
  isDark,
  title,
  count,
  defaultOpen = true,
  children,
}: InspectorSectionProps) {
  return (
    <details open={defaultOpen} className="group">
      <summary
        className={`flex cursor-pointer list-none items-center gap-2 rounded-lg py-1 text-[10px] font-semibold uppercase tracking-[0.14em] [&::-webkit-details-marker]:hidden ${
          isDark ? "text-neutral-400 hover:text-neutral-200" : "text-gray-500 hover:text-gray-800"
        }`}
      >
        <ChevronRight
          size={12}
          className="shrink-0 transition-transform group-open:rotate-90"
        />
        <span className="flex-1">{title}</span>
        {count !== undefined && (
          <span className="rounded-md border border-current/20 px-1.5 text-[10px] font-medium normal-case tracking-normal">
            {count}
          </span>
        )}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

function formatLength(meters: number): string {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(2)} km`
    : `${meters.toFixed(2)} m`;
}

function formatArea(squareMeters: number): string {
  if (squareMeters >= 1_000_000) {
    return `${(squareMeters / 1_000_000).toFixed(3)} km²`;
  }

  if (squareMeters >= 10_000) {
    return `${(squareMeters / 10_000).toFixed(2)} hectares`;
  }

  return `${squareMeters.toFixed(2)} m²`;
}

export default function FeatureInspector({
  theme,
  feature,
  onCreateBuffer,
  onClose,
  onAnalyzePointsInPolygon,
  pointAnalysisResult,
  onClearPointAnalysis,
  nearestFeatureDetails,
}: FeatureInspectorProps) {
  const isDark = theme === "dark";

  const [backendArea, setBackendArea] = useState<{
    squareMetres: number;
    squareKilometres: number;
  } | null>(null);

  const [areaLoading, setAreaLoading] = useState(false);
  const [areaError, setAreaError] = useState("");
  const [bufferDistance, setBufferDistance] = useState(500);
  const [bufferLoading, setBufferLoading] = useState(false);
  const [bufferError, setBufferError] = useState("");

  async function calculateAreaWithBackend() {
    if (!feature || feature.geometryType !== "Polygon") return;

    setAreaLoading(true);
    setAreaError("");
    setBackendArea(null);

    try {
      const coordinates = feature.coordinatesWGS84 as number[][][];

      const data = await postJSON<{
        area_square_metres: number;
        area_square_kilometres: number;
      }>(
        "/api/analysis/polygon-area",
        { coordinates: coordinates[0] },
        "Area calculation failed.",
      );

      setBackendArea({
        squareMetres: data.area_square_metres,
        squareKilometres: data.area_square_kilometres,
      });
    } catch (error) {
      setAreaError(
        error instanceof Error
          ? error.message
          : "Unable to connect to the backend.",
      );
    } finally {
      setAreaLoading(false);
    }
  }

  async function handleCreateBuffer() {
    if (
      !feature ||
      (feature.geometryType !== "Point" &&
        feature.geometryType !== "LineString")
    ) {
      return;
    }

    setBufferLoading(true);
    setBufferError("");

    try {
      const coordinates = feature.coordinatesWGS84 as number[] | number[][];

      await onCreateBuffer(feature.geometryType, coordinates, bufferDistance);
    } catch (error) {
      setBufferError(
        error instanceof Error ? error.message : "Buffer creation failed.",
      );
    } finally {
      setBufferLoading(false);
    }
  }

  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);

  if (!feature) return null;

  const geometryIcon =
    feature.geometryType === "Point" || feature.geometryType === "MultiPoint"
      ? MapPin
      : feature.geometryType === "Polygon" ||
          feature.geometryType === "MultiPolygon"
        ? Pentagon
        : Ruler;

  const osm =
    feature.properties?.osm_id != null ? feature.properties : undefined;
  const osmTags =
    osm?.tags && typeof osm.tags === "object"
      ? Object.entries(osm.tags as Record<string, string>)
      : [];
  const osmRows: [string, string][] = osm
    ? [
        ["Name", String(osm.display_name ?? osm.name ?? "Unnamed")],
        ["Category", String(osm.category ?? "—").replace(/_/g, " ")],
        [
          "Distance from search centre",
          typeof osm.distance_km === "number"
            ? osm.distance_km < 1
              ? `${(osm.distance_km * 1000).toFixed(0)} m`
              : `${osm.distance_km.toFixed(2)} km`
            : "—",
        ],
        ["Address", osm.address ? String(osm.address) : "Not recorded in OSM"],
        ["Source", String(osm.source ?? "OpenStreetMap")],
      ]
    : [];
  const cardClass = `rounded-lg border p-3 ${
    isDark ? "border-white/8 bg-white/[0.025]" : "border-gray-200 bg-white/60"
  }`;

  const GeometryIcon = geometryIcon;

  const isLinear =
    feature.geometryType === "LineString" ||
    feature.geometryType === "MultiLineString";
  const isAreal =
    feature.geometryType === "Polygon" || feature.geometryType === "MultiPolygon";
  const featureTitle = String(
    osm?.display_name ??
      feature.properties?.name ??
      feature.properties?.Name ??
      nearestFeatureDetails?.properties.name ??
      `${feature.geometryType} feature`,
  );
  const sourceLabel = osm
    ? "OpenStreetMap"
    : nearestFeatureDetails
      ? "Analysis result"
      : "Drawn on map";
  const badgeClass = `rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
    isDark
      ? "border-emerald-400/20 bg-emerald-400/8 text-emerald-300"
      : "border-emerald-200 bg-emerald-50 text-emerald-700"
  }`;

  // Map geometries are EPSG:3857; show users WGS84 longitude/latitude.
  const coordinatesText = JSON.stringify(
    feature.coordinatesWGS84,
    (_, value) => (typeof value === "number" ? Number(value.toFixed(6)) : value),
    feature.geometryType === "Point" ? undefined : 1,
  );
  const pointLonLat =
    feature.geometryType === "Point" && Array.isArray(feature.coordinatesWGS84)
      ? (feature.coordinatesWGS84 as number[])
          .map((value) => value.toFixed(6))
          .join(", ")
      : null;

  const panel = (
      <aside
        className={`flex h-full w-full flex-col overflow-hidden rounded-2xl border backdrop-blur-2xl transition-colors duration-300 ${
          isDark
            ? "border-white/12 bg-neutral-950/65 text-neutral-100 shadow-[0_20px_60px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.04)]"
            : "border-white/80 bg-white/65 text-gray-900 shadow-[0_20px_60px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.7)]"
        }`}
      >
        {/* Header */}
        <div
          className={`feature-inspector-drag-handle flex shrink-0 cursor-move items-center justify-between border-b px-4 py-3 ${
            isDark
              ? "border-white/[0.09] bg-white/[0.025]"
              : "border-white/70 bg-white/30"
          }`}
        >
          <div className="flex items-center gap-3">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-xl border ${
                isDark
                  ? "border-emerald-400/20 bg-emerald-400/[0.10] text-emerald-400"
                  : "border-emerald-200/70 bg-emerald-50/70 text-emerald-700"
              }`}
            >
              <GeometryIcon size={19} strokeWidth={1.8} />
            </div>

            <div>
              <h3 className="text-sm font-semibold tracking-tight">
                Feature Inspector
              </h3>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_7px_rgba(16,185,129,0.45)]" />
                <p
                  className={`text-[11px] ${
                    isDark ? "text-neutral-400" : "text-gray-500"
                  }`}
                >
                  {feature.geometryType}
                </p>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            title="Close inspector"
            aria-label="Close inspector"
            className={`rounded-lg border border-transparent p-2 transition-colors ${
              isDark
                ? "text-neutral-400 hover:border-white/[0.08] hover:bg-white/[0.07] hover:text-white"
                : "text-gray-400 hover:border-gray-200/60 hover:bg-white/70 hover:text-gray-900"
            }`}
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable content */}
        <div
          className={`min-h-0 flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin ${
            isDark
              ? "[scrollbar-color:rgba(52,211,153,0.3)_transparent] [&::-webkit-scrollbar-thumb]:bg-emerald-400/25 hover:[&::-webkit-scrollbar-thumb]:bg-emerald-400/50"
              : "[scrollbar-color:rgba(5,150,105,0.3)_transparent] [&::-webkit-scrollbar-thumb]:bg-emerald-600/25 hover:[&::-webkit-scrollbar-thumb]:bg-emerald-600/50"
          } [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full`}
        >
          {/* Feature identity */}
          <section
            className={`rounded-xl border p-3 ${
              isDark ? "border-white/8 bg-white/2.5" : "border-gray-200/80 bg-white/50"
            }`}
          >
            <p className="break-words text-base font-semibold tracking-tight">
              {featureTitle}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className={badgeClass}>{feature.geometryType}</span>
              <span className={badgeClass}>{sourceLabel}</span>
            </div>
            <p className="mt-2 text-[11px] text-neutral-500">Feature ID</p>
            <p className="mt-0.5 break-all font-mono text-xs">{feature.id}</p>
          </section>

          {/* OpenStreetMap attributes */}
          {osm && (
            <InspectorSection isDark={isDark} title="OpenStreetMap">
              <div className="space-y-2">
                {osmRows.map(([label, value]) => (
                  <div key={label} className={cardClass}>
                    <p className="text-[11px] text-neutral-500">{label}</p>
                    <p className="mt-1 break-words text-xs">{value}</p>
                  </div>
                ))}

                <div className={cardClass}>
                  <p className="text-[11px] text-neutral-500">OSM ID</p>
                  <a
                    href={String(osm.osm_url)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block break-all font-mono text-xs text-emerald-500 hover:underline"
                  >
                    {String(osm.osm_type)}/{String(osm.osm_id)}
                  </a>
                </div>
              </div>
            </InspectorSection>
          )}

          {osmTags.length > 0 && (
            <InspectorSection
              isDark={isDark}
              title="Raw OSM tags"
              count={osmTags.length}
              defaultOpen={osmTags.length <= 8}
            >
              <div className={`${cardClass} space-y-1`}>
                {osmTags.map(([key, value]) => (
                  <p key={key} className="break-words font-mono text-[11px]">
                    <span className="text-neutral-500">{key}</span> = {value}
                  </p>
                ))}
              </div>
            </InspectorSection>
          )}

          {/* Geometry measurements */}
          {(isLinear &&
            feature.lengthMeters !== undefined) ||
          (isAreal &&
            feature.areaSquareMeters !== undefined) ? (
            <InspectorSection isDark={isDark} title="Measurements">
              <div className="grid grid-cols-2 gap-2">
                {isLinear &&
                  feature.lengthMeters !== undefined && (
                    <div
                      className={`rounded-xl border p-3 backdrop-blur-xl ${
                        isDark
                          ? "border-white/8 bg-white/[0.035]"
                          : "border-white/80 bg-white/45"
                      }`}
                    >
                      <div className="mb-2 flex items-center gap-1.5">
                        <Ruler size={13} className="text-emerald-500" />
                        <p
                          className={`text-[10px] ${
                            isDark ? "text-neutral-400" : "text-gray-500"
                          }`}
                        >
                          Line length
                        </p>
                      </div>
                      <p className="text-sm font-semibold tracking-tight text-emerald-500">
                        {formatLength(feature.lengthMeters)}
                      </p>
                    </div>
                  )}

                {isAreal &&
                  feature.areaSquareMeters !== undefined && (
                    <div
                      className={`rounded-xl border p-3 backdrop-blur-xl ${
                        isDark
                          ? "border-white/8 bg-white/[0.035]"
                          : "border-white/80 bg-white/45"
                      }`}
                    >
                      <div className="mb-2 flex items-center gap-1.5">
                        <FlaskConical size={13} className="text-emerald-500" />
                        <p
                          className={`text-[10px] ${
                            isDark ? "text-neutral-400" : "text-gray-500"
                          }`}
                        >
                          Polygon area
                        </p>
                      </div>
                      <p className="text-sm font-semibold tracking-tight text-emerald-500">
                        {formatArea(feature.areaSquareMeters)}
                      </p>
                    </div>
                  )}

                {isAreal &&
                  feature.perimeterMeters !== undefined && (
                    <div
                      className={`rounded-xl border p-3 backdrop-blur-xl ${
                        isDark
                          ? "border-white/8 bg-white/[0.035]"
                          : "border-white/80 bg-white/45"
                      }`}
                    >
                      <div className="mb-2 flex items-center gap-1.5">
                        <Ruler size={13} className="text-emerald-500" />
                        <p
                          className={`text-[10px] ${
                            isDark ? "text-neutral-400" : "text-gray-500"
                          }`}
                        >
                          Perimeter
                        </p>
                      </div>
                      <p className="text-sm font-semibold tracking-tight">
                        {formatLength(feature.perimeterMeters)}
                      </p>
                    </div>
                  )}
              </div>
            </InspectorSection>
          ) : null}

          {/* Server-side area calculation */}
          {feature.geometryType === "Polygon" && (
            <InspectorSection isDark={isDark} title="Geodesic area (server)">
              <button
                type="button"
                onClick={calculateAreaWithBackend}
                disabled={areaLoading}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/90 px-3 py-2.5 text-xs font-semibold text-neutral-950 shadow-[0_4px_18px_rgba(16,185,129,0.12)] transition-all hover:border-emerald-300 hover:bg-emerald-400 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Calculator size={15} />
                {areaLoading
                  ? "Calculating area..."
                  : "Calculate area with API"}
              </button>

              {backendArea && (
                <div
                  className={`mt-3 rounded-xl border p-3 backdrop-blur-xl ${
                    isDark
                      ? "border-emerald-400/20 bg-emerald-400/6"
                      : "border-emerald-200/70 bg-emerald-50/60"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-400/15 bg-emerald-500/10 text-emerald-500">
                      <Database size={13} />
                    </div>
                    <p className="text-xs font-medium text-emerald-500">
                      Backend result
                    </p>
                  </div>

                  <p className="mt-3 text-lg font-semibold tracking-tight">
                    {formatArea(backendArea.squareMetres)}
                  </p>
                  <p
                    className={`mt-1 text-[11px] ${
                      isDark ? "text-neutral-400" : "text-gray-500"
                    }`}
                  >
                    {backendArea.squareKilometres.toFixed(6)} km²
                  </p>
                </div>
              )}

              {areaError && (
                <p className="mt-2 text-xs text-red-500">{areaError}</p>
              )}
            </InspectorSection>
          )}
          {nearestFeatureDetails && (
  <InspectorSection isDark={isDark} title="Nearest-feature analysis">
    <div
      className={`mb-3 rounded-xl border p-3 ${
        isDark
          ? "border-emerald-400/20 bg-emerald-400/5"
          : "border-emerald-200 bg-emerald-50"
      }`}
    >
      <p className="text-xs text-neutral-500">Distance from origin</p>
      <p className="mt-1 text-xl font-semibold text-emerald-500">
        {nearestFeatureDetails.distanceMetres >= 1000
          ? `${(
              nearestFeatureDetails.distanceMetres / 1000
            ).toFixed(3)} km`
          : `${nearestFeatureDetails.distanceMetres.toFixed(2)} m`}
      </p>
    </div>

    <div className="space-y-2">
      {Object.entries(nearestFeatureDetails.properties).map(
        ([key, value]) => (
          <div
            key={key}
            className={`rounded-lg border p-3 ${
              isDark
                ? "border-white/8 bg-white/[0.025]"
                : "border-gray-200 bg-white/60"
            }`}
          >
            <p className="text-[11px] text-neutral-500">{key}</p>
            <p className="mt-1 break-words text-xs">
              {value == null
                ? "—"
                : typeof value === "object"
                  ? JSON.stringify(value)
                  : String(value)}
            </p>
          </div>
        ),
      )}

      {Object.keys(nearestFeatureDetails.properties).length === 0 && (
        <p className="text-xs text-neutral-500">
          No additional properties are available for this feature.
        </p>
      )}
    </div>
  </InspectorSection>
)}

          {/* Buffer analysis */}
          {(feature.geometryType === "Point" ||
            feature.geometryType === "LineString") && (
            <InspectorSection isDark={isDark} title="Buffer analysis">
              <label
                className={`mb-1.5 block text-[11px] ${
                  isDark ? "text-neutral-400" : "text-gray-500"
                }`}
              >
                Distance (metres)
              </label>

              <input
                type="number"
                min={1}
                max={100000}
                value={bufferDistance}
                onChange={(event) =>
                  setBufferDistance(Number(event.target.value))
                }
                className={`w-full rounded-xl border px-3 py-2.5 text-sm outline-none backdrop-blur-xl transition-colors focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/10 ${
                  isDark
                    ? "border-white/10 bg-white/[0.035] text-white placeholder:text-neutral-500"
                    : "border-white/80 bg-white/50 text-gray-900 placeholder:text-gray-400"
                }`}
              />

              <button
                type="button"
                onClick={handleCreateBuffer}
                disabled={
                  bufferLoading ||
                  !Number.isFinite(bufferDistance) ||
                  bufferDistance <= 0 ||
                  bufferDistance > 100000
                }
                className={`mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-semibold backdrop-blur-xl transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                  isDark
                    ? "border-white/10 bg-white/4 text-neutral-200 hover:border-emerald-400/30 hover:bg-emerald-400/[0.07]"
                    : "border-white/80 bg-white/55 text-gray-700 hover:border-emerald-200 hover:bg-emerald-50/60"
                }`}
              >
                {bufferLoading ? "Creating buffer..." : "Create buffer"}
              </button>

              {bufferError && (
                <p className="mt-2 text-xs text-red-500">{bufferError}</p>
              )}
            </InspectorSection>
          )}

          {(feature.geometryType === "Polygon" || pointAnalysisResult) && (
            <InspectorSection isDark={isDark} title="Points in polygon">
              <div className="space-y-3">
          {/* Point-in-polygon results */}
          {pointAnalysisResult && (
            <section
              className={`rounded-xl border p-3 backdrop-blur-xl ${
                isDark
                  ? "border-emerald-400/20 bg-emerald-400/5"
                  : "border-emerald-200/70 bg-emerald-50/50"
              }`}
            >
              <h4 className="mb-3 text-sm font-semibold">
                Point-in-Polygon Results
              </h4>

              {pointAnalysisResult.error ? (
                <p className="text-sm text-red-500">
                  {pointAnalysisResult.error}
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p
                        className={`text-xs ${
                          isDark ? "text-neutral-400" : "text-gray-500"
                        }`}
                      >
                        Points inside
                      </p>
                      <p className="text-xl font-semibold text-emerald-500">
                        {pointAnalysisResult.points_inside_count}
                      </p>
                    </div>

                    <div>
                      <p
                        className={`text-xs ${
                          isDark ? "text-neutral-400" : "text-gray-500"
                        }`}
                      >
                        Points outside
                      </p>
                      <p className="text-xl font-semibold">
                        {pointAnalysisResult.points_outside_count}
                      </p>
                    </div>
                  </div>

                  <p
                    className={`mt-3 text-xs ${
                      isDark ? "text-neutral-400" : "text-gray-500"
                    }`}
                  >
                    Total analyzed: {pointAnalysisResult.total_points}
                  </p>
                </>
              )}
            </section>
          )}

          {feature?.geometryType === "Polygon" && (
            <button
              type="button"
              onClick={onAnalyzePointsInPolygon}
              className="w-full rounded-xl border border-emerald-400/20 bg-emerald-500/90 px-4 py-2.5 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-400 active:scale-[0.99]"
            >
              Analyze Imported Points
            </button>
          )}

          {pointAnalysisResult && (
            <button
              type="button"
              onClick={onClearPointAnalysis}
              className={`w-full rounded-xl border px-4 py-2.5 text-sm transition-colors ${
                isDark
                  ? "border-red-400/20 bg-red-400/5 text-red-400 hover:bg-red-400/10"
                  : "border-red-200/70 bg-red-50/60 text-red-600 hover:bg-red-50"
              }`}
            >
              Clear Analysis
            </button>
          )}
              </div>
            </InspectorSection>
          )}

          {/* Coordinates */}
          <InspectorSection isDark={isDark} title="Coordinates (WGS84)" defaultOpen={false}>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] text-neutral-500">
                {pointLonLat ? `Lon/Lat: ${pointLonLat}` : "Longitude, latitude pairs"}
              </p>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(coordinatesText);
                }}
                className={`flex items-center gap-1.5 rounded-lg border border-transparent px-2 py-1.5 text-[11px] font-medium transition-colors ${
                  isDark
                    ? "text-neutral-400 hover:border-white/8 hover:bg-white/5 hover:text-emerald-400"
                    : "text-gray-500 hover:border-gray-200/70 hover:bg-white/60 hover:text-emerald-700"
                }`}
              >
                <Copy size={12} />
                Copy
              </button>
            </div>

            <pre
              className={`max-h-40 overflow-auto rounded-xl border p-3 font-mono text-[10px] leading-relaxed ${
                isDark
                  ? "border-white/8 bg-white/2.5 text-neutral-300"
                  : "border-gray-200 bg-white/50 text-gray-700"
              }`}
            >
              {coordinatesText}
            </pre>
          </InspectorSection>

          {/* Footer */}
          <div
            className={`flex items-center gap-2 border-t pt-3 ${
              isDark ? "border-white/9" : "border-gray-200/70"
            }`}
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-30" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <p
              className={`text-[10px] ${
                isDark ? "text-neutral-400" : "text-gray-500"
              }`}
            >
              Ready for spatial analysis
            </p>
          </div>
        </div>
      </aside>
  );

  // Small screens get a fixed sheet; a draggable 680px window cannot fit.
  if (compact) {
    return <div className="pointer-events-auto h-full w-full">{panel}</div>;
  }

  return (
    <Rnd
      default={{
        x: 0,
        y: 0,
        width: "100%",
        height: 440,
      }}
      maxWidth={680}
      minWidth={400}
      minHeight={280}
      bounds="parent"
      dragHandleClassName="feature-inspector-drag-handle"
      enableResizing={{
        top: true,
        right: true,
        bottom: true,
        left: true,
        topRight: true,
        bottomRight: true,
        bottomLeft: true,
        topLeft: true,
      }}
      className="pointer-events-auto z-20"
    >
      {panel}
    </Rnd>
  );
}
