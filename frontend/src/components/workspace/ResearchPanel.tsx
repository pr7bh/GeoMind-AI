import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, RefObject } from "react";
import type { Feature as GeoJSONFeature } from "geojson";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  LoaderCircle,
  MapPlus,
  Route,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { isAbortError } from "../../lib/api";
import { getAgentStatus, streamAgentChat } from "../../lib/agentClient";
import type {
  AgentResponse,
  AgentStatus,
  AgentStep,
  WorkflowStep,
} from "../../lib/agentClient";
import PickField from "../map/PickField";
import type { MapPicker } from "../map/useMapPicker";
import type { RouteResult } from "../tools/RoutingTool";
import type { GeoMapHandle } from "./GeoMap";
import WorkflowView from "./WorkflowView";
import { AREA_COLORS, COVERAGE_PALETTE } from "../../lib/coverage";

interface NearestFeaturesInput {
  coordinates: [number, number];
  features: Record<string, unknown>[];
}

interface ResearchPanelProps {
  theme: "light" | "dark";
  onClose: () => void;
  mapRef: RefObject<GeoMapHandle | null>;
  picker: MapPicker;
  onLayersChanged: () => void;
  routeStart?: [number, number] | null;
  routeDestination?: [number, number] | null;
  onRouteResult?: (route: RouteResult) => void;
  getNearestFeaturesInput?: () => NearestFeaturesInput | null;
  onNearestFeaturesResult?: (
    origin: [number, number],
    features: GeoJSONFeature[],
  ) => void;
  onNearestFeatureSelect?: (
    origin: [number, number],
    feature: GeoJSONFeature,
    distanceMetres: number,
  ) => void;
}

type TurnStatus = "thinking" | "running" | "completed" | "failed" | "cancelled";

interface Turn {
  id: number;
  question: string;
  status: TurnStatus;
  runningTool: string | null;
  steps: AgentStep[];
  // Multi-step workflow plan, updated from real step events.
  plan: WorkflowStep[] | null;
  response: AgentResponse | null;
  error: string | null;
  addedLayers: number[];
}

const EXAMPLES = [
  "Find hospitals within 5 km",
  "Find hospitals within 5 km and identify which hospitals have the most pharmacies within 1 km",
  "Identify areas within 5 km that are underserved by hospitals",
  "Compare hospital coverage in these two areas",
  "Find schools within 2 km",
  "Which parks are within 1 km, and which is nearest?",
];

const NEAREST_KEYWORDS = ["nearest", "closest", "nearby"];

export default function ResearchPanel({
  theme,
  onClose,
  mapRef,
  picker,
  onLayersChanged,
  routeStart,
  routeDestination,
  onRouteResult,
  getNearestFeaturesInput,
  onNearestFeaturesResult,
  onNearestFeatureSelect,
}: ResearchPanelProps) {
  const isDark = theme === "dark";
  const muted = isDark ? "text-neutral-400" : "text-gray-500";

  const [question, setQuestion] = useState("");
  const [location, setLocation] = useState<[number, number] | null>(null);
  // Second centre for Area A vs Area B comparisons ("location" is Area A).
  const [areaB, setAreaB] = useState<[number, number] | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const busy = turns.some(
    (turn) => turn.status === "thinking" || turn.status === "running",
  );
  const picking = picker.isPicking("agent");

  useEffect(() => {
    const controller = new AbortController();

    getAgentStatus(controller.signal)
      .then(setStatus)
      .catch((error: unknown) => {
        if (!isAbortError(error)) setStatusError("Backend unreachable");
      });

    return () => {
      controller.abort();
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  function updateTurn(id: number, change: (turn: Turn) => Partial<Turn>) {
    setTurns((current) =>
      current.map((turn) => (turn.id === id ? { ...turn, ...change(turn) } : turn)),
    );
  }

  function applyMapSideEffects(response: AgentResponse) {
    const result = response.parameters?.result;

    if (
      response.intent === "route" &&
      result?.geometry?.type === "LineString" &&
      result.geometry.coordinates.length >= 2
    ) {
      onRouteResult?.(result as RouteResult);
    }

    if (response.intent === "nearest_features" && Array.isArray(result?.results)) {
      const origin = result.origin?.coordinates;
      const features = result.results
        .map((item: { feature?: GeoJSONFeature }) => item.feature)
        .filter((feature: GeoJSONFeature | undefined): feature is GeoJSONFeature =>
          Boolean(feature?.geometry),
        );

      if (Array.isArray(origin) && features.length > 0) {
        onNearestFeaturesResult?.([Number(origin[0]), Number(origin[1])], features);
      }
    }
  }

  async function ask(message: string) {
    if (!message || busy) return;

    const id = nextId.current++;
    setTurns((current) => [
      ...current,
      {
        id,
        question: message,
        status: "thinking",
        runningTool: null,
        steps: [],
        plan: null,
        response: null,
        error: null,
        addedLayers: [],
      },
    ]);
    setQuestion("");

    const payload: Record<string, unknown> = { message };
    if (routeStart) payload.start = routeStart;
    if (routeDestination) payload.destination = routeDestination;

    // Visible layer features let the rule-based nearest tool work offline.
    const wantsNearest = NEAREST_KEYWORDS.some((word) =>
      message.toLowerCase().includes(word),
    );
    const nearestInput = wantsNearest ? getNearestFeaturesInput?.() : null;

    if (location) payload.coordinates = location;
    else if (nearestInput) payload.coordinates = nearestInput.coordinates;
    if (areaB) payload.compare_coordinates = areaB;
    if (nearestInput) {
      payload.features = nearestInput.features;
      payload.limit = 5;
    }

    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const response = await streamAgentChat(
        payload,
        (event) => {
          if (event.type === "thinking") {
            updateTurn(id, () => ({ status: "thinking", runningTool: null }));
          } else if (event.type === "tool_started") {
            updateTurn(id, () => ({ status: "running", runningTool: event.tool }));
          } else if (event.type === "tool_finished") {
            updateTurn(id, (turn) => ({
              runningTool: null,
              steps: [...turn.steps, event.step],
            }));
          } else if (event.type === "plan_created") {
            updateTurn(id, () => ({ plan: event.plan }));
          } else if (event.type === "step_started") {
            updateTurn(id, (turn) => {
              const step = turn.plan?.find((item) => item.id === event.step_id);
              return {
                status: "running",
                runningTool: step?.description ?? event.step_id,
                plan: patchStep(turn.plan, event.step_id, { status: "running" }),
              };
            });
          } else if (event.type === "step_completed") {
            updateTurn(id, (turn) => ({
              runningTool: null,
              plan: patchStep(turn.plan, event.step_id, {
                status: "completed",
                summary: event.summary,
                partial: event.partial,
                preview: event.preview,
              }),
            }));
          } else if (event.type === "step_failed") {
            updateTurn(id, (turn) => ({
              runningTool: null,
              plan: patchStep(turn.plan, event.step_id, { status: "failed", error: event.error }),
            }));
          } else if (event.type === "step_skipped") {
            updateTurn(id, (turn) => ({
              plan: patchStep(turn.plan, event.step_id, { status: "skipped", error: event.reason }),
            }));
          }
        },
        controller.signal,
      );

      updateTurn(id, (turn) => ({
        status: response.success ? "completed" : "failed",
        runningTool: null,
        steps: response.steps,
        plan: response.workflow?.plan ?? turn.plan,
        response,
      }));
      applyMapSideEffects(response);
    } catch (error) {
      updateTurn(id, () =>
        isAbortError(error)
          ? { status: "cancelled", runningTool: null }
          : {
              status: "failed",
              runningTool: null,
              error:
                error instanceof Error
                  ? error.message
                  : "Unable to connect to the GeoMind AI backend.",
            },
      );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question.trim());
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void ask(question.trim());
    }
  }

  function addLayer(turn: Turn, index: number) {
    const layer = turn.response?.layers[index];
    const map = mapRef.current;

    if (!layer || !map) return;

    try {
      if (layer.style === "coverage") {
        map.addClassifiedLayer(
          layer.geojson,
          layer.name,
          "coverage_class",
          COVERAGE_PALETTE,
          layer.area ? AREA_COLORS[layer.area] : undefined,
        );
      } else if (layer.kind === "discovery") {
        map.addDiscoveryLayer(layer.geojson, layer.name);
      } else {
        map.addClipResultGeoJSON(JSON.stringify(layer.geojson), layer.name);
      }
      onLayersChanged();
      updateTurn(turn.id, (current) => ({
        addedLayers: [...current.addedLayers, index],
      }));
    } catch (error) {
      updateTurn(turn.id, () => ({
        error: error instanceof Error ? error.message : "Unable to add layer.",
      }));
    }
  }

  const providerLabel = statusError
    ? statusError
    : !status
      ? "Checking AI provider…"
      : status.configured
        ? `${status.provider === "ollama" ? "Ollama" : "Remote LLM"} · ${status.model}`
        : status.error
          ? "AI provider misconfigured"
          : "No LLM configured · direct requests only";

  const card = isDark
    ? "border-white/10 bg-white/[0.03]"
    : "border-gray-200 bg-white/70";

  return (
    <aside
      className={`pointer-events-auto flex h-full w-full flex-col overflow-hidden rounded-2xl border backdrop-blur-2xl transition-colors duration-200 ${
        isDark
          ? "border-white/10 bg-neutral-950/80 text-neutral-100 shadow-[0_8px_32px_rgba(0,0,0,0.35)]"
          : "border-gray-200/70 bg-white/85 text-gray-900 shadow-[0_8px_32px_rgba(15,23,42,0.10)]"
      }`}
    >
      {/* Header */}
      <header
        className={`flex shrink-0 items-center justify-between border-b px-4 py-3 ${
          isDark ? "border-white/10" : "border-gray-200"
        }`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
              isDark
                ? "border-emerald-400/20 bg-emerald-400/8 text-emerald-400"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            <Bot size={21} strokeWidth={1.7} />
            <span
              className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 ${
                isDark ? "border-black" : "border-white"
              } ${busy ? "animate-pulse bg-amber-400" : status?.configured ? "bg-emerald-400" : "bg-neutral-400"}`}
            />
          </div>

          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight">Research Agent</h2>
            <p className={`mt-0.5 truncate text-[11px] ${muted}`} title={status?.error ?? undefined}>
              {providerLabel}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close research panel"
          title="Close panel"
          className={`rounded-lg border p-2 transition-colors ${
            isDark
              ? "border-white/10 text-neutral-500 hover:bg-white/[0.06] hover:text-white"
              : "border-gray-200 text-gray-400 hover:bg-gray-100 hover:text-gray-900"
          }`}
        >
          <X size={16} />
        </button>
      </header>

      {/* Analysis location */}
      <div className={`shrink-0 border-b px-4 py-3 ${isDark ? "border-white/10" : "border-gray-200"}`}>
        <PickField
          isDark={isDark}
          label="Analysis location"
          value={location}
          picking={picking}
          markerClass="bg-amber-500"
          emptyText="Pick a point for location questions"
          onPick={() =>
            picker.pickPoint(
              "agent",
              "location",
              "Click the map to set the agent's analysis location",
              setLocation,
            )
          }
          onCancel={() => picker.cancel("agent")}
          onClear={() => {
            setLocation(null);
            picker.setMarker("agent", "location", null);
          }}
        />
        <button
          type="button"
          onClick={() => {
            picker.cancel("agent");
            const centre = mapRef.current?.getViewCenter();
            if (centre) {
              setLocation(centre);
              picker.setMarker("agent", "location", centre);
            }
          }}
          className="mt-1.5 text-[11px] font-medium text-emerald-500 hover:underline"
        >
          Use current map centre
        </button>
        <details className="group mt-2" open={areaB !== null}>
          <summary
            className={`flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium [&::-webkit-details-marker]:hidden ${muted}`}
          >
            <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
            Compare with a second area
            {areaB && <span className="ml-auto text-violet-400">Area B set</span>}
          </summary>
          <div className="mt-2">
            <p className={`mb-1.5 text-[10px] ${muted}`}>
              For comparisons, the analysis location above is Area A.
            </p>
            <PickField
              isDark={isDark}
              label="Area B"
              value={areaB}
              picking={picker.isPicking("agent", "compare")}
              markerClass="bg-violet-500"
              emptyText="Pick the second study centre"
              onPick={() =>
                picker.pickPoint(
                  "agent",
                  "compare",
                  "Click the map to set Area B for the comparison",
                  setAreaB,
                )
              }
              onCancel={() => picker.cancel("agent")}
              onClear={() => {
                setAreaB(null);
                picker.setMarker("agent", "compare", null);
              }}
            />
          </div>
        </details>
      </div>

      {/* Conversation */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
        aria-live="polite"
      >
        {turns.length === 0 && (
          <section>
            <h3 className="text-base font-semibold tracking-tight">
              Ask a geographic question
            </h3>
            <p className={`mt-1 text-xs leading-5 ${muted}`}>
              Answers come only from real OpenStreetMap data and GeoMind's spatial
              tools. Every tool call is listed with its result.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => void ask(example)}
                  disabled={busy}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs transition-colors disabled:opacity-50 ${card} hover:border-emerald-500/40`}
                >
                  <Sparkles size={13} className="shrink-0 text-emerald-500" />
                  {example}
                </button>
              ))}
            </div>
          </section>
        )}

        {turns.map((turn) => (
          <article key={turn.id} className="space-y-2">
            <p
              className={`ml-8 rounded-2xl rounded-br-md px-3 py-2 text-xs leading-5 ${
                isDark ? "bg-emerald-500/15 text-emerald-50" : "bg-emerald-50 text-emerald-950"
              }`}
            >
              {turn.question}
            </p>

            <div className={`mr-4 rounded-2xl rounded-bl-md border p-3 ${card}`}>
              <TurnStatusLine turn={turn} />

              {turn.response && (
                <p className="mt-2 whitespace-pre-line text-xs leading-5">
                  {turn.response.message}
                </p>
              )}

              {turn.error && (
                <p className="mt-2 flex gap-2 text-xs leading-5 text-red-400">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  {turn.error}
                </p>
              )}

              {turn.response?.needs_input.includes("coordinates") && (
                <p className="mt-2 text-[11px] text-amber-500">
                  Use “Analysis location” above, then ask again.
                </p>
              )}
              {turn.response?.needs_input.includes("compare_coordinates") && (
                <p className="mt-2 text-[11px] text-amber-500">
                  Open “Compare with a second area” above and pick Area B.
                </p>
              )}

              {turn.plan && (
                <WorkflowView
                  isDark={isDark}
                  plan={turn.plan}
                  result={turn.response?.workflow ?? null}
                  cancelled={turn.status === "cancelled"}
                />
              )}

              {!turn.plan && turn.steps.length > 0 && (
                <details className="group mt-3" open={turn.status !== "completed"}>
                  <summary
                    className={`flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] [&::-webkit-details-marker]:hidden ${muted}`}
                  >
                    <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
                    Tool steps ({turn.steps.length})
                  </summary>
                  <ol className="mt-2 space-y-1.5">
                    {turn.steps.map((step, index) => (
                      <li
                        key={index}
                        className={`flex gap-2 rounded-lg border px-2.5 py-2 text-[11px] ${
                          isDark ? "border-white/8" : "border-gray-200"
                        }`}
                      >
                        {step.status === "completed" ? (
                          <CheckCircle2 size={13} className="mt-px shrink-0 text-emerald-500" />
                        ) : (
                          <AlertCircle size={13} className="mt-px shrink-0 text-red-400" />
                        )}
                        <div className="min-w-0">
                          <p className="font-mono font-medium">{step.tool}</p>
                          <p className={muted}>{step.summary}</p>
                          {step.error && <p className="text-red-400">{step.error}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                </details>
              )}

              {turn.response?.layers.map((layer, index) => {
                const added = turn.addedLayers.includes(index);
                return (
                  <button
                    key={index}
                    type="button"
                    onClick={() => addLayer(turn, index)}
                    disabled={added}
                    className={`mt-2 flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs font-medium transition-colors disabled:cursor-default ${
                      added
                        ? "border-emerald-500/30 text-emerald-500"
                        : isDark
                          ? "border-emerald-400/25 text-emerald-400 hover:bg-emerald-400/10"
                          : "border-emerald-500/30 text-emerald-700 hover:bg-emerald-50"
                    }`}
                  >
                    {added ? <CheckCircle2 size={14} /> : <MapPlus size={14} />}
                    <span className="min-w-0 flex-1 truncate">
                      {added ? "Added" : "Add to map"}: {layer.name}
                    </span>
                    <span className={`shrink-0 text-[10px] ${muted}`}>{layer.feature_count}</span>
                  </button>
                );
              })}

              {turn.response?.intent === "route" && turn.response.parameters?.result && (
                <p className={`mt-2 flex items-center gap-1.5 text-[11px] ${muted}`}>
                  <Route size={12} /> Route drawn on the map.
                </p>
              )}

              {turn.response?.intent === "nearest_features" &&
                turn.response.parameters?.result?.results?.map(
                  (
                    item: {
                      feature_index: number;
                      feature?: GeoJSONFeature;
                      distance_metres: number;
                    },
                    index: number,
                  ) => (
                    <button
                      key={`${item.feature_index}-${index}`}
                      type="button"
                      onClick={() => {
                        const origin = turn.response?.parameters?.result?.origin?.coordinates;
                        if (Array.isArray(origin) && item.feature?.geometry) {
                          onNearestFeatureSelect?.(
                            [Number(origin[0]), Number(origin[1])],
                            item.feature,
                            Number(item.distance_metres),
                          );
                        }
                      }}
                      className={`mt-2 flex w-full justify-between rounded-lg border px-2.5 py-2 text-left text-[11px] ${card}`}
                    >
                      <span>
                        {String(
                          item.feature?.properties?.display_name ??
                            item.feature?.properties?.name ??
                            `Feature ${item.feature_index + 1}`,
                        )}
                      </span>
                      <span className={muted}>{(item.distance_metres / 1000).toFixed(2)} km</span>
                    </button>
                  ),
                )}
            </div>
          </article>
        ))}
      </div>

      {/* Composer */}
      <form
        onSubmit={handleSubmit}
        className={`shrink-0 border-t p-3 ${isDark ? "border-white/10" : "border-gray-200"}`}
      >
        <div
          className={`rounded-xl border transition-colors focus-within:border-emerald-500 ${
            isDark ? "border-white/10 bg-black/40" : "border-gray-200 bg-white"
          }`}
        >
          <label htmlFor="research-question" className="sr-only">
            Research question
          </label>
          <textarea
            id="research-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a GIS question… (Enter to send)"
            rows={2}
            maxLength={2000}
            className={`w-full resize-none bg-transparent px-3 py-2.5 text-xs leading-5 outline-none ${
              isDark ? "text-white placeholder:text-neutral-500" : "text-gray-900 placeholder:text-gray-400"
            }`}
          />
          <div className="flex items-center justify-between px-2.5 pb-2">
            <span className={`text-[10px] tabular-nums ${muted}`}>{question.length}/2000</span>
            {busy ? (
              <button
                type="button"
                onClick={() => controllerRef.current?.abort()}
                className={`min-h-8 rounded-lg border px-3 text-xs font-medium ${
                  isDark ? "border-white/10 hover:text-red-300" : "border-gray-200 hover:text-red-600"
                }`}
              >
                Cancel
              </button>
            ) : (
              <button
                type="submit"
                disabled={!question.trim()}
                className="flex min-h-8 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-xs font-semibold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Ask <ChevronRight size={14} />
              </button>
            )}
          </div>
        </div>
      </form>
    </aside>
  );
}

function patchStep(
  plan: WorkflowStep[] | null,
  stepId: string,
  change: Partial<WorkflowStep>,
): WorkflowStep[] | null {
  return plan?.map((step) => (step.id === stepId ? { ...step, ...change } : step)) ?? null;
}

function TurnStatusLine({ turn }: { turn: Turn }) {
  const base = "flex items-center gap-1.5 text-[11px] font-medium";

  switch (turn.status) {
    case "thinking":
      return (
        <p className={`${base} text-amber-500`} role="status">
          <LoaderCircle size={13} className="animate-spin" /> Thinking…
        </p>
      );
    case "running":
      return (
        <p className={`${base} text-sky-500`} role="status">
          <Wrench size={13} className="animate-pulse" /> Running:{" "}
          <span className={turn.plan ? "" : "font-mono"}>{turn.runningTool}</span>…
        </p>
      );
    case "completed": {
      if (turn.response?.workflow?.outcome === "partial") {
        return (
          <p className={`${base} text-amber-500`}>
            <AlertCircle size={13} /> Completed · partial results
          </p>
        );
      }

      const failedSteps = turn.steps.filter((step) => step.status === "failed").length;

      // Never present a run with failed tool steps as a clean success.
      if (failedSteps > 0) {
        return (
          <p className={`${base} text-amber-500`}>
            <AlertCircle size={13} /> Completed · {failedSteps} tool step
            {failedSteps === 1 ? "" : "s"} failed
          </p>
        );
      }

      return (
        <p className={`${base} text-emerald-500`}>
          <CheckCircle2 size={13} /> Completed
          {turn.response?.mode === "llm"
            ? " · LLM"
            : turn.response?.mode === "deterministic"
              ? " · direct (no LLM)"
              : turn.response?.mode === "workflow"
                ? " · workflow (no LLM)"
                : ""}
        </p>
      );
    }
    case "cancelled":
      return (
        <p className={`${base} text-neutral-500`}>
          <CircleSlash size={13} /> Cancelled
        </p>
      );
    default:
      return (
        <p className={`${base} text-red-400`}>
          <AlertCircle size={13} /> Failed
        </p>
      );
  }
}
