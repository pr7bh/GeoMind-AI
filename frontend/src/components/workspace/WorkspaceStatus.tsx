
interface WorkspaceStatusProps {
  theme: 'light' | 'dark';
}

export default function WorkspaceStatus({
  theme,
}: WorkspaceStatusProps) {
  const isDark = theme === 'dark';

  return (
    <div
      className={`absolute left-4 top-4 rounded-lg border px-3 py-2 text-xs shadow-lg ${
        isDark
          ? 'border-neutral-700 bg-black/90 text-neutral-300'
          : 'border-gray-200 bg-white/95 text-gray-600'
      }`}
    >
      <span className="mr-2 inline-block h-2 w-2 rounded-full bg-emerald-500" />
      2D MAP · OPENSTREETMAP
    </div>
  );
}
