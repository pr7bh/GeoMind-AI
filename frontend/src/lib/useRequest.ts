import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError } from "./api";

/**
 * One cancellable request slot. Starting a new request aborts the previous
 * one; aborted, superseded and post-unmount responses resolve to null so they
 * never overwrite newer state. Real failures still throw.
 */
export function useRequest() {
  const controllerRef = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = useCallback(
    async <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
      controllerRef.current?.abort();

      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);

      try {
        const result = await task(controller.signal);
        return controller.signal.aborted ? null : result;
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return null;
        throw error;
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setLoading(false);
        }
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setLoading(false);
  }, []);

  return { loading, run, cancel };
}
