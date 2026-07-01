import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { Card } from "../components/ui/Card";
import { cn } from "../lib/cn";
import type { Category } from "../lib/types";
import type {
  Assertion,
  HeartbeatConfig,
  HttpConfig,
  HttpMethod,
  Schedule,
} from "../../shared/schemas";

/**
 * Create / edit a monitor (PRD §6, §7). Mirrors `createMonitorSchema`: an HTTP
 * or heartbeat monitor with a schedule and — for HTTP — request config and
 * content assertions. The form holds a flattened local state and assembles the
 * discriminated-union payload on submit; the worker re-validates with zod and
 * returns `{ issues }` on 400 which we surface inline.
 */

type MonitorType = "http" | "heartbeat";
type AuthType = "none" | "basic" | "bearer";
type AssertionKind = Assertion["kind"];
type ScheduleMode = Schedule["mode"];

interface HeaderRow {
  name: string;
  value: string;
}
interface AssertionRow {
  kind: AssertionKind;
  value: string;
  path: string;
  caseSensitive: boolean;
}
interface PeriodRow {
  start: string;
  end: string;
}
interface CustomDayRow {
  weekday: number;
  periods: PeriodRow[];
}

interface FormState {
  name: string;
  type: MonitorType;
  enabled: boolean;
  // HTTP config
  url: string;
  method: HttpMethod;
  headers: HeaderRow[];
  body: string;
  authType: AuthType;
  authUsername: string;
  authPassword: string;
  authToken: string;
  timeoutMs: number;
  warmupTimeoutMs: number;
  followRedirects: boolean;
  expectedMin: number;
  expectedMax: number;
  degradedResponseMs: string;
  failResponseMs: string;
  assertions: AssertionRow[];
  // Heartbeat config
  intervalSeconds: number;
  graceSeconds: number;
  secret: string;
  acceptedMethods: HttpMethod[];
  // Schedule
  scheduleMode: ScheduleMode;
  bizWeekdays: number[];
  bizStart: string;
  bizEnd: string;
  bizTimezone: string;
  customTimezone: string;
  customDays: CustomDayRow[];
  customExcludedDates: string;
  // Status page
  categoryId: string | null;
  publicVisible: boolean;
}

/** Subset of the monitor record the editor needs for prefill (edit mode). */
interface LoadedMonitor {
  id: string;
  type: MonitorType;
  name: string;
  enabled: boolean;
  config: HttpConfig | HeartbeatConfig;
  schedule: Schedule;
  assertions: Assertion[];
  notify: unknown;
  public: unknown;
  categoryId?: string | null;
}

const HTTP_METHODS: HttpMethod[] = [
  "HEAD",
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const ASSERTION_KINDS: { value: AssertionKind; label: string }[] = [
  { value: "contains", label: "Body contains" },
  { value: "not_contains", label: "Body does not contain" },
  { value: "not_empty", label: "Body is not empty" },
  { value: "is_json", label: "Body is valid JSON" },
  { value: "json_path_exists", label: "JSON path exists" },
  { value: "json_path_equals", label: "JSON path equals" },
  { value: "json_path_contains", label: "JSON path contains" },
];

function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timezones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    if (fn) return fn("timeZone");
  } catch {
    /* ignore */
  }
  return ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London"];
}

function initialForm(): FormState {
  const tz = guessTimezone();
  return {
    name: "",
    type: "http",
    enabled: true,
    url: "",
    method: "GET",
    headers: [],
    body: "",
    authType: "none",
    authUsername: "",
    authPassword: "",
    authToken: "",
    timeoutMs: 60000,
    warmupTimeoutMs: 120000,
    followRedirects: true,
    expectedMin: 200,
    expectedMax: 399,
    degradedResponseMs: "",
    failResponseMs: "",
    assertions: [],
    intervalSeconds: 3600,
    graceSeconds: 300,
    secret: "",
    acceptedMethods: [],
    scheduleMode: "always",
    bizWeekdays: [1, 2, 3, 4, 5],
    bizStart: "08:00",
    bizEnd: "17:00",
    bizTimezone: tz,
    customTimezone: tz,
    customDays: [],
    customExcludedDates: "",
    categoryId: null,
    publicVisible: false,
  };
}

function toAssertionRow(a: Assertion): AssertionRow {
  return {
    kind: a.kind,
    value: "value" in a ? a.value : "",
    path: "path" in a ? a.path : "",
    caseSensitive: "caseSensitive" in a ? a.caseSensitive : false,
  };
}

/** Populate form state from a loaded monitor record (edit mode). */
function prefill(m: LoadedMonitor): FormState {
  const base = initialForm();
  base.name = m.name;
  base.type = m.type;
  base.enabled = m.enabled;
  base.categoryId = m.categoryId ?? null;
  const pub =
    m.public && typeof m.public === "object"
      ? (m.public as Record<string, unknown>)
      : {};
  base.publicVisible = pub.visible === true;

  if (m.type === "http") {
    const c = m.config as HttpConfig;
    base.url = c.url ?? "";
    base.method = c.method ?? "GET";
    base.headers = Array.isArray(c.headers)
      ? c.headers.map((h) => ({ name: h.name, value: h.value }))
      : [];
    base.body = c.body ?? "";
    const auth = c.auth ?? { type: "none" };
    base.authType = auth.type;
    if (auth.type === "basic") {
      base.authUsername = auth.username;
      base.authPassword = auth.password;
    } else if (auth.type === "bearer") {
      base.authToken = auth.token;
    }
    base.timeoutMs = c.timeoutMs ?? 60000;
    base.warmupTimeoutMs = c.warmupTimeoutMs ?? 120000;
    base.followRedirects = c.followRedirects ?? true;
    base.expectedMin = c.expectedStatus?.min ?? 200;
    base.expectedMax = c.expectedStatus?.max ?? 399;
    base.degradedResponseMs =
      c.degradedResponseMs != null ? String(c.degradedResponseMs) : "";
    base.failResponseMs =
      c.failResponseMs != null ? String(c.failResponseMs) : "";
    base.assertions = Array.isArray(m.assertions)
      ? m.assertions.map(toAssertionRow)
      : [];
  } else {
    const c = m.config as HeartbeatConfig;
    base.intervalSeconds = c.intervalSeconds ?? 3600;
    base.graceSeconds = c.graceSeconds ?? 300;
    base.secret = c.secret ?? "";
    base.acceptedMethods = Array.isArray(c.acceptedMethods)
      ? c.acceptedMethods
      : [];
  }

  const s = m.schedule ?? { mode: "always" };
  base.scheduleMode = s.mode;
  if (s.mode === "business_hours") {
    base.bizWeekdays = s.weekdays ?? [1, 2, 3, 4, 5];
    base.bizStart = s.start ?? "08:00";
    base.bizEnd = s.end ?? "17:00";
    base.bizTimezone = s.timezone ?? base.bizTimezone;
  } else if (s.mode === "custom") {
    base.customTimezone = s.timezone ?? base.customTimezone;
    base.customDays = Array.isArray(s.days)
      ? s.days.map((d) => ({
          weekday: d.weekday,
          periods: d.periods.map((p) => ({ start: p.start, end: p.end })),
        }))
      : [];
    base.customExcludedDates = Array.isArray(s.excludedDates)
      ? s.excludedDates.join(", ")
      : "";
  }
  return base;
}

function toggle<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

/** Pull human-readable messages out of a worker 400 validation response. */
function errorMessages(err: unknown): string[] {
  if (
    err instanceof ApiError &&
    err.status === 400 &&
    err.data &&
    typeof err.data === "object" &&
    "issues" in err.data
  ) {
    const issues = (err.data as { issues?: unknown }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues.map((raw) => {
        const i = raw as { path?: unknown[]; message?: string };
        const path = Array.isArray(i.path) ? i.path.join(".") : "";
        const msg = i.message ?? "Invalid value";
        return path ? `${path}: ${msg}` : msg;
      });
    }
  }
  if (err instanceof Error) return [err.message];
  return ["Could not save the monitor."];
}

export default function MonitorEditor() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { csrf } = useBootstrap();
  const tzList = useMemo(timezones, []);

  const [form, setForm] = useState<FormState>(initialForm);
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  // Focused on submit so screen-reader + keyboard users land on the error
  // summary (which also carries role="alert").
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const [preserved, setPreserved] = useState<{
    notify?: unknown;
    public?: unknown;
  }>({});
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { categories: list } = await api<{ categories: Category[] }>(
          "/api/categories",
        );
        if (!cancelled) setCategories(list);
      } catch {
        // Categories are optional; a load failure just leaves "None" selectable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { monitor } = await api<{ monitor: LoadedMonitor }>(
          `/api/monitors/${id}`,
        );
        if (cancelled) return;
        setForm(prefill(monitor));
        setPreserved({ notify: monitor.notify, public: monitor.public });
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof Error ? e.message : "Could not load this monitor.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }) as FormState);
  }

  const showBody = form.method !== "GET" && form.method !== "HEAD";
  const cancelTo = isEdit ? `/monitors/${id}` : "/monitors";

  // --- Header rows ---
  const addHeader = () =>
    set("headers", [...form.headers, { name: "", value: "" }]);
  const updateHeader = (i: number, patch: Partial<HeaderRow>) =>
    set(
      "headers",
      form.headers.map((h, idx) => (idx === i ? { ...h, ...patch } : h)),
    );
  const removeHeader = (i: number) =>
    set(
      "headers",
      form.headers.filter((_, idx) => idx !== i),
    );

  // --- Assertion rows ---
  const addAssertion = () =>
    set("assertions", [
      ...form.assertions,
      { kind: "contains", value: "", path: "", caseSensitive: false },
    ]);
  const updateAssertion = (i: number, patch: Partial<AssertionRow>) =>
    set(
      "assertions",
      form.assertions.map((a, idx) => (idx === i ? { ...a, ...patch } : a)),
    );
  const removeAssertion = (i: number) =>
    set(
      "assertions",
      form.assertions.filter((_, idx) => idx !== i),
    );

  // --- Custom schedule rows ---
  const addCustomDay = () =>
    set("customDays", [
      ...form.customDays,
      { weekday: 1, periods: [{ start: "09:00", end: "17:00" }] },
    ]);
  const updateCustomDay = (di: number, patch: Partial<CustomDayRow>) =>
    set(
      "customDays",
      form.customDays.map((d, idx) => (idx === di ? { ...d, ...patch } : d)),
    );
  const removeCustomDay = (di: number) =>
    set(
      "customDays",
      form.customDays.filter((_, idx) => idx !== di),
    );
  const addPeriod = (di: number) =>
    set(
      "customDays",
      form.customDays.map((d, idx) =>
        idx === di
          ? { ...d, periods: [...d.periods, { start: "09:00", end: "17:00" }] }
          : d,
      ),
    );
  const updatePeriod = (di: number, pi: number, patch: Partial<PeriodRow>) =>
    set(
      "customDays",
      form.customDays.map((d, idx) =>
        idx === di
          ? {
              ...d,
              periods: d.periods.map((p, j) =>
                j === pi ? { ...p, ...patch } : p,
              ),
            }
          : d,
      ),
    );
  const removePeriod = (di: number, pi: number) =>
    set(
      "customDays",
      form.customDays.map((d, idx) =>
        idx === di
          ? { ...d, periods: d.periods.filter((_, j) => j !== pi) }
          : d,
      ),
    );

  function buildSchedule(): Schedule {
    if (form.scheduleMode === "business_hours") {
      return {
        mode: "business_hours",
        weekdays: [...form.bizWeekdays].sort((a, b) => a - b),
        start: form.bizStart,
        end: form.bizEnd,
        timezone: form.bizTimezone,
      };
    }
    if (form.scheduleMode === "custom") {
      return {
        mode: "custom",
        timezone: form.customTimezone,
        days: form.customDays.map((d) => ({
          weekday: d.weekday,
          periods: d.periods.map((p) => ({ start: p.start, end: p.end })),
        })),
        excludedDates: form.customExcludedDates
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    }
    return { mode: "always" };
  }

  function buildPayload(): Record<string, unknown> {
    const schedule = buildSchedule();
    // Set public.visible from the toggle while preserving the other public.*
    // fields (sortOrder, showUptime, showResponseTime, showIncidentDetails,
    // showScheduledOff, name/description/group) round-tripped from the load. On
    // create there's nothing to preserve, so zod fills the rest from defaults.
    const publicBase =
      preserved.public && typeof preserved.public === "object"
        ? (preserved.public as Record<string, unknown>)
        : {};
    const publicConfig = { ...publicBase, visible: form.publicVisible };

    const common: Record<string, unknown> = {
      name: form.name.trim(),
      enabled: form.enabled,
      schedule,
      categoryId: form.categoryId,
      public: publicConfig,
      // Preserve notify prefs (out of this form's scope) on edit so a
      // full-replace update doesn't reset them to defaults.
      ...(preserved.notify !== undefined ? { notify: preserved.notify } : {}),
    };

    if (form.type === "http") {
      const auth: HttpConfig["auth"] =
        form.authType === "basic"
          ? {
              type: "basic",
              username: form.authUsername,
              password: form.authPassword,
            }
          : form.authType === "bearer"
            ? { type: "bearer", token: form.authToken }
            : { type: "none" };

      const config: HttpConfig = {
        url: form.url.trim(),
        method: form.method,
        headers: form.headers.filter((h) => h.name.trim() !== ""),
        auth,
        timeoutMs: form.timeoutMs,
        warmupTimeoutMs: form.warmupTimeoutMs,
        followRedirects: form.followRedirects,
        expectedStatus: { min: form.expectedMin, max: form.expectedMax },
      };
      if (showBody && form.body.trim() !== "") config.body = form.body;
      if (form.degradedResponseMs.trim() !== "")
        config.degradedResponseMs = Number(form.degradedResponseMs);
      if (form.failResponseMs.trim() !== "")
        config.failResponseMs = Number(form.failResponseMs);

      const assertions: Assertion[] = form.assertions.map((a): Assertion => {
        switch (a.kind) {
          case "contains":
          case "not_contains":
            return { kind: a.kind, value: a.value, caseSensitive: a.caseSensitive };
          case "not_empty":
          case "is_json":
            return { kind: a.kind };
          case "json_path_exists":
            return { kind: a.kind, path: a.path };
          case "json_path_equals":
          case "json_path_contains":
            return { kind: a.kind, path: a.path, value: a.value };
        }
      });

      return { type: "http", ...common, config, assertions };
    }

    const config: HeartbeatConfig = {
      intervalSeconds: form.intervalSeconds,
      graceSeconds: form.graceSeconds,
    };
    if (form.secret.trim() !== "") config.secret = form.secret.trim();
    if (form.acceptedMethods.length > 0)
      config.acceptedMethods = form.acceptedMethods;

    return { type: "heartbeat", ...common, config };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      const payload = buildPayload();
      const result = await api<{ monitor: { id: string } }>(
        isEdit ? `/api/monitors/${id}` : "/api/monitors",
        {
          method: isEdit ? "PUT" : "POST",
          json: payload,
          csrf: csrf ?? undefined,
        },
      );
      navigate(`/monitors/${result.monitor.id}`);
    } catch (err) {
      setErrors(errorMessages(err));
      window.scrollTo({ top: 0, behavior: "smooth" });
      // Defer to after the summary renders, then move focus to it.
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          {loadError}
        </div>
        <Link
          to="/monitors"
          className="mt-4 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="size-4" /> Back to monitors
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <Link
          to={cancelTo}
          className="inline-flex items-center gap-1.5 text-xs text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="size-3.5" />
          {isEdit ? "Back to monitor" : "Back to monitors"}
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">
          {isEdit ? "Edit monitor" : "New monitor"}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {form.type === "http"
            ? "Poll an HTTP endpoint and assert on its response."
            : "Expect a periodic ping from a job or device."}
        </p>
      </div>

      {errors.length > 0 && (
        <div
          ref={errorSummaryRef}
          role="alert"
          tabIndex={-1}
          className="mb-5 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down outline-none"
        >
          <p className="font-medium">Please fix the following:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {errors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* 1. Basics */}
        <FormCard title="Basics">
          <Field label="Name" required>
            <input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="My API"
              required
              className="input"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Type"
              hint={isEdit ? "Type can't be changed after creation." : undefined}
            >
              <select
                value={form.type}
                disabled={isEdit}
                onChange={(e) => set("type", e.target.value as MonitorType)}
                className="input disabled:opacity-60"
              >
                <option value="http">HTTP</option>
                <option value="heartbeat">Heartbeat</option>
              </select>
            </Field>
            <div className="flex items-end">
              <Checkbox
                label="Enabled"
                checked={form.enabled}
                onChange={(v) => set("enabled", v)}
              />
            </div>
          </div>
        </FormCard>

        {/* 2. HTTP config */}
        {form.type === "http" && (
          <FormCard title="Request" description="What to send and how to read the response.">
            <Field label="URL" required>
              <input
                value={form.url}
                onChange={(e) => set("url", e.target.value)}
                placeholder="https://example.com/health"
                type="url"
                required
                className="input"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Method">
                <select
                  value={form.method}
                  onChange={(e) => set("method", e.target.value as HttpMethod)}
                  className="input"
                >
                  {HTTP_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Timeout (ms)">
                <input
                  type="number"
                  min={1000}
                  max={120000}
                  value={form.timeoutMs}
                  onChange={(e) => set("timeoutMs", Number(e.target.value))}
                  className="input"
                />
              </Field>
              <Field label="Warmup timeout (ms)" hint="Grace on first check">
                <input
                  type="number"
                  min={1000}
                  max={300000}
                  value={form.warmupTimeoutMs}
                  onChange={(e) =>
                    set("warmupTimeoutMs", Number(e.target.value))
                  }
                  className="input"
                />
              </Field>
            </div>

            {/* Headers */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-ink-muted">
                  Custom headers
                </span>
                <SecondaryButton onClick={addHeader}>
                  <Plus className="size-3.5" /> Add header
                </SecondaryButton>
              </div>
              {form.headers.length === 0 ? (
                <p className="text-xs text-ink-faint">No custom headers.</p>
              ) : (
                <div className="space-y-2">
                  {form.headers.map((h, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={h.name}
                        onChange={(e) =>
                          updateHeader(i, { name: e.target.value })
                        }
                        placeholder="Header name"
                        aria-label="Header name"
                        className="input"
                      />
                      <input
                        value={h.value}
                        onChange={(e) =>
                          updateHeader(i, { value: e.target.value })
                        }
                        placeholder="Value"
                        aria-label="Header value"
                        className="input"
                      />
                      <IconButton
                        label="Remove header"
                        onClick={() => removeHeader(i)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Body */}
            {showBody && (
              <Field label="Request body" hint="Sent verbatim. Set a Content-Type header as needed.">
                <textarea
                  value={form.body}
                  onChange={(e) => set("body", e.target.value)}
                  rows={4}
                  placeholder='{"ping":true}'
                  className="input font-mono"
                />
              </Field>
            )}

            {/* Auth */}
            <Field label="Authentication">
              <select
                value={form.authType}
                onChange={(e) => set("authType", e.target.value as AuthType)}
                className="input"
              >
                <option value="none">None</option>
                <option value="basic">Basic</option>
                <option value="bearer">Bearer token</option>
              </select>
            </Field>
            {form.authType === "basic" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Username">
                  <input
                    value={form.authUsername}
                    onChange={(e) => set("authUsername", e.target.value)}
                    autoComplete="off"
                    className="input"
                  />
                </Field>
                <Field label="Password">
                  <input
                    type="password"
                    value={form.authPassword}
                    onChange={(e) => set("authPassword", e.target.value)}
                    autoComplete="off"
                    className="input"
                  />
                </Field>
              </div>
            )}
            {form.authType === "bearer" && (
              <Field label="Token">
                <input
                  type="password"
                  value={form.authToken}
                  onChange={(e) => set("authToken", e.target.value)}
                  autoComplete="off"
                  className="input"
                />
              </Field>
            )}

            {/* Status + redirects */}
            <div className="grid items-end gap-4 sm:grid-cols-3">
              <Field label="Expected status min">
                <input
                  type="number"
                  min={100}
                  max={599}
                  value={form.expectedMin}
                  onChange={(e) => set("expectedMin", Number(e.target.value))}
                  className="input"
                />
              </Field>
              <Field label="Expected status max">
                <input
                  type="number"
                  min={100}
                  max={599}
                  value={form.expectedMax}
                  onChange={(e) => set("expectedMax", Number(e.target.value))}
                  className="input"
                />
              </Field>
              <Checkbox
                label="Follow redirects"
                checked={form.followRedirects}
                onChange={(v) => set("followRedirects", v)}
              />
            </div>

            {/* Latency thresholds */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Degraded above (ms)"
                hint="Optional. Mark degraded over this response time."
              >
                <input
                  type="number"
                  min={1}
                  value={form.degradedResponseMs}
                  onChange={(e) => set("degradedResponseMs", e.target.value)}
                  placeholder="—"
                  className="input"
                />
              </Field>
              <Field
                label="Fail above (ms)"
                hint="Optional. Treat as down over this response time."
              >
                <input
                  type="number"
                  min={1}
                  value={form.failResponseMs}
                  onChange={(e) => set("failResponseMs", e.target.value)}
                  placeholder="—"
                  className="input"
                />
              </Field>
            </div>
          </FormCard>
        )}

        {/* 3. Assertions */}
        {form.type === "http" && (
          <FormCard
            title="Assertions"
            description="Optional checks on the response body. All must pass."
          >
            {form.assertions.length === 0 ? (
              <p className="text-xs text-ink-faint">No assertions configured.</p>
            ) : (
              <div className="space-y-3">
                {form.assertions.map((a, i) => {
                  const needsValue =
                    a.kind === "contains" ||
                    a.kind === "not_contains" ||
                    a.kind === "json_path_equals" ||
                    a.kind === "json_path_contains";
                  const needsPath =
                    a.kind === "json_path_exists" ||
                    a.kind === "json_path_equals" ||
                    a.kind === "json_path_contains";
                  const needsCase =
                    a.kind === "contains" || a.kind === "not_contains";
                  return (
                    <div
                      key={i}
                      className="rounded-lg border border-line bg-surface-2/40 p-3"
                    >
                      <div className="flex items-center gap-2">
                        <select
                          value={a.kind}
                          onChange={(e) =>
                            updateAssertion(i, {
                              kind: e.target.value as AssertionKind,
                            })
                          }
                          className="input"
                        >
                          {ASSERTION_KINDS.map((k) => (
                            <option key={k.value} value={k.value}>
                              {k.label}
                            </option>
                          ))}
                        </select>
                        <IconButton
                          label="Remove assertion"
                          onClick={() => removeAssertion(i)}
                        />
                      </div>
                      {(needsPath || needsValue) && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          {needsPath && (
                            <input
                              value={a.path}
                              onChange={(e) =>
                                updateAssertion(i, { path: e.target.value })
                              }
                              placeholder="JSON path e.g. data.status"
                              aria-label="JSON path"
                              className="input font-mono"
                            />
                          )}
                          {needsValue && (
                            <input
                              value={a.value}
                              onChange={(e) =>
                                updateAssertion(i, { value: e.target.value })
                              }
                              placeholder="Expected value"
                              aria-label="Assertion value"
                              className="input"
                            />
                          )}
                        </div>
                      )}
                      {needsCase && (
                        <div className="mt-2">
                          <Checkbox
                            label="Case sensitive"
                            checked={a.caseSensitive}
                            onChange={(v) =>
                              updateAssertion(i, { caseSensitive: v })
                            }
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <SecondaryButton onClick={addAssertion}>
              <Plus className="size-3.5" /> Add assertion
            </SecondaryButton>
          </FormCard>
        )}

        {/* 4. Heartbeat config */}
        {form.type === "heartbeat" && (
          <FormCard
            title="Heartbeat"
            description="A ping URL is generated on save; we alert if it goes silent."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Interval (seconds)" hint="How often a ping is expected.">
                <input
                  type="number"
                  min={60}
                  max={2592000}
                  value={form.intervalSeconds}
                  onChange={(e) =>
                    set("intervalSeconds", Number(e.target.value))
                  }
                  className="input"
                />
              </Field>
              <Field label="Grace (seconds)" hint="Lateness allowed before alerting.">
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={form.graceSeconds}
                  onChange={(e) => set("graceSeconds", Number(e.target.value))}
                  className="input"
                />
              </Field>
            </div>
            <Field
              label="Shared secret"
              hint="Optional. Required on the ping request when set."
            >
              <input
                type="password"
                value={form.secret}
                onChange={(e) => set("secret", e.target.value)}
                autoComplete="off"
                placeholder="Optional"
                className="input"
              />
            </Field>
            <div>
              <span className="mb-1.5 block text-xs font-medium text-ink-muted">
                Accepted methods
              </span>
              <p className="mb-2 text-xs text-ink-faint">
                Leave all unchecked to accept any method.
              </p>
              <div className="flex flex-wrap gap-2">
                {HTTP_METHODS.map((m) => (
                  <ToggleChip
                    key={m}
                    active={form.acceptedMethods.includes(m)}
                    onClick={() =>
                      set("acceptedMethods", toggle(form.acceptedMethods, m))
                    }
                  >
                    {m}
                  </ToggleChip>
                ))}
              </div>
            </div>
          </FormCard>
        )}

        {/* 5. Schedule */}
        <FormCard
          title="Schedule"
          description="When this monitor is expected to be up."
        >
          <Field label="Mode">
            <select
              value={form.scheduleMode}
              onChange={(e) =>
                set("scheduleMode", e.target.value as ScheduleMode)
              }
              className="input"
            >
              <option value="always">Always</option>
              <option value="business_hours">Business hours</option>
              <option value="custom">Custom</option>
            </select>
          </Field>

          {form.scheduleMode === "business_hours" && (
            <>
              <div>
                <span className="mb-1.5 block text-xs font-medium text-ink-muted">
                  Active days
                </span>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((label, i) => (
                    <ToggleChip
                      key={i}
                      active={form.bizWeekdays.includes(i)}
                      onClick={() =>
                        set("bizWeekdays", toggle(form.bizWeekdays, i))
                      }
                    >
                      {label}
                    </ToggleChip>
                  ))}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Start">
                  <input
                    type="time"
                    value={form.bizStart}
                    onChange={(e) => set("bizStart", e.target.value)}
                    className="input"
                  />
                </Field>
                <Field label="End">
                  <input
                    type="time"
                    value={form.bizEnd}
                    onChange={(e) => set("bizEnd", e.target.value)}
                    className="input"
                  />
                </Field>
                <Field label="Timezone">
                  <select
                    value={form.bizTimezone}
                    onChange={(e) => set("bizTimezone", e.target.value)}
                    className="input"
                  >
                    {tzList.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </>
          )}

          {form.scheduleMode === "custom" && (
            <>
              <Field label="Timezone">
                <select
                  value={form.customTimezone}
                  onChange={(e) => set("customTimezone", e.target.value)}
                  className="input"
                >
                  {tzList.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </Field>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-muted">
                    Active periods by day
                  </span>
                  <SecondaryButton onClick={addCustomDay}>
                    <Plus className="size-3.5" /> Add day
                  </SecondaryButton>
                </div>
                {form.customDays.length === 0 ? (
                  <p className="text-xs text-ink-faint">No days configured.</p>
                ) : (
                  <div className="space-y-3">
                    {form.customDays.map((d, di) => (
                      <div
                        key={di}
                        className="rounded-lg border border-line bg-surface-2/40 p-3"
                      >
                        <div className="flex items-center gap-2">
                          <select
                            value={d.weekday}
                            onChange={(e) =>
                              updateCustomDay(di, {
                                weekday: Number(e.target.value),
                              })
                            }
                            className="input"
                          >
                            {WEEKDAYS.map((label, i) => (
                              <option key={i} value={i}>
                                {label}
                              </option>
                            ))}
                          </select>
                          <IconButton
                            label="Remove day"
                            onClick={() => removeCustomDay(di)}
                          />
                        </div>
                        <div className="mt-2 space-y-2">
                          {d.periods.map((p, pi) => (
                            <div key={pi} className="flex items-center gap-2">
                              <input
                                type="time"
                                value={p.start}
                                onChange={(e) =>
                                  updatePeriod(di, pi, { start: e.target.value })
                                }
                                aria-label="Start time"
                                className="input"
                              />
                              <span className="text-xs text-ink-faint">to</span>
                              <input
                                type="time"
                                value={p.end}
                                onChange={(e) =>
                                  updatePeriod(di, pi, { end: e.target.value })
                                }
                                aria-label="End time"
                                className="input"
                              />
                              <IconButton
                                label="Remove period"
                                onClick={() => removePeriod(di, pi)}
                              />
                            </div>
                          ))}
                          <SecondaryButton onClick={() => addPeriod(di)}>
                            <Plus className="size-3.5" /> Add period
                          </SecondaryButton>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Field
                label="Excluded dates"
                hint="Comma-separated YYYY-MM-DD (e.g. holidays)."
              >
                <input
                  value={form.customExcludedDates}
                  onChange={(e) => set("customExcludedDates", e.target.value)}
                  placeholder="2026-12-25, 2027-01-01"
                  className="input"
                />
              </Field>
            </>
          )}
        </FormCard>

        {/* 6. Status page */}
        <FormCard
          title="Status page"
          description="Group this monitor and control its visibility on public status pages."
        >
          <Field
            label="Category"
            hint="Groups the monitor on category status pages."
          >
            <select
              value={form.categoryId ?? ""}
              onChange={(e) => set("categoryId", e.target.value || null)}
              className="input"
            >
              <option value="">None</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </Field>
          <Checkbox
            label="Show on public status pages"
            checked={form.publicVisible}
            onChange={(v) => set("publicVisible", v)}
          />
        </FormCard>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-1">
          <Link
            to={cancelTo}
            className="inline-flex items-center rounded-lg px-3 py-2 text-sm text-ink-muted transition-colors hover:text-ink"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {isEdit ? "Save changes" : "Create monitor"}
          </button>
        </div>
      </form>
    </div>
  );
}

// --- Small presentational helpers ---

function FormCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
        )}
      </div>
      {children}
    </Card>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-muted">
        {label}
        {required && (
          <span className="text-down" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-accent"
      />
      {label}
    </label>
  );
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-accent bg-accent-soft text-ink"
          : "border-line text-ink-muted hover:bg-surface-2",
      )}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-down"
    >
      <Trash2 className="size-4" />
    </button>
  );
}
