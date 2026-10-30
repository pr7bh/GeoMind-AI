import { Crosshair } from "lucide-react";
import type { ActivePick } from "./useMapPicker";

interface MapPickBannerProps {
  isDark: boolean;
  pick: ActivePick;
  onCancel: () => void;
}

export default function MapPickBanner({ isDark, pick, onCancel }: MapPickBannerProps) {
  return (
    <div
      role="status"
      className={`pointer-events-auto flex items-center gap-3 rounded-xl border py-2 pl-3 pr-2 text-xs shadow-lg backdrop-blur-2xl ${
        isDark
          ? "border-amber-400/30 bg-neutral-950/85 text-neutral-100 shadow-black/40"
          : "border-amber-400/40 bg-white/90 text-gray-900 shadow-gray-900/10"
      }`}
    >
      <Crosshair size={15} className="shrink-0 animate-pulse text-amber-500" />
      <span className="font-medium">{pick.instruction}</span>
      <kbd
        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
          isDark ? "border-white/15 text-neutral-400" : "border-gray-300 text-gray-500"
        }`}
      >
        Esc
      </kbd>
      <button
        type="button"
        onClick={onCancel}
        className={`rounded-lg border px-2.5 py-1 font-medium transition-colors ${
          isDark
            ? "border-white/10 hover:border-red-400/30 hover:text-red-300"
            : "border-gray-200 hover:border-red-300 hover:text-red-600"
        }`}
      >
        Cancel selection
      </button>
    </div>
  );
}
