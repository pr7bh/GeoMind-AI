import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileDown, LoaderCircle } from "lucide-react";
import { isAbortError } from "../../lib/api";
import { downloadResearchReport } from "../../lib/researchClient";
import type { ReportFormat } from "../../lib/researchClient";

interface ResearchReportControlsProps {
  isDark: boolean;
  executionId: string;
  /** False when the insights have no evidence-supported findings. */
  available: boolean;
  /** Called after a successful download (e.g. to refresh report history). */
  onGenerated?: () => void;
}

const FORMATS: { id: ReportFormat; label: string; detail: string }[] = [
  { id: "pdf", label: "PDF", detail: "Print-ready" },
  { id: "docx", label: "DOCX", detail: "Editable in Word" },
];

export default function ResearchReportControls({ isDark, executionId, available, onGenerated }: ResearchReportControlsProps) {
  const muted = isDark ? "text-neutral-400" : "text-gray-500";
  const border = isDark ? "border-white/8" : "border-gray-200";
  const [format, setFormat] = useState<ReportFormat>("pdf");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function generate() {
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError("");
    setDownloaded(null);
    try {
      const { blob, filename } = await downloadResearchReport(executionId, format, controller.signal);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setDownloaded(filename);
      onGenerated?.();
    } catch (caught) {
      if (!isAbortError(caught)) {
        setError(caught instanceof Error ? caught.message : "The report could not be generated.");
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setLoading(false);
    }
  }

  return (
    <section aria-label="Research report" className={`gm-fade-up gm-glass-card mt-3 space-y-2 rounded-xl border p-2.5 ${border}`}>
      <div className="flex items-center gap-1.5">
        <FileDown size={14} className="text-emerald-500" />
        <span className="text-xs font-semibold">Research report</span>
        <span className={`ml-auto text-[10px] ${muted}`}>Built from these insights; nothing is re-run</span>
      </div>

      <div role="radiogroup" aria-label="Report format" className="grid grid-cols-2 gap-1.5">
        {FORMATS.map((option) => {
          const selected = format === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!available || loading}
              onClick={() => setFormat(option.id)}
              className={`gm-press rounded-lg border px-2.5 py-1.5 text-left text-[11px] transition-colors disabled:opacity-40 ${
                selected
                  ? "gm-pop border-emerald-500/50 bg-emerald-500/10 text-emerald-500"
                  : isDark
                    ? "border-white/10 hover:bg-white/5"
                    : "border-gray-200 hover:bg-gray-50"
              }`}
            >
              <span className="block font-semibold">{option.label}</span>
              <span className={`block text-[10px] ${selected ? "" : muted}`}>{option.detail}</span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => void generate()}
        disabled={!available || loading}
        className={`gm-press flex min-h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-xs font-semibold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40 ${
          loading ? "gm-shimmer" : ""
        }`}
      >
        {loading ? <LoaderCircle size={13} className="animate-spin" /> : <FileDown size={13} />}
        {loading ? "Building report…" : "Generate Research Report"}
      </button>

      {!available && (
        <p className={`text-[11px] ${muted}`}>
          A report needs evidence-supported findings; these insights have none.
        </p>
      )}
      {downloaded && (
        <p key={downloaded} className="gm-fade-up flex items-center gap-1.5 text-[11px] text-emerald-500" role="status">
          <CheckCircle2 size={12} /> Downloaded <span className="font-mono">{downloaded}</span>
        </p>
      )}
      {error && (
        <p key={error} className="gm-fade-down flex gap-1.5 text-[11px] text-red-400" role="alert">
          <AlertCircle size={13} className="mt-px shrink-0" /> {error}
        </p>
      )}
    </section>
  );
}
