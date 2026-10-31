import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleSlash,
  LoaderCircle,
} from "lucide-react";
import type {
  AreaMetrics,
  ComparisonMetric,
  WorkflowResult,
  WorkflowStep,
} from "../../lib/agentClient";
import { AREA_COLORS, COVERAGE_CLASSES } from "../../lib/coverage";
import SuitabilityView from "./SuitabilityView";

interface WorkflowViewProps {
  isDark: boolean;
  plan: WorkflowStep[];
  result: WorkflowResult | null;
  cancelled: boolean;
  /** False when the steps are already shown elsewhere (research execution). */
  showTimeline?: boolean;
}

const MAX_RANKED_ROWS = 10;

function StepIcon({ status }: { status: WorkflowStep["status"] }) {
  switch (status) {
    case "running":
      return <LoaderCircle size={13} className="shrink-0 animate-spin text-sky-500" />;
    case "completed":
      return <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />;
    case "failed":
      return <AlertCircle size={13} className="shrink-0 text-red-400" />;
    case "skipped":
      return <CircleSlash size={13} className="shrink-0 text-neutral-500" />;
    default:
      return <Circle size={13} className="shrink-0 text-neutral-500" />;
  }
}

function previewRows(preview: Record<string, unknown>) {
  return Object.entries(preview)
    .filter(([, value]) => value !== null && typeof value !== "object")
    .map(([key, value]) => [key.replace(/_/g, " "), String(value)] as const);
}

export default function WorkflowView({ isDark, plan, result, cancelled, showTimeline = true }: WorkflowViewProps) {
  const muted = isDark ? "text-neutral-400" : "text-gray-500";
  const border = isDark ? "border-white/8" : "border-gray-200";
  const analysis = result?.analysis;
  const ranking = analysis?.ranking ?? [];
  const unranked = analysis?.unranked ?? [];
  const nearbyLabel = analysis?.nearby?.label.toLowerCase() ?? "nearby";

  return (
    <div className="mt-3 space-y-3">
      {/* Timeline */}
      {showTimeline && (
        <ol aria-label="Workflow steps" className="space-y-1">
          {plan.map((step, index) => (
            <li key={step.id}>
              <details className="group">
                <summary
                  className={`flex cursor-pointer list-none items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] [&::-webkit-details-marker]:hidden ${border} ${
                    step.status === "running" ? "border-sky-500/40" : ""
                  }`}
                >
                  <StepIcon status={cancelled && step.status === "running" ? "skipped" : step.status} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">
                      {index + 1}. {step.description}
                    </span>
                    {step.summary && <span className={`block ${muted}`}>{step.summary}</span>}
                    {step.error && (
                      <span className={`block ${step.status === "failed" ? "text-red-400" : muted}`}>
                        {step.error}
                      </span>
                    )}
                    {step.partial && <span className="block text-amber-500">Partial result</span>}
                  </span>
                  <ChevronRight size={12} className={`mt-0.5 shrink-0 transition-transform group-open:rotate-90 ${muted}`} />
                </summary>
                <dl className={`ml-6 mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px] ${muted}`}>
                  <dt>tool</dt>
                  <dd className="font-mono">{step.tool}</dd>
                  <dt>status</dt>
                  <dd>{step.status}</dd>
                  {previewRows(step.preview).map(([key, value]) => (
                    <div key={key} className="contents">
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            </li>
          ))}
        </ol>
      )}

      {/* Outcome */}
      {result?.outcome === "partial" && (
        <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-2.5 py-2 text-[11px] text-amber-500">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          Partial results: some searches failed or hit a limit, so the ranking is incomplete.
        </p>
      )}
      {result?.outcome === "failed" && (
        <p className="flex gap-2 rounded-lg border border-red-500/30 bg-red-500/8 px-2.5 py-2 text-[11px] text-red-400">
          <AlertCircle size={13} className="mt-px shrink-0" />
          The workflow did not complete; no ranking was produced.
        </p>
      )}
      {result?.stop_reason && (
        <p className={`rounded-lg border px-2.5 py-2 text-[11px] ${border} ${muted}`}>
          {result.stop_reason}
        </p>
      )}

      {result?.type === "comparison" && analysis?.areas && (
        <ComparisonView isDark={isDark} result={result} />
      )}

      {result?.type === "suitability" && analysis?.suitability && (
        <SuitabilityView isDark={isDark} result={result} />
      )}

      {result?.type === "coverage" && analysis?.coverage && (
        <CoverageSummaryView isDark={isDark} result={result} />
      )}

      {/* Ranking */}
      {ranking.length > 0 && (
        <section aria-label="Ranking">
          <p className={`mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${muted}`}>
            Ranked by distinct {nearbyLabel} within {analysis?.nearby?.radius_km} km
          </p>
          <ol className="space-y-1">
            {ranking.slice(0, MAX_RANKED_ROWS).map((entry) => (
              <li key={entry.id}>
                <details className="group">
                  <summary
                    className={`flex cursor-pointer list-none items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] [&::-webkit-details-marker]:hidden ${border}`}
                  >
                    <span className="w-6 shrink-0 font-mono text-emerald-500">
                      {entry.rank}
                      {entry.tied ? "=" : ""}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    <span className="shrink-0 font-semibold">
                      {entry.nearby_count}
                      {entry.count_is_lower_bound ? "+" : ""}
                    </span>
                  </summary>
                  <ul className={`ml-8 mt-1 space-y-0.5 text-[10px] ${muted}`}>
                    {entry.nearby.length === 0 && <li>None within the radius.</li>}
                    {entry.nearby.map((item) => (
                      <li key={item.id} className="flex justify-between gap-2">
                        <span className="truncate">{item.name}</span>
                        <span className="shrink-0">{Math.round(item.distance_m)} m</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ol>
          {ranking.length > MAX_RANKED_ROWS && (
            <p className={`mt-1 text-[10px] ${muted}`}>
              {ranking.length - MAX_RANKED_ROWS} more ranked in the map layer properties.
            </p>
          )}
        </section>
      )}

      {/* Failed or skipped searches are not zero counts */}
      {unranked.length > 0 && (
        <section aria-label="Not ranked">
          <p className={`mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${muted}`}>
            Not ranked ({unranked.length})
          </p>
          <ul className="space-y-1">
            {unranked.map((entry) => (
              <li key={entry.id} className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${border}`}>
                <span className="font-medium">{entry.name}</span>
                <span className="block text-amber-500">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function km(metres: number | null) {
  return metres === null ? "n/a" : `${(metres / 1000).toFixed(2)} km`;
}

function CoverageSummaryView({ isDark, result }: { isDark: boolean; result: WorkflowResult }) {
  const muted = isDark ? "text-neutral-400" : "text-gray-500";
  const border = isDark ? "border-white/8" : "border-gray-200";
  const summary = result.analysis.coverage!;
  const services = result.analysis.services;
  const { well_covered: well, moderate } = summary.thresholds_m;
  const range: Record<string, string> = {
    well_covered: `≤ ${km(well)}`,
    moderate: `${km(well)}–${km(moderate)}`,
    underserved: `> ${km(moderate)}`,
    no_service_found: "none mapped",
  };

  return (
    <section aria-label="Coverage summary" className="space-y-2">
      <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${muted}`}>
        {services?.label ?? "Service"} coverage · {summary.radius_km} km · {summary.cell_size_m} m cells
      </p>

      {/* Share of cells by class */}
      <div className="flex h-2.5 overflow-hidden rounded-full" role="img" aria-label="Share of cells by coverage class">
        {COVERAGE_CLASSES.map(({ key, color }) =>
          summary.percentages[key] > 0 ? (
            <span key={key} style={{ width: `${summary.percentages[key]}%`, backgroundColor: color }} />
          ) : null,
        )}
      </div>
      <ul className="space-y-0.5 text-[11px]">
        {COVERAGE_CLASSES.filter(({ key }) => key !== "no_service_found" || summary.counts[key] > 0).map(
          ({ key, label, color }) => (
            <li key={key} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
              <span className="flex-1">
                {label} <span className={muted}>({range[key]})</span>
              </span>
              <span className="tabular-nums">
                {summary.counts[key]} · {summary.percentages[key]}%
              </span>
            </li>
          ),
        )}
      </ul>

      <dl className={`grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-lg border px-2.5 py-2 text-[10px] ${border}`}>
        <dt className={muted}>Cells</dt>
        <dd className="text-right tabular-nums">{summary.total_cells}</dd>
        <dt className={muted}>Services found</dt>
        <dd className="text-right tabular-nums">{summary.services_count}</dd>
        <dt className={muted}>Avg nearest distance</dt>
        <dd className="text-right tabular-nums">{km(summary.average_distance_m)}</dd>
        <dt className={muted}>Max nearest distance</dt>
        <dd className="text-right tabular-nums">{km(summary.max_distance_m)}</dd>
        <dt className={muted}>Search radius</dt>
        <dd className="text-right tabular-nums">{summary.search_radius_km} km</dd>
      </dl>

      {(summary.partial || summary.cell_size_adjusted) && (
        <ul className="space-y-1 text-[11px] text-amber-500">
          {summary.discovery_truncated && (
            <li>Discovery was truncated; results may be incomplete near the edge.</li>
          )}
          {!summary.search_margin_sufficient && (
            <li>The search did not reach far enough past the study edge; edge cells may be misclassified.</li>
          )}
          {summary.cell_size_adjusted && <li>Cell size was enlarged to stay within 500 cells.</li>}
        </ul>
      )}

      <details className="group">
        <summary
          className={`flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] [&::-webkit-details-marker]:hidden ${muted}`}
        >
          <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
          Assumptions &amp; methodology
        </summary>
        <ul className={`mt-1 list-disc space-y-1 pl-4 text-[10px] leading-4 ${muted}`}>
          {result.analysis.methodology?.map((line) => <li key={line}>{line}</li>)}
          {services && (
            <li>
              {services.attribution}
              {services.osm_base && ` · data as of ${new Date(services.osm_base).toLocaleDateString()}`}
            </li>
          )}
        </ul>
      </details>
    </section>
  );
}

function CoverageBar({ percentages }: { percentages: AreaMetrics["percentages"] }) {
  return (
    <div className="flex h-2 overflow-hidden rounded-full" role="img" aria-label="Share of cells by coverage class">
      {COVERAGE_CLASSES.map(({ key, color }) =>
        percentages[key] > 0 ? (
          <span key={key} style={{ width: `${percentages[key]}%`, backgroundColor: color }} />
        ) : null,
      )}
    </div>
  );
}

function formatMetric(value: number | null, unit: ComparisonMetric["unit"]) {
  if (value === null) return "—";
  if (unit === "m") return `${(value / 1000).toFixed(2)} km`;
  if (unit === "%") return `${value}%`;
  if (unit === "per km²") return value.toFixed(3);
  return String(value);
}

function formatDifference(metric: ComparisonMetric) {
  if (metric.difference === null) return "—";
  const sign = metric.difference > 0 ? "+" : metric.difference < 0 ? "−" : "";
  const magnitude = Math.abs(metric.difference);
  if (metric.unit === "%") return `${sign}${magnitude.toFixed(1)} pp`;
  return `${sign}${formatMetric(magnitude, metric.unit)}`;
}

function ComparisonView({ isDark, result }: { isDark: boolean; result: WorkflowResult }) {
  const muted = isDark ? "text-neutral-400" : "text-gray-500";
  const border = isDark ? "border-white/8" : "border-gray-200";
  const analysis = result.analysis;
  const areas = analysis.areas!;
  const metrics = analysis.metrics ?? [];

  return (
    <section aria-label="Area comparison" className="space-y-3">
      {analysis.complete === false && (
        <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-2.5 py-2 text-[11px] text-amber-500">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          Potentially incomplete data: read differences as indicative, not a definitive ranking.
        </p>
      )}

      {/* Area cards */}
      <div className="grid grid-cols-2 gap-2">
        {(["a", "b"] as const).map((key) => {
          const area = areas[key].metrics;
          return (
            <div
              key={key}
              role="group"
              aria-label={`Area ${key.toUpperCase()}`}
              className={`rounded-lg border p-2 text-[10px] ${border}`}
              style={{ borderTopColor: AREA_COLORS[key], borderTopWidth: 3 }}
            >
              <p className="mb-1 text-[11px] font-semibold">Area {key.toUpperCase()}</p>
              {area ? (
                <div className="space-y-1">
                  <p className={`font-mono ${muted}`}>
                    {area.centre[1].toFixed(4)}, {area.centre[0].toFixed(4)}
                  </p>
                  <CoverageBar percentages={area.percentages} />
                  <dl className="grid grid-cols-[1fr_auto] gap-x-1">
                    <dt className={muted}>Services</dt>
                    <dd className="text-right tabular-nums">{area.services_in_area}</dd>
                    <dt className={muted}>Per km²</dt>
                    <dd className="text-right tabular-nums">{formatMetric(area.density_per_km2, "per km²")}</dd>
                    <dt className={muted}>Well covered</dt>
                    <dd className="text-right tabular-nums">{area.percentages.well_covered}%</dd>
                    <dt className={muted}>Underserved</dt>
                    <dd className="text-right tabular-nums">{area.percentages.underserved}%</dd>
                    <dt className={muted}>Avg distance</dt>
                    <dd className="text-right tabular-nums">{formatMetric(area.average_distance_m, "m")}</dd>
                  </dl>
                  {(area.truncated || !area.coverage_complete) && (
                    <p className="text-amber-500">Incomplete OSM data</p>
                  )}
                </div>
              ) : (
                <p className="text-red-400">Not analysed: {areas[key].error}</p>
              )}
            </div>
          );
        })}
      </div>

      <ul className={`flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] ${muted}`}>
        {COVERAGE_CLASSES.map(({ key, label, color }) => (
          <li key={key} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />
            {label}
          </li>
        ))}
      </ul>

      {/* Metric by metric */}
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]" aria-label="Metric differences">
          <thead className={muted}>
            <tr className="text-left">
              <th className="py-1 font-medium">Metric</th>
              <th className="py-1 text-right font-medium">A</th>
              <th className="py-1 text-right font-medium">B</th>
              <th className="py-1 text-right font-medium">A − B</th>
              <th className="py-1 text-right font-medium">Better</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => (
              <tr key={metric.key} className={`border-t ${border}`}>
                <td className="py-1 pr-1">
                  {metric.label}
                  <span className={`block ${muted}`}>
                    {metric.higher_is_better ? "higher is better" : "lower is better"}
                    {metric.relative_difference_pct !== null && metric.unit !== "%"
                      ? ` · ${metric.relative_difference_pct > 0 ? "+" : ""}${metric.relative_difference_pct}% rel.`
                      : ""}
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums">{formatMetric(metric.a, metric.unit)}</td>
                <td className="py-1 text-right tabular-nums">{formatMetric(metric.b, metric.unit)}</td>
                <td className="py-1 text-right tabular-nums">{formatDifference(metric)}</td>
                <td className="py-1 text-right">
                  {metric.better === null ? (
                    <span className={muted}>n/a</span>
                  ) : metric.better === "tie" ? (
                    "Equal"
                  ) : (
                    <span style={{ color: AREA_COLORS[metric.better] }} className="font-semibold">
                      {metric.better.toUpperCase()}
                    </span>
                  )}
                  {metric.better !== null && !metric.definitive && (
                    <span className="text-amber-500" title="Indicative: incomplete data"> ~</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={`text-[10px] ${muted}`}>
        No overall winner: each metric is compared on its own. “~” marks indicative results.
      </p>

      <details className="group">
        <summary
          className={`flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] [&::-webkit-details-marker]:hidden ${muted}`}
        >
          <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
          Methodology
        </summary>
        <ul className={`mt-1 list-disc space-y-1 pl-4 text-[10px] leading-4 ${muted}`}>
          {analysis.methodology?.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </details>
    </section>
  );
}
