import { Crosshair, X } from "lucide-react";
import { formatLonLat } from "./useMapPicker";

interface PickFieldProps {
  isDark: boolean;
  label: string;
  value: [number, number] | null;
  picking: boolean;
  /** Tailwind colour for the role dot, matching the map marker. */
  markerClass: string;
  emptyText?: string;
  onPick: () => void;
  onCancel: () => void;
  onClear: () => void;
}

export default function PickField({
  isDark,
  label,
  value,
  picking,
  markerClass,
  emptyText = "Not selected",
  onPick,
  onCancel,
  onClear,
}: PickFieldProps) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-neutral-500">{label}</p>

      <div
        className={`flex items-center gap-2 rounded-xl border p-2 transition-colors ${
          picking
            ? "border-amber-400/50 bg-amber-400/8"
            : isDark
              ? "border-white/10 bg-white/[0.03]"
              : "border-gray-200 bg-white/60"
        }`}
      >
        <span className={`ml-1 h-2.5 w-2.5 shrink-0 rounded-full ${markerClass}`} />

        <div className="min-w-0 flex-1">
          {picking ? (
            <p className="text-xs font-medium text-amber-500">
              Click on the map…
            </p>
          ) : value ? (
            <p className="truncate font-mono text-[11px]" title="Longitude, latitude">
              {formatLonLat(value)}
            </p>
          ) : (
            <p className="text-xs text-neutral-500">{emptyText}</p>
          )}
        </div>

        {picking ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-2 py-1 text-xs font-medium text-amber-500 hover:bg-amber-400/10"
          >
            Cancel
          </button>
        ) : (
          <>
            {value && (
              <button
                type="button"
                onClick={onClear}
                title={`Clear ${label.toLowerCase()}`}
                aria-label={`Clear ${label.toLowerCase()}`}
                className={`rounded-lg p-1.5 transition-colors ${
                  isDark
                    ? "text-neutral-500 hover:bg-white/8 hover:text-red-300"
                    : "text-gray-400 hover:bg-red-50 hover:text-red-600"
                }`}
              >
                <X size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={onPick}
              aria-label={`Pick ${label.toLowerCase()} on map`}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                isDark
                  ? "border-emerald-400/25 text-emerald-400 hover:bg-emerald-400/10"
                  : "border-emerald-500/30 text-emerald-700 hover:bg-emerald-50"
              }`}
            >
              <Crosshair size={13} />
              {value ? "Change" : "Pick"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
