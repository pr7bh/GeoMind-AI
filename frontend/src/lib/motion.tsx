import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./reducedMotion";

interface CountUpProps {
  value: number | null;
  /** Formats the displayed number (and null, which is never animated). */
  format: (value: number | null) => string;
  durationMs?: number;
}

/**
 * Counts up to `value` once, when it first appears. Re-renders with the same
 * value never restart it; null stays null (shown via `format`, never as 0).
 */
export function CountUp({ value, format, durationMs = 600 }: CountUpProps) {
  const done = useRef(false);
  const [shown, setShown] = useState<number | null>(() =>
    value === null || prefersReducedMotion() ? value : 0,
  );

  useEffect(() => {
    if (value === null || done.current || prefersReducedMotion()) {
      done.current = done.current || value !== null;
      setShown(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / durationMs, 1);
      setShown(t < 1 ? value * (1 - Math.pow(1 - t, 3)) : value);
      if (t < 1) frame = requestAnimationFrame(tick);
      else done.current = true;
    };
    frame = requestAnimationFrame(tick);
    // Interrupted (unmount or StrictMode re-run): the next run starts cleanly.
    return () => cancelAnimationFrame(frame);
  }, [value, durationMs]);

  return <>{format(shown)}</>;
}
