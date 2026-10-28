
import { Home, Layers, Minus, Plus } from 'lucide-react';

interface MapToolbarProps {
  theme: 'light' | 'dark';
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onToggleLayers: () => void;
  isLayersOpen: boolean;
}

export default function MapToolbar({
  theme,
  onZoomIn,
  onZoomOut,
  onReset,
  onToggleLayers,
  isLayersOpen,
}: MapToolbarProps) {
  const isDark = theme === 'dark';

  const buttonClass = `rounded-lg p-2 transition-all duration-200 ${
    isDark
      ? 'text-neutral-300 hover:bg-white/[0.08] hover:text-emerald-400'
      : 'text-gray-600 hover:bg-emerald-50/70 hover:text-emerald-700'
  }`;

  const activeButtonClass = isDark
    ? 'border border-emerald-400/15 bg-emerald-400/[0.12] text-emerald-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'
    : 'border border-emerald-200/50 bg-emerald-50/70 text-emerald-700';

  return (
    <div
      className={`absolute right-4 top-16 z-10 flex flex-col gap-1 rounded-xl border backdrop-blur-2xl transition-all duration-300 ${
        isDark
          ? 'border-white/[0.12] bg-neutral-950/55 shadow-[0_12px_35px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.04)]'
          : 'border-white/80 bg-white/55 shadow-[0_12px_35px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.65)]'
      }`}
    >
      <button
        className={buttonClass}
        onClick={onZoomIn}
        title="Zoom in"
        aria-label="Zoom in"
      >
        <Plus size={18} strokeWidth={1.8} />
      </button>

      <button
        className={buttonClass}
        onClick={onZoomOut}
        title="Zoom out"
        aria-label="Zoom out"
      >
        <Minus size={18} strokeWidth={1.8} />
      </button>

      <div
        className={
          isDark
            ? 'mx-1 border-t border-white/[0.09]'
            : 'mx-1 border-t border-gray-300/50'
        }
      />

      <button
        className={buttonClass}
        onClick={onReset}
        title="Reset map view"
        aria-label="Reset map view"
      >
        <Home size={18} strokeWidth={1.8} />
      </button>

      <button
        className={`${buttonClass} ${
          isLayersOpen ? activeButtonClass : ''
        }`}
        onClick={onToggleLayers}
        title="Map layers"
        aria-label="Toggle map layers"
        aria-pressed={isLayersOpen}
      >
        <Layers size={18} strokeWidth={1.8} />
      </button>
    </div>
  );
}
