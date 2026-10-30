export type CoverageClass = "well_covered" | "moderate" | "underserved" | "no_service_found";

/** Shared by the map layer and the Ask AI legend so they always match. */
export const COVERAGE_CLASSES: { key: CoverageClass; label: string; color: string }[] = [
  { key: "well_covered", label: "Well covered", color: "#10b981" },
  { key: "moderate", label: "Moderate", color: "#f59e0b" },
  { key: "underserved", label: "Underserved", color: "#ef4444" },
  { key: "no_service_found", label: "No service found", color: "#737373" },
];

/** Outline colours that tell compared areas apart on the map. */
export const AREA_COLORS: Record<"a" | "b", string> = { a: "#38bdf8", b: "#a78bfa" };

export const COVERAGE_PALETTE: Record<string, string> = Object.fromEntries(
  COVERAGE_CLASSES.map(({ key, color }) => [key, color]),
);
