import { useSyncExternalStore } from "react";

// Matches Tailwind's max-[900px] variant, which is `width < 900px`.
export const COMPACT_LAYOUT_QUERY = "(max-width: 899.98px)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}
