
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { LoaderCircle, MapPin, Search, X } from "lucide-react";

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

const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_DELAY = 500;

export default function LocationSearch({
  theme,
  onSelectLocation,
}: LocationSearchProps) {
  const isDark = theme === "dark";

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isFocused, setIsFocused] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const lastRequestedQueryRef = useRef("");
  const skipNextAutoSearchRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const searchLocations = useCallback(
    async (value: string, force = false) => {
      const searchTerm = value.trim();

      if (searchTerm.length < MIN_QUERY_LENGTH) {
        requestControllerRef.current?.abort();
        requestControllerRef.current = null;
        requestIdRef.current += 1;
        lastRequestedQueryRef.current = "";

        setResults([]);
        setLoading(false);
        setError(
          force ? "Enter at least 3 characters to search." : ""
        );
        return;
      }

      if (
        !force &&
        searchTerm === lastRequestedQueryRef.current
      ) {
        return;
      }

      requestControllerRef.current?.abort();

      const controller = new AbortController();
      const requestId = ++requestIdRef.current;

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
            method: "GET",
            headers: {
              Accept: "application/json",
            },
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          if (response.status === 429) {
            throw new Error(
              "Too many searches. Please wait a moment and try again."
            );
          }

          throw new Error(
            `Location search failed (${response.status}). Please try again.`
          );
        }

        const data: LocationResult[] = await response.json();

        if (
          controller.signal.aborted ||
          requestId !== requestIdRef.current
        ) {
          return;
        }

        setResults(data);
        setError(
          data.length === 0
            ? "No locations found. Try another search."
            : ""
        );
      } catch (err) {
        if (
          controller.signal.aborted ||
          requestId !== requestIdRef.current
        ) {
          return;
        }

        setResults([]);
        setError(
          err instanceof Error
            ? err.message
            : "Unable to search locations. Please try again."
        );
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          requestControllerRef.current = null;
        }
      }
    },
    []
  );

  // Automatically search after the user stops typing.
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    const searchTerm = query.trim();

    if (skipNextAutoSearchRef.current) {
      skipNextAutoSearchRef.current = false;
      return;
    }

    if (searchTerm.length < MIN_QUERY_LENGTH) {
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      requestIdRef.current += 1;
      lastRequestedQueryRef.current = "";

      setResults([]);
      setLoading(false);
      setError("");
      return;
    }

    debounceTimerRef.current = setTimeout(() => {
      void searchLocations(searchTerm);
    }, DEBOUNCE_DELAY);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [query, searchLocations]);

  // Cancel pending requests when the component unmounts.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      requestControllerRef.current?.abort();
    };
  }, []);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    void searchLocations(query, true);
  }

  function selectLocation(result: LocationResult) {
    const longitude = Number(result.lon);
    const latitude = Number(result.lat);

    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      setError("The selected location has invalid coordinates.");
      return;
    }

    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    requestIdRef.current += 1;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    lastRequestedQueryRef.current = result.display_name;
    skipNextAutoSearchRef.current = true;

    setQuery(result.display_name);
    setResults([]);
    setError("");
    setLoading(false);
    setIsFocused(false);

    onSelectLocation(longitude, latitude);
    inputRef.current?.blur();
  }

  function clearSearch() {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    requestIdRef.current += 1;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    lastRequestedQueryRef.current = "";
    skipNextAutoSearchRef.current = true;

    setQuery("");
    setResults([]);
    setError("");
    setLoading(false);

    inputRef.current?.focus();
  }

  const glassPanel = isDark
    ? "border-white/[0.12] bg-neutral-950/65 text-white shadow-[0_18px_50px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.04)]"
    : "border-white/80 bg-white/65 text-gray-900 shadow-[0_18px_50px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.65)]";

  return (
    <div className="relative w-full">
      <form
        onSubmit={handleSearch}
        className={`group relative flex min-h-[54px] items-center gap-3 gm-glass overflow-hidden rounded-2xl border px-3 transition-all duration-300 ${
          isDark
            ? `bg-neutral-950/55 ${
                isFocused
                  ? "border-emerald-400/45 shadow-[0_0_0_3px_rgba(16,185,129,0.07),0_12px_35px_rgba(0,0,0,0.2)]"
                  : "border-white/[0.10] shadow-[0_8px_30px_rgba(0,0,0,0.15)] hover:border-white/20"
              }`
            : `bg-white/55 ${
                isFocused
                  ? "border-emerald-500/40 shadow-[0_0_0_3px_rgba(5,150,105,0.06),0_12px_35px_rgba(15,23,42,0.05)]"
                  : "border-white/80 shadow-[0_8px_30px_rgba(15,23,42,0.05)] hover:border-emerald-200/80"
              }`
        }`}
      >
       

        <div className="min-w-0 flex-1 py-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setError("");
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
        </div>

        {query && (
          <button
            type="button"
            onClick={clearSearch}
            aria-label="Clear search"
            title="Clear search"
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
              isDark
                ? "text-neutral-400 hover:bg-white/[0.08] hover:text-white"
                : "text-gray-400 hover:bg-white/80 hover:text-gray-800"
            }`}
          >
            <X size={15} />
          </button>
        )}

        <button
          type="submit"
          disabled={loading || query.trim().length < MIN_QUERY_LENGTH}
          aria-label="Search locations"
          title="Search locations"
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-all duration-200 ${
            isDark
              ? "border-emerald-400/15 bg-emerald-400/[0.09] text-emerald-400 hover:bg-emerald-400/[0.16]"
              : "border-emerald-200/60 bg-emerald-50/70 text-emerald-700 hover:bg-emerald-100/80"
          } disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {loading ? (
            <LoaderCircle size={18} className="animate-spin" />
          ) : (
            <Search size={18} strokeWidth={1.8} />
          )}
        </button>
      </form>

      {(results.length > 0 || error || loading) && (
        <div
          className={`absolute left-0 right-0 top-full z-[100] gm-glass-strong mt-2 overflow-hidden rounded-2xl border ${glassPanel}`}
        >
          <div
            className={`flex items-center justify-between border-b px-3 py-2.5 ${
              isDark
                ? "border-white/[0.08] bg-white/[0.025]"
                : "border-gray-200/60 bg-white/25"
            }`}
          >
            <span
              className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${
                isDark ? "text-neutral-400" : "text-gray-500"
              }`}
            >
              {loading
                ? "Searching locations"
                : error
                  ? "Search status"
                  : "Location results"}
            </span>

            {results.length > 0 && (
              <span
                className={`rounded-md border px-2 py-1 text-[10px] font-medium ${
                  isDark
                    ? "border-emerald-400/15 bg-emerald-400/[0.08] text-emerald-400"
                    : "border-emerald-200/60 bg-emerald-50/70 text-emerald-700"
                }`}
              >
                {results.length} found
              </span>
            )}
          </div>

          {loading && results.length === 0 && !error && (
            <div
              className={`flex items-center gap-3 px-4 py-5 text-xs ${
                isDark ? "text-neutral-400" : "text-gray-500"
              }`}
            >
              <LoaderCircle
                size={16}
                className="animate-spin text-emerald-500"
              />
              Looking up locations...
            </div>
          )}

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
                  ? "[scrollbar-color:rgba(52,211,153,0.35)_transparent]"
                  : "[scrollbar-color:rgba(5,150,105,0.35)_transparent]"
              } [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-emerald-500/35`}
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
                  className={`flex w-full items-start gap-3 rounded-xl border border-transparent p-3 text-left transition-colors duration-200 ${
                    isDark
                      ? "hover:border-white/[0.05] hover:bg-white/[0.055] focus-visible:bg-white/[0.06]"
                      : "hover:border-emerald-100/70 hover:bg-emerald-50/60 focus-visible:bg-emerald-50/60"
                  }`}
                >
                  <div
                    className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
                      isDark
                        ? "border-emerald-400/10 bg-emerald-400/[0.08] text-emerald-400"
                        : "border-emerald-100/70 bg-emerald-50/70 text-emerald-700"
                    }`}
                  >
                    <MapPin size={16} strokeWidth={1.8} />
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
            className={`border-t px-3 py-2.5 text-[10px] ${
              isDark
                ? "border-white/[0.08] bg-white/[0.015] text-neutral-500"
                : "border-gray-200/60 bg-white/25 text-gray-400"
            }`}
          >
            Location data provided by OpenStreetMap Nominatim
          </div>
        </div>
      )}
    </div>
  );
}
