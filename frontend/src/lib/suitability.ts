import { getJSON } from "./api";

export type FacilityId = "hospital" | "school" | "pharmacy" | "police" | "fire_station";
export type Normalization = "saturating" | "minmax";
export type PharmacyDirection = "closer" | "farther";

export interface CriterionConfig {
  id: string;
  name: string;
  description: string;
  unit: "m" | "count" | "index";
  higher_is_better: boolean;
  method: Normalization;
  saturation: number | null;
  default_weight: number;
  enabled_by_default: boolean;
  direction_required: boolean;
}

export interface SuitabilityConfig {
  facilities: Record<FacilityId, { label: string; existing_category: string; density_category: string; criteria: CriterionConfig[] }>;
  constraint: { id: string; name: string; description: string };
  limits: {
    max_radius_km: number;
    default_radius_km: number;
    max_candidates: number;
    min_candidates: number;
    max_criteria: number;
    existing_saturation_m: { min: number; max: number; default: number };
  };
  normalizations: Normalization[];
  unsupported_criteria: Record<string, string>;
}

/** Sent as `suitability` with an agent request. */
export interface SuitabilityOptions {
  facility: FacilityId;
  radius_km: number;
  weights: Record<string, number>;
  pharmacy_direction?: PharmacyDirection;
  normalization: Normalization;
}

export interface CriterionPart {
  raw: number | null;
  normalized: number | null;
  weight: number;
  contribution: number | null;
  lower_bound: boolean;
}

export interface SuitabilityCandidate {
  id: string;
  rank?: number;
  tied?: boolean;
  score?: number;
  lon: number;
  lat: number;
  cell_area_km2: number;
  criteria: Record<string, CriterionPart>;
  strengths?: string[];
  weaknesses?: string[];
  explanation?: string;
  reason?: string;
}

export interface SuitabilityCriterionResult {
  id: string;
  name: string;
  description: string;
  unit: "m" | "count" | "index";
  higher_is_better: boolean;
  method: Normalization;
  saturation: number | null;
  status: "used" | "unavailable" | "disabled";
  weight: number;
  requested_weight: number;
  note: string | null;
}

export interface SuitabilityResult {
  facility: FacilityId;
  facility_label: string;
  centre: [number, number];
  radius_km: number;
  cell_size_m: number;
  candidate_count: number;
  scored_count: number;
  unscored_count: number;
  excluded_by_constraint: number;
  small_edge_cells_dropped: number;
  normalization: Normalization;
  criteria: SuitabilityCriterionResult[];
  constraint: { id: string; name: string; description: string };
  weights: Record<string, number>;
  requested_weights: Record<string, number>;
  weight_total: number;
  ranked: SuitabilityCandidate[];
  unscored: SuitabilityCandidate[];
  top_comparison: { a: string; b: string; score_difference: number; text: string } | null;
  existing_count: number;
  pharmacy_count: number | null;
  data_quality: string[];
  complete: boolean;
}

export interface SuitabilitySource {
  label?: string;
  search_radius_km?: number;
  total_found?: number;
  returned?: number;
  truncated?: boolean;
  attribution?: string;
  osm_base?: string | null;
  error?: string;
}

/** Score bands shared by the map layers and the results legend. */
export const SCORE_BANDS: { key: string; label: string; color: string }[] = [
  { key: "80-100", label: "80–100", color: "#15803d" },
  { key: "60-80", label: "60–80", color: "#65a30d" },
  { key: "40-60", label: "40–60", color: "#eab308" },
  { key: "20-40", label: "20–40", color: "#f97316" },
  { key: "0-20", label: "0–20", color: "#dc2626" },
  { key: "unscored", label: "Unscored", color: "#737373" },
];

export const SCORE_PALETTE: Record<string, string> = Object.fromEntries(
  SCORE_BANDS.map(({ key, color }) => [key, color]),
);

export function scoreColor(score: number | null | undefined) {
  if (score === null || score === undefined) return SCORE_PALETTE.unscored;
  if (score >= 80) return SCORE_PALETTE["80-100"];
  if (score >= 60) return SCORE_PALETTE["60-80"];
  if (score >= 40) return SCORE_PALETTE["40-60"];
  if (score >= 20) return SCORE_PALETTE["20-40"];
  return SCORE_PALETTE["0-20"];
}

export function formatRaw(part: CriterionPart, unit: CriterionConfig["unit"]) {
  if (part.raw === null) return "—";
  if (unit === "m") return `${(part.raw / 1000).toFixed(2)} km${part.lower_bound ? "+" : ""}`;
  if (unit === "count") return String(part.raw);
  return `${part.raw}/100`;
}

export function getSuitabilityConfig(signal?: AbortSignal) {
  return getJSON<SuitabilityConfig>(
    "/api/agent/suitability/config",
    "Unable to load the suitability settings.",
    { signal },
  );
}
