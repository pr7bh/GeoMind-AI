import type { ReactNode } from 'react';
import { Map, Activity, Sparkles } from 'lucide-react';

interface AppHeaderProps {
  theme: 'light' | 'dark';
  /** Centre slot, e.g. location search. */
  center?: ReactNode;
  /** Trailing actions, e.g. the theme switch. */
  actions?: ReactNode;
}

export default function AppHeader({ theme, center, actions }: AppHeaderProps) {
  const isDark = theme === 'dark';

  return (
    // Floats over the full-screen map; only the bar itself takes clicks.
    <div className="pointer-events-none absolute inset-x-3 top-3 z-40 max-[900px]:inset-x-2 max-[900px]:top-2">
    <header
      className={`pointer-events-auto flex h-[60px] items-center gap-3 gm-glass rounded-2xl border px-3 transition-colors duration-200 max-[900px]:h-14 max-[900px]:gap-2 max-[900px]:px-2 ${
        isDark
          ? 'border-white/10 bg-neutral-950/60 shadow-[0_8px_32px_rgba(0,0,0,0.35)]'
          : 'border-gray-200/70 bg-white/70 shadow-[0_8px_32px_rgba(15,23,42,0.10)]'
      }`}
    >
      {/* Brand */}
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
            isDark
              ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-400'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          <Map size={21} strokeWidth={1.8} />
        </div>

        <div className="min-w-0 max-sm:hidden">
          <h1 className="text-lg font-semibold tracking-tight">
            GeoMind{' '}
            <span className="text-emerald-500">AI</span>
          </h1>

          <p
            className={`mt-0.5 truncate text-[11px] tracking-wide max-lg:hidden ${
              isDark ? 'text-neutral-500' : 'text-gray-500'
            }`}
          >
            Scientific GIS Intelligence Platform
          </p>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 justify-center">{center}</div>

      {/* Workspace status */}
      <div className="flex shrink-0 items-center gap-3 max-[900px]:gap-2">
        <div
          className={`hidden items-center gap-1.5 rounded-lg border px-2.5 py-1.5 xl:flex ${
            isDark
              ? 'border-neutral-800 bg-neutral-900/60 text-neutral-400'
              : 'border-gray-200 bg-gray-50 text-gray-500'
          }`}
        >
          <Sparkles size={13} className="text-emerald-500" />
          <span className="text-[10px] font-medium tracking-wider">
            GIS WORKSPACE
          </span>
        </div>

        <div
          className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 max-[900px]:hidden ${
            isDark ? 'bg-emerald-500/[0.07]' : 'bg-emerald-50'
          }`}
          title="Workspace status"
        >
          <span className="relative flex h-2.5 w-2.5 items-center justify-center">
  {/* Outer soft glow */}
  <span className="absolute h-5 w-5 rounded-full bg-emerald-400/20 blur-md" />

  {/* Animated pulse */}
  <span className="absolute h-4 w-4 animate-ping rounded-full bg-emerald-400/40" />

  {/* Inner glow */}
  <span className="absolute h-3 w-3 rounded-full bg-emerald-400/40 blur-[3px]" />

  {/* Bright solid dot */}
  <span className="relative h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_3px_rgba(52,211,153,0.7),0_0_18px_5px_rgba(16,185,129,0.35)]" />
</span>

          <span
            className={`text-[10px] font-medium ${
              isDark ? 'text-emerald-400' : 'text-emerald-700'
            }`}
          >
            Ready
          </span>

          <Activity
            size={14}
            className={
              isDark ? 'text-neutral-500' : 'text-gray-400'
            }
          />
        </div>
        {actions}
      </div>
    </header>
    </div>
  );
}