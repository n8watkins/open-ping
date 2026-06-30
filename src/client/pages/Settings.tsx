import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Loader2,
  Settings as SettingsIcon,
  Database,
  Gauge,
  ServerCog,
  Info,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { api, ApiError } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { Card, CardHeader, CardTitle } from "../components/ui/Card";
import { Stat } from "../components/ui/Stat";
import { formatMs, formatRelativeTime } from "../lib/format";
import { cn } from "../lib/cn";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppSettings {
  timezone?: string | null;
  app_url?: string | null;
  email_from?: string | null;
  [key: string]: unknown;
}
interface SettingsResponse {
  settings: AppSettings;
}

interface SchedulerRun {
  id: string;
  cron: string | null;
  startedAt: number;
  finishedAt: number | null;
  ok: number | null;
  monitorsChecked: number | null;
  monitorsSkipped: number | null;
  checkFailures: number | null;
  notificationFailures: number | null;
  durationMs: number | null;
  error: string | null;
}
interface DiagnosticsResponse {
  version: string;
  dbOk: boolean;
  lastSuccessfulRun: SchedulerRun | null;
  lastFailedRun: SchedulerRun | null;
  recentRuns: SchedulerRun[];
  counts: Record<string, number>;
}

interface RetentionConfig {
  sampleHours: number;
  hourlyDays: number;
  dailyDays: number;
}
interface UsageResponse {
  scheduledExecutionsPerDay: number;
  httpChecksPerDay: number;
  dbReadsPerDayEstimate: number;
  dbWritesPerDayEstimate: number;
  estimatedDbBytes: number;
  note: string;
  intervalSeconds: number;
  retention: RetentionConfig;
  counts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const d = e.data as { error?: string } | null;
    if (d && typeof d.error === "string") return d.error;
  }
  return e instanceof Error ? e.message : fallback;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

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

const NAV = [
  { id: "general", label: "General", icon: <SettingsIcon className="size-4" /> },
  { id: "retention", label: "Data retention", icon: <Database className="size-4" /> },
  { id: "usage", label: "Usage estimates", icon: <Gauge className="size-4" /> },
  { id: "diagnostics", label: "Diagnostics", icon: <ServerCog className="size-4" /> },
  { id: "about", label: "About", icon: <Info className="size-4" /> },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Settings() {
  const { csrf } = useBootstrap();

  const {
    data: settingsData,
    loading: settingsLoading,
    error: settingsError,
    reload: reloadSettings,
  } = useFetch<SettingsResponse>("/api/settings");
  const { data: usageData, loading: usageLoading, error: usageError } =
    useFetch<UsageResponse>("/api/diagnostics/usage");
  const { data: diagData, loading: diagLoading, error: diagError } =
    useFetch<DiagnosticsResponse>("/api/diagnostics");

  return (
    <div className="mx-auto max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Installation configuration, usage estimates, and diagnostics.
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[180px_1fr]">
        <nav className="hidden lg:block">
          <ul className="sticky top-6 space-y-1">
            {NAV.map((n) => (
              <li key={n.id}>
                <a
                  href={`#${n.id}`}
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  {n.icon}
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-6">
          <GeneralSection
            settings={settingsData?.settings ?? null}
            loading={settingsLoading && !settingsData}
            error={settingsError}
            csrf={csrf ?? undefined}
            onSaved={() => void reloadSettings()}
          />
          <RetentionSection
            retention={usageData?.retention ?? null}
            loading={usageLoading && !usageData}
            error={usageError}
          />
          <UsageSection
            usage={usageData ?? null}
            loading={usageLoading && !usageData}
            error={usageError}
          />
          <DiagnosticsSection
            diag={diagData ?? null}
            loading={diagLoading && !diagData}
            error={diagError}
          />
          <AboutSection version={diagData?.version ?? null} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function GeneralSection({
  settings,
  loading,
  error,
  csrf,
  onSaved,
}: {
  settings: AppSettings | null;
  loading: boolean;
  error: string | null;
  csrf: string | undefined;
  onSaved: () => void;
}) {
  const tzList = useMemo(timezones, []);
  const [timezone, setTimezone] = useState(guessTimezone);
  const [appUrl, setAppUrl] = useState("");
  const [emailFrom, setEmailFrom] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      setTimezone(settings.timezone ?? guessTimezone());
      setAppUrl(settings.app_url ?? "");
      setEmailFrom(settings.email_from ?? "");
    }
  }, [settings]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await api("/api/settings", {
        method: "PUT",
        csrf,
        json: {
          settings: {
            timezone,
            app_url: appUrl,
            email_from: emailFrom,
          },
        },
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setSaveError(errMessage(e, "Could not save settings."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section id="general" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>

        {loading ? (
          <SectionSpinner />
        ) : error ? (
          <ErrorBanner>Could not load settings: {error}</ErrorBanner>
        ) : (
          <div className="space-y-4">
            <Field
              label="Timezone"
              hint="Used for schedules, maintenance windows, and reporting."
            >
              <select
                value={timezone}
                onChange={(e) => {
                  setTimezone(e.target.value);
                  setSaved(false);
                }}
                className="input"
              >
                {!tzList.includes(timezone) && timezone && (
                  <option value={timezone}>{timezone}</option>
                )}
                {tzList.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Installation URL"
              hint="Public base URL — used for links in notifications and OAuth redirects."
            >
              <input
                value={appUrl}
                onChange={(e) => {
                  setAppUrl(e.target.value);
                  setSaved(false);
                }}
                placeholder="https://status.example.com"
                type="url"
                className="input"
              />
            </Field>

            <Field
              label="Email from address"
              hint="The sender address used for email notifications."
            >
              <input
                value={emailFrom}
                onChange={(e) => {
                  setEmailFrom(e.target.value);
                  setSaved(false);
                }}
                placeholder="openping@example.com"
                type="email"
                className="input"
              />
            </Field>

            {saveError && <ErrorBanner>{saveError}</ErrorBanner>}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
              >
                {saving && <Loader2 className="size-4 animate-spin" />}
                Save changes
              </button>
              {saved && !saving && (
                <span
                  role="status"
                  className="inline-flex items-center gap-1.5 text-sm text-up"
                >
                  <CheckCircle2 className="size-4" />
                  Saved
                </span>
              )}
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Data retention
// ---------------------------------------------------------------------------

function RetentionSection({
  retention,
  loading,
  error,
}: {
  retention: RetentionConfig | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <section id="retention" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle>Data retention</CardTitle>
        </CardHeader>
        {loading ? (
          <SectionSpinner />
        ) : error ? (
          <ErrorBanner>Could not load retention config: {error}</ErrorBanner>
        ) : retention ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Card className="bg-surface-2/40 p-4">
                <Stat label="Raw samples" value={`${retention.sampleHours} h`} />
              </Card>
              <Card className="bg-surface-2/40 p-4">
                <Stat
                  label="Hourly summaries"
                  value={`${retention.hourlyDays} d`}
                />
              </Card>
              <Card className="bg-surface-2/40 p-4">
                <Stat
                  label="Daily summaries"
                  value={`${retention.dailyDays} d`}
                />
              </Card>
            </div>
            <p className="mt-3 text-xs text-ink-faint">
              Older data is rolled up into summaries and pruned automatically.
            </p>
          </>
        ) : (
          <p className="text-sm text-ink-muted">No retention config available.</p>
        )}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Usage estimates
// ---------------------------------------------------------------------------

function UsageSection({
  usage,
  loading,
  error,
}: {
  usage: UsageResponse | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <section id="usage" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle>Usage estimates</CardTitle>
          <span className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-ink-muted">
            OpenPing estimates, not Cloudflare billing
          </span>
        </CardHeader>
        {loading ? (
          <SectionSpinner />
        ) : error ? (
          <ErrorBanner>Could not load usage estimates: {error}</ErrorBanner>
        ) : usage ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Card className="bg-surface-2/40 p-4">
                <Stat
                  label="Scheduled executions / day"
                  value={usage.scheduledExecutionsPerDay.toLocaleString()}
                />
              </Card>
              <Card className="bg-surface-2/40 p-4">
                <Stat
                  label="HTTP checks / day"
                  value={usage.httpChecksPerDay.toLocaleString()}
                />
              </Card>
              <Card className="bg-surface-2/40 p-4">
                <Stat
                  label="Estimated DB size"
                  value={formatBytes(usage.estimatedDbBytes)}
                />
              </Card>
            </div>
            <p className="mt-3 text-xs text-ink-faint">{usage.note}</p>
          </>
        ) : (
          <p className="text-sm text-ink-muted">No usage data available.</p>
        )}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function DiagnosticsSection({
  diag,
  loading,
  error,
}: {
  diag: DiagnosticsResponse | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <section id="diagnostics" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle>Diagnostics</CardTitle>
          {diag && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
                diag.dbOk
                  ? "border-up/40 bg-up/10 text-up"
                  : "border-down/40 bg-down/10 text-down",
              )}
            >
              {diag.dbOk ? (
                <CheckCircle2 className="size-3.5" />
              ) : (
                <XCircle className="size-3.5" />
              )}
              Database {diag.dbOk ? "reachable" : "unreachable"}
            </span>
          )}
        </CardHeader>

        {loading ? (
          <SectionSpinner />
        ) : error ? (
          <ErrorBanner>Could not load diagnostics: {error}</ErrorBanner>
        ) : diag ? (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KeyVal
                label="Last successful run"
                value={
                  diag.lastSuccessfulRun
                    ? formatRelativeTime(diag.lastSuccessfulRun.startedAt)
                    : "—"
                }
              />
              <KeyVal
                label="Last failed run"
                value={
                  diag.lastFailedRun
                    ? formatRelativeTime(diag.lastFailedRun.startedAt)
                    : "Never"
                }
                valueClass={diag.lastFailedRun ? "text-down" : undefined}
              />
              <KeyVal
                label="Monitors"
                value={`${diag.counts.monitorsEnabled ?? 0}/${diag.counts.monitors ?? 0}`}
              />
              <KeyVal
                label="Open incidents"
                value={(diag.counts.incidentsOpen ?? 0).toLocaleString()}
                valueClass={diag.counts.incidentsOpen ? "text-down" : undefined}
              />
            </div>

            {/* Recent scheduler runs */}
            <div>
              <h4 className="mb-2 text-xs font-medium text-ink-muted">
                Recent scheduler runs
              </h4>
              {diag.recentRuns.length === 0 ? (
                <p className="text-sm text-ink-faint">No runs recorded yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-line text-xs text-ink-faint">
                        <th scope="col" className="px-3 py-2 font-medium">Cron</th>
                        <th scope="col" className="px-3 py-2 font-medium">Started</th>
                        <th scope="col" className="px-3 py-2 font-medium">Status</th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          Checked
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          Failures
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          Duration
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {diag.recentRuns.map((run) => (
                        <tr key={run.id} className="text-ink-muted">
                          <td className="px-3 py-2 font-mono text-xs text-ink-faint">
                            {run.cron ?? "—"}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {formatRelativeTime(run.startedAt)}
                          </td>
                          <td className="px-3 py-2">
                            {run.ok == null ? (
                              <span className="text-ink-faint">running…</span>
                            ) : run.ok === 1 ? (
                              <span className="inline-flex items-center gap-1 text-up">
                                <CheckCircle2 className="size-3.5" /> ok
                              </span>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 text-down"
                                title={run.error ?? undefined}
                              >
                                <XCircle className="size-3.5" /> failed
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {run.monitorsChecked ?? 0}
                          </td>
                          <td
                            className={cn(
                              "px-3 py-2 text-right tabular-nums",
                              (run.checkFailures ?? 0) > 0 && "text-down",
                            )}
                          >
                            {run.checkFailures ?? 0}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatMs(run.durationMs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Counts */}
            <div>
              <h4 className="mb-2 text-xs font-medium text-ink-muted">
                Table counts
              </h4>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                <KeyVal label="Samples" value={fmt(diag.counts.samples)} />
                <KeyVal label="Summaries" value={fmt(diag.counts.summaries)} />
                <KeyVal label="Channels" value={fmt(diag.counts.channels)} />
                <KeyVal
                  label="Push devices"
                  value={fmt(diag.counts.pushSubscriptions)}
                />
                <KeyVal
                  label="Outbox pending"
                  value={fmt(diag.counts.outboxPending)}
                />
                <KeyVal
                  label="Outbox dead"
                  value={fmt(diag.counts.outboxDead)}
                  valueClass={diag.counts.outboxDead ? "text-down" : undefined}
                />
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-muted">No diagnostics available.</p>
        )}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function AboutSection({ version }: { version: string | null }) {
  return (
    <section id="about" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle>About</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink-muted">
          <span>
            <span className="text-ink-faint">OpenPing version</span>{" "}
            <span className="font-mono text-ink">{version ?? "—"}</span>
          </span>
          <span className="text-ink-faint">
            Self-hosted uptime monitoring on Cloudflare Workers.
          </span>
        </div>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function fmt(n: number | undefined): string {
  return (n ?? 0).toLocaleString();
}

function SectionSpinner() {
  return (
    <div className="grid place-items-center py-10">
      <Loader2 className="size-5 animate-spin text-ink-faint" />
    </div>
  );
}

function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down"
    >
      {children}
    </p>
  );
}

function KeyVal({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2">
      <div className="text-xs text-ink-faint">{label}</div>
      <div className={cn("mt-0.5 text-sm font-medium text-ink", valueClass)}>
        {value}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}
