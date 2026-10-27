import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Bot,
  X,
  Workflow,
  Database,
  FlaskConical,
  ShieldCheck,
  Sparkles,
  ChevronRight,
  Activity,
  Command,
  Microscope,
} from "lucide-react";

interface ResearchPanelProps {
  theme: "light" | "dark";
  onClose: () => void;
}

export default function ResearchPanel({ theme, onClose }: ResearchPanelProps) {
  const [question, setQuestion] = useState("");
  const isDark = theme === "dark";

  const muted = isDark ? "text-neutral-400" : "text-gray-500";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!question.trim()) return;

    // AI backend integration will be added in a later step.
    setQuestion("");
  }

  return (
    <aside
      className={`flex h-full w-90 max-w-full shrink-0 flex-col border-l transition-colors duration-200 ${
        isDark
          ? "border-neutral-800 bg-black text-neutral-100"
          : "border-gray-200 bg-white text-gray-900"
      }`}
    >
      {/* Header */}
      <header
        className={`flex h-16.25 shrink-0 items-center justify-between border-b px-4 ${
          isDark ? "border-neutral-800" : "border-gray-200"
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`relative flex h-10 w-10 items-center justify-center rounded-xl border ${
              isDark
                ? "border-emerald-400/20 bg-emerald-400/8 text-emerald-400"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            <Bot size={21} strokeWidth={1.7} />
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-black bg-emerald-400" />
          </div>

          <div>
            <h2 className="text-sm font-semibold tracking-tight">
              Research Agent
            </h2>
            <p className={`mt-0.5 text-[11px] ${muted}`}>
              Geospatial intelligence console
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close research panel"
          title="Close panel"
          className={`rounded-lg border p-2 transition-colors ${
            isDark
              ? "border-neutral-800 text-neutral-500 hover:bg-neutral-900 hover:text-white"
              : "border-gray-200 text-gray-400 hover:bg-gray-100 hover:text-gray-900"
          }`}
        >
          <X size={16} />
        </button>
      </header>

      {/* Scrollable research area */}
      <div
        className={`flex-1 space-y-5 overflow-y-auto p-4
    scrollbar-thin
    ${
      isDark
        ? "[scrollbar-color:rgba(52,211,153,0.3)_transparent]"
        : "[scrollbar-color:rgba(5,150,105,0.3)_transparent]"
    }
    [&::-webkit-scrollbar]:w-1
    [&::-webkit-scrollbar-track]:bg-transparent
    [&::-webkit-scrollbar-thumb]:rounded-full
    ${
      isDark
        ? "[&::-webkit-scrollbar-thumb]:bg-emerald-400/25 hover:[&::-webkit-scrollbar-thumb]:bg-emerald-400/50"
        : "[&::-webkit-scrollbar-thumb]:bg-emerald-600/25 hover:[&::-webkit-scrollbar-thumb]:bg-emerald-600/50"
    }`}
      >
        {/* Intro */}
        <section>
          <div className="mb-3 flex items-center gap-2">
            <span
              className={`rounded-md border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.15em] ${
                isDark
                  ? "border-emerald-400/20 bg-emerald-400/6 text-emerald-400"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }`}
            >
              Research environment
            </span>
          </div>

          <h3 className="text-xl font-semibold leading-7 tracking-tight">
            Investigate your
            <span className="block text-emerald-500">geographic data.</span>
          </h3>

          <p className={`mt-2 text-xs leading-5 ${muted}`}>
            Describe a spatial problem. The agent will be designed to plan
            analytical steps, validate datasets, and explain results.
          </p>
        </section>

        {/* Execution pipeline */}
        <section
          className={`overflow-hidden rounded-xl border ${
            isDark
              ? "border-neutral-800 bg-neutral-950/70"
              : "border-gray-200 bg-white"
          }`}
        >
          <div
            className={`flex items-center justify-between border-b px-3 py-3 ${
              isDark ? "border-neutral-800" : "border-gray-100"
            }`}
          >
            <div className="flex items-center gap-2">
              <Workflow size={15} className="text-emerald-500" />
              <h4 className="text-xs font-semibold">Execution pipeline</h4>
            </div>

            <span
              className={`rounded-md px-2 py-1 text-[9px] font-medium ${
                isDark
                  ? "bg-neutral-900 text-neutral-500"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              IDLE
            </span>
          </div>

          <div className="p-3">
            <div className="space-y-0">
              <TraceItem
                icon={<Bot size={15} />}
                number="01"
                title="Interpret query"
                description="Awaiting research question"
                theme={theme}
                last={false}
              />

              <TraceItem
                icon={<Database size={15} />}
                number="02"
                title="Validate datasets"
                description="No input datasets selected"
                theme={theme}
                last={false}
              />

              <TraceItem
                icon={<FlaskConical size={15} />}
                number="03"
                title="Execute analysis"
                description="Spatial tools not executed"
                theme={theme}
                last={true}
              />
            </div>
          </div>
        </section>

        {/* Scientific principles */}
        <section
          className={`rounded-xl border p-3 ${
            isDark
              ? "border-neutral-800 bg-neutral-950/60"
              : "border-gray-200 bg-gray-50/80"
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                isDark
                  ? "bg-emerald-400/10 text-emerald-400"
                  : "bg-emerald-100 text-emerald-700"
              }`}
            >
              <ShieldCheck size={17} />
            </div>

            <div>
              <h4 className="text-xs font-semibold">Reproducible research</h4>
              <p className={`mt-1 text-[11px] leading-5 ${muted}`}>
                Designed for transparent workflows, traceable operations, and
                interpretable spatial results.
              </p>
            </div>
          </div>
        </section>

        {/* Capability indicators */}
        <section>
          <div className="mb-3 flex items-center gap-2">
            <Microscope size={14} className="text-emerald-500" />
            <h4
              className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${muted}`}
            >
              Research capabilities
            </h4>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Capability
              icon={<Database size={14} />}
              label="Data validation"
              theme={theme}
            />
            <Capability
              icon={<FlaskConical size={14} />}
              label="Spatial analysis"
              theme={theme}
            />
            <Capability
              icon={<Workflow size={14} />}
              label="Agent workflow"
              theme={theme}
            />
            <Capability
              icon={<Activity size={14} />}
              label="Result tracing"
              theme={theme}
            />
          </div>
        </section>
      </div>

      {/* Research composer */}
      <form
        onSubmit={handleSubmit}
        className={`shrink-0 border-t p-4 ${
          isDark ? "border-neutral-800 bg-black" : "border-gray-200 bg-white"
        }`}
      >
        <div className="mb-2 flex items-center justify-between">
          <label htmlFor="research-question" className="text-xs font-semibold">
            Research query
          </label>

          <span className={`flex items-center gap-1 text-[10px] ${muted}`}>
            <Command size={11} />
            GIS
          </span>
        </div>

        <div
          className={`rounded-xl border transition-colors focus-within:border-emerald-500 ${
            isDark
              ? "border-neutral-800 bg-neutral-950"
              : "border-gray-200 bg-gray-50"
          }`}
        >
          <textarea
            id="research-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Describe the spatial problem you want to investigate..."
            rows={3}
            className={`w-full resize-none bg-transparent px-3 py-3 text-xs leading-5 outline-none ${
              isDark
                ? "text-white placeholder:text-neutral-600"
                : "text-gray-900 placeholder:text-gray-400"
            }`}
          />

          <div
            className={`flex items-center justify-between border-t px-2.5 py-2 ${
              isDark ? "border-neutral-800" : "border-gray-200"
            }`}
          >
            <span className={`text-[10px] ${muted}`}>
              Spatial research assistant
            </span>

            <span className={`text-[10px] tabular-nums ${muted}`}>
              {question.length} chars
            </span>
          </div>
        </div>

        <button
          type="submit"
          disabled={!question.trim()}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-semibold text-black transition-all hover:bg-emerald-400 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Sparkles size={15} />
          Prepare analysis
          <ChevronRight size={15} className="ml-auto" />
        </button>

        <p className={`mt-2.5 text-center text-[10px] ${muted}`}>
          AI execution will be enabled when backend integration is added.
        </p>
      </form>
    </aside>
  );
}

function TraceItem({
  icon,
  number,
  title,
  description,
  theme,
  last,
}: {
  icon: ReactNode;
  number: string;
  title: string;
  description: string;
  theme: "light" | "dark";
  last: boolean;
}) {
  const isDark = theme === "dark";

  return (
    <div className="relative flex gap-3 pb-4 last:pb-0">
      {!last && (
        <span
          className={`absolute left-3.25 top-8 bottom-0 w-px ${
            isDark ? "bg-neutral-800" : "bg-gray-200"
          }`}
        />
      )}

      <div
        className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
          isDark
            ? "border-neutral-800 bg-neutral-900 text-emerald-400"
            : "border-gray-200 bg-gray-50 text-emerald-700"
        }`}
      >
        {icon}
      </div>

      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-2">
          <span
            className={`font-mono text-[9px] ${
              isDark ? "text-neutral-600" : "text-gray-400"
            }`}
          >
            {number}
          </span>

          <p className="text-xs font-medium">{title}</p>
        </div>

        <p
          className={`mt-1 text-[10px] leading-4 ${
            isDark ? "text-neutral-500" : "text-gray-500"
          }`}
        >
          {description}
        </p>
      </div>
    </div>
  );
}

function Capability({
  icon,
  label,
  theme,
}: {
  icon: ReactNode;
  label: string;
  theme: "light" | "dark";
}) {
  const isDark = theme === "dark";

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2.5 ${
        isDark
          ? "border-neutral-800 bg-neutral-950/60 text-neutral-300"
          : "border-gray-200 bg-white text-gray-600"
      }`}
    >
      <span className="shrink-0 text-emerald-500">{icon}</span>
      <span className="text-[10px] font-medium">{label}</span>
    </div>
  );
}
