import { Bot, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { WORKSPACE_TOOLS } from '../tools/registry';
import type { WorkspaceToolId } from '../tools/registry';

interface SidebarProps {
  theme: 'light' | 'dark';
  activeTool: WorkspaceToolId | null;
  isResearchOpen: boolean;
  expanded: boolean;
  onSelectTool: (tool: WorkspaceToolId) => void;
  onToggleResearch: () => void;
  onToggleExpanded: () => void;
}

export default function Sidebar({
  theme,
  activeTool,
  isResearchOpen,
  expanded,
  onSelectTool,
  onToggleResearch,
  onToggleExpanded,
}: SidebarProps) {
  const isDark = theme === 'dark';

  const inactiveClass = isDark
    ? 'text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100'
    : 'text-gray-500 hover:bg-gray-900/[0.05] hover:text-gray-900';

  const tooltipClass = `pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-medium opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 max-[900px]:hidden ${
    isDark
      ? 'border-white/10 bg-neutral-950/90 text-neutral-100'
      : 'border-gray-200 bg-white text-gray-900'
  }`;

  function navButton(
    key: string,
    title: string,
    label: string,
    Icon: LucideIcon,
    active: boolean,
    onClick: () => void,
  ) {
    return (
      <button
        key={key}
        type="button"
        onClick={onClick}
        aria-label={title}
        aria-pressed={active}
        className={`group relative flex h-11 shrink-0 items-center rounded-xl transition-colors duration-150 ${
          expanded ? 'w-full gap-3 px-3' : 'w-11 flex-col justify-center gap-0.5'
        } ${
          active
            ? isDark
              ? 'bg-emerald-400/[0.12] text-emerald-400'
              : 'bg-emerald-50 text-emerald-700'
            : inactiveClass
        }`}
      >
        {active && (
          <span
            className={`absolute -left-2 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full ${
              isDark ? 'bg-emerald-400' : 'bg-emerald-600'
            }`}
          />
        )}

        <Icon
          size={expanded ? 18 : 17}
          strokeWidth={active ? 2 : 1.7}
          className="shrink-0 transition-transform duration-150 group-hover:scale-105"
        />

        {expanded ? (
          <span className="truncate text-sm font-medium">{title}</span>
        ) : (
          <>
            <span className="text-[8px] font-medium leading-tight">{label}</span>
            <span role="tooltip" className={tooltipClass}>
              {title}
            </span>
          </>
        )}
      </button>
    );
  }

  return (
    // Floats over the map below the header; the map is never resized.
    <aside
      className={`absolute bottom-3 left-3 top-[5.5rem] z-40 flex flex-col rounded-2xl border py-2 backdrop-blur-2xl transition-[width] duration-200 max-[900px]:bottom-2 max-[900px]:left-2 max-[900px]:top-[4.5rem] max-[900px]:w-14 ${
        expanded ? 'w-44 px-2' : 'w-16 items-center'
      } ${
        isDark
          ? 'border-white/10 bg-neutral-950/60 shadow-[0_8px_32px_rgba(0,0,0,0.35)]'
          : 'border-gray-200/70 bg-white/70 shadow-[0_8px_32px_rgba(15,23,42,0.10)]'
      }`}
    >
      <nav
        className={`flex min-h-0 w-full flex-1 flex-col gap-1 max-[900px]:items-center max-[900px]:overflow-y-auto ${
          expanded ? '' : 'items-center'
        }`}
      >
        {WORKSPACE_TOOLS.map(({ id, label, title, icon }) =>
          navButton(id, title, label, icon, activeTool === id, () => onSelectTool(id)),
        )}
      </nav>

      <div
        className={`flex w-full shrink-0 flex-col gap-1 pt-2 ${expanded ? '' : 'items-center'}`}
      >
        <div
          className={`mx-auto mb-1 h-px w-8 ${isDark ? 'bg-white/10' : 'bg-gray-200'}`}
        />

        <button
          type="button"
          onClick={onToggleResearch}
          aria-label="Ask AI"
          aria-pressed={isResearchOpen}
          className={`group relative flex h-11 shrink-0 items-center rounded-xl border transition-colors duration-150 ${
            expanded ? 'w-full gap-3 px-3' : 'w-11 flex-col justify-center gap-0.5'
          } ${
            isResearchOpen
              ? 'border-emerald-400 bg-emerald-500 text-black'
              : isDark
                ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-400 hover:bg-emerald-400/15'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
          }`}
        >
          <Bot size={expanded ? 18 : 19} strokeWidth={1.8} className="shrink-0" />
          {expanded ? (
            <span className="text-sm font-semibold">Ask AI</span>
          ) : (
            <>
              <span className="text-[8px] font-semibold leading-tight">Ask AI</span>
              <span role="tooltip" className={tooltipClass}>
                Ask AI
              </span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={onToggleExpanded}
          aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
          aria-expanded={expanded}
          className={`group relative flex h-9 shrink-0 items-center rounded-xl transition-colors duration-150 max-[900px]:hidden ${
            expanded ? 'w-full gap-3 px-3' : 'w-11 justify-center'
          } ${inactiveClass}`}
        >
          {expanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          {expanded ? (
            <span className="text-xs font-medium">Collapse</span>
          ) : (
            <span role="tooltip" className={tooltipClass}>
              Expand navigation
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}
