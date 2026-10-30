export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000"
).replace(/\/+$/, "");

export interface RequestOptions {
  signal?: AbortSignal;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function request<T>(
  path: string,
  init: RequestInit,
  fallbackError: string,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      typeof data?.detail === "string" ? data.detail : fallbackError,
    );
  }

  return data as T;
}

export function getJSON<T>(
  path: string,
  fallbackError: string,
  options: RequestOptions = {},
): Promise<T> {
  return request<T>(
    path,
    { method: "GET", signal: options.signal },
    fallbackError,
  );
}

export function postJSON<T>(
  path: string,
  body: unknown,
  fallbackError: string,
  options: RequestOptions = {},
): Promise<T> {
  return request<T>(
    path,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: options.signal,
    },
    fallbackError,
  );
}
