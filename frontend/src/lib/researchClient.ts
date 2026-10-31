import { API_BASE_URL, getJSON, postJSON, sendJSON } from "./api";
import type { AgentLayer, WorkflowResult } from "./agentClient";

export type ResearchPlanStatus = "ready" | "needs_input" | "unsupported" | "invalid";
export type ResearchStepStatus = "planned" | "blocked" | "ready";
export type ResearchInputId = "location" | "compare_location" | "category" | "facility";

export interface ResearchStep {
  id: string;
  capability_id: string;
  tool: string;
  title: string;
  description: string;
  execution_order: number;
  dependencies: string[];
  optional_dependencies: string[];
  aliases: string[];
  arguments: Record<string, unknown>;
  required_inputs: ResearchInputId[];
  expected_outputs: string[];
  status: ResearchStepStatus;
}

export interface ResearchPlan {
  id: string;
  title: string;
  original_question: string;
  objective: string;
  status: ResearchPlanStatus;
  interpretation: string[];
  selected_areas: { id: "a" | "b"; label: string; coordinates: [number, number] | null; required: boolean }[];
  assumptions: string[];
  limitations: string[];
  missing_inputs: {
    id: ResearchInputId;
    label: string;
    reason: string;
    action: "pick_location" | "pick_compare_location" | "edit_question";
  }[];
  clarification_questions: string[];
  capabilities: { id: string; title: string; reason: string }[];
  steps: ResearchStep[];
  interpreter: "rules" | "llm";
  executed: false;
  created_at: string;
  signature: string;
}

export interface ResearchPlanRequest {
  question: string;
  coordinates?: [number, number];
  compare_coordinates?: [number, number];
  session_id?: string;
}

/** Plan only: the backend never executes the steps it returns. */
export function planResearch(body: ResearchPlanRequest, signal?: AbortSignal) {
  return postJSON<ResearchPlan>("/api/research/plan", body, "Unable to create a research plan.", {
    signal,
    headers: workspaceHeaders(),
  });
}

// Execution (Milestone 9.2): runs an approved, server-signed plan.

export type ExecutionStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_warnings"
  | "partial"
  | "failed"
  | "cancelled";

export type ExecutionStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "blocked"
  | "skipped"
  | "cancelled";

export interface ExecutionStepState {
  status: ExecutionStepStatus;
  summary: string;
  error: string | null;
  reused_from: string | null;
}

export interface ResearchCapabilityResult {
  capability_id: string;
  title: string;
  outcome: "completed" | "partial" | "failed";
  message: string;
  workflow: WorkflowResult | null;
  layers: AgentLayer[];
}

export interface ExecutionSummary {
  execution_id: string;
  status: ExecutionStatus;
  steps: (ExecutionStepState & { id: string })[];
  warnings: string[];
  errors: string[];
  results: ResearchCapabilityResult[];
}

export type ExecutionEvent = { execution_id: string } & (
  | { type: "execution_started"; total_steps: number; steps: (ExecutionStepState & { id: string })[] }
  | { type: "step_started"; step_id: string; title: string }
  | { type: "step_completed" | "step_partial"; step_id: string; summary: string; reused_from: string | null; warning?: string }
  | { type: "step_failed"; step_id: string; error: string }
  | { type: "step_blocked" | "step_skipped"; step_id: string; reason: string }
  | { type: "execution_completed" | "execution_failed" | "execution_cancelled"; status: ExecutionStatus; result: ExecutionSummary }
);

const FINAL_EVENTS = new Set(["execution_completed", "execution_failed", "execution_cancelled"]);

/** Stream an execution; resolves with the final summary event. */
export async function executeResearch(
  plan: ResearchPlan,
  onEvent: (event: ExecutionEvent) => void,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<ExecutionSummary> {
  const response = await fetch(`${API_BASE_URL}/api/research/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...workspaceHeaders() },
    body: JSON.stringify(sessionId ? { plan, session_id: sessionId } : { plan }),
    signal,
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(
      typeof data?.detail === "string" ? data.detail : `The research could not be started (${response.status}).`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      const event = JSON.parse(line) as ExecutionEvent;
      onEvent(event);
      if (FINAL_EVENTS.has(event.type)) return (event as { result: ExecutionSummary }).result;
    }

    if (done) break;
  }

  throw new Error("The research stream ended without a result.");
}

export function cancelExecution(executionId: string) {
  return postJSON<{ cancel_requested: boolean }>(
    `/api/research/executions/${encodeURIComponent(executionId)}/cancel`,
    {},
    "Unable to cancel the research.",
  );
}

// Synthesis (Milestone 9.3): evidence-based insights from a finished execution.

export interface EvidenceItem {
  evidence_id: string;
  source_execution_id: string;
  source_step_id: string | null;
  capability_id: string;
  finding_type: "measurement" | "derived" | "ranking" | "qualitative" | "data_quality";
  kind: "measured" | "derived" | "interpretation" | "assumption";
  title: string;
  description: string;
  observed_value: number | string | null;
  unit: string | null;
  geographic_scope: string;
  methodology: string;
  source_dataset: string;
  quality: string;
  limitations: string[];
  partial_or_truncated: boolean;
}

export interface KeyFinding {
  finding_id: string;
  title: string;
  conclusion: string;
  evidence_ids: string[];
  explanation: string;
  geographic_scope: string;
  quality: string;
  caveats: string[];
  source: "deterministic" | "llm";
}

export interface ResearchSynthesis {
  synthesis_id: string;
  execution_id: string;
  research_question: string;
  title: string;
  executive_summary: string;
  overall_status: "complete" | "partial" | "insufficient_evidence" | "failed";
  key_findings: KeyFinding[];
  evidence: EvidenceItem[];
  comparisons: {
    comparison_id: string;
    metric: string;
    unit: string;
    a_value: number | null;
    b_value: number | null;
    difference: number | null;
    better: "a" | "b" | "tie" | null;
    comparable: boolean;
    note: string;
    evidence_ids: string[];
  }[];
  candidate_insights: {
    candidate_id: string;
    rank: number;
    tied: boolean;
    score: number;
    coordinates: [number, number];
    coverage_class: string | null;
    strengths: string[];
    weaknesses: string[];
    explanation: string;
    evidence_ids: string[];
    caveat: string;
  }[];
  limitations: string[];
  assumptions: string[];
  data_quality_warnings: string[];
  unsupported_questions: string[];
  recommendations: { text: string; evidence_ids: string[]; source: "deterministic" | "llm" }[];
  methodology: string[];
  generated_at: string;
  synthesis_mode: "deterministic" | "llm_assisted";
  rejected_llm_claims: number;
}

/** Reads retained evidence only; never re-runs the research. */
export function synthesizeExecution(executionId: string, signal?: AbortSignal) {
  return postJSON<ResearchSynthesis>(
    `/api/research/executions/${encodeURIComponent(executionId)}/synthesize`,
    { mode: "auto" },
    "Unable to generate research insights.",
    { signal },
  );
}

// Reports (Milestone 9.4): PDF or DOCX built from existing insights.

export type ReportFormat = "pdf" | "docx";

/** Downloads a report built from the execution's existing insights (nothing re-runs). */
export async function downloadResearchReport(executionId: string, format: ReportFormat, signal?: AbortSignal) {
  const response = await fetch(`${API_BASE_URL}/api/research/executions/${encodeURIComponent(executionId)}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format }),
    signal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(typeof data?.detail === "string" ? data.detail : `The report could not be generated (${response.status}).`);
  }

  const blob = await response.blob();
  const filename = `geomind-research-${executionId.replace(/[^A-Za-z0-9_-]/g, "")}.${format}`;
  return { blob, filename };
}

// Research sessions (Milestone 9.5): workspace and report history.

const WORKSPACE_KEY = "geomind-research-workspace";
let memoryWorkspace: string | null = null;

function randomKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Random per-browser key that scopes research sessions. It is not
 * authentication: anyone with the key could list these sessions.
 */
export function workspaceKey(): string {
  try {
    const stored = localStorage.getItem(WORKSPACE_KEY);
    if (stored && /^[A-Za-z0-9_-]{16,64}$/.test(stored)) return stored;
    const key = randomKey();
    localStorage.setItem(WORKSPACE_KEY, key);
    return key;
  } catch {
    // Storage blocked (private mode): sessions last for this page only.
    memoryWorkspace ??= randomKey();
    return memoryWorkspace;
  }
}

export function newClientToken() {
  return randomKey();
}

function workspaceHeaders() {
  return { "X-GeoMind-Workspace": workspaceKey() };
}

export type SessionStatus =
  | "draft"
  | "planned"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "expired";

export interface SessionAvailability {
  execution: "none" | "retained" | "expired";
  insights: "not_generated" | "available";
  reports: "none" | "regenerable" | "unavailable";
  can_execute: boolean;
  note: string;
}

export interface ReportRecord {
  report_id: string;
  session_id: string;
  execution_id: string;
  format: ReportFormat;
  generated_at: string;
  size_bytes: number;
  sha256: string;
  availability: "regenerable" | "unavailable";
}

export interface SessionSummary {
  session_id: string;
  title: string;
  question: string;
  created_at: string;
  updated_at: string;
  status: SessionStatus;
  insight_status: "not_generated" | "available";
  report_count: number;
  availability: SessionAvailability;
}

export interface SessionDetail extends SessionSummary {
  warnings: string[];
  plan: ResearchPlan | null;
  execution: {
    execution_id: string;
    status: ExecutionStatus;
    started_at: string | null;
    finished_at: string | null;
    steps: { id: string; title: string; capability_id: string; status: ExecutionStepStatus; summary: string; error: string | null }[];
    warnings: string[];
    errors: string[];
    results: { capability_id: string; title: string; outcome: string; message: string; layer_count: number }[];
  } | null;
  insights: ResearchSynthesis | null;
  reports: ReportRecord[];
}

export interface SessionList {
  items: SessionSummary[];
  total: number;
  limit: number;
  offset: number;
  storage: { kind: "memory" | "sqlite"; persistent: boolean; note: string };
}

const SESSIONS = "/api/research/sessions";

export function createSession(question: string, clientToken: string) {
  return postJSON<SessionDetail>(SESSIONS, { question, client_token: clientToken }, "Unable to start a research session.", {
    headers: workspaceHeaders(),
  });
}

export function listSessions(params: { limit?: number; offset?: number; q?: string; status?: string }, signal?: AbortSignal) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => value !== undefined && value !== "" && query.set(key, String(value)));
  return getJSON<SessionList>(`${SESSIONS}?${query}`, "Unable to load research sessions.", {
    signal,
    headers: workspaceHeaders(),
  });
}

export function getSession(sessionId: string, signal?: AbortSignal) {
  return getJSON<SessionDetail>(`${SESSIONS}/${encodeURIComponent(sessionId)}`, "Unable to load the research session.", {
    signal,
    headers: workspaceHeaders(),
  });
}

export function renameSession(sessionId: string, title: string) {
  return sendJSON<SessionDetail>("PATCH", `${SESSIONS}/${encodeURIComponent(sessionId)}`, { title }, "Unable to rename the session.", {
    headers: workspaceHeaders(),
  });
}

export function deleteSession(sessionId: string) {
  return sendJSON<null>("DELETE", `${SESSIONS}/${encodeURIComponent(sessionId)}`, undefined, "Unable to delete the session.", {
    headers: workspaceHeaders(),
  });
}
