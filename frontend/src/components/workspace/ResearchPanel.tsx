import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Bot,
  X,
  Workflow,
  Database,
  FlaskConical,
  ShieldCheck,
  Sparkles,
  ChevronRight,
  Activity,
  Command,
  Microscope,
  CheckCircle2,
  LoaderCircle,
  AlertCircle,
  Route,
} from "lucide-react";

interface RouteResult {
  geometry: {
    type: "LineString";
    coordinates: number[][];
  };
  distance_meters: number;
  distance_km: number;
  estimated_duration_minutes: number;
  route_type: string;
}

interface AgentResponse {
  success: boolean;
  intent: string;
  message: string;
  tool?: string | null;
  parameters: Record<string, any>;
  needs_input: string[];
}

interface ResearchPanelProps {
  theme: "light" | "dark";
  onClose: () => void;
  routeStart?: [number, number] | null;
  routeDestination?: [number, number] | null;
  onRouteResult?: (route: RouteResult) => void;
  getNearestFeaturesInput?: () => NearestFeaturesInput | null;
  onNearestFeaturesResult?: (
    origin: [number, number],
    features: import("geojson").Feature[],
  ) => void;
  onNearestFeatureSelect?: (
    origin: [number, number],
    feature: import("geojson").Feature,
    distanceMetres: number,
  ) => void;
}

interface NearestFeaturesInput {
  coordinates: [number, number];
  features: Record<string, unknown>[];
}

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000"
).replace(/\/+$/, "");

export default function ResearchPanel({
  theme,
  onClose,
  routeStart,
  routeDestination,
  onRouteResult,
  getNearestFeaturesInput,
  onNearestFeaturesResult,
  onNearestFeatureSelect,
}: ResearchPanelProps) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<AgentResponse | null>(null);
  const [error, setError] = useState("");

  const isDark = theme === "dark";

  const muted = isDark ? "text-neutral-400" : "text-gray-500";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const message = question.trim();

    if (!message || loading) return;

    setLoading(true);
    setError("");
    setResponse(null);

    try {
      const payload: {
        message: string;
        start?: [number, number];
        destination?: [number, number];
        coordinates?: [number, number];
        features?: Record<string, unknown>[];
        limit?: number;
      } = { message };

      // Include route coordinates when available from the parent.
      if (routeStart) payload.start = routeStart;
      if (routeDestination) payload.destination = routeDestination;

      // Include loaded GeoJSON data for nearest-features queries.
      const normalizedMessage = message.toLowerCase();

      const isNearestFeaturesQuery = ["nearest", "closest", "nearby"].some(
        (keyword) => normalizedMessage.includes(keyword),
      );

      if (isNearestFeaturesQuery) {
        const nearestInput = getNearestFeaturesInput?.();

        if (!nearestInput) {
          throw new Error(
            "No visible GeoJSON features found. Import a GeoJSON layer and make sure it is visible.",
          );
        }

        payload.coordinates = nearestInput.coordinates;
        payload.features = nearestInput.features;
        payload.limit = 5;
      }

      const result = await fetch(`${API_BASE_URL}/api/agent/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await result.json();

      if (!result.ok) {
        throw new Error(
          typeof data.detail === "string"
            ? data.detail
            : "The research request could not be completed.",
        );
      }

      const agentResponse = data as AgentResponse;
      setResponse(agentResponse);
      if (
        agentResponse.success &&
        agentResponse.intent === "nearest_features"
      ) {
        const nearestResult = agentResponse.parameters?.result;
        const origin = nearestResult?.origin?.coordinates;
        const results = nearestResult?.results;

        if (
          Array.isArray(origin) &&
          origin.length >= 2 &&
          Array.isArray(results)
        ) {
          const features = results
            .map(
              (item: { feature?: import("geojson").Feature }) => item.feature,
            )
            .filter(
              (
                feature: import("geojson").Feature | undefined,
              ): feature is import("geojson").Feature =>
                Boolean(feature?.geometry),
            );

          if (features.length > 0) {
            onNearestFeaturesResult?.(
              [Number(origin[0]), Number(origin[1])],
              features,
            );
          }
        }
      }

      // Automatically draw a successful route on the map.
      const route = agentResponse.parameters?.result as RouteResult | undefined;

      if (
        agentResponse.success &&
        agentResponse.intent === "route" &&
        route?.geometry?.type === "LineString" &&
        route.geometry.coordinates.length >= 2
      ) {
        onRouteResult?.(route);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to connect to the GeoMind AI backend.",
      );
    } finally {
      setLoading(false);
    }
  }

  const isRouteResult =
    response?.intent === "route" &&
    Boolean(response.parameters?.result?.geometry);

  const pipelineStatus = loading
    ? "RUNNING"
    : error
      ? "FAILED"
      : response
        ? response.success
          ? "COMPLETE"
          : "FAILED"
        : "IDLE";

  return (
    <aside
      className={`flex h-full w-90 max-w-full shrink-0 flex-col border-l transition-colors duration-200 ${
        isDark
          ? "border-neutral-800 bg-black text-neutral-100"
          : "border-gray-200 bg-white text-gray-900"
      }`}
    >
      {/* Header */}
      <header
        className={`flex h-16.25 shrink-0 items-center justify-between border-b px-4 ${
          isDark ? "border-neutral-800" : "border-gray-200"
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`relative flex h-10 w-10 items-center justify-center rounded-xl border ${
              isDark
                ? "border-emerald-400/20 bg-emerald-400/8 text-emerald-400"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            <Bot size={21} strokeWidth={1.7} />
            <span
              className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 ${
                isDark ? "border-black" : "border-white"
              } ${loading ? "animate-pulse bg-amber-400" : "bg-emerald-400"}`}
            />
          </div>

          <div>
            <h2 className="text-sm font-semibold tracking-tight">
              Research Agent
            </h2>
            <p className={`mt-0.5 text-[11px] ${muted}`}>
              Geospatial intelligence console
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
              ? "border-neutral-800 text-neutral-500 hover:bg-neutral-900 hover:text-white"
              : "border-gray-200 text-gray-400 hover:bg-gray-100 hover:text-gray-900"
          }`}
        >
          <X size={16} />
        </button>
      </header>

      {/* Scrollable research area */}
      <div
        className={`flex-1 space-y-5 overflow-y-auto p-4 scrollbar-thin ${
          isDark
            ? "[scrollbar-color:rgba(52,211,153,0.3)_transparent]"
            : "[scrollbar-color:rgba(5,150,105,0.3)_transparent]"
        } [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full ${
          isDark
            ? "[&::-webkit-scrollbar-thumb]:bg-emerald-400/25"
            : "[&::-webkit-scrollbar-thumb]:bg-emerald-600/25"
        }`}
      >
        {/* Intro */}
        <section>
          <div className="mb-3 flex items-center gap-2">
            <span
              className={`rounded-md border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.15em] ${
                isDark
                  ? "border-emerald-400/20 bg-emerald-400/6 text-emerald-400"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }`}
            >
              Research environment
            </span>
          </div>

          <h3 className="text-xl font-semibold leading-7 tracking-tight">
            Investigate your
            <span className="block text-emerald-500">geographic data.</span>
          </h3>

          <p className={`mt-2 text-xs leading-5 ${muted}`}>
            Describe a spatial problem. GeoMind AI identifies the operation,
            executes connected GIS tools, and returns traceable results.
          </p>
        </section>

        {/* Execution pipeline */}
        <section
          className={`overflow-hidden rounded-xl border ${
            isDark
              ? "border-neutral-800 bg-neutral-950/70"
              : "border-gray-200 bg-white"
          }`}
        >
          <div
            className={`flex items-center justify-between border-b px-3 py-3 ${
              isDark ? "border-neutral-800" : "border-gray-100"
            }`}
          >
            <div className="flex items-center gap-2">
              <Workflow size={15} className="text-emerald-500" />
              <h4 className="text-xs font-semibold">Execution pipeline</h4>
            </div>

            <span
              className={`rounded-md px-2 py-1 text-[9px] font-medium ${
                loading
                  ? "bg-amber-500/10 text-amber-500"
                  : error || response?.success === false
                    ? "bg-red-500/10 text-red-500"
                    : response
                      ? "bg-emerald-500/10 text-emerald-500"
                      : isDark
                        ? "bg-neutral-900 text-neutral-500"
                        : "bg-gray-100 text-gray-500"
              }`}
            >
              {pipelineStatus}
            </span>
          </div>

          <div className="p-3">
            <TraceItem
              icon={
                loading ? (
                  <LoaderCircle size={15} className="animate-spin" />
                ) : (
                  <Bot size={15} />
                )
              }
              number="01"
              title="Interpret query"
              description={
                loading
                  ? "Processing research question..."
                  : response
                    ? `Detected intent: ${response.intent.replace("_", " ")}`
                    : "Awaiting research question"
              }
              theme={theme}
              last={false}
              active={loading}
              complete={Boolean(response)}
            />

            <TraceItem
              icon={<Database size={15} />}
              number="02"
              title="Validate inputs"
              description={
                response?.needs_input?.length
                  ? `Missing: ${response.needs_input.join(", ")}`
                  : response
                    ? "Request processed by backend"
                    : "Waiting for query"
              }
              theme={theme}
              last={false}
              complete={Boolean(response && !response.needs_input?.length)}
            />

            <TraceItem
              icon={<FlaskConical size={15} />}
              number="03"
              title="Execute analysis"
              description={
                loading
                  ? "Waiting for tool execution..."
                  : isRouteResult
                    ? "Driving route calculated"
                    : response?.tool
                      ? response.message
                      : "Spatial tool execution"
              }
              theme={theme}
              last={true}
              active={loading}
              complete={Boolean(isRouteResult)}
            />
          </div>
        </section>

        {/* Error state */}
        {error && (
          <section className="rounded-xl border border-red-500/30 bg-red-500/5 p-3">
            <div className="flex items-start gap-2">
              <AlertCircle size={17} className="mt-0.5 shrink-0 text-red-500" />
              <div>
                <h4 className="text-xs font-semibold text-red-500">
                  Request failed
                </h4>
                <p className={`mt-1 text-xs leading-5 ${muted}`}>{error}</p>
              </div>
            </div>
          </section>
        )}

        {/* Agent response */}
        {response && (
          <section
            className={`rounded-xl border p-3 ${
              response.success
                ? isDark
                  ? "border-emerald-400/20 bg-emerald-400/5"
                  : "border-emerald-200 bg-emerald-50/70"
                : "border-red-500/30 bg-red-500/5"
            }`}
          >
            <div className="mb-2 flex items-center gap-2">
              {response.success ? (
                <CheckCircle2 size={16} className="shrink-0 text-emerald-500" />
              ) : (
                <AlertCircle size={16} className="shrink-0 text-red-500" />
              )}

              <h4 className="text-xs font-semibold">Research result</h4>
            </div>

            <p className={`text-xs leading-5 ${muted}`}>{response.message}</p>

            {response.needs_input?.length > 0 && (
              <p className="mt-2 text-xs text-amber-500">
                Required inputs: {response.needs_input.join(", ")}
              </p>
            )}

            {isRouteResult && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div
                  className={`rounded-lg border p-3 ${
                    isDark
                      ? "border-neutral-800 bg-black/40"
                      : "border-emerald-200 bg-white"
                  }`}
                >
                  <Route size={15} className="mb-2 text-emerald-500" />
                  <p className="text-lg font-semibold tabular-nums">
                    {response.parameters.result.distance_km} km
                  </p>
                  <p className={`mt-1 text-[10px] ${muted}`}>
                    Driving distance
                  </p>
                </div>

                <div
                  className={`rounded-lg border p-3 ${
                    isDark
                      ? "border-neutral-800 bg-black/40"
                      : "border-emerald-200 bg-white"
                  }`}
                >
                  <Activity size={15} className="mb-2 text-emerald-500" />
                  <p className="text-lg font-semibold tabular-nums">
                    {response.parameters.result.estimated_duration_minutes} min
                  </p>
                  <p className={`mt-1 text-[10px] ${muted}`}>
                    Estimated duration
                  </p>
                </div>
              </div>
            )}

            {response.tool && (
              <div className="mt-3 flex items-center gap-2">
                <Workflow size={13} className="text-emerald-500" />
                <span className={`text-[10px] ${muted}`}>
                  Tool: {response.tool}
                </span>
              </div>
            )}
            {response.parameters?.result?.results?.map(
              (
                item: {
                  feature_index: number;
                  feature?: import("geojson").Feature;
                  distance_metres: number;
                  distance_kilometres?: number | null;
                },
                index: number,
              ) => (
                <button
                  key={`${item.feature_index}-${index}`}
                  type="button"
                  onClick={() => {
                    const origin =
                      response.parameters?.result?.origin?.coordinates;

                    if (Array.isArray(origin) && item.feature?.geometry) {
                      onNearestFeatureSelect?.(
                        [Number(origin[0]), Number(origin[1])],
                        item.feature,
                        Number(item.distance_metres),
                      );
                    }
                  }}
                  className="w-full rounded-xl border p-3 text-left transition hover:border-purple-500 hover:bg-purple-500/10"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">
                      Feature {item.feature_index + 1}
                    </span>

                    <span className="text-sm">
                      {item.distance_kilometres != null
                        ? `${Number(item.distance_kilometres).toFixed(2)} km`
                        : `${Number(item.distance_metres).toFixed(0)} m`}
                    </span>
                  </div>

                  <p className="mt-1 text-sm opacity-70">
                    {item.feature?.geometry?.type ?? "Unknown geometry"}
                  </p>
                </button>
              ),
            )}
          </section>
        )}

        {/* Scientific principles */}
        <section
          className={`rounded-xl border p-3 ${
            isDark
              ? "border-neutral-800 bg-neutral-950/60"
              : "border-gray-200 bg-gray-50/80"
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                isDark
                  ? "bg-emerald-400/10 text-emerald-400"
                  : "bg-emerald-100 text-emerald-700"
              }`}
            >
              <ShieldCheck size={17} />
            </div>

            <div>
              <h4 className="text-xs font-semibold">Reproducible research</h4>
              <p className={`mt-1 text-[11px] leading-5 ${muted}`}>
                Designed for transparent workflows, traceable operations, and
                interpretable spatial results.
              </p>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section>
          <div className="mb-3 flex items-center gap-2">
            <Microscope size={14} className="text-emerald-500" />
            <h4
              className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${muted}`}
            >
              Research capabilities
            </h4>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Capability
              icon={<Database size={14} />}
              label="Data validation"
              theme={theme}
            />
            <Capability
              icon={<FlaskConical size={14} />}
              label="Spatial analysis"
              theme={theme}
            />
            <Capability
              icon={<Workflow size={14} />}
              label="Agent workflow"
              theme={theme}
            />
            <Capability
              icon={<Activity size={14} />}
              label="Result tracing"
              theme={theme}
            />
          </div>
        </section>
      </div>

      {/* Research composer */}
      <form
        onSubmit={handleSubmit}
        className={`shrink-0 border-t p-4 ${
          isDark ? "border-neutral-800 bg-black" : "border-gray-200 bg-white"
        }`}
      >
        <div className="mb-2 flex items-center justify-between">
          <label htmlFor="research-question" className="text-xs font-semibold">
            Research query
          </label>

          <span className={`flex items-center gap-1 text-[10px] ${muted}`}>
            <Command size={11} />
            GIS
          </span>
        </div>

        <div
          className={`rounded-xl border transition-colors focus-within:border-emerald-500 ${
            isDark
              ? "border-neutral-800 bg-neutral-950"
              : "border-gray-200 bg-gray-50"
          }`}
        >
          <textarea
            id="research-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask a GIS question..."
            rows={3}
            maxLength={2000}
            disabled={loading}
            className={`w-full resize-none bg-transparent px-3 py-3 text-xs leading-5 outline-none disabled:opacity-60 ${
              isDark
                ? "text-white placeholder:text-neutral-600"
                : "text-gray-900 placeholder:text-gray-400"
            }`}
          />

          <div
            className={`flex items-center justify-between border-t px-2.5 py-2 ${
              isDark ? "border-neutral-800" : "border-gray-200"
            }`}
          >
            <span className={`text-[10px] ${muted}`}>
              {loading ? "Executing GIS tool..." : "GIS research assistant"}
            </span>

            <span className={`text-[10px] tabular-nums ${muted}`}>
              {question.length}/2000
            </span>
          </div>
        </div>
        <button
          type="submit"
          disabled={!question.trim() || loading}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-semibold text-black transition-all hover:bg-emerald-400 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? (
            <>
              <LoaderCircle size={15} className="animate-spin" />
              Running analysis...
            </>
          ) : (
            <>
              <Sparkles size={15} />
              Run analysis
              <ChevronRight size={15} className="ml-auto" />
            </>
          )}
        </button>

        <p className={`mt-2.5 text-center text-[10px] ${muted}`}>
          Connected to your GeoMind AI backend
        </p>
      </form>
    </aside>
  );
}

function TraceItem({
  icon,
  number,
  title,
  description,
  theme,
  last,
  active = false,
  complete = false,
}: {
  icon: ReactNode;
  number: string;
  title: string;
  description: string;
  theme: "light" | "dark";
  last: boolean;
  active?: boolean;
  complete?: boolean;
}) {
  const isDark = theme === "dark";

  return (
    <div className="relative flex gap-3 pb-4 last:pb-0">
      {!last && (
        <span
          className={`absolute left-3.25 top-8 bottom-0 w-px ${
            isDark ? "bg-neutral-800" : "bg-gray-200"
          }`}
        />
      )}

      <div
        className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
          complete
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
            : active
              ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
              : isDark
                ? "border-neutral-800 bg-neutral-900 text-emerald-400"
                : "border-gray-200 bg-gray-50 text-emerald-700"
        }`}
      >
        {complete ? <CheckCircle2 size={15} /> : icon}
      </div>

      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-2">
          <span
            className={`font-mono text-[9px] ${
              isDark ? "text-neutral-600" : "text-gray-400"
            }`}
          >
            {number}
          </span>

          <p className="text-xs font-medium">{title}</p>
        </div>

        <p
          className={`mt-1 text-[10px] leading-4 ${
            isDark ? "text-neutral-500" : "text-gray-500"
          }`}
        >
          {description}
        </p>
      </div>
    </div>
  );
}

function Capability({
  icon,
  label,
  theme,
}: {
  icon: ReactNode;
  label: string;
  theme: "light" | "dark";
}) {
  const isDark = theme === "dark";

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2.5 ${
        isDark
          ? "border-neutral-800 bg-neutral-950/60 text-neutral-300"
          : "border-gray-200 bg-white text-gray-600"
      }`}
    >
      <span className="shrink-0 text-emerald-500">{icon}</span>
      <span className="text-[10px] font-medium">{label}</span>
    </div>
  );
}
