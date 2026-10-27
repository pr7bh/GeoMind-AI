
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

  const buttonClass = `rounded-lg p-2 transition-colors ${
    isDark
      ? 'text-neutral-300 hover:bg-neutral-800 hover:text-white'
      : 'text-gray-600 hover:bg-gray-100 hover:text-black'
  }`;

  const activeButtonClass = isDark
    ? 'bg-emerald-500/15 text-emerald-400'
    : 'bg-emerald-50 text-emerald-700';

  return (
    <div
      className={`absolute right-4 top-16 z-10 flex flex-col gap-1 rounded-xl border  shadow-lg ${
        isDark
          ? 'border-neutral-800 bg-black'
          : 'border-gray-200 bg-white'
      }`}
    >
      <button
        className={buttonClass}
        onClick={onZoomIn}
        title="Zoom in"
        aria-label="Zoom in"
      >
        <Plus size={18} />
      </button>

      <button
        className={buttonClass}
        onClick={onZoomOut}
        title="Zoom out"
        aria-label="Zoom out"
      >
        <Minus size={18} />
      </button>

      <div
        className={
          isDark
            ? 'border-t border-neutral-800'
            : 'border-t border-gray-200'
        }
      />

      <button
        className={buttonClass}
        onClick={onReset}
        title="Reset map view"
        aria-label="Reset map view"
      >
        <Home size={18} />
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
        <Layers size={18} />
      </button>
    </div>
  );
}
