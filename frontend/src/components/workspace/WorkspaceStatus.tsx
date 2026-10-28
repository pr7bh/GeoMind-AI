
interface WorkspaceStatusProps {
  theme: 'light' | 'dark';
}

export default function WorkspaceStatus({
  theme,
}: WorkspaceStatusProps) {
  const isDark = theme === 'dark';

  return (
    <div
      className={`absolute left-4 top-4 rounded-xl border px-3 py-2 text-xs backdrop-blur-2xl transition-all duration-300 ${
        isDark
          ? 'border-white/[0.12] bg-neutral-950/55 text-neutral-300 shadow-[0_8px_30px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.04)]'
          : 'border-white/80 bg-white/55 text-gray-600 shadow-[0_8px_30px_rgba(15,23,42,0.07),inset_0_1px_0_rgba(255,255,255,0.65)]'
      }`}
    >
      <span className="mr-2 inline-block h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.45)]" />
      2D MAP · OPENSTREETMAP
    </div>
  );
}
