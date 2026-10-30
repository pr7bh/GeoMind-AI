import {
  Map,
  Layers,
  Ruler,
  FlaskConical,
  Database,
  Bot,
} from 'lucide-react';

interface SidebarProps {
  theme: 'light' | 'dark';
  onOpenResearch: () => void;
}

export default function Sidebar({
  theme,
  onOpenResearch,
}: SidebarProps) {
  const isDark = theme === 'dark';

  const navItems = [
    { label: 'Map', icon: Map, active: true },
    { label: 'Layers', icon: Layers },
    { label: 'Measure', icon: Ruler },
    { label: 'Analysis', icon: FlaskConical },
    { label: 'Data', icon: Database },
  ];

  const inactiveClass = isDark
    ? 'text-neutral-500 hover:bg-neutral-900 hover:text-neutral-100'
    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900';

  return (
    <aside
      className={`relative flex w-14 shrink-0 flex-col items-center border-r py-3 transition-colors duration-200 ${
        isDark
          ? 'border-neutral-800 bg-[black]'
          : 'border-gray-200 bg-white'
      }`}
    >
      {/* Navigation */}
      <nav className="flex w-full flex-col items-center gap-1 px-1.5">
        {navItems.map(({ label, icon: Icon, active }) => (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            className={`group relative flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-lg transition-colors duration-150 ${
              active
                ? isDark
                  ? 'bg-emerald-400/10 text-emerald-400'
                  : 'bg-emerald-50 text-emerald-700'
                : inactiveClass
            }`}
          >
            {active && (
              <span
                className={`absolute -left-[7px] top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full ${
                  isDark ? 'bg-emerald-400' : 'bg-emerald-600'
                }`}
              />
            )}

            <Icon
              size={17}
              strokeWidth={active ? 2 : 1.7}
              className="transition-transform duration-150 group-hover:scale-105"
            />

            <span className="text-[8px] font-medium leading-tight">
              {label}
            </span>
          </button>
        ))}
      </nav>

      {/* AI Agent */}
      <div className="mt-auto flex w-full flex-col items-center px-1.5">
        <div
          className={`mb-2 h-px w-7 ${
            isDark ? 'bg-neutral-800' : 'bg-gray-200'
          }`}
        />

        <button
          type="button"
          onClick={onOpenResearch}
          title="AI Research Assistant"
          aria-label="Open AI Research Assistant"
          className={`group relative flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-lg border transition-colors duration-150 ${
            isDark
              ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-400 hover:bg-emerald-400/15'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
          }`}
        >
          <span className="absolute right-1.5 top-1.5 h-1 w-1 rounded-full bg-emerald-400" />

          <Bot
            size={19}
            strokeWidth={1.8}
            className="transition-transform duration-150 group-hover:scale-105"
          />

          <span className="text-[8px] font-semibold leading-tight">
            AI Agent
          </span>
        </button>
      </div>
    </aside>
  );
}