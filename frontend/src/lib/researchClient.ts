import { API_BASE_URL, postJSON } from "./api";
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
}

/** Plan only: the backend never executes the steps it returns. */
export function planResearch(body: ResearchPlanRequest, signal?: AbortSignal) {
  return postJSON<ResearchPlan>("/api/research/plan", body, "Unable to create a research plan.", { signal });
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
): Promise<ExecutionSummary> {
  const response = await fetch(`${API_BASE_URL}/api/research/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
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
