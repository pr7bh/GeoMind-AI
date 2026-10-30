import { Bot } from 'lucide-react';
import { WORKSPACE_TOOLS } from '../tools/registry';
import type { WorkspaceToolId } from '../tools/registry';

interface SidebarProps {
  theme: 'light' | 'dark';
  activeTool: WorkspaceToolId | null;
  isResearchOpen: boolean;
  onSelectTool: (tool: WorkspaceToolId) => void;
  onToggleResearch: () => void;
}

export default function Sidebar({
  theme,
  activeTool,
  isResearchOpen,
  onSelectTool,
  onToggleResearch,
}: SidebarProps) {
  const isDark = theme === 'dark';

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
      <nav className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-1.5">
        {WORKSPACE_TOOLS.map(({ id, label, title, icon: Icon }) => {
          const active = activeTool === id;

          return (
          <button
            key={id}
            type="button"
            onClick={() => onSelectTool(id)}
            title={title}
            aria-label={title}
            aria-pressed={active}
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
          );
        })}
      </nav>

      {/* AI Agent */}
      <div className="flex w-full shrink-0 flex-col items-center px-1.5 pt-2">
        <div
          className={`mb-2 h-px w-7 ${
            isDark ? 'bg-neutral-800' : 'bg-gray-200'
          }`}
        />

        <button
          type="button"
          onClick={onToggleResearch}
          title="Ask AI"
          aria-label="Ask AI"
          aria-pressed={isResearchOpen}
          className={`group relative flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-lg border transition-colors duration-150 ${
            isResearchOpen
              ? 'border-emerald-400 bg-emerald-500 text-black'
              : isDark
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
            Ask AI
          </span>
        </button>
      </div>
    </aside>
  );
}