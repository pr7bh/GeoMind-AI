import type { FeatureCollection } from "geojson";
import { API_BASE_URL, getJSON } from "./api";
import type { CoverageClass } from "./coverage";

export interface AgentStep {
  tool: string;
  arguments: Record<string, unknown> | null;
  status: "completed" | "failed";
  summary: string;
  error: string | null;
}

export interface AgentLayer {
  kind: "discovery" | "analysis";
  /** "coverage": colour cells by their coverage_class property. */
  style?: "coverage";
  /** Comparison area this layer belongs to. */
  area?: "a" | "b";
  name: string;
  feature_count: number;
  geojson: FeatureCollection;
}

export type WorkflowStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface WorkflowStep {
  id: string;
  tool: string;
  description: string;
  depends_on: string[];
  arguments: Record<string, unknown>;
  status: WorkflowStepStatus;
  summary: string;
  error: string | null;
  partial: boolean;
  preview: Record<string, unknown>;
}

export interface RankedSource {
  rank: number;
  tied: boolean;
  id: string;
  name: string;
  distance_km: number | null;
  nearby_count: number;
  relationship_count: number;
  count_is_lower_bound: boolean;
  nearest_m: number | null;
  nearby: { id: string; name: string; distance_m: number }[];
}

export interface CoverageSummary {
  centre: [number, number];
  radius_km: number;
  cell_size_m: number;
  cell_size_adjusted: boolean;
  total_cells: number;
  counts: Record<CoverageClass, number>;
  percentages: Record<CoverageClass, number>;
  average_distance_m: number | null;
  max_distance_m: number | null;
  services_count: number;
  invalid_services: number;
  thresholds_m: { well_covered: number; moderate: number };
  search_radius_km: number;
  search_margin_sufficient: boolean;
  discovery_truncated: boolean;
  partial: boolean;
}

export interface ComparisonMetric {
  key: string;
  label: string;
  unit: "count" | "per km²" | "%" | "m";
  higher_is_better: boolean;
  a: number | null;
  b: number | null;
  difference: number | null;
  relative_difference_pct: number | null;
  better: "a" | "b" | "tie" | null;
  definitive: boolean;
}

export interface AreaMetrics {
  centre: [number, number];
  radius_km: number;
  cell_size_m: number;
  total_cells: number;
  percentages: Record<CoverageClass, number>;
  services_in_area: number;
  density_per_km2: number | null;
  average_distance_m: number | null;
  truncated: boolean;
  density_complete: boolean;
  coverage_complete: boolean;
}

export interface WorkflowResult {
  type?: "nearby_count" | "coverage" | "comparison";
  outcome: "completed" | "partial" | "failed";
  stop_reason: string | null;
  plan: WorkflowStep[];
  analysis: {
    location: [number, number];
    sources?: { label: string; radius_km: number; returned: number; total_found: number; truncated: boolean };
    nearby?: { label: string; radius_km: number; distinct_count: number; relationship_count: number; failed_count: number };
    ranking?: RankedSource[];
    unranked?: { id: string; name: string; status: string; reason: string | null }[];
    complete?: boolean;
    coverage?: CoverageSummary;
    services?: {
      label: string;
      search_radius_km: number;
      total_found: number;
      returned: number;
      truncated: boolean;
      attribution: string;
      osm_base: string | null;
      coverage_note: string;
    };
    methodology?: string[];
    metrics?: ComparisonMetric[];
    overall_winner?: null;
    areas?: Record<"a" | "b", { metrics: AreaMetrics | null; error: string | null }>;
  };
}

export interface AgentResponse {
  success: boolean;
  intent: string;
  message: string;
  tool?: string | null;
  // Shape depends on the intent (route / nearest results etc.).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: Record<string, any>;
  needs_input: string[];
  mode: "keyword" | "deterministic" | "llm" | "workflow";
  steps: AgentStep[];
  layers: AgentLayer[];
  error_code: string | null;
  workflow?: WorkflowResult | null;
}

export type AgentEvent =
  | { type: "thinking" }
  | { type: "tool_started"; tool: string; arguments: Record<string, unknown> | null }
  | { type: "tool_finished"; step: AgentStep }
  | { type: "plan_created"; plan: WorkflowStep[] }
  | { type: "step_started"; step_id: string }
  | { type: "step_completed"; step_id: string; summary: string; partial: boolean; preview: Record<string, unknown> }
  | { type: "step_failed"; step_id: string; error: string }
  | { type: "step_skipped"; step_id: string; reason: string }
  | { type: "workflow_completed" | "workflow_partial" | "workflow_failed"; stop_reason: string | null }
  | { type: "result"; response: AgentResponse }
  | { type: "error"; status: number; detail: unknown };

export interface AgentStatus {
  configured: boolean;
  provider: "ollama" | "remote" | null;
  model: string | null;
  error: string | null;
}

export function getAgentStatus(signal?: AbortSignal) {
  return getJSON<AgentStatus>("/api/agent/status", "Unable to reach the agent.", { signal });
}

/**
 * POST to the streaming endpoint and report each event as it arrives.
 * Resolves with the final response; rejects on transport or agent errors.
 */
export async function streamAgentChat(
  payload: unknown,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<AgentResponse> {
  const response = await fetch(`${API_BASE_URL}/api/agent/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(
      typeof data?.detail === "string"
        ? data.detail
        : `The agent request failed (${response.status}).`,
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

      const event = JSON.parse(line) as AgentEvent;
      onEvent(event);

      if (event.type === "result") return event.response;
      if (event.type === "error") {
        throw new Error(
          typeof event.detail === "string" ? event.detail : "The agent request failed.",
        );
      }
    }

    if (done) break;
  }

  throw new Error("The agent stream ended without a result.");
}
