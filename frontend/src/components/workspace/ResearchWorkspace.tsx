import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Database,
  FileText,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { isAbortError } from "../../lib/api";
import {
  deleteSession,
  getSession,
  listSessions,
  renameSession,
  synthesizeExecution,
} from "../../lib/researchClient";
import type { SessionDetail, SessionList, SessionStatus, SessionSummary } from "../../lib/researchClient";
import ResearchInsightsView from "./ResearchInsightsView";
import ResearchPlanView from "./ResearchPlanView";
import ResearchReportControls from "./ResearchReportControls";
import type { ExecutionUIState } from "./ResearchExecutionView";

interface ResearchWorkspaceProps {
  isDark: boolean;
  busy: boolean;
  /** Bumped by the panel when a session changes elsewhere (plan, run, insights). */
  refreshToken: number;
  onNewResearch: () => void;
  onPickLocation: () => void;
  onPickCompare: () => void;
  onEditQuestion: (question: string) => void;
  onReplan: (question: string, sessionId: string) => void;
  onExecute: (session: SessionDetail) => void;
}

const PAGE_SIZE = 20;
const SELECTED_KEY = "geomind-research-session";

const SESSION_STATUS: Record<SessionStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "border-neutral-500/40 text-neutral-400" },
  planned: { label: "Planned", className: "border-sky-500/40 text-sky-500" },
  running: { label: "Running", className: "border-sky-500/40 text-sky-500" },
  completed: { label: "Completed", className: "border-emerald-500/40 text-emerald-500" },
  partial: { label: "Partially completed", className: "border-amber-500/40 text-amber-500" },
  failed: { label: "Failed", className: "border-red-500/40 text-red-400" },
  cancelled: { label: "Cancelled", className: "border-neutral-500/40 text-neutral-400" },
  expired: { label: "Expired", className: "border-neutral-500/40 text-neutral-400" },
};

const FILTERS: { value: "" | SessionStatus; label: string }[] = [
  { value: "", label: "All research" },
  { value: "completed", label: "Completed" },
  { value: "partial", label: "Partially completed" },
  { value: "planned", label: "Planned" },
  { value: "running", label: "Running" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
];

function readSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function storeSelected(id: string | null) {
  try {
    if (id) localStorage.setItem(SELECTED_KEY, id);
    else localStorage.removeItem(SELECTED_KEY);
  } catch {
    // Selection simply isn't remembered.
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function StatusChip({ status }: { status: SessionStatus }) {
  const style = SESSION_STATUS[status];
  return (
    <span className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-semibold ${style.className}`}>
      {style.label}
    </span>
  );
}

export default function ResearchWorkspace(props: ResearchWorkspaceProps) {
  const { isDark, refreshToken, onNewResearch } = props;
  const muted = isDark ? "text-neutral-400" : "text-gray-500";
  const border = isDark ? "border-white/8" : "border-gray-200";
  const input = `rounded-lg border px-2 py-1.5 text-[11px] outline-none focus:border-emerald-500 ${
    isDark ? "gm-glass-field border-white/10 text-white" : "gm-glass-field border-gray-200 text-gray-900"
  }`;

  const [selected, setSelected] = useState<string | null>(readSelected);
  const [list, setList] = useState<SessionList | null>(null);
  const [items, setItems] = useState<SessionSummary[]>([]);
  const [listError, setListError] = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"" | SessionStatus>("");

  const loadList = useCallback(
    async (offset: number, signal?: AbortSignal) => {
      setLoadingList(true);
      setListError("");
      try {
        const page = await listSessions({ limit: PAGE_SIZE, offset, q: query.trim(), status }, signal);
        setList(page);
        setItems((current) => (offset === 0 ? page.items : [...current, ...page.items]));
      } catch (error) {
        if (!isAbortError(error)) setListError(error instanceof Error ? error.message : "Unable to load research sessions.");
      } finally {
        if (!signal?.aborted) setLoadingList(false);
      }
    },
    [query, status],
  );

  useEffect(() => {
    if (selected) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadList(0, controller.signal), 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [selected, loadList, refreshToken]);

  function open(id: string | null) {
    storeSelected(id);
    setSelected(id);
  }

  if (selected) {
    return <SessionView key={selected} {...props} sessionId={selected} onBack={() => open(null)} />;
  }

  return (
    <section aria-label="Research workspace" className="flex min-h-0 flex-1 flex-col">
      <div className={`shrink-0 space-y-2 border-b p-3 ${border}`}>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold tracking-tight">Research workspace</h3>
          <button
            type="button"
            onClick={onNewResearch}
            className="gm-press ml-auto flex min-h-7 items-center gap-1 rounded-lg bg-emerald-500 px-2.5 text-[11px] font-semibold text-black hover:bg-emerald-400"
          >
            <Plus size={12} /> New research
          </button>
        </div>
        <div className="flex gap-1.5">
          <label className="relative min-w-0 flex-1">
            <Search size={12} className={`absolute left-2 top-1/2 -translate-y-1/2 ${muted}`} />
            <input
              aria-label="Search research"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search research"
              maxLength={100}
              className={`${input} w-full pl-6`}
            />
          </label>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value as "" | SessionStatus)}
            className={input}
          >
            {FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {listError && (
          <div className="gm-fade-down flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/8 px-2.5 py-2 text-[11px] text-red-400" role="alert">
            <AlertCircle size={13} className="shrink-0" /> <span className="flex-1">{listError}</span>
            <button type="button" onClick={() => void loadList(0)} className="flex items-center gap-1 font-medium underline">
              <RefreshCw size={11} /> Retry
            </button>
          </div>
        )}
        {loadingList && (
          <p className={`gm-fade-in flex items-center gap-1.5 text-[11px] ${muted}`} role="status">
            <LoaderCircle size={12} className="animate-spin" /> {items.length ? "Refreshing research…" : "Loading research…"}
          </p>
        )}
        {loadingList && items.length === 0 && (
          <div className={`space-y-1.5 ${muted}`} aria-hidden>
            {[0, 1, 2].map((row) => (
              <div key={row} className="gm-skeleton h-[62px]" />
            ))}
          </div>
        )}
        {!loadingList && !listError && list && items.length === 0 && (
          <div className={`gm-scale-in rounded-xl border p-4 text-center ${border}`}>
            <FileText size={18} className="mx-auto text-emerald-500" />
            <p className="mt-2 text-xs font-semibold">{query || status ? "No matching research" : "No research yet"}</p>
            <p className={`mt-1 text-[11px] ${muted}`}>
              Ask a question and use Plan Research to start an investigation; it will appear here.
            </p>
            <button
              type="button"
              onClick={onNewResearch}
              className="gm-press mt-3 rounded-lg border border-emerald-500/40 px-3 py-1.5 text-[11px] font-medium text-emerald-500 hover:bg-emerald-500/10"
            >
              Start research
            </button>
          </div>
        )}
        <ul aria-label="Research sessions" className="gm-stagger space-y-1.5">
          {items.map((item) => (
            <li key={item.session_id}>
              <button
                type="button"
                onClick={() => open(item.session_id)}
                className={`gm-press gm-lift gm-glass-card w-full rounded-xl border px-2.5 py-2 text-left transition-colors ${border}`}
              >
                <span className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{item.title}</span>
                  <StatusChip status={item.status} />
                </span>
                <span className={`mt-0.5 block truncate text-[11px] ${muted}`}>{item.question || "No question yet"}</span>
                <span className={`mt-1 flex flex-wrap gap-x-2 text-[10px] ${muted}`}>
                  <span>{formatDate(item.created_at)}</span>
                  <span className={item.insight_status === "available" ? "text-emerald-500" : ""}>
                    {item.insight_status === "available" ? "Insights" : "No insights"}
                  </span>
                  <span>
                    {item.report_count} report{item.report_count === 1 ? "" : "s"}
                    {item.report_count > 0 && item.availability.reports === "unavailable" ? " (expired)" : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {list && items.length < list.total && (
          <button
            type="button"
            disabled={loadingList}
            onClick={() => void loadList(items.length)}
            className={`w-full rounded-lg border py-1.5 text-[11px] ${border} ${muted}`}
          >
            {loadingList ? "Loading…" : `Load more (${list.total - items.length})`}
          </button>
        )}
      </div>

      {list && (
        <p className={`flex shrink-0 gap-1.5 border-t px-3 py-2 text-[10px] leading-4 ${border} ${muted}`}>
          <Database size={11} className="mt-0.5 shrink-0" />
          {list.storage.note} Sessions are scoped to this browser but are not private: there are no user accounts.
        </p>
      )}
    </section>
  );
}

function SessionView({
  isDark, busy, refreshToken, sessionId, onBack, onPickLocation, onPickCompare, onEditQuestion, onReplan, onExecute,
}: ResearchWorkspaceProps & { sessionId: string; onBack: () => void }) {
  const muted = isDark ? "text-neutral-400" : "text-gray-500";
  const border = isDark ? "border-white/8" : "border-gray-200";
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState<"" | "insights" | "rename" | "delete">("");
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setError("");
    try {
      const data = await getSession(sessionId, controller.signal);
      if (data.session_id === sessionId) setSession(data); // never show another session's data
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "Unable to load the research session.");
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load, refreshToken]);

  async function act(kind: "insights" | "rename" | "delete", task: () => Promise<unknown>, after?: () => void) {
    setWorking(kind);
    setError("");
    try {
      await task();
      after?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The action failed.");
    } finally {
      setWorking("");
    }
  }

  const header = (
    <button type="button" onClick={onBack} className={`flex items-center gap-1 text-[11px] font-medium ${muted} hover:text-emerald-500`}>
      <ArrowLeft size={12} /> All research
    </button>
  );

  if (!session) {
    return (
      <section aria-label="Research session" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {header}
        {error ? (
          <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/8 px-2.5 py-2 text-[11px] text-red-400" role="alert">
            <p className="flex gap-1.5"><AlertCircle size={13} className="mt-px shrink-0" /> {error}</p>
            <div className="flex gap-3">
              <button type="button" onClick={() => void load()} className="font-medium underline">Retry</button>
              <button type="button" onClick={onBack} className="font-medium underline">Back to all research</button>
            </div>
          </div>
        ) : (
          <p className={`flex items-center gap-1.5 text-[11px] ${muted}`} role="status">
            <LoaderCircle size={12} className="animate-spin" /> Loading research session…
          </p>
        )}
      </section>
    );
  }

  const available = session.availability;
  const live = available.execution === "retained";
  const finished = session.execution && !["queued", "running"].includes(session.execution.status);
  const execution: ExecutionUIState | null = session.execution
    ? {
        id: session.execution.execution_id,
        status: session.execution.status,
        steps: Object.fromEntries(
          session.execution.steps.map((s) => [s.id, { status: s.status, summary: s.summary, error: s.error, reused_from: null }]),
        ),
        currentStep: null,
        warnings: session.execution.warnings,
        errors: session.execution.errors,
        results: [],
        error: null,
      }
    : null;
  const insightsOk = session.insights && !["failed", "insufficient_evidence"].includes(session.insights.overall_status);

  return (
    <section aria-label="Research session" className="gm-slide-in min-h-0 flex-1 space-y-3 overflow-y-auto p-3" data-session={session.session_id}>
      {header}

      <div className={`gm-glass-card space-y-1.5 rounded-xl border p-2.5 ${border}`}>
        {renaming ? (
          <form
            className="flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void act("rename", () => renameSession(session.session_id, title.trim()), () => {
                setRenaming(false);
                void load();
              });
            }}
          >
            <input
              aria-label="Session title"
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              className={`min-w-0 flex-1 rounded-lg border px-2 py-1 text-xs outline-none focus:border-emerald-500 ${
                isDark ? "border-white/10 bg-black/40" : "border-gray-200 bg-white"
              }`}
            />
            <button type="submit" disabled={!title.trim() || working === "rename"} className="rounded-lg bg-emerald-500 px-2 text-[11px] font-semibold text-black disabled:opacity-40">
              Save
            </button>
          </form>
        ) : (
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 flex-1 text-sm font-semibold leading-5">{session.title}</h3>
            <StatusChip status={session.status} />
            <button
              type="button"
              aria-label="Rename session"
              onClick={() => {
                setTitle(session.title);
                setRenaming(true);
              }}
              className={muted}
            >
              <Pencil size={12} />
            </button>
          </div>
        )}
        <p className="text-[11px] leading-4">{session.question}</p>
        <p className={`text-[10px] ${muted}`}>
          Created {formatDate(session.created_at)} · Updated {formatDate(session.updated_at)}
        </p>
        <p
          className={`rounded-lg px-2 py-1.5 text-[10px] leading-4 ${
            available.execution === "expired" ? "bg-amber-500/8 text-amber-500" : `${muted} ${isDark ? "bg-white/[0.03]" : "bg-gray-50"}`
          }`}
          aria-label="Data availability"
        >
          {available.note}
        </p>
      </div>

      {error && (
        <p className="flex gap-1.5 text-[11px] text-red-400" role="alert">
          <AlertCircle size={13} className="mt-px shrink-0" /> {error}
        </p>
      )}

      {session.plan && (
        <div>
          <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${muted}`}>Plan and execution</p>
          <ResearchPlanView
            isDark={isDark}
            plan={session.plan}
            busy={busy}
            onPickLocation={onPickLocation}
            onPickCompare={onPickCompare}
            onEditQuestion={onEditQuestion}
            onReplan={(question) => onReplan(question, session.session_id)}
            onExecute={available.can_execute ? () => onExecute(session) : undefined}
            execution={execution}
          />
        </div>
      )}

      {session.execution && session.execution.results.length > 0 && (
        <div className="space-y-1.5" aria-label="Results summary">
          <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${muted}`}>Results summary</p>
          {session.execution.results.map((result) => (
            <div key={result.capability_id} className={`rounded-lg border px-2.5 py-2 text-[11px] ${border}`}>
              <p className="flex font-semibold">
                {result.title}
                <span className={`ml-auto text-[10px] font-medium ${result.outcome === "completed" ? "text-emerald-500" : result.outcome === "failed" ? "text-red-400" : "text-amber-500"}`}>
                  {result.outcome}
                </span>
              </p>
              <p className="mt-1 whitespace-pre-line leading-4">{result.message}</p>
              {result.layer_count > 0 && (
                <p className={`mt-1 text-[10px] ${muted}`}>
                  {live ? `${result.layer_count} map layer(s) were produced by this run.` : "Map layers are not kept with the session."}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {session.warnings.length > 0 && (
        <ul aria-label="Session warnings" className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/8 px-2.5 py-2 text-[11px] text-amber-500">
          {session.warnings.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {session.insights ? (
        <ResearchInsightsView isDark={isDark} synthesis={session.insights} />
      ) : (
        live && finished && !["failed", "cancelled"].includes(session.execution!.status) && (
          <button
            type="button"
            disabled={working === "insights"}
            onClick={() => void act("insights", () => synthesizeExecution(session.execution!.execution_id), () => void load())}
            className="gm-press flex min-h-8 items-center gap-1.5 rounded-lg border border-emerald-500/40 px-3 text-xs font-medium text-emerald-500 hover:bg-emerald-500/10 disabled:opacity-50"
          >
            {working === "insights" ? <LoaderCircle size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {working === "insights" ? "Analysing evidence…" : "Generate Research Insights"}
          </button>
        )
      )}

      {live && session.insights && session.execution && (
        <ResearchReportControls
          isDark={isDark}
          executionId={session.execution.execution_id}
          available={Boolean(insightsOk)}
          onGenerated={() => void load()}
        />
      )}

      <div aria-label="Report history" className="space-y-1.5">
        <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${muted}`}>Report history</p>
        {session.reports.length === 0 ? (
          <p className={`text-[11px] ${muted}`}>No reports generated yet.</p>
        ) : (
          <ul className="gm-stagger space-y-1">
            {session.reports.map((record) => (
              <li key={record.report_id} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${border}`} data-report={record.report_id}>
                <FileText size={12} className="shrink-0 text-emerald-500" />
                <span className="font-semibold uppercase">{record.format}</span>
                <span className={muted}>{formatDate(record.generated_at)}</span>
                <span className={`tabular-nums ${muted}`}>{(record.size_bytes / 1024).toFixed(0)} KB</span>
                <span className={`ml-auto text-[10px] ${record.availability === "regenerable" ? "text-emerald-500" : "text-amber-500"}`}>
                  {record.availability === "regenerable" ? "Can be regenerated above" : "Unavailable: run the research again"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className={`text-[10px] leading-4 ${muted}`}>
          Report files are not stored. They can be regenerated while this run's data is in memory (30 minutes, lost on
          restart).
        </p>
      </div>

      <div className={`flex items-center gap-2 border-t pt-3 ${border}`}>
        {confirmDelete ? (
          <>
            <span className="text-[11px] text-red-400">Delete this session and its history?</span>
            <button
              type="button"
              disabled={working === "delete"}
              onClick={() => void act("delete", () => deleteSession(session.session_id), onBack)}
              className="rounded-lg bg-red-500 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              Confirm delete
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className={`text-[11px] ${muted}`}>
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1 text-[11px] text-red-400 hover:underline"
          >
            <Trash2 size={12} /> Delete session
          </button>
        )}
      </div>
    </section>
  );
}
