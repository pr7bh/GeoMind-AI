import type { ReactNode } from "react";
import { AlertCircle, LoaderCircle, Maximize2, SearchX, X } from "lucide-react";

const PRIMARY_COLORS = {
  emerald: "border-emerald-400/30 bg-emerald-500 text-black hover:bg-emerald-400",
  sky: "border-sky-400/30 bg-sky-500 text-white hover:bg-sky-400",
  violet: "border-violet-400/30 bg-violet-500 text-white hover:bg-violet-400",
};

interface RunButtonProps {
  label: string;
  loadingLabel: string;
  loading: boolean;
  disabled?: boolean;
  color?: keyof typeof PRIMARY_COLORS;
  isDark: boolean;
  onRun: () => void;
  onCancel: () => void;
}

/** Primary action; while running it shows real request status plus Cancel. */
export function RunButton({
  label,
  loadingLabel,
  loading,
  disabled,
  color = "emerald",
  isDark,
  onRun,
  onCancel,
}: RunButtonProps) {
  if (loading) {
    return (
      <div className="flex gap-2">
        <div
          role="status"
          className={`flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium ${
            isDark
              ? "border-white/10 bg-white/5 text-neutral-200"
              : "border-gray-200 bg-white/70 text-gray-700"
          }`}
        >
          <LoaderCircle size={15} className="animate-spin text-emerald-500" />
          {loadingLabel}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className={`min-h-10 rounded-xl border px-3 text-sm font-medium transition-colors ${
            isDark
              ? "border-white/10 hover:border-red-400/30 hover:text-red-300"
              : "border-gray-200 hover:border-red-300 hover:text-red-600"
          }`}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onRun}
      disabled={disabled}
      className={`min-h-10 w-full rounded-xl border px-3 py-2.5 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${PRIMARY_COLORS[color]}`}
    >
      {label}
    </button>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex gap-2 break-words rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs leading-relaxed text-red-400"
    >
      <AlertCircle size={14} className="mt-px shrink-0" />
      <span>{message}</span>
    </p>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-xl border border-dashed border-neutral-500/30 p-3 text-xs leading-relaxed text-neutral-500">
      <SearchX size={14} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

interface ResultCardProps {
  isDark: boolean;
  title: string;
  /** Headline number or value. */
  value?: ReactNode;
  /** Shown when a newer request failed and this result is older. */
  stale?: boolean;
  onZoom?: () => void;
  onClear?: () => void;
  children?: ReactNode;
}

export function ResultCard({
  isDark,
  title,
  value,
  stale,
  onZoom,
  onClear,
  children,
}: ResultCardProps) {
  const iconButton = `rounded-lg p-1.5 transition-colors max-[900px]:p-2.5 ${
    isDark
      ? "text-neutral-400 hover:bg-white/8 hover:text-white"
      : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
  }`;

  return (
    <section
      aria-label={title}
      className={`rounded-xl border p-3 ${
        isDark
          ? "border-emerald-400/20 bg-emerald-400/5"
          : "border-emerald-500/20 bg-emerald-500/5"
      }`}
    >
      <div className="flex items-center gap-1">
        <p className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
          {title}
        </p>
        {onZoom && (
          <button
            type="button"
            onClick={onZoom}
            title="Zoom to results"
            aria-label="Zoom to results"
            className={iconButton}
          >
            <Maximize2 size={14} />
          </button>
        )}
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            title="Clear results"
            aria-label="Clear results"
            className={iconButton}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {value !== undefined && (
        <p className="mt-1 text-2xl font-semibold tracking-tight text-emerald-500">
          {value}
        </p>
      )}

      {stale && (
        <p className="mt-1 text-[11px] text-amber-500">
          Showing the previous successful result.
        </p>
      )}

      {children && <div className="mt-2 space-y-2">{children}</div>}
    </section>
  );
}

interface FeatureListProps<T> {
  isDark: boolean;
  items: T[];
  max?: number;
  getKey: (item: T, index: number) => string;
  getName: (item: T, index: number) => string;
  getDetail?: (item: T) => string;
  onSelect?: (item: T) => void;
}

export function FeatureList<T>({
  isDark,
  items,
  max = 50,
  getKey,
  getName,
  getDetail,
  onSelect,
}: FeatureListProps<T>) {
  const shown = items.slice(0, max);

  return (
    <div>
      <ul className="max-h-56 space-y-1 overflow-y-auto pr-0.5">
        {shown.map((item, index) => (
          <li key={getKey(item, index)}>
            <button
              type="button"
              onClick={onSelect ? () => onSelect(item) : undefined}
              disabled={!onSelect}
              className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors disabled:cursor-default ${
                isDark
                  ? "border-white/8 bg-white/[0.03] enabled:hover:border-emerald-400/30"
                  : "border-gray-200/80 bg-white/60 enabled:hover:border-emerald-500/30"
              }`}
            >
              <span className="min-w-0 truncate font-medium">
                {getName(item, index)}
              </span>
              {getDetail && (
                <span className="shrink-0 text-[11px] text-neutral-500">
                  {getDetail(item)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {items.length > max && (
        <p className="mt-1 text-[11px] text-neutral-500">
          Showing {max} of {items.length}.
        </p>
      )}
    </div>
  );
}
