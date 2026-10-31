import type { ReactNode } from "react";
import { AlertTriangle, ChevronRight, FileSearch, Lightbulb, ShieldQuestion } from "lucide-react";
import type { EvidenceItem, KeyFinding, ResearchSynthesis } from "../../lib/researchClient";
import { CountUp } from "../../lib/motion";

/** Decimals of the final value, so counting never shows extra digits. */
function sameDecimals(final: number) {
  const decimals = (String(final).split(".")[1] ?? "").length;
  return (value: number) => Number(value.toFixed(decimals));
}

function AnimatedMetric({ value, unit }: { value: number | null; unit: string }) {
  const round = value === null ? (v: number) => v : sameDecimals(value);
  return <CountUp value={value} format={(v) => formatMetric(v === null ? null : round(v), unit)} />;
}

interface ResearchInsightsViewProps {
  isDark: boolean;
  synthesis: ResearchSynthesis;
}

const STATUS: Record<ResearchSynthesis["overall_status"], { label: string; className: string }> = {
  complete: { label: "Complete evidence", className: "border-emerald-500/40 text-emerald-500" },
  partial: { label: "Partial evidence", className: "border-amber-500/40 text-amber-500" },
  insufficient_evidence: { label: "Insufficient evidence", className: "border-neutral-500/40 text-neutral-400" },
  failed: { label: "No results to analyse", className: "border-red-500/40 text-red-400" },
};

const COVERAGE_CLASS: Record<string, string> = {
  well_covered: "text-emerald-500",
  moderate: "text-amber-500",
  underserved: "text-red-400",
  no_service_found: "text-neutral-400",
};

function formatValue(item: EvidenceItem) {
  const value = item.observed_value;
  if (value === null) return "missing";
  if (typeof value === "string") return value;
  if (item.unit === "m") return `${(value / 1000).toFixed(2)} km`;
  if (item.unit === "%") return `${value}%`;
  if (item.unit === "weight") return `${(value * 100).toFixed(0)}%`;
  return `${value}${item.unit && item.unit !== "count" ? ` ${item.unit}` : ""}`;
}

function formatMetric(value: number | null, unit: string) {
  if (value === null) return "missing";
  if (unit === "m") return `${(value / 1000).toFixed(2)} km`;
  if (unit === "%") return `${value}%`;
  if (unit === "per km²") return value.toFixed(3);
  return String(value);
}

function SectionTitle({ children, muted }: { children: ReactNode; muted: string }) {
  return <p className={`mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${muted}`}>{children}</p>;
}

function Finding({ finding, evidence, isDark }: { finding: KeyFinding; evidence: Map<string, EvidenceItem>; isDark: boolean }) {
  const muted = isDark ? "text-neutral-400" : "text-gray-500";
  const border = isDark ? "border-white/8" : "border-gray-200";
  return (
    <li className={`gm-glass-card rounded-lg border px-2.5 py-2 text-[11px] ${border}`} data-finding={finding.finding_id}>
      <p className={`text-[10px] font-semibold uppercase tracking-[0.08em] ${muted}`}>
        {finding.title}
        {finding.source === "llm" && <span className="ml-1.5 normal-case tracking-normal text-sky-500">AI-written, evidence-checked</span>}
      </p>
      <p className="mt-0.5 font-medium leading-5">{finding.conclusion}</p>
      {finding.explanation && <p className={`mt-1 leading-4 ${muted}`}>{finding.explanation}</p>}
      {finding.caveats.map((caveat) => (
        <p key={caveat} className="mt-1 text-[10px] leading-4 text-amber-500">
          {caveat}
        </p>
      ))}
      <details className="gm-details group mt-1.5">
        <summary
          className={`flex cursor-pointer list-none items-center gap-1 text-[10px] font-medium [&::-webkit-details-marker]:hidden ${muted}`}
        >
          <ChevronRight size={11} className="transition-transform group-open:rotate-90" />
          Evidence ({finding.evidence_ids.length}) · {finding.quality}
        </summary>
        <ul className="mt-1 space-y-1" aria-label={`Evidence for ${finding.title}`}>
          {finding.evidence_ids.map((id) => {
            const item = evidence.get(id);
            if (!item) return null;
            return (
              <li key={id} className={`rounded-md border px-2 py-1 text-[10px] ${border}`}>
                <span className="flex justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">{item.title}</span>
                  <span className="shrink-0 tabular-nums">{formatValue(item)}</span>
                </span>
                <span className={`block ${muted}`}>
                  {item.kind} · {item.geographic_scope}
                  {item.source_step_id && <> · step <span className="font-mono">{item.source_step_id}</span></>}
                  {item.partial_or_truncated && <span className="text-amber-500"> · incomplete</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </details>
    </li>
  );
}

export default function ResearchInsightsView({ isDark, synthesis }: ResearchInsightsViewProps) {
  const muted = isDark ? "text-neutral-400" : "text-gray-500";
  const border = isDark ? "border-white/8" : "border-gray-200";
  const evidence = new Map(synthesis.evidence.map((item) => [item.evidence_id, item]));
  const status = STATUS[synthesis.overall_status];

  return (
    <section aria-label="Research insights" className={`gm-fade-up mt-3 space-y-3 border-t pt-3 ${border}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <FileSearch size={14} className="text-emerald-500" />
        <span className="text-xs font-semibold">Research insights</span>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${status.className}`}>{status.label}</span>
        <span className={`rounded-md border px-1.5 py-px text-[10px] ${border}`}>
          {synthesis.synthesis_mode === "llm_assisted" ? "AI-assisted, evidence-checked" : "Deterministic"}
        </span>
        <span className={`ml-auto text-[10px] ${muted}`}><CountUp value={synthesis.evidence.length} format={(v) => String(Math.round(v ?? 0))} /> evidence items</span>
      </div>

      <p className="text-xs leading-5">{synthesis.executive_summary}</p>

      {synthesis.data_quality_warnings.length > 0 && (
        <ul
          aria-label="Data-quality warnings"
          className="gm-fade-down space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/8 px-2.5 py-2 text-[11px] text-amber-500"
        >
          {synthesis.data_quality_warnings.map((line) => (
            <li key={line} className="flex gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {line}
            </li>
          ))}
        </ul>
      )}

      {synthesis.key_findings.length > 0 && (
        <div>
          <SectionTitle muted={muted}>Key findings</SectionTitle>
          <ol className="gm-stagger space-y-1.5" aria-label="Key findings">
            {synthesis.key_findings.map((finding) => (
              <Finding key={finding.finding_id} finding={finding} evidence={evidence} isDark={isDark} />
            ))}
          </ol>
        </div>
      )}

      {synthesis.comparisons.length > 0 && (
        <div className="overflow-x-auto">
          <SectionTitle muted={muted}>Area A vs Area B · metric by metric</SectionTitle>
          <table className="w-full text-[10px]" aria-label="Evidence comparisons">
            <thead className={muted}>
              <tr className="text-left">
                <th className="py-1 font-medium">Metric</th>
                <th className="py-1 text-right font-medium">A</th>
                <th className="py-1 text-right font-medium">B</th>
                <th className="py-1 text-right font-medium">Better</th>
              </tr>
            </thead>
            <tbody className="gm-stagger">
              {synthesis.comparisons.map((row) => (
                <tr key={row.comparison_id} className={`border-t ${border}`} title={row.note}>
                  <td className="py-1 pr-1">
                    {row.metric}
                    <span className={`block ${row.comparable ? muted : "text-amber-500"}`}>{row.note}</span>
                  </td>
                  <td className="py-1 text-right tabular-nums"><AnimatedMetric value={row.a_value} unit={row.unit} /></td>
                  <td className="py-1 text-right tabular-nums"><AnimatedMetric value={row.b_value} unit={row.unit} /></td>
                  <td className="py-1 text-right font-semibold">
                    {row.better === null ? <span className={muted}>n/a</span> : row.better === "tie" ? "Equal" : row.better.toUpperCase()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={`mt-1 text-[10px] ${muted}`}>No overall winner is declared; each metric stands on its own.</p>
        </div>
      )}

      {synthesis.candidate_insights.length > 0 && (
        <div>
          <SectionTitle muted={muted}>Top analytical candidates</SectionTitle>
          <ol className="gm-stagger space-y-1" aria-label="Candidate insights">
            {synthesis.candidate_insights.map((candidate) => (
              <li key={candidate.candidate_id} className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${border}`}>
                <span className="flex items-center gap-2">
                  <span className="w-6 font-mono text-emerald-500">
                    {candidate.rank}
                    {candidate.tied ? "=" : ""}
                  </span>
                  <span className="font-mono">{candidate.candidate_id}</span>
                  {candidate.coverage_class && (
                    <span className={`text-[10px] ${COVERAGE_CLASS[candidate.coverage_class] ?? muted}`}>
                      in {candidate.coverage_class.replace(/_/g, " ")} cell
                    </span>
                  )}
                  <span className="ml-auto font-semibold tabular-nums"><CountUp value={candidate.score} format={(v) => String(sameDecimals(candidate.score)(v ?? 0))} /></span>
                </span>
                <span className={`block text-[10px] ${muted}`}>{candidate.explanation}</span>
              </li>
            ))}
          </ol>
          <p className="mt-1 text-[10px] text-amber-500">{synthesis.candidate_insights[0].caveat}</p>
        </div>
      )}

      {synthesis.unsupported_questions.length > 0 && (
        <div className={`rounded-lg border px-2.5 py-2 text-[11px] ${border}`} aria-label="Not analysed">
          <p className="mb-1 flex items-center gap-1.5 font-medium">
            <ShieldQuestion size={12} className={muted} /> Not analysed
          </p>
          <ul className={`space-y-0.5 ${muted}`}>
            {synthesis.unsupported_questions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {synthesis.recommendations.length > 0 && (
        <div>
          <SectionTitle muted={muted}>Next steps</SectionTitle>
          <ul className="gm-stagger space-y-1 text-[11px]" aria-label="Recommendations">
            {synthesis.recommendations.map((item) => (
              <li key={item.text} className="flex gap-1.5">
                <Lightbulb size={12} className="mt-0.5 shrink-0 text-emerald-500" /> {item.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="gm-details group">
        <summary
          className={`flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] [&::-webkit-details-marker]:hidden ${muted}`}
        >
          <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
          Limitations, assumptions &amp; methodology
        </summary>
        <ul className={`mt-1 list-disc space-y-1 pl-4 text-[10px] leading-4 ${muted}`}>
          {[...synthesis.limitations, ...synthesis.assumptions, ...synthesis.methodology].map((line) => (
            <li key={line}>{line}</li>
          ))}
          {synthesis.rejected_llm_claims > 0 && (
            <li className="text-amber-500">
              {synthesis.rejected_llm_claims} AI-written statement(s) were dropped because the evidence did not support them.
            </li>
          )}
        </ul>
      </details>
    </section>
  );
}
