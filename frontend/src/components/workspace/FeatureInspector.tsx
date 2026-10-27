import type { SelectedFeatureInfo } from "./GeoMap";
import { MapPin, Ruler, Pentagon, X, Copy, Calculator, Database, FlaskConical } from "lucide-react";
import { useState } from "react";

interface FeatureInspectorProps {
  theme: "light" | "dark";
  feature: SelectedFeatureInfo | null;
  onClose: () => void;
  onCreateBuffer: (
    geometryType: "Point" | "LineString",
    coordinates: number[] | number[][],
    distanceMetres: number,
  ) => Promise<void>;
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

      const response = await fetch(
        "http://127.0.0.1:8000/api/analysis/polygon-area",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            coordinates: coordinates[0],
          }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail ?? "Area calculation failed.");
      }

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

  if (!feature) return null;

  const geometryIcon =
    feature.geometryType === "Point"
      ? MapPin
      : feature.geometryType === "Polygon"
        ? Pentagon
        : Ruler;

  const GeometryIcon = geometryIcon;

  const coordinatesText = JSON.stringify(feature.coordinates, null, 2);

  return (
    <aside
      className={`absolute bottom-4 left-4 z-20 w-80 max-w-[calc(100%-2rem)] overflow-hidden rounded-2xl border shadow-2xl backdrop-blur-xl transition-colors duration-200 ${
        isDark
          ? "border-neutral-800 bg-neutral-950/95 text-neutral-100 shadow-black/40"
          : "border-gray-200 bg-white/95 text-gray-900 shadow-gray-300/40"
      }`}
    >
      {/* Header */}
      <div
        className={`flex items-center justify-between border-b px-4 py-3 ${
          isDark ? "border-neutral-800" : "border-gray-100"
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`flex h-9 w-9 items-center justify-center rounded-xl border ${
              isDark
                ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-400"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            <GeometryIcon size={19} strokeWidth={1.8} />
          </div>

          <div>
            <h3 className="text-sm font-semibold tracking-tight">
              Feature Inspector
            </h3>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
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
          className={`rounded-lg p-2 transition-colors ${
            isDark
              ? "text-neutral-500 hover:bg-neutral-800 hover:text-white"
              : "text-gray-400 hover:bg-gray-100 hover:text-gray-900"
          }`}
        >
          <X size={16} />
        </button>
      </div>

      <div className="max-h-[calc(100vh-9rem)] space-y-4 overflow-y-auto p-4">
        {/* Feature metadata */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${
                isDark ? "text-neutral-500" : "text-gray-400"
              }`}
            >
              Feature details
            </p>
            <span
              className={`rounded-md px-2 py-1 text-[10px] font-medium ${
                isDark
                  ? "bg-neutral-900 text-neutral-400"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              Selected
            </span>
          </div>

          <div
            className={`rounded-xl border p-3 ${
              isDark
                ? "border-neutral-800 bg-black/50"
                : "border-gray-100 bg-gray-50/80"
            }`}
          >
            <p
              className={`text-[11px] ${
                isDark ? "text-neutral-500" : "text-gray-500"
              }`}
            >
              Feature ID
            </p>
            <p className="mt-1.5 break-all font-mono text-xs leading-relaxed">
              {feature.id}
            </p>
          </div>
        </section>

        {/* Geometry measurements */}
        {(feature.geometryType === "LineString" &&
          feature.lengthMeters !== undefined) ||
        (feature.geometryType === "Polygon" &&
          feature.areaSquareMeters !== undefined) ? (
          <section>
            <p
              className={`mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                isDark ? "text-neutral-500" : "text-gray-400"
              }`}
            >
              Measurements
            </p>

            <div className="grid grid-cols-2 gap-2">
              {feature.geometryType === "LineString" &&
                feature.lengthMeters !== undefined && (
                  <div
                    className={`rounded-xl border p-3 ${
                      isDark
                        ? "border-neutral-800 bg-neutral-900/60"
                        : "border-gray-200 bg-white"
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

              {feature.geometryType === "Polygon" &&
                feature.areaSquareMeters !== undefined && (
                  <div
                    className={`rounded-xl border p-3 ${
                      isDark
                        ? "border-neutral-800 bg-neutral-900/60"
                        : "border-gray-200 bg-white"
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

              {feature.geometryType === "Polygon" &&
                feature.perimeterMeters !== undefined && (
                  <div
                    className={`rounded-xl border p-3 ${
                      isDark
                        ? "border-neutral-800 bg-neutral-900/60"
                        : "border-gray-200 bg-white"
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
          </section>
        ) : null}

        {/* Backend area calculation */}
        {feature.geometryType === "Polygon" && (
          <section>
            <p
              className={`mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                isDark ? "text-neutral-500" : "text-gray-400"
              }`}
            >
              Spatial tools
            </p>

            <button
              type="button"
              onClick={calculateAreaWithBackend}
              disabled={areaLoading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-3 py-2.5 text-xs font-semibold text-black transition-all hover:bg-emerald-400 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Calculator size={15} />
              {areaLoading ? "Calculating area..." : "Calculate area with API"}
            </button>

            {backendArea && (
              <div
                className={`mt-3 rounded-xl border p-3 ${
                  isDark
                    ? "border-emerald-500/20 bg-emerald-500/6"
                    : "border-emerald-200 bg-emerald-50/70"
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
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
          </section>
        )}

        {/* Buffer analysis */}
        {(feature.geometryType === "Point" ||
          feature.geometryType === "LineString") && (
          <section
            className={`border-t pt-4 ${
              isDark ? "border-neutral-800" : "border-gray-100"
            }`}
          >
            <div className="mb-3 flex items-center gap-2">
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-lg ${
                  isDark
                    ? "bg-neutral-900 text-emerald-400"
                    : "bg-emerald-50 text-emerald-700"
                }`}
              >
                <Ruler size={14} />
              </div>
              <div>
                <h4 className="text-xs font-semibold">Buffer analysis</h4>
                <p
                  className={`mt-0.5 text-[10px] ${
                    isDark ? "text-neutral-500" : "text-gray-500"
                  }`}
                >
                  Create a surrounding zone
                </p>
              </div>
            </div>

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
              className={`w-full rounded-xl border px-3 py-2.5 text-sm outline-none transition-colors focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/10 ${
                isDark
                  ? "border-neutral-800 bg-black text-white placeholder:text-neutral-600"
                  : "border-gray-200 bg-white text-gray-900 placeholder:text-gray-400"
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
              className={`mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                isDark
                  ? "border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-emerald-500/40 hover:bg-neutral-800"
                  : "border-gray-200 bg-white text-gray-700 hover:border-emerald-300 hover:bg-emerald-50"
              }`}
            >
              {bufferLoading ? "Creating buffer..." : "Create buffer"}
            </button>

            {bufferError && (
              <p className="mt-2 text-xs text-red-500">{bufferError}</p>
            )}
          </section>
        )}

        {/* Coordinates */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${
                isDark ? "text-neutral-500" : "text-gray-400"
              }`}
            >
              Coordinates
            </p>

            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(coordinatesText);
              }}
              className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors ${
                isDark
                  ? "text-neutral-400 hover:bg-neutral-800 hover:text-emerald-400"
                  : "text-gray-500 hover:bg-gray-100 hover:text-emerald-700"
              }`}
            >
              <Copy size={12} />
              Copy
            </button>
          </div>

          <pre
            className={`max-h-32 overflow-auto rounded-xl border p-3 font-mono text-[10px] leading-relaxed
                scrollbar-thin
                ${
                isDark
                    ? "border-neutral-800 bg-black text-neutral-300 [scrollbar-color:rgba(52,211,153,0.3)_transparent]"
                    : "border-gray-100 bg-gray-50 text-gray-700 [scrollbar-color:rgba(5,150,105,0.3)_transparent]"
                }
                [&::-webkit-scrollbar]:w-1
                [&::-webkit-scrollbar]:h-1
                [&::-webkit-scrollbar-track]:bg-transparent
                [&::-webkit-scrollbar-thumb]:rounded-full
                ${
                isDark
                    ? "[&::-webkit-scrollbar-thumb]:bg-emerald-400/25 hover:[&::-webkit-scrollbar-thumb]:bg-emerald-400/50"
                    : "[&::-webkit-scrollbar-thumb]:bg-emerald-600/25 hover:[&::-webkit-scrollbar-thumb]:bg-emerald-600/50"
                }`}
            >
            {coordinatesText}
            </pre>
        </section>

        {/* Footer */}
        <div
          className={`flex items-center gap-2 border-t pt-3 ${
            isDark ? "border-neutral-800" : "border-gray-100"
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
}
