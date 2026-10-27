
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  MapPin,
  Search,
  LoaderCircle,
  X,
  Navigation,
} from "lucide-react";

export interface LocationResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type: string;
}

interface LocationSearchProps {
  theme: "light" | "dark";
  onSelectLocation: (longitude: number, latitude: number) => void;
}

function useDebouncedValue<T>(value: T, delay = 1000): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

export default function LocationSearch({
  theme,
  onSelectLocation,
}: LocationSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isFocused, setIsFocused] = useState(false);

  const isDark = theme === "dark";
  const debouncedQuery = useDebouncedValue(query, 1000);

  const inputRef = useRef<HTMLInputElement>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const lastRequestedQueryRef = useRef("");
  const skipSearchForQueryRef = useRef<string | null>(null);

  const searchLocations = useCallback(
    async (value: string, manual = false) => {
      const searchTerm = value.trim();

      if (searchTerm.length < 3) {
        if (manual) {
          setError("Enter at least 3 characters to search.");
        } else {
          setError("");
        }

        setResults([]);
        setLoading(false);
        lastRequestedQueryRef.current = "";
        return;
      }

      // Prevent duplicate requests from manual and debounced search.
      if (
        !manual &&
        searchTerm === lastRequestedQueryRef.current
      ) {
        return;
      }

      // Cancel the previous request before starting another.
      requestControllerRef.current?.abort();

      const controller = new AbortController();
      requestControllerRef.current = controller;
      lastRequestedQueryRef.current = searchTerm;

      setLoading(true);
      setError("");

      try {
        const params = new URLSearchParams({
          q: searchTerm,
          format: "jsonv2",
          limit: "5",
          addressdetails: "1",
        });

        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?${params.toString()}`,
          {
            headers: {
              Accept: "application/json",
            },
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error(
            "Location search is temporarily unavailable. Please try again.",
          );
        }

        const data: LocationResult[] = await response.json();

        if (controller.signal.aborted) return;

        setResults(data);
        setError(
          data.length === 0
            ? "No locations found. Try another search."
            : "",
        );
      } catch (err) {
        if (controller.signal.aborted) return;

        setResults([]);

        setError(
          err instanceof Error
            ? err.message
            : "Unable to search locations. Please try again.",
        );
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    },
    [],
  );

  // Automatic search after the user pauses typing.
  useEffect(() => {
    const searchTerm = debouncedQuery.trim();

    if (skipSearchForQueryRef.current === searchTerm) {
      skipSearchForQueryRef.current = null;
      return;
    }

    if (searchTerm.length < 3) {
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      lastRequestedQueryRef.current = "";
      setResults([]);
      setError("");
      setLoading(false);
      return;
    }

    void searchLocations(searchTerm);

    return () => {
      requestControllerRef.current?.abort();
    };
  }, [debouncedQuery, searchLocations]);

  // Manual search works immediately on click or Enter.
  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void searchLocations(query, true);
  }

  function selectLocation(result: LocationResult) {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;

    skipSearchForQueryRef.current = result.display_name;
    lastRequestedQueryRef.current = result.display_name;

    onSelectLocation(Number(result.lon), Number(result.lat));

    setQuery(result.display_name);
    setResults([]);
    setError("");
    setLoading(false);
    setIsFocused(false);

    inputRef.current?.blur();
  }

  function clearSearch() {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;

    skipSearchForQueryRef.current = null;
    lastRequestedQueryRef.current = "";

    setQuery("");
    setResults([]);
    setError("");
    setLoading(false);

    inputRef.current?.focus();
  }

  return (
    <div className="relative w-full">
      <form
        onSubmit={handleSearch}
        className={`group relative flex min-h-[54px] items-center gap-3 rounded-2xl border px-3 backdrop-blur-xl transition-all duration-200 ${
          isDark
            ? `bg-neutral-950/95 ${
                isFocused
                  ? "border-emerald-500/60 shadow-[0_0_0_3px_rgba(16,185,129,0.10),0_12px_35px_rgba(0,0,0,0.35)]"
                  : "border-white/10 shadow-[0_8px_30px_rgba(0,0,0,0.25)] hover:border-white/20"
              }`
            : `bg-white/95 ${
                isFocused
                  ? "border-emerald-600/50 shadow-[0_0_0_3px_rgba(5,150,105,0.08),0_12px_35px_rgba(15,23,42,0.08)]"
                  : "border-gray-200 shadow-[0_8px_30px_rgba(15,23,42,0.07)] hover:border-gray-300"
              }`
        }`}
      >
        

        <div className="min-w-0 flex-1 py-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              const value = event.target.value;

              setQuery(value);
              setError("");

              if (value.trim().length < 3) {
                requestControllerRef.current?.abort();
                requestControllerRef.current = null;
                lastRequestedQueryRef.current = "";
                setResults([]);
                setLoading(false);
              }
            }}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="Search places, coordinates, regions..."
            aria-label="Search geographic locations"
            aria-autocomplete="list"
            autoComplete="off"
            className={`w-full bg-transparent text-[13px] font-medium outline-none ${
              isDark
                ? "text-neutral-100 placeholder:text-neutral-500"
                : "text-gray-900 placeholder:text-gray-400"
            }`}
          />

          <div
            className={`mt-1 flex items-center gap-1.5 text-[10px] ${
              isDark ? "text-neutral-500" : "text-gray-400"
            }`}
          >
            <Navigation size={10} className="text-emerald-500" />
            <span>Global geospatial search</span>
          </div>
        </div>

        {query && (
          <button
            type="button"
            onClick={clearSearch}
            aria-label="Clear search"
            title="Clear search"
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
              isDark
                ? "text-neutral-400 hover:bg-white/10 hover:text-white"
                : "text-gray-400 hover:bg-gray-100 hover:text-gray-800"
            }`}
          >
            <X size={15} />
          </button>
        )}

        <button
  type="submit"
  disabled={loading || query.trim().length < 3}
  aria-label="Search locations"
  title="Search locations"
  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all duration-200 ${
    isDark
      ? "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
      : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
  } disabled:cursor-not-allowed disabled:opacity-40`}
>
  {loading ? (
    <LoaderCircle size={19} className="animate-spin" />
  ) : (
    <Search size={19} strokeWidth={1.8} />
  )}
</button>
      </form>

      {(results.length > 0 || error) && (
        <div
          className={`absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border backdrop-blur-2xl ${
            isDark
              ? "border-white/10 bg-neutral-950/95 text-white shadow-[0_18px_45px_rgba(0,0,0,0.45)]"
              : "border-gray-200 bg-white text-gray-900 shadow-[0_18px_45px_rgba(15,23,42,0.13)]"
          }`}
        >
          <div
            className={`flex items-center justify-between border-b px-3 py-2.5 ${
              isDark ? "border-white/[0.07]" : "border-gray-100"
            }`}
          >
            <span
              className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${
                isDark ? "text-neutral-400" : "text-gray-500"
              }`}
            >
              {error ? "Search status" : "Location results"}
            </span>

            {results.length > 0 && (
              <span className="rounded-md bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-500">
                {results.length} found
              </span>
            )}
          </div>

          {error && (
            <p
              role="status"
              className={`px-4 py-4 text-xs leading-5 ${
                isDark ? "text-neutral-300" : "text-gray-600"
              }`}
            >
              {error}
            </p>
          )}

          {results.length > 0 && (
            <div
              className={`max-h-72 overflow-y-auto p-1.5 [scrollbar-width:thin] ${
                isDark
                  ? "[scrollbar-color:rgba(52,211,153,0.3)_transparent]"
                  : "[scrollbar-color:rgba(5,150,105,0.3)_transparent]"
              } [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-emerald-500/30`}
              role="listbox"
              aria-label="Location search results"
            >
              {results.map((result) => (
                <button
                  key={`${result.place_id}-${result.lat}-${result.lon}`}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectLocation(result)}
                  className={`flex w-full items-start gap-3 rounded-xl p-3 text-left transition-colors ${
                    isDark
                      ? "hover:bg-white/[0.06] focus-visible:bg-white/[0.06]"
                      : "hover:bg-emerald-50/70 focus-visible:bg-emerald-50/70"
                  }`}
                >
                  <div
                    className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      isDark
                        ? "bg-emerald-400/10 text-emerald-400"
                        : "bg-emerald-50 text-emerald-700"
                    }`}
                  >
                    <MapPin size={16} />
                  </div>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">
                      {result.display_name.split(",")[0]}
                    </span>

                    <span
                      className={`mt-1 block text-[11px] leading-4 ${
                        isDark ? "text-neutral-400" : "text-gray-500"
                      }`}
                    >
                      {result.display_name}
                    </span>

                    <span
                      className={`mt-1.5 block text-[10px] ${
                        isDark ? "text-neutral-500" : "text-gray-400"
                      }`}
                    >
                      {Number(result.lat).toFixed(5)},{" "}
                      {Number(result.lon).toFixed(5)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div
            className={`border-t px-3 py-2 text-[10px] ${
              isDark
                ? "border-white/[0.07] text-neutral-500"
                : "border-gray-100 text-gray-400"
            }`}
          >
            Location data provided by OpenStreetMap Nominatim
          </div>
        </div>
      )}
    </div>
  );
}
