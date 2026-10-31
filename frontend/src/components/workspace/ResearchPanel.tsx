import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, RefObject } from "react";
import type { Feature as GeoJSONFeature } from "geojson";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  LayoutList,
  ListChecks,
  LoaderCircle,
  MapPlus,
  Route,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { isAbortError } from "../../lib/api";
import { getAgentStatus, streamAgentChat } from "../../lib/agentClient";
import {
  cancelExecution,
  createSession,
  executeResearch,
  newClientToken,
  planResearch,
  synthesizeExecution,
} from "../../lib/researchClient";
import type {
  ExecutionEvent,
  ResearchPlan,
  ResearchSynthesis,
  SessionDetail,
} from "../../lib/researchClient";
import type {
  AgentLayer,
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
import SuitabilityConfig from "./SuitabilityConfig";
import ResearchPlanView from "./ResearchPlanView";
import ResearchExecutionView from "./ResearchExecutionView";
import ResearchInsightsView from "./ResearchInsightsView";
import ResearchReportControls from "./ResearchReportControls";
import ResearchWorkspace from "./ResearchWorkspace";
import type { ExecutionUIState } from "./ResearchExecutionView";
import { AREA_COLORS, COVERAGE_PALETTE } from "../../lib/coverage";
import { SCORE_PALETTE } from "../../lib/suitability";
import type { SuitabilityOptions } from "../../lib/suitability";

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
  // "plan": research planning only (nothing is executed).
  kind: "ask" | "plan";
  // Research session this turn belongs to (workspace history), if saved.
  sessionId: string | null;
  question: string;
  status: TurnStatus;
  runningTool: string | null;
  steps: AgentStep[];
  // Multi-step workflow plan, updated from real step events.
  plan: WorkflowStep[] | null;
  response: AgentResponse | null;
  researchPlan: ResearchPlan | null;
  // Present once the user approved and started executing the plan.
  execution: ExecutionUIState | null;
  // Evidence-based synthesis of a finished execution (on request).
  insights: {
    loading: boolean;
    data: ResearchSynthesis | null;
    error: string | null;
  } | null;
  error: string | null;
  addedLayers: number[];
  addedResultLayers: string[];
}

const EXAMPLES = [
  "Find hospitals within 5 km",
  "Find hospitals within 5 km and identify which hospitals have the most pharmacies within 1 km",
  "Identify areas within 5 km that are underserved by hospitals",
  "Compare hospital coverage in these two areas",
  "Find suitable locations for a new hospital",
  "Find schools within 2 km",
  "Which parks are within 1 km, and which is nearest?",
];

const NEAREST_KEYWORDS = ["nearest", "closest", "nearby"];
const VIEW_KEY = "geomind-research-view";

function readView(): "conversation" | "workspace" {
  try {
    return localStorage.getItem(VIEW_KEY) === "workspace"
      ? "workspace"
      : "conversation";
  } catch {
    return "conversation";
  }
}

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
  const [view, setView] = useState<"conversation" | "workspace">(readView);
  // Bumped whenever a session changes, so the workspace reloads it.
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
      current.map((turn) =>
        turn.id === id ? { ...turn, ...change(turn) } : turn,
      ),
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

    if (
      response.intent === "nearest_features" &&
      Array.isArray(result?.results)
    ) {
      const origin = result.origin?.coordinates;
      const features = result.results
        .map((item: { feature?: GeoJSONFeature }) => item.feature)
        .filter(
          (feature: GeoJSONFeature | undefined): feature is GeoJSONFeature =>
            Boolean(feature?.geometry),
        );

      if (Array.isArray(origin) && features.length > 0) {
        onNearestFeaturesResult?.(
          [Number(origin[0]), Number(origin[1])],
          features,
        );
      }
    }
  }

  /** Use the current map centre as the analysis location; returns it. */
  function takeMapCentre(): [number, number] | null {
    picker.cancel("agent");
    const centre = mapRef.current?.getViewCenter() ?? null;
    if (centre) {
      setLocation(centre);
      picker.setMarker("agent", "location", centre);
    }
    return centre;
  }

  async function ask(message: string, suitability?: SuitabilityOptions, at?: [number, number] | null) {
    if (!message || busy) return;

    const id = nextId.current++;
    setTurns((current) => [
      ...current,
      {
        id,
        kind: "ask",
        sessionId: null,
        question: message,
        status: "thinking",
        runningTool: null,
        steps: [],
        plan: null,
        response: null,
        researchPlan: null,
        execution: null,
        insights: null,
        error: null,
        addedLayers: [],
        addedResultLayers: [],
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

    const origin = at ?? location;
    if (origin) payload.coordinates = origin;
    else if (nearestInput) payload.coordinates = nearestInput.coordinates;
    if (areaB) payload.compare_coordinates = areaB;
    if (suitability) payload.suitability = suitability;
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
            updateTurn(id, () => ({
              status: "running",
              runningTool: event.tool,
            }));
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
                plan: patchStep(turn.plan, event.step_id, {
                  status: "running",
                }),
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
              plan: patchStep(turn.plan, event.step_id, {
                status: "failed",
                error: event.error,
              }),
            }));
          } else if (event.type === "step_skipped") {
            updateTurn(id, (turn) => ({
              plan: patchStep(turn.plan, event.step_id, {
                status: "skipped",
                error: event.reason,
              }),
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

  function showView(next: "conversation" | "workspace") {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // The view simply isn't remembered.
    }
  }

  /** Research planning: returns a validated plan; never runs a step. */
  async function planQuestion(
    message: string,
    existingSessionId: string | null = null,
  ) {
    if (!message || busy) return;

    const id = nextId.current++;
    setTurns((current) => [
      ...current,
      {
        id,
        kind: "plan",
        sessionId: existingSessionId,
        question: message,
        status: "thinking",
        runningTool: null,
        steps: [],
        plan: null,
        response: null,
        researchPlan: null,
        execution: null,
        insights: null,
        error: null,
        addedLayers: [],
        addedResultLayers: [],
      },
    ]);
    setQuestion("");

    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      // Save the investigation as a session; planning still works if this fails.
      let sessionId = existingSessionId;
      if (!sessionId) {
        sessionId = await createSession(message, newClientToken())
          .then((session) => session.session_id)
          .catch(() => null);
      }
      const researchPlan = await planResearch(
        {
          question: message,
          ...(location ? { coordinates: location } : {}),
          ...(areaB ? { compare_coordinates: areaB } : {}),
          ...(sessionId ? { session_id: sessionId } : {}),
        },
        controller.signal,
      );
      updateTurn(id, () => ({ status: "completed", researchPlan, sessionId }));
      setSessionsVersion((version) => version + 1);
    } catch (error) {
      updateTurn(id, () =>
        isAbortError(error)
          ? { status: "cancelled" }
          : {
              status: "failed",
              error:
                error instanceof Error
                  ? error.message
                  : "Unable to create a research plan.",
            },
      );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  /** Run an approved plan; progress streams into the turn's execution state. */
  async function executePlan(
    turnId: number,
    researchPlan: ResearchPlan,
    sessionId: string | null,
  ) {
    if (busy) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    updateTurn(turnId, () => ({
      status: "running",
      runningTool: null,
      execution: {
        id: null,
        status: "queued",
        steps: {},
        currentStep: null,
        warnings: [],
        errors: [],
        results: [],
        error: null,
      },
    }));

    try {
      const summary = await executeResearch(
        researchPlan,
        (event) =>
          updateTurn(turnId, (turn) => {
            const execution = applyExecutionEvent(turn.execution!, event);
            const title =
              researchPlan.steps.find(
                (step) => step.id === execution.currentStep,
              )?.title ?? null;
            return { execution, runningTool: title };
          }),
        controller.signal,
        sessionId ?? undefined,
      );
      updateTurn(turnId, (turn) => ({
        status: "completed",
        runningTool: null,
        execution: {
          ...turn.execution!,
          status: summary.status,
          currentStep: null,
          steps: Object.fromEntries(
            summary.steps.map(({ id, ...step }) => [id, step]),
          ),
          warnings: summary.warnings,
          errors: summary.errors,
          results: summary.results,
        },
      }));
    } catch (error) {
      updateTurn(turnId, (turn) => ({
        status: "completed",
        runningTool: null,
        execution: {
          ...turn.execution!,
          currentStep: null,
          status: isAbortError(error) ? "cancelled" : "failed",
          error: isAbortError(error)
            ? "The connection was closed; the server stopped the research."
            : error instanceof Error
              ? error.message
              : "The research could not be executed.",
        },
      }));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setSessionsVersion((version) => version + 1);
    }
  }

  /** Continue a saved session in the conversation (optionally running its plan). */
  function resumeSession(session: SessionDetail, execute: boolean) {
    if (!session.plan || busy) return;
    const id = nextId.current++;
    const plan = session.plan;
    setTurns((current) => [
      ...current,
      {
        id,
        kind: "plan",
        sessionId: session.session_id,
        question: session.question,
        status: "completed",
        runningTool: null,
        steps: [],
        plan: null,
        response: null,
        researchPlan: plan,
        execution: null,
        insights: null,
        error: null,
        addedLayers: [],
        addedResultLayers: [],
      },
    ]);
    showView("conversation");
    if (execute) void executePlan(id, plan, session.session_id);
  }

  /** Synthesis reads the execution's retained evidence; nothing is re-run. */
  async function generateInsights(turnId: number, executionId: string) {
    updateTurn(turnId, () => ({
      insights: { loading: true, data: null, error: null },
    }));
    try {
      const data = await synthesizeExecution(executionId);
      updateTurn(turnId, () => ({
        insights: { loading: false, data, error: null },
      }));
      setSessionsVersion((version) => version + 1);
    } catch (error) {
      updateTurn(turnId, () => ({
        insights: {
          loading: false,
          data: null,
          error:
            error instanceof Error
              ? error.message
              : "Unable to generate research insights.",
        },
      }));
    }
  }

  /** Graceful cancel for research (keeps completed results); abort otherwise. */
  function cancelActive() {
    const executing = turns.find(
      (turn) =>
        turn.execution &&
        (turn.execution.status === "running" ||
          turn.execution.status === "queued"),
    );
    const executionId = executing?.execution?.id;
    if (executionId) {
      cancelExecution(executionId).catch(() => controllerRef.current?.abort());
    } else {
      controllerRef.current?.abort();
    }
  }

  function pickLocation() {
    picker.pickPoint(
      "agent",
      "location",
      "Click the map to set the agent's analysis location",
      setLocation,
    );
  }

  function pickAreaB() {
    picker.pickPoint(
      "agent",
      "compare",
      "Click the map to set Area B for the comparison",
      setAreaB,
    );
  }

  function editQuestion(text: string) {
    setQuestion(text);
    textareaRef.current?.focus();
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

  /** Add an analysis layer through the shared layer registry. */
  function addAgentLayer(layer: AgentLayer) {
    const map = mapRef.current;
    if (!map) throw new Error("The map is not ready.");

    if (layer.style === "suitability") {
      map.addClassifiedLayer(
        layer.geojson,
        layer.name,
        "score_band",
        SCORE_PALETTE,
      );
    } else if (layer.style === "coverage") {
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
  }

  function addResultLayer(turnId: number, layer: AgentLayer, key: string) {
    try {
      addAgentLayer(layer);
      updateTurn(turnId, (current) => ({
        addedResultLayers: [...current.addedResultLayers, key],
      }));
    } catch (error) {
      updateTurn(turnId, () => ({
        error: error instanceof Error ? error.message : "Unable to add layer.",
      }));
    }
  }

  function addLayer(turn: Turn, index: number) {
    const layer = turn.response?.layers[index];
    if (!layer) return;

    try {
      addAgentLayer(layer);
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

  const card = `gm-glass-card ${isDark ? "border-white/10" : "border-gray-200"}`;

  return (
    <aside
      className={`pointer-events-auto flex h-full w-full flex-col gm-glass-strong overflow-hidden rounded-2xl border transition-colors duration-200 ${
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
            <h2 className="text-sm font-semibold tracking-tight">
              Research Agent
            </h2>
            <p
              className={`mt-0.5 truncate text-[11px] ${muted}`}
              title={status?.error ?? undefined}
            >
              {providerLabel}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              showView(view === "workspace" ? "conversation" : "workspace")
            }
            aria-label="Research workspace"
            aria-pressed={view === "workspace"}
            title={
              view === "workspace"
                ? "Back to the conversation"
                : "Research workspace and history"
            }
            className={`rounded-lg border p-2 transition-colors ${
              view === "workspace"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
                : isDark
                  ? "border-white/10 text-neutral-500 hover:bg-white/[0.06] hover:text-white"
                  : "border-gray-200 text-gray-400 hover:bg-gray-100 hover:text-gray-900"
            }`}
          >
            <LayoutList size={16} />
          </button>
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
        </div>
      </header>

      {/* Analysis location */}
      <div
        className={`shrink-0 border-b px-4 py-3 ${isDark ? "border-white/10" : "border-gray-200"}`}
      >
        <PickField
          isDark={isDark}
          label="Analysis location"
          value={location}
          picking={picking}
          markerClass="bg-amber-500"
          emptyText="Pick a point for location questions"
          onPick={pickLocation}
          onCancel={() => picker.cancel("agent")}
          onClear={() => {
            setLocation(null);
            picker.setMarker("agent", "location", null);
          }}
        />
        <button
          type="button"
          onClick={() => void takeMapCentre()}
          className="mt-1.5 text-[11px] font-medium text-emerald-500 hover:underline"
        >
          Use current map centre
        </button>
        <details className="group mt-2" open={areaB !== null}>
          <summary
            className={`flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium [&::-webkit-details-marker]:hidden ${muted}`}
          >
            <ChevronRight
              size={12}
              className="transition-transform group-open:rotate-90"
            />
            Compare with a second area
            {areaB && (
              <span className="ml-auto text-violet-400">Area B set</span>
            )}
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
              onPick={pickAreaB}
              onCancel={() => picker.cancel("agent")}
              onClear={() => {
                setAreaB(null);
                picker.setMarker("agent", "compare", null);
              }}
            />
          </div>
        </details>
        <SuitabilityConfig
          isDark={isDark}
          disabled={busy}
          hasLocation={location !== null}
          onRun={(message, options) => void ask(message, options)}
        />
      </div>

      {view === "workspace" && (
        <ResearchWorkspace
          isDark={isDark}
          busy={busy}
          refreshToken={sessionsVersion}
          onNewResearch={() => {
            showView("conversation");
            window.setTimeout(() => textareaRef.current?.focus(), 0);
          }}
          onPickLocation={pickLocation}
          onPickCompare={pickAreaB}
          onEditQuestion={(text) => {
            showView("conversation");
            editQuestion(text);
          }}
          onReplan={(text, sessionId) => {
            showView("conversation");
            void planQuestion(text, sessionId);
          }}
          onExecute={(session) => resumeSession(session, true)}
        />
      )}

      {/* Conversation */}
      <div
        ref={scrollRef}
        className={`min-h-0 flex-1 space-y-4 overflow-y-auto p-4 ${
          view === "workspace" ? "hidden" : ""
        } ${isDark ? "scrollbar-thin-dark" : "scrollbar-thin-light"}`}
        aria-live="polite"
      >
        {turns.length === 0 && (
          <section>
            <h3 className="text-base font-semibold tracking-tight">
              Ask a geographic question
            </h3>
            <p className={`mt-1 text-xs leading-5 ${muted}`}>
              Answers come only from real OpenStreetMap data and GeoMind's
              spatial tools. Every tool call is listed with its result.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  // Examples need a location: fall back to the current map centre.
                  onClick={() => void ask(example, undefined, location ?? takeMapCentre())}
                  disabled={busy}
                  className={`gm-press gm-lift flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs transition-colors disabled:opacity-50 ${card} hover:border-emerald-500/40`}
                >
                  <Sparkles size={13} className="shrink-0 text-emerald-500" />
                  {example}
                </button>
              ))}
            </div>
          </section>
        )}

        {turns.map((turn) => (
          <article key={turn.id} className="gm-fade-up space-y-2">
            <p
              className={`ml-8 rounded-2xl rounded-br-md px-3 py-2 text-xs leading-5 ${
                isDark
                  ? "bg-emerald-500/15 text-emerald-50"
                  : "bg-emerald-50 text-emerald-950"
              }`}
            >
              {turn.question}
            </p>

            <div
              className={`mr-4 rounded-2xl rounded-bl-md border p-3 ${card}`}
            >
              <TurnStatusLine
                key={`${turn.status}:${turn.status === "running" ? turn.runningTool : ""}:${turn.execution?.status ?? ""}`}
                turn={turn}
              />

              {turn.response && (
                <p className="gm-fade-in mt-2 whitespace-pre-line text-xs leading-5">
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
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-amber-500">
                  <span>Use “Analysis location” above, or:</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const centre = takeMapCentre();
                      if (centre) void ask(turn.question, undefined, centre);
                    }}
                    className="gm-press rounded-md border border-amber-500/40 px-2 py-1 font-medium hover:bg-amber-500/10 disabled:opacity-40"
                  >
                    Use map centre and ask again
                  </button>
                </div>
              )}
              {turn.response?.needs_input.includes("facility") && (
                <p className="mt-2 text-[11px] text-amber-500">
                  Or open “Site suitability settings” above and choose a
                  facility.
                </p>
              )}
              {turn.response?.needs_input.includes("compare_coordinates") && (
                <p className="mt-2 text-[11px] text-amber-500">
                  Open “Compare with a second area” above and pick Area B.
                </p>
              )}

              {turn.researchPlan && (
                <ResearchPlanView
                  isDark={isDark}
                  plan={turn.researchPlan}
                  busy={busy}
                  onPickLocation={pickLocation}
                  onPickCompare={pickAreaB}
                  onEditQuestion={editQuestion}
                  onReplan={(text) => void planQuestion(text, turn.sessionId)}
                  onExecute={() =>
                    turn.researchPlan &&
                    void executePlan(turn.id, turn.researchPlan, turn.sessionId)
                  }
                  execution={turn.execution}
                />
              )}

              {turn.researchPlan && turn.execution && (
                <ResearchExecutionView
                  isDark={isDark}
                  execution={turn.execution}
                  totalSteps={turn.researchPlan.steps.length}
                  currentTitle={turn.runningTool}
                  addedLayers={turn.addedResultLayers}
                  onAddLayer={(layer, key) =>
                    addResultLayer(turn.id, layer, key)
                  }
                  onCancel={cancelActive}
                />
              )}

              {turn.execution?.id &&
                !["queued", "running"].includes(turn.execution.status) &&
                !turn.insights?.data && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={turn.insights?.loading}
                      onClick={() =>
                        void generateInsights(turn.id, turn.execution!.id!)
                      }
                      className={`flex min-h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition disabled:opacity-50 ${
                        isDark
                          ? "border-emerald-400/30 text-emerald-400 hover:bg-emerald-400/10"
                          : "border-emerald-500/40 text-emerald-700 hover:bg-emerald-50"
                      }`}
                    >
                      {turn.insights?.loading ? (
                        <LoaderCircle size={13} className="animate-spin" />
                      ) : (
                        <Sparkles size={13} />
                      )}
                      {turn.insights?.loading
                        ? "Analysing evidence…"
                        : "Generate Research Insights"}
                    </button>
                    <span className={`text-[10px] ${muted}`}>
                      Uses these results only; nothing is re-run.
                    </span>
                    {turn.insights?.error && (
                      <p className="flex w-full gap-1.5 text-[11px] text-red-400">
                        <AlertCircle size={13} className="mt-px shrink-0" />{" "}
                        {turn.insights.error}
                      </p>
                    )}
                  </div>
                )}

              {turn.insights?.data && (
                <ResearchInsightsView
                  isDark={isDark}
                  synthesis={turn.insights.data}
                />
              )}

              {turn.insights?.data && turn.execution?.id && (
                <ResearchReportControls
                  isDark={isDark}
                  executionId={turn.execution.id}
                  available={
                    !["failed", "insufficient_evidence"].includes(
                      turn.insights.data.overall_status,
                    )
                  }
                  onGenerated={() =>
                    setSessionsVersion((version) => version + 1)
                  }
                />
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
                <details
                  className="group mt-3"
                  open={turn.status !== "completed"}
                >
                  <summary
                    className={`flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] [&::-webkit-details-marker]:hidden ${muted}`}
                  >
                    <ChevronRight
                      size={12}
                      className="transition-transform group-open:rotate-90"
                    />
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
                          <CheckCircle2
                            size={13}
                            className="mt-px shrink-0 text-emerald-500"
                          />
                        ) : (
                          <AlertCircle
                            size={13}
                            className="mt-px shrink-0 text-red-400"
                          />
                        )}
                        <div className="min-w-0">
                          <p className="font-mono font-medium">{step.tool}</p>
                          <p className={muted}>{step.summary}</p>
                          {step.error && (
                            <p className="text-red-400">{step.error}</p>
                          )}
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
                    className={`gm-press mt-2 flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs font-medium transition-colors disabled:cursor-default ${
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
                    <span className={`shrink-0 text-[10px] ${muted}`}>
                      {layer.feature_count}
                    </span>
                  </button>
                );
              })}

              {turn.response?.intent === "route" &&
                turn.response.parameters?.result && (
                  <p
                    className={`mt-2 flex items-center gap-1.5 text-[11px] ${muted}`}
                  >
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
                        const origin =
                          turn.response?.parameters?.result?.origin
                            ?.coordinates;
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
                      <span className={muted}>
                        {(item.distance_metres / 1000).toFixed(2)} km
                      </span>
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
        className={`shrink-0 border-t p-3 ${isDark ? "border-white/10" : "border-gray-200"} ${view === "workspace" ? "hidden" : ""}`}
      >
        <div
          className={`gm-focus-glow gm-glass-field rounded-xl border transition-colors focus-within:border-emerald-500 ${
            isDark ? "border-white/10 bg-black/40" : "border-gray-200 bg-white"
          }`}
        >
          <label htmlFor="research-question" className="sr-only">
            Research question
          </label>
          <textarea
            ref={textareaRef}
            id="research-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a GIS question… (Enter to send)"
            rows={2}
            maxLength={2000}
            className={`w-full resize-none bg-transparent px-3 py-2.5 text-xs leading-5 outline-none ${
              isDark
                ? "text-white placeholder:text-neutral-500"
                : "text-gray-900 placeholder:text-gray-400"
            }`}
          />
          <div className="flex items-center justify-between px-2.5 pb-2">
            <span className={`text-[10px] tabular-nums ${muted}`}>
              {question.length}/2000
            </span>
            {busy ? (
              <button
                type="button"
                onClick={cancelActive}
                className={`gm-press gm-fade-in min-h-8 rounded-lg border px-3 text-xs font-medium ${
                  isDark
                    ? "border-white/10 hover:text-red-300"
                    : "border-gray-200 hover:text-red-600"
                }`}
              >
                Cancel
              </button>
            ) : (
              <div className="gm-fade-in flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void planQuestion(question.trim())}
                  disabled={!question.trim()}
                  title="Create a research plan without running anything"
                  className={`gm-press flex min-h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    isDark
                      ? "border-emerald-400/30 text-emerald-400 hover:bg-emerald-400/10"
                      : "border-emerald-500/40 text-emerald-700 hover:bg-emerald-50"
                  }`}
                >
                  <ListChecks size={14} /> Plan Research
                </button>
                <button
                  type="submit"
                  disabled={!question.trim()}
                  className="gm-press flex min-h-8 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-xs font-semibold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Ask <ChevronRight size={14} />
                </button>
              </div>
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
  return (
    plan?.map((step) => (step.id === stepId ? { ...step, ...change } : step)) ??
    null
  );
}

function TurnStatusLine({ turn }: { turn: Turn }) {
  const base = "gm-fade-in flex items-center gap-1.5 text-[11px] font-medium";

  switch (turn.status) {
    case "thinking":
      return (
        <p className={`${base} text-amber-500`} role="status">
          <span className="gm-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>{" "}
          {turn.kind === "plan" ? "Planning research…" : "Thinking…"}
        </p>
      );
    case "running":
      return (
        <p className={`${base} text-sky-500`} role="status">
          <Wrench size={13} className="animate-pulse" /> Running:{" "}
          <span className={turn.plan ? "" : "font-mono"}>
            {turn.runningTool}
          </span>
          …
        </p>
      );
    case "completed": {
      if (turn.kind === "plan" && turn.execution) {
        const failed = turn.execution.status === "failed";
        const cancelled = turn.execution.status === "cancelled";
        const clean = turn.execution.status === "completed";
        return (
          <p
            className={`${base} ${failed ? "gm-nudge text-red-400" : cancelled ? "text-neutral-500" : clean ? "text-emerald-500" : "text-amber-500"}`}
          >
            {failed ? (
              <AlertCircle size={13} />
            ) : cancelled ? (
              <CircleSlash size={13} />
            ) : (
              <CheckCircle2 size={13} className="gm-pop" />
            )}
            {failed
              ? "Research execution failed"
              : cancelled
                ? "Research cancelled · completed steps kept"
                : clean
                  ? "Research executed"
                  : "Research executed · partial results or warnings"}
          </p>
        );
      }

      if (turn.kind === "plan") {
        return (
          <p className={`${base} text-emerald-500`}>
            <ListChecks size={13} /> Research plan created · not executed
          </p>
        );
      }

      if (turn.response?.workflow?.outcome === "partial") {
        return (
          <p className={`${base} text-amber-500`}>
            <AlertCircle size={13} /> Completed · partial results
          </p>
        );
      }

      const failedSteps = turn.steps.filter(
        (step) => step.status === "failed",
      ).length;

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
          <CheckCircle2 size={13} className="gm-pop" /> Completed
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
        <p className={`${base} gm-nudge text-red-400`}>
          <AlertCircle size={13} /> Failed
        </p>
      );
  }
}

function applyExecutionEvent(
  state: ExecutionUIState,
  event: ExecutionEvent,
): ExecutionUIState {
  const next: ExecutionUIState = {
    ...state,
    id: event.execution_id,
    steps: { ...state.steps },
  };
  const patch = (
    stepId: string,
    change: Partial<ExecutionUIState["steps"][string]>,
  ) => {
    const current = next.steps[stepId] ?? {
      status: "pending",
      summary: "",
      error: null,
      reused_from: null,
    };
    next.steps[stepId] = { ...current, ...change };
  };

  switch (event.type) {
    case "execution_started":
      next.status = "running";
      event.steps.forEach(({ id, ...step }) => patch(id, step));
      break;
    case "step_started":
      next.currentStep = event.step_id;
      patch(event.step_id, { status: "running" });
      break;
    case "step_completed":
    case "step_partial":
      patch(event.step_id, {
        status: event.type === "step_partial" ? "partial" : "completed",
        summary: event.summary,
        reused_from: event.reused_from,
      });
      if (event.warning) next.warnings = [...next.warnings, event.warning];
      break;
    case "step_failed":
      patch(event.step_id, { status: "failed", error: event.error });
      break;
    case "step_blocked":
    case "step_skipped":
      patch(event.step_id, {
        status: event.type === "step_blocked" ? "blocked" : "skipped",
        error: event.reason,
      });
      break;
    default:
      next.status = event.status;
      next.currentStep = null;
  }
  return next;
}
