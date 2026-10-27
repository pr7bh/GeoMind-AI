import {
  MapPin,
  Minus,
  Pentagon,
  MousePointer2,
  Download,
  Trash2,
  Upload,
} from "lucide-react";

export type DrawingMode = "none" | "Point" | "LineString" | "Polygon";

interface DrawingToolbarProps {
  theme: "light" | "dark";
  mode: DrawingMode;
  onModeChange: (mode: DrawingMode) => void;
  onClear: () => void;
  onImport: () => void;
  onExport: () => void;
}

export default function DrawingToolbar({
  theme,
  mode,
  onModeChange,
  onClear,
  onImport,
  onExport,
}: DrawingToolbarProps) {
  const isDark = theme === "dark";

  const buttonClass = (active: boolean) =>
    `rounded-lg p-2 transition-colors ${
      active
        ? "bg-emerald-500/15 text-emerald-500"
        : isDark
          ? "text-neutral-300 hover:bg-neutral-800"
          : "text-gray-600 hover:bg-gray-100"
    }`;

  return (
    <div
      className={`absolute left-4 top-32 z-10 flex flex-col gap-1 rounded-xl border shadow-lg ${
        isDark ? "border-neutral-800 bg-black" : "border-gray-200 bg-white"
      }`}
    >
      <button
        className={buttonClass(mode === "none")}
        onClick={() => onModeChange("none")}
        title="Navigation mode"
        aria-label="Navigation mode"
      >
        <MousePointer2 size={18} />
      </button>

      <button
        className={buttonClass(mode === "Point")}
        onClick={() => onModeChange("Point")}
        title="Draw point"
        aria-label="Draw point"
      >
        <MapPin size={18} />
      </button>

      <button
        className={buttonClass(mode === "LineString")}
        onClick={() => onModeChange("LineString")}
        title="Draw line"
        aria-label="Draw line"
      >
        <Minus size={18} />
      </button>

      <button
        className={buttonClass(mode === "Polygon")}
        onClick={() => onModeChange("Polygon")}
        title="Draw polygon"
        aria-label="Draw polygon"
      >
        <Pentagon size={18} />
      </button>

      <div
        className={
          isDark ? "border-t border-neutral-800" : "border-t border-gray-200"
        }
      />

      <button
        className={buttonClass(false)}
        onClick={onClear}
        title="Clear drawings"
        aria-label="Clear drawings"
      >
        <Trash2 size={18} />
      </button>
      <button
        className={buttonClass(false)}
        onClick={onImport}
        title="Import GeoJSON"
        aria-label="Import GeoJSON"
      >
        <Upload size={18} />
      </button>

      <button
        className={buttonClass(false)}
        onClick={onExport}
        title="Export drawings as GeoJSON"
        aria-label="Export drawings as GeoJSON"
      >
        <Download size={18} />
      </button>
    </div>
  );
}
