import {
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  ListChecks,
  MapPin,
  PencilLine,
  Play,
  RefreshCw,
} from "lucide-react";
import type { ExecutionStepStatus, ResearchPlan, ResearchStep } from "../../lib/researchClient";
import type { ExecutionUIState } from "./ResearchExecutionView";

interface ResearchPlanViewProps {
  isDark: boolean;
  plan: ResearchPlan;
  busy: boolean;
  onPickLocation: () => void;
  onPickCompare: () => void;
  onEditQuestion: (question: string) => void;
  onReplan: (question: string) => void;
  /** Explicit approval: only offered for ready plans that have not run. */
  onExecute?: () => void;
  execution?: ExecutionUIState | null;
}

const PLAN_STATUS: Record<ResearchPlan["status"], { label: string; className: string }> = {
  ready: { label: "Ready to execute", className: "border-emerald-500/40 text-emerald-500" },
  needs_input: { label: "Needs input", className: "border-amber-500/40 text-amber-500" },
  unsupported: { label: "Unsupported", className: "border-neutral-500/40 text-neutral-400" },
  invalid: { label: "Invalid", className: "border-red-500/40 text-red-400" },
};

const STEP_STATUS: Record<ResearchStep["status"], { label: string; dot: string; text: string }> = {
  ready: { label: "ready", dot: "border-emerald-500 bg-emerald-500/15 text-emerald-500", text: "text-emerald-500" },
  planned: { label: "waits for dependencies", dot: "border-sky-500/60 bg-sky-500/10 text-sky-500", text: "text-sky-500" },
  blocked: { label: "blocked", dot: "border-amber-500 bg-amber-500/15 text-amber-500", text: "text-amber-500" },
};

const EXECUTION_STATUS: Record<ExecutionStepStatus, { label: string; dot: string; text: string }> = {
  pending: { label: "pending", dot: "border-neutral-500/50 text-neutral-400", text: "text-neutral-400" },
  running: { label: "running…", dot: "border-sky-500 bg-sky-500/15 text-sky-500 animate-pulse", text: "text-sky-500" },
  completed: { label: "completed", dot: "border-emerald-500 bg-emerald-500 text-black", text: "text-emerald-500" },
  partial: { label: "partial", dot: "border-amber-500 bg-amber-500/20 text-amber-500", text: "text-amber-500" },
  failed: { label: "failed", dot: "border-red-500 bg-red-500/15 text-red-400", text: "text-red-400" },
  blocked: { label: "blocked", dot: "border-amber-500 bg-amber-500/15 text-amber-500", text: "text-amber-500" },
  skipped: { label: "skipped", dot: "border-neutral-500/50 text-neutral-400", text: "text-neutral-400" },
  cancelled: { label: "cancelled", dot: "border-neutral-500/50 text-neutral-400", text: "text-neutral-400" },
};

const INPUT_NAMES: Record<string, string> = {
  location: "Area A",
  compare_location: "Area B",
  category: "service",
  facility: "facility",
};

function formatPoint(point: [number, number] | null) {
  return point ? `${point[1].toFixed(4)}, ${point[0].toFixed(4)}` : "not selected";
}

export default function ResearchPlanView({
  isDark,
  plan,
  busy,
  onPickLocation,
  onPickCompare,
  onEditQuestion,
  onReplan,
  onExecute,
  execution,
}: ResearchPlanViewProps) {
  const muted = isDark ? "text-neutral-400" : "text-gray-500";
  const border = isDark ? "border-white/8" : "border-gray-200";
  const chip = `rounded-md border px-1.5 py-px text-[10px] ${border}`;
  const order = Object.fromEntries(plan.steps.map((step) => [step.id, step.execution_order]));
  const executing = execution?.status === "queued" || execution?.status === "running";
  const status = execution
    ? { label: "Plan approved", className: "border-emerald-500/40 text-emerald-500" }
    : PLAN_STATUS[plan.status];
  const areas = plan.selected_areas.filter((area) => area.required || area.coordinates);

  return (
    <section aria-label="Research plan" className="gm-fade-up mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${status.className}`}>
          {status.label}
        </span>
        <span className={chip}>{plan.interpreter === "llm" ? "AI-assisted, validated" : "Rule-based"}</span>
        <span className={`ml-auto text-[10px] ${muted}`}>
          {!execution ? "Plan only · nothing has been run" : executing ? "Executing…" : "Executed"}
        </span>
      </div>

      <div>
        <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${muted}`}>{plan.title}</p>
        <p className="mt-1 text-xs font-medium leading-5">{plan.objective}</p>
        {plan.interpretation.length > 0 && (
          <ul className={`mt-1 list-disc space-y-0.5 pl-4 text-[11px] leading-4 ${muted}`}>
            {plan.interpretation.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </div>

      {areas.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Study areas">
          {areas.map((area) => (
            <span
              key={area.id}
              className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] ${
                area.coordinates ? border : "border-amber-500/40 text-amber-500"
              }`}
            >
              <MapPin size={11} className={area.id === "a" ? "text-amber-500" : "text-violet-400"} />
              Area {area.id.toUpperCase()}: <span className="font-mono">{formatPoint(area.coordinates)}</span>
            </span>
          ))}
        </div>
      )}

      {plan.missing_inputs.length > 0 && (
        <div
          role="group"
          aria-label="Missing inputs"
          className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/8 px-2.5 py-2 text-[11px]"
        >
          <p className="flex items-center gap-1.5 font-semibold text-amber-500">
            <AlertTriangle size={13} /> Needed before this plan can run
          </p>
          {plan.missing_inputs.map((input) => (
            <div key={input.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{input.label}</span>
                <span className={`block ${muted}`}>{input.reason}</span>
              </span>
              {input.action !== "edit_question" ? (
                <button
                  type="button"
                  onClick={input.action === "pick_location" ? onPickLocation : onPickCompare}
                  className="gm-press flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 px-2 py-1 text-[10px] font-medium text-amber-500 hover:bg-amber-500/10"
                >
                  <MapPin size={11} /> {input.action === "pick_location" ? "Pick Area A" : "Pick Area B"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onEditQuestion(plan.original_question)}
                  className="gm-press flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 px-2 py-1 text-[10px] font-medium text-amber-500 hover:bg-amber-500/10"
                >
                  <PencilLine size={11} /> Edit question
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {(plan.status === "unsupported" || plan.status === "invalid") && (
        <div
          className={`flex gap-2 rounded-lg border px-2.5 py-2 text-[11px] ${
            plan.status === "invalid" ? "border-red-500/30 bg-red-500/8 text-red-400" : `${border} ${muted}`
          }`}
        >
          <AlertCircle size={13} className="mt-px shrink-0" />
          <ul className="space-y-1">
            {plan.clarification_questions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {plan.steps.length > 0 && (
        <ol aria-label="Planned steps" className="gm-stagger relative space-y-1.5">
          {plan.steps.map((step, index) => {
            const run = execution?.steps[step.id];
            const style = run ? EXECUTION_STATUS[run.status] : STEP_STATUS[step.status];
            return (
              <li
                key={step.id}
                className="relative flex gap-2"
                data-status={step.status}
                data-execution-status={run?.status}
              >
                {index < plan.steps.length - 1 && (
                  <span className={`absolute left-[9px] top-5 h-[calc(100%-0.25rem)] w-px ${isDark ? "bg-white/10" : "bg-gray-200"}`} />
                )}
                <span
                  key={run?.status ?? step.status}
                  className={`relative z-10 mt-0.5 flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold transition-colors duration-300 ${style.dot} ${
                    run?.status === "completed" || run?.status === "partial" ? "gm-pop" : ""
                  }`}
                >
                  {step.execution_order}
                </span>
                <details
                  className={`gm-details gm-glass-card group min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 transition-colors duration-300 ${
                    run?.status === "running" ? "border-sky-500/40" : border
                  }`}
                >
                  <summary className="flex cursor-pointer list-none items-start gap-2 text-[11px] [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{step.title}</span>
                      <span className={`block ${muted}`}>{run?.summary || step.description}</span>
                      {run?.error && <span className="block text-[10px] text-red-400">{run.error}</span>}
                      {run?.reused_from && (
                        <span className="block text-[10px] text-emerald-500">
                          Reused result of #{order[run.reused_from]} (no new request)
                        </span>
                      )}
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        <span className={`${chip} font-mono`}>{step.capability_id}</span>
                        <span className={`text-[10px] ${style.text}`}>{style.label}</span>
                        {step.dependencies.length > 0 && (
                          <span className={`text-[10px] ${muted}`}>
                            after {step.dependencies.map((id) => `#${order[id]}`).join(", ")}
                          </span>
                        )}
                        {step.optional_dependencies.length > 0 && (
                          <span className={`text-[10px] ${muted}`}>
                            uses {step.optional_dependencies.map((id) => `#${order[id]}`).join(", ")} if available
                          </span>
                        )}
                      </span>
                    </span>
                    <ChevronRight size={12} className={`mt-0.5 shrink-0 transition-transform group-open:rotate-90 ${muted}`} />
                  </summary>
                  <dl className={`mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px] ${muted}`}>
                    <dt>tool</dt>
                    <dd className="font-mono">{step.tool}</dd>
                    <dt>inputs</dt>
                    <dd>
                      {step.required_inputs.length
                        ? step.required_inputs.map((input) => INPUT_NAMES[input] ?? input).join(", ")
                        : "previous steps only"}
                    </dd>
                    <dt>outputs</dt>
                    <dd>{step.expected_outputs.join("; ")}</dd>
                    {Object.keys(step.arguments).length > 0 && (
                      <>
                        <dt>arguments</dt>
                        <dd className="break-all font-mono">{JSON.stringify(step.arguments)}</dd>
                      </>
                    )}
                  </dl>
                </details>
              </li>
            );
          })}
        </ol>
      )}

      {(plan.assumptions.length > 0 || plan.limitations.length > 0) && (
        <details className="gm-details group">
          <summary
            className={`flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] [&::-webkit-details-marker]:hidden ${muted}`}
          >
            <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
            Assumptions &amp; limitations
          </summary>
          <ul className={`mt-1 list-disc space-y-1 pl-4 text-[10px] leading-4 ${muted}`}>
            {plan.assumptions.map((line) => (
              <li key={`a-${line}`}>{line}</li>
            ))}
            {plan.limitations.map((line) => (
              <li key={`l-${line}`} className="text-amber-500">
                {line}
              </li>
            ))}
          </ul>
        </details>
      )}

      {plan.status === "ready" && !execution && onExecute && (
        <div className={`gm-fade-up flex items-center gap-2 rounded-lg border px-2.5 py-2 ${border}`}>
          <button
            type="button"
            disabled={busy}
            onClick={onExecute}
            className="gm-press flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-xs font-semibold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play size={13} /> Execute Research
          </button>
          <span className={`text-[10px] leading-4 ${muted}`}>
            Runs {plan.steps.length} steps on live OpenStreetMap data. You can cancel at any time.
          </span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onReplan(plan.original_question)}
          className={`gm-press flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-40 ${
            isDark
              ? "border-emerald-400/25 text-emerald-400 hover:bg-emerald-400/10"
              : "border-emerald-500/30 text-emerald-700 hover:bg-emerald-50"
          }`}
        >
          <RefreshCw size={12} /> Plan again
        </button>
        <button
          type="button"
          onClick={() => onEditQuestion(plan.original_question)}
          className={`gm-press flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] ${border} ${muted}`}
        >
          <PencilLine size={12} /> Revise question
        </button>
        <span className={`ml-auto flex items-center gap-1 font-mono text-[10px] ${muted}`} title="Plan id">
          <ListChecks size={11} /> {plan.id}
        </span>
      </div>
    </section>
  );
}
