export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

interface ApiOptions extends Omit<RequestInit, "body"> {
  /** JSON-serializable body. */
  json?: unknown;
  /** CSRF token to echo on mutations. */
  csrf?: string;
}

/** Thin JSON fetch wrapper: same-origin credentials, JSON in/out, typed errors. */
export async function api<T = unknown>(
  path: string,
  opts: ApiOptions = {},
): Promise<T> {
  const { json, csrf, headers, ...rest } = opts;
  const h = new Headers(headers);
  if (json !== undefined) h.set("Content-Type", "application/json");
  if (csrf) h.set("x-csrf-token", csrf);

  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: h,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : res.statusText) || "request_failed";
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}
