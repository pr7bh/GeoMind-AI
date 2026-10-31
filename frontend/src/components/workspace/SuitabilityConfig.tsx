import { useState } from "react";
import { ChevronRight, LoaderCircle, RotateCcw, Target } from "lucide-react";
import { isAbortError } from "../../lib/api";
import { getSuitabilityConfig } from "../../lib/suitability";
import type {
  FacilityId,
  Normalization,
  PharmacyDirection,
  SuitabilityConfig as Config,
  SuitabilityOptions,
} from "../../lib/suitability";

interface SuitabilityConfigProps {
  isDark: boolean;
  disabled: boolean;
  hasLocation: boolean;
  onRun: (message: string, options: SuitabilityOptions) => void;
}

interface CriterionState {
  enabled: boolean;
  weight: number;
}

function defaultsFor(config: Config, facility: FacilityId): Record<string, CriterionState> {
  return Object.fromEntries(
    config.facilities[facility].criteria.map((criterion) => [
      criterion.id,
      {
        enabled: criterion.enabled_by_default,
        // Shown as whole numbers; only the ratio matters.
        weight: criterion.enabled_by_default ? Math.round(criterion.default_weight * 100) : 20,
      },
    ]),
  );
}

export default function SuitabilityConfig({ isDark, disabled, hasLocation, onRun }: SuitabilityConfigProps) {
  const muted = isDark ? "text-neutral-400" : "text-gray-500";
  const border = isDark ? "border-white/8" : "border-gray-200";
  const input = `rounded-md border px-1.5 py-1 text-[11px] outline-none focus:border-emerald-500 ${
    isDark ? "border-white/10 bg-black/40 text-white" : "border-gray-200 bg-white text-gray-900"
  }`;

  const [config, setConfig] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [facility, setFacility] = useState<FacilityId>("hospital");
  const [radius, setRadius] = useState(5);
  const [normalization, setNormalization] = useState<Normalization>("saturating");
  const [direction, setDirection] = useState<PharmacyDirection | "">("");
  const [criteria, setCriteria] = useState<Record<string, CriterionState>>({});

  function load() {
    if (config || loading) return;
    setLoading(true);
    setLoadError("");
    getSuitabilityConfig()
      .then((data) => {
        setConfig(data);
        setRadius(data.limits.default_radius_km);
        setCriteria(defaultsFor(data, "hospital"));
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          setLoadError(error instanceof Error ? error.message : "Unable to load settings.");
        }
      })
      .finally(() => setLoading(false));
  }

  function restoreDefaults() {
    if (!config) return;
    setCriteria(defaultsFor(config, facility));
    setRadius(config.limits.default_radius_km);
    setNormalization("saturating");
    setDirection("");
  }

  const definitions = config?.facilities[facility].criteria ?? [];
  const active = definitions.filter((c) => criteria[c.id]?.enabled);
  const total = active.reduce((sum, c) => sum + (criteria[c.id]?.weight ?? 0), 0);
  const maxRadius = config?.limits.max_radius_km ?? 10;

  const problems: string[] = [];
  if (active.some((c) => !Number.isFinite(criteria[c.id].weight) || criteria[c.id].weight < 0)) {
    problems.push("Weights must be zero or more.");
  } else if (total <= 0) {
    problems.push("Enable at least one criterion with a weight above zero.");
  }
  if (!(radius > 0 && radius <= maxRadius)) problems.push(`Radius must be between 0 and ${maxRadius} km.`);
  if (active.some((c) => c.direction_required) && !direction) {
    problems.push("Choose whether closer to or farther from pharmacies is better.");
  }

  function run() {
    if (!config || problems.length > 0) return;
    const weights = Object.fromEntries(active.map((c) => [c.id, criteria[c.id].weight]));
    onRun(`Find suitable locations for a new ${config.facilities[facility].label.toLowerCase()}`, {
      facility,
      radius_km: radius,
      weights,
      normalization,
      ...(direction && active.some((c) => c.direction_required) ? { pharmacy_direction: direction } : {}),
    });
  }

  return (
    <details className="group mt-2" onToggle={(event) => event.currentTarget.open && load()}>
      <summary
        className={`flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium [&::-webkit-details-marker]:hidden ${muted}`}
      >
        <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
        Site suitability settings
      </summary>

      <div className={`mt-2 space-y-2 rounded-lg border p-2.5 text-[11px] ${border}`} aria-label="Site suitability settings">
        {loading && (
          <p className={`flex items-center gap-1.5 ${muted}`}>
            <LoaderCircle size={12} className="animate-spin" /> Loading criteria…
          </p>
        )}
        {loadError && <p className="text-red-400">{loadError}</p>}

        {config && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className={muted}>Facility</span>
                <select
                  aria-label="Facility"
                  value={facility}
                  onChange={(event) => {
                    const next = event.target.value as FacilityId;
                    setFacility(next);
                    setCriteria(defaultsFor(config, next));
                    setDirection("");
                  }}
                  className={input}
                >
                  {(Object.keys(config.facilities) as FacilityId[]).map((key) => (
                    <option key={key} value={key}>
                      {config.facilities[key].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={muted}>Radius (km, max {maxRadius})</span>
                <input
                  aria-label="Study radius in km"
                  type="number"
                  min={0.5}
                  max={maxRadius}
                  step={0.5}
                  value={Number.isFinite(radius) ? radius : ""}
                  onChange={(event) => setRadius(event.target.valueAsNumber)}
                  className={input}
                />
              </label>
            </div>

            <fieldset className="space-y-1.5">
              <legend className={`mb-1 ${muted}`}>Criteria and weights</legend>
              {definitions.map((criterion) => {
                const state = criteria[criterion.id] ?? { enabled: false, weight: 0 };
                const share = state.enabled && total > 0 ? (state.weight / total) * 100 : 0;
                return (
                  <div key={criterion.id} className={`rounded-md border px-2 py-1.5 ${border}`}>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label={`Use ${criterion.name}`}
                        checked={state.enabled}
                        onChange={(event) =>
                          setCriteria((current) => ({
                            ...current,
                            [criterion.id]: { ...state, enabled: event.target.checked },
                          }))
                        }
                        className="accent-emerald-500"
                      />
                      <span className="min-w-0 flex-1 truncate" title={criterion.description}>
                        {criterion.name}
                      </span>
                      <input
                        type="number"
                        aria-label={`Weight for ${criterion.name}`}
                        min={0}
                        step={5}
                        disabled={!state.enabled}
                        value={Number.isFinite(state.weight) ? state.weight : ""}
                        onChange={(event) =>
                          setCriteria((current) => ({
                            ...current,
                            [criterion.id]: { ...state, weight: event.target.valueAsNumber },
                          }))
                        }
                        className={`${input} w-14 text-right disabled:opacity-40`}
                      />
                      <span className={`w-10 text-right tabular-nums ${muted}`} data-testid={`share-${criterion.id}`}>
                        {state.enabled ? `${share.toFixed(0)}%` : "off"}
                      </span>
                    </div>
                    <p className={`mt-0.5 text-[10px] leading-4 ${muted}`}>
                      {criterion.higher_is_better || criterion.direction_required ? "" : "Lower is better · "}
                      {criterion.description}
                    </p>
                    {criterion.direction_required && state.enabled && (
                      <label className="mt-1 flex items-center gap-2">
                        <span className={muted}>Better when</span>
                        <select
                          aria-label="Pharmacy direction"
                          value={direction}
                          onChange={(event) => setDirection(event.target.value as PharmacyDirection | "")}
                          className={input}
                        >
                          <option value="">Choose…</option>
                          <option value="closer">closer to a pharmacy</option>
                          <option value="farther">farther from pharmacies</option>
                        </select>
                      </label>
                    )}
                  </div>
                );
              })}
              <p className={`flex justify-between text-[10px] ${muted}`}>
                <span>{config.constraint.name}: always applied (hard constraint)</span>
                <span className="tabular-nums" data-testid="weight-total">
                  Total {total > 0 ? "100%" : "0%"} (raw {Number.isFinite(total) ? total : "—"})
                </span>
              </p>
            </fieldset>

            <label className="flex items-center gap-2">
              <span className={muted}>Normalisation</span>
              <select
                aria-label="Normalisation"
                value={normalization}
                onChange={(event) => setNormalization(event.target.value as Normalization)}
                className={input}
              >
                <option value="saturating">Saturating (absolute)</option>
                <option value="minmax">Min–max (relative)</option>
              </select>
            </label>

            {problems.length > 0 && (
              <ul className="space-y-0.5 text-amber-500">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
            {!hasLocation && <p className="text-amber-500">Pick an analysis location above first.</p>}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={run}
                disabled={disabled || problems.length > 0 || !hasLocation}
                className="flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-xs font-semibold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Target size={13} /> Run suitability analysis
              </button>
              <button
                type="button"
                onClick={restoreDefaults}
                title="Restore defaults"
                className={`flex min-h-8 items-center gap-1 rounded-lg border px-2 text-[11px] ${border} ${muted}`}
              >
                <RotateCcw size={12} /> Defaults
              </button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
