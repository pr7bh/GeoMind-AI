import { AlertCircle, AlertTriangle, CheckCircle2, CircleSlash, LoaderCircle, MapPlus, Square } from "lucide-react";
import type { AgentLayer } from "../../lib/agentClient";
import type {
  ExecutionStatus,
  ExecutionStepState,
  ResearchCapabilityResult,
} from "../../lib/researchClient";
import WorkflowView from "./WorkflowView";

export interface ExecutionUIState {
  id: string | null;
  status: ExecutionStatus;
  steps: Record<string, ExecutionStepState>;
  currentStep: string | null;
  warnings: string[];
  errors: string[];
  results: ResearchCapabilityResult[];
  // Transport or validation error (e.g. the plan expired).
  error: string | null;
}

interface ResearchExecutionViewProps {
  isDark: boolean;
  execution: ExecutionUIState;
  totalSteps: number;
  currentTitle: string | null;
  addedLayers: string[];
  onAddLayer: (layer: AgentLayer, key: string) => void;
  onCancel: () => void;
}

const STATUS: Record<ExecutionStatus, { label: string; className: string }> = {
  queued: { label: "Starting…", className: "border-sky-500/40 text-sky-500" },
  running: { label: "Executing", className: "border-sky-500/40 text-sky-500" },
  completed: { label: "Research completed", className: "border-emerald-500/40 text-emerald-500" },
  completed_with_warnings: { label: "Completed with warnings", className: "border-amber-500/40 text-amber-500" },
  partial: { label: "Partial results", className: "border-amber-500/40 text-amber-500" },
  failed: { label: "Research failed", className: "border-red-500/40 text-red-400" },
  cancelled: { label: "Cancelled", className: "border-neutral-500/40 text-neutral-400" },
};

const OUTCOME: Record<ResearchCapabilityResult["outcome"], string> = {
  completed: "text-emerald-500",
  partial: "text-amber-500",
  failed: "text-red-400",
};

export default function ResearchExecutionView({
  isDark,
  execution,
  totalSteps,
  currentTitle,
  addedLayers,
  onAddLayer,
  onCancel,
}: ResearchExecutionViewProps) {
  const muted = isDark ? "text-neutral-400" : "text-gray-500";
  const border = isDark ? "border-white/8" : "border-gray-200";
  const active = execution.status === "queued" || execution.status === "running";
  const done = Object.values(execution.steps).filter((s) => s.status === "completed" || s.status === "partial").length;
  const status = STATUS[execution.status];

  return (
    <section aria-label="Research execution" className={`gm-fade-up mt-3 space-y-3 border-t pt-3 ${border}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          key={execution.status}
          className={`gm-fade-in flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${status.className} ${
            execution.status === "failed" ? "gm-nudge" : ""
          }`}
        >
          {active ? <LoaderCircle size={11} className="animate-spin" /> : execution.status === "cancelled" ? <CircleSlash size={11} /> : execution.status === "failed" ? <AlertCircle size={11} /> : <CheckCircle2 size={11} className="gm-pop" />}
          {status.label}
        </span>
        <span className={`text-[10px] tabular-nums ${muted}`} aria-label="Execution progress">
          {done} of {totalSteps} steps completed
        </span>
        {active && (
          <button
            type="button"
            onClick={onCancel}
            className={`gm-press gm-fade-in ml-auto flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium ${
              isDark ? "border-white/10 hover:text-red-300" : "border-gray-200 hover:text-red-600"
            }`}
          >
            <Square size={10} /> Cancel Research
          </button>
        )}
      </div>

      {active && currentTitle && (
        <p key={currentTitle} className="gm-fade-in flex items-center gap-1.5 text-[11px] text-sky-500" role="status">
          <LoaderCircle size={12} className="animate-spin" /> Running: {currentTitle}
        </p>
      )}

      <div className="h-1 overflow-hidden rounded-full bg-neutral-500/20" aria-hidden>
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-500"
          style={{ width: `${totalSteps ? (done / totalSteps) * 100 : 0}%` }}
        />
      </div>

      {execution.error && (
        <p className="flex gap-2 rounded-lg border border-red-500/30 bg-red-500/8 px-2.5 py-2 text-[11px] text-red-400">
          <AlertCircle size={13} className="mt-px shrink-0" /> {execution.error}
        </p>
      )}

      {(execution.warnings.length > 0 || execution.errors.length > 0) && (
        <ul className="gm-fade-down space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/8 px-2.5 py-2 text-[11px] text-amber-500">
          {[...execution.errors, ...execution.warnings].map((line) => (
            <li key={line} className="flex gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {line}
            </li>
          ))}
        </ul>
      )}

      {execution.results.map((result, index) => (
        <div
          role="group"
          key={result.capability_id}
          aria-label={`${result.title} results`}
          className={`gm-fade-up gm-glass-card space-y-2 rounded-xl border p-2.5 ${border}`}
          style={{ animationDelay: `calc(var(--gm-stagger) * ${Math.min(index, 8)})` }}
        >
          <p className="flex items-center gap-2 text-[11px] font-semibold">
            {result.title}
            <span className={`ml-auto text-[10px] font-medium ${OUTCOME[result.outcome]}`}>{result.outcome}</span>
          </p>
          <p className="whitespace-pre-line text-[11px] leading-5">{result.message}</p>
          {result.workflow && (
            <WorkflowView isDark={isDark} plan={result.workflow.plan} result={result.workflow} cancelled={false} showTimeline={false} />
          )}
          {result.layers.map((layer, index) => {
            const key = `${result.capability_id}:${index}`;
            const added = addedLayers.includes(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => onAddLayer(layer, key)}
                disabled={added}
                className={`gm-press flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs font-medium transition-colors disabled:cursor-default ${
                  added
                    ? "border-emerald-500/30 text-emerald-500"
                    : isDark
                      ? "border-emerald-400/25 text-emerald-400 hover:bg-emerald-400/10"
                      : "border-emerald-500/30 text-emerald-700 hover:bg-emerald-50"
                }`}
              >
                {added ? <CheckCircle2 size={14} /> : <MapPlus size={14} />}
                <span className="min-w-0 flex-1 truncate">
                  {added ? "Added" : "Add to map"}: {layer.name}
                </span>
                <span className={`shrink-0 text-[10px] ${muted}`}>{layer.feature_count}</span>
              </button>
            );
          })}
        </div>
      ))}
    </section>
  );
}
