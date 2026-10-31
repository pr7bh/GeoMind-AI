import type { ReactNode } from "react";
import { X } from "lucide-react";
import type { WorkspaceTool } from "./registry";

interface ToolPanelProps {
  isDark: boolean;
  tool: WorkspaceTool;
  hidden: boolean;
  onClose: () => void;
  children: ReactNode;
}

export default function ToolPanel({
  isDark,
  tool,
  hidden,
  onClose,
  children,
}: ToolPanelProps) {
  const Icon = tool.icon;

  return (
    <section
      hidden={hidden}
      aria-label={tool.title}
      className={`pointer-events-auto flex max-h-full w-80 max-w-[calc(100vw-5.5rem)] flex-col overflow-hidden gm-glass-strong rounded-2xl border shadow-2xl max-[900px]:max-h-[46vh] max-[900px]:w-full max-[900px]:max-w-none ${
        isDark
          ? "border-white/10 bg-neutral-950/80 text-white shadow-black/40"
          : "border-gray-200/80 bg-white/85 text-gray-900 shadow-gray-900/10"
      }`}
    >
      <header
        className={`flex shrink-0 items-start gap-3 border-b px-4 py-3 ${
          isDark ? "border-white/10" : "border-gray-200/80"
        }`}
      >
        <span
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
            isDark
              ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-400"
              : "border-emerald-500/20 bg-emerald-50 text-emerald-700"
          }`}
        >
          <Icon size={16} strokeWidth={1.9} />
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight">{tool.title}</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">
            {tool.description}
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          title="Close panel"
          aria-label={`Close ${tool.title}`}
          className={`rounded-lg p-1.5 transition-colors max-[900px]:p-2.5 ${
            isDark
              ? "text-neutral-500 hover:bg-white/8 hover:text-white"
              : "text-gray-400 hover:bg-gray-100 hover:text-gray-900"
          }`}
        >
          <X size={16} />
        </button>
      </header>

      <div
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 ${
          isDark ? "scrollbar-thin-dark" : "scrollbar-thin-light"
        }`}
      >
        {children}
      </div>
    </section>
  );
}
