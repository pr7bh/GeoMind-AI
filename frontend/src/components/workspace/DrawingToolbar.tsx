
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
    `rounded-lg border border-transparent p-2 transition-all duration-200 ${
      active
        ? isDark
          ? "border-emerald-400/15 bg-emerald-400/[0.12] text-emerald-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
          : "border-emerald-200/50 bg-emerald-50/70 text-emerald-700"
        : isDark
          ? "text-neutral-300 hover:border-white/[0.05] hover:bg-white/[0.07] hover:text-emerald-400"
          : "text-gray-600 hover:border-emerald-100/60 hover:bg-emerald-50/60 hover:text-emerald-700"
    }`;

  return (
    <div
      className={`absolute right-4 top-32 z-10 flex flex-col gap-1 rounded-xl border backdrop-blur-2xl transition-all duration-300 ${
        isDark
          ? "border-white/12 bg-neutral-950/55 shadow-[0_12px_35px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.04)]"
          : "border-white/80 bg-white/55 shadow-[0_12px_35px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.65)]"
      }`}
    >
      <button
        className={buttonClass(mode === "none")}
        onClick={() => onModeChange("none")}
        title="Navigation mode"
        aria-label="Navigation mode"
      >
        <MousePointer2 size={18} strokeWidth={1.8} />
      </button>

      <button
        className={buttonClass(mode === "Point")}
        onClick={() => onModeChange("Point")}
        title="Draw point"
        aria-label="Draw point"
      >
        <MapPin size={18} strokeWidth={1.8} />
      </button>

      <button
        className={buttonClass(mode === "LineString")}
        onClick={() => onModeChange("LineString")}
        title="Draw line"
        aria-label="Draw line"
      >
        <Minus size={18} strokeWidth={1.8} />
      </button>

      <button
        className={buttonClass(mode === "Polygon")}
        onClick={() => onModeChange("Polygon")}
        title="Draw polygon"
        aria-label="Draw polygon"
      >
        <Pentagon size={18} strokeWidth={1.8} />
      </button>

      <div
        className={
          isDark
            ? "mx-1 border-t border-white/9"
            : "mx-1 border-t border-gray-300/50"
        }
      />

      <button
        className={buttonClass(false)}
        onClick={onClear}
        title="Clear drawings"
        aria-label="Clear drawings"
      >
        <Trash2 size={18} strokeWidth={1.8} />
      </button>

      <button
        className={buttonClass(false)}
        onClick={onImport}
        title="Import GeoJSON"
        aria-label="Import GeoJSON"
      >
        <Upload size={18} strokeWidth={1.8} />
      </button>

      <button
        className={buttonClass(false)}
        onClick={onExport}
        title="Export drawings as GeoJSON"
        aria-label="Export drawings as GeoJSON"
      >
        <Download size={18} strokeWidth={1.8} />
      </button>
    </div>
  );
}
