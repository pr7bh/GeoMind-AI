import { useState } from "react";
import { AlertTriangle, ChevronRight, Trophy } from "lucide-react";
import type { WorkflowResult } from "../../lib/agentClient";
import { SCORE_BANDS, formatRaw, scoreColor } from "../../lib/suitability";
import type { SuitabilityCandidate, SuitabilityCriterionResult } from "../../lib/suitability";

const TOP_ROWS = 10;

function ScoreBar({ score }: { score: number }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-neutral-500/20">
      <span className="block h-full rounded-full" style={{ width: `${score}%`, backgroundColor: scoreColor(score) }} />
    </span>
  );
}

function Breakdown({
  candidate,
  criteria,
  muted,
}: {
  candidate: SuitabilityCandidate;
  criteria: SuitabilityCriterionResult[];
  muted: string;
}) {
  return (
    <table className="w-full text-[10px]" aria-label={`Score breakdown for ${candidate.id}`}>
      <thead className={muted}>
        <tr className="text-left">
          <th className="py-0.5 font-medium">Criterion</th>
          <th className="py-0.5 text-right font-medium">Value</th>
          <th className="py-0.5 text-right font-medium">Score</th>
          <th className="py-0.5 text-right font-medium">Weight</th>
          <th className="py-0.5 text-right font-medium">Points</th>
        </tr>
      </thead>
      <tbody>
        {criteria
          .filter((c) => candidate.criteria[c.id])
          .map((c) => {
            const part = candidate.criteria[c.id];
            return (
              <tr key={c.id}>
                <td className="py-0.5 pr-1">{c.name}</td>
                <td className="py-0.5 text-right tabular-nums">{formatRaw(part, c.unit)}</td>
                <td className="py-0.5 text-right tabular-nums">{part.normalized ?? "—"}</td>
                <td className="py-0.5 text-right tabular-nums">{(part.weight * 100).toFixed(0)}%</td>
                <td className="py-0.5 text-right tabular-nums">{part.contribution ?? "—"}</td>
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}

export default function SuitabilityView({ isDark, result }: { isDark: boolean; result: WorkflowResult }) {
  const muted = isDark ? "text-neutral-400" : "text-gray-500";
  const border = isDark ? "border-white/8" : "border-gray-200";
  const analysis = result.analysis;
  const data = analysis.suitability!;
  const ranked = data.ranked;
  const top = ranked[0];
  const used = data.criteria.filter((c) => c.status === "used");
  const existing = analysis.data_sources?.existing;

  const [selected, setSelected] = useState<string[]>(ranked.slice(0, 2).map((c) => c.id));
  const pair = selected
    .map((id) => ranked.find((c) => c.id === id))
    .filter((c): c is SuitabilityCandidate => Boolean(c));

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(-2),
    );
  }

  return (
    <section aria-label="Site suitability" className="space-y-3">
      {!data.complete && data.data_quality.length > 0 && (
        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-2.5 py-2 text-[11px] text-amber-500">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <ul className="space-y-0.5">
            {data.data_quality.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Summary */}
      <dl className={`grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-lg border px-2.5 py-2 text-[10px] ${border}`}>
        <dt className={muted}>Facility</dt>
        <dd className="text-right">{data.facility_label}</dd>
        <dt className={muted}>Study radius</dt>
        <dd className="text-right tabular-nums">{data.radius_km} km</dd>
        <dt className={muted}>Candidates</dt>
        <dd className="text-right tabular-nums">
          {data.scored_count} scored{data.unscored_count ? ` · ${data.unscored_count} unscored` : ""}
        </dd>
        <dt className={muted}>Grid</dt>
        <dd className="text-right tabular-nums">{data.cell_size_m} m cells</dd>
        <dt className={muted}>Existing {data.facility_label.toLowerCase()}s</dt>
        <dd className="text-right tabular-nums">{data.existing_count}</dd>
        <dt className={muted}>Normalisation</dt>
        <dd className="text-right">{data.normalization === "minmax" ? "Min–max" : "Saturating"}</dd>
      </dl>

      {top && (
        <div className={`rounded-lg border p-2.5 text-[11px] ${border}`} style={{ borderLeftColor: scoreColor(top.score), borderLeftWidth: 3 }}>
          <p className="flex items-center gap-1.5 font-semibold">
            <Trophy size={13} className="text-emerald-500" /> Highest-scoring analytical candidate
          </p>
          <p className="mt-1">
            <span className="font-mono">{top.id}</span> · {top.lat.toFixed(5)}, {top.lon.toFixed(5)} ·{" "}
            <span className="font-semibold tabular-nums">{top.score}/100</span>
            {top.tied && <span className="text-amber-500"> (tied)</span>}
          </p>
          <p className={`mt-1 text-[10px] ${muted}`}>
            An analytical grid point, not a verified site. Check land availability, zoning and access separately.
          </p>
        </div>
      )}

      {/* Weights */}
      <div>
        <p className={`mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${muted}`}>
          Criteria · weights total {(data.weight_total * 100).toFixed(0)}%
        </p>
        <ul className="space-y-1 text-[11px]">
          {data.criteria.map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={c.description}>
                {c.name}
                {c.status !== "used" && (
                  <span className={c.status === "unavailable" ? " text-amber-500" : ` ${muted}`}>
                    {" "}
                    · {c.status}
                  </span>
                )}
              </span>
              <span className="w-10 text-right tabular-nums">{(c.weight * 100).toFixed(0)}%</span>
            </li>
          ))}
          <li className={`text-[10px] ${muted}`}>{data.constraint.description}</li>
        </ul>
        {data.criteria
          .filter((c) => c.note)
          .map((c) => (
            <p key={c.id} className="mt-1 text-[10px] text-amber-500">
              {c.name}: {c.note}
            </p>
          ))}
      </div>

      <ul className={`flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] ${muted}`} aria-label="Score legend">
        {SCORE_BANDS.map(({ key, label, color }) => (
          <li key={key} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />
            {label}
          </li>
        ))}
      </ul>

      {/* Top candidates */}
      {ranked.length > 0 && (
        <section aria-label="Top candidates">
          <p className={`mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${muted}`}>
            Top {Math.min(TOP_ROWS, ranked.length)} of {ranked.length} · tick two to compare
          </p>
          <ol className="space-y-1">
            {ranked.slice(0, TOP_ROWS).map((candidate) => (
              <li key={candidate.id} className="flex items-start gap-1.5">
                <input
                  type="checkbox"
                  aria-label={`Compare ${candidate.id}`}
                  checked={selected.includes(candidate.id)}
                  onChange={() => toggle(candidate.id)}
                  className="mt-2 accent-emerald-500"
                />
                <details className="group min-w-0 flex-1">
                  <summary
                    className={`flex cursor-pointer list-none items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] [&::-webkit-details-marker]:hidden ${border}`}
                  >
                    <span className="w-6 shrink-0 font-mono text-emerald-500">
                      {candidate.rank}
                      {candidate.tied ? "=" : ""}
                    </span>
                    <span className="w-16 shrink-0 truncate font-mono">{candidate.id}</span>
                    <span className="min-w-0 flex-1">
                      <ScoreBar score={candidate.score ?? 0} />
                    </span>
                    <span className="w-10 shrink-0 text-right font-semibold tabular-nums">{candidate.score}</span>
                  </summary>
                  <div className="ml-2 mt-1 space-y-1">
                    <Breakdown candidate={candidate} criteria={used} muted={muted} />
                    {candidate.strengths && candidate.strengths.length > 0 && (
                      <p className="text-[10px] text-emerald-500">+ {candidate.strengths.join("; ")}</p>
                    )}
                    {candidate.weaknesses && candidate.weaknesses.length > 0 && (
                      <p className="text-[10px] text-red-400">− {candidate.weaknesses.join("; ")}</p>
                    )}
                    <p className={`font-mono text-[10px] ${muted}`}>
                      {candidate.lat.toFixed(5)}, {candidate.lon.toFixed(5)}
                    </p>
                  </div>
                </details>
              </li>
            ))}
          </ol>
          {ranked.length > TOP_ROWS && (
            <p className={`mt-1 text-[10px] ${muted}`}>
              {ranked.length - TOP_ROWS} more candidates are in the map layer properties.
            </p>
          )}
        </section>
      )}

      {/* Side-by-side comparison */}
      {pair.length === 2 && (
        <section aria-label="Candidate comparison" className={`rounded-lg border p-2 ${border}`}>
          <p className={`mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${muted}`}>Compare candidates</p>
          <table className="w-full text-[10px]">
            <thead className={muted}>
              <tr className="text-left">
                <th className="py-0.5 font-medium">Criterion</th>
                {pair.map((c) => (
                  <th key={c.id} className="py-0.5 text-right font-mono font-medium">
                    {c.id}
                  </th>
                ))}
                <th className="py-0.5 text-right font-medium">Δ points</th>
              </tr>
            </thead>
            <tbody>
              {used.map((criterion) => {
                const [a, b] = pair.map((c) => c.criteria[criterion.id]);
                const delta =
                  a && b && a.contribution !== null && b.contribution !== null
                    ? a.contribution - b.contribution
                    : null;
                return (
                  <tr key={criterion.id} className={`border-t ${border}`}>
                    <td className="py-0.5 pr-1">{criterion.name}</td>
                    {[a, b].map((part, index) => (
                      <td key={index} className="py-0.5 text-right tabular-nums">
                        {part ? `${formatRaw(part, criterion.unit)} · ${part.contribution}` : "—"}
                      </td>
                    ))}
                    <td className="py-0.5 text-right tabular-nums">
                      {delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`}
                    </td>
                  </tr>
                );
              })}
              <tr className={`border-t font-semibold ${border}`}>
                <td className="py-0.5">Score</td>
                {pair.map((c) => (
                  <td key={c.id} className="py-0.5 text-right tabular-nums">
                    {c.score}
                  </td>
                ))}
                <td className="py-0.5 text-right tabular-nums">
                  {((pair[0].score ?? 0) - (pair[1].score ?? 0)).toFixed(2)}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {/* Unscored candidates are kept apart, never shown as zero */}
      {data.unscored.length > 0 && (
        <section aria-label="Unscored candidates">
          <p className={`mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${muted}`}>
            Unscored ({data.unscored.length})
          </p>
          <ul className="space-y-1">
            {data.unscored.map((candidate) => (
              <li key={candidate.id} className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${border}`}>
                <span className="font-mono">{candidate.id}</span>
                <span className="block text-amber-500">{candidate.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="group">
        <summary
          className={`flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] [&::-webkit-details-marker]:hidden ${muted}`}
        >
          <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
          Caveats &amp; methodology
        </summary>
        <ul className={`mt-1 list-disc space-y-1 pl-4 text-[10px] leading-4 ${muted}`}>
          {analysis.caveats?.map((line) => <li key={`c-${line}`}>{line}</li>)}
          {analysis.methodology?.map((line) => <li key={line}>{line}</li>)}
          {data.criteria.map((c) => (
            <li key={`d-${c.id}`}>
              {c.name}: {c.description}
            </li>
          ))}
          {existing?.attribution && (
            <li>
              {existing.attribution}
              {existing.osm_base && ` · data as of ${new Date(existing.osm_base).toLocaleDateString()}`}
            </li>
          )}
        </ul>
      </details>
    </section>
  );
}
