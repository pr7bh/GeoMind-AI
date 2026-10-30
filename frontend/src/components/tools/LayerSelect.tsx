import type { ImportedLayerInfo } from "../workspace/GeoMap";

interface LayerSelectProps {
  isDark: boolean;
  label: string;
  placeholder: string;
  value: string;
  layers: ImportedLayerInfo[];
  onChange: (layerId: string) => void;
}

export default function LayerSelect({
  isDark,
  label,
  placeholder,
  value,
  layers,
  onChange,
}: LayerSelectProps) {
  return (
    <div>
      <label className="block text-xs font-medium text-neutral-500">
        {label}
      </label>

      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1.5 w-full rounded-xl border p-2.5 text-sm outline-none backdrop-blur-md transition-all focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/10 ${
          isDark
            ? "border-white/10 bg-neutral-900/60 text-white hover:border-white/20"
            : "border-white/80 bg-white/50 text-black hover:border-emerald-500/30"
        }`}
      >
        <option value="">{placeholder}</option>
        {layers.map((layer) => (
          <option key={layer.id} value={layer.id}>
            {layer.name}
          </option>
        ))}
      </select>
    </div>
  );
}
