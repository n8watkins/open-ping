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
  KeyRound,
  RefreshCw,
  FileBarChart,
  Fingerprint,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { installationUrlImpact, installationUrlWarning, type PasskeySignIn } from "../lib/webauthn";
import { api, ApiError } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { Card, CardHeader, CardTitle } from "../components/ui/Card";
import { Stat } from "../components/ui/Stat";
import { formatMs, formatRelativeTime } from "../lib/format";
import { cn } from "../lib/cn";
import { LandingEventsCard } from "../components/LandingEventsCard";
import { ReportsCard } from "../components/ReportsCard";
import { PasskeysCard } from "../components/PasskeysCard";

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
  d1Queries: number | null;
  /** Confirmation re-checks made, passed (blips) and deferred; null before migration 0014. */
  confirmations: number | null;
  confirmationsCleared: number | null;
  confirmationsDeferred: number | null;
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
  { id: "sign-in", label: "Passkeys", icon: <Fingerprint className="size-4" /> },
  { id: "reports", label: "Reports", icon: <FileBarChart className="size-4" /> },
  { id: "retention", label: "Data retention", icon: <Database className="size-4" /> },
  { id: "usage", label: "Usage estimates", icon: <Gauge className="size-4" /> },
  { id: "diagnostics", label: "Diagnostics", icon: <ServerCog className="size-4" /> },
  { id: "encryption", label: "Encryption keys", icon: <KeyRound className="size-4" /> },
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
  // Only the canonical install collects the Hosted waitlist; elsewhere the
  // endpoint doesn't exist, so don't ask (a 404 would log a console error).
  const { status } = useBootstrap();
  const { data: waitlistData } = useFetch<WaitlistResponse>(
    status?.waitlistEnabled ? "/api/waitlist" : null,
  );

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings<span className="text-accent">.</span></h1>
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
          <PasskeysCard csrf={csrf ?? undefined} />
          <ReportsCard
            emailEnabled={settingsData?.settings.monthly_report_enabled === "true"}
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
          <EncryptionSection csrf={csrf ?? undefined} />
          {waitlistData && <WaitlistSection waitlist={waitlistData} />}
          <LandingEventsCard />
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
  // Passkeys are bound to the installation's hostname, so a new hostname
  // strands them (docs/SECURITY.md); ask before saving one.
  const { data: passkeyData } = useFetch<PasskeySignIn>("/api/passkeys");

  useEffect(() => {
    if (settings) {
      setTimezone(settings.timezone ?? guessTimezone());
      setAppUrl(settings.app_url ?? "");
      setEmailFrom(settings.email_from ?? "");
    }
  }, [settings]);

  async function save() {
    const impact = installationUrlImpact(appUrl, settings?.app_url, passkeyData);
    if (impact && !window.confirm(installationUrlWarning(impact))) return;
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
              hint={
                passkeyData?.appUrlFromEnv
                  ? `The APP_URL Worker variable sets this address (${passkeyData.origin}) and takes precedence, so this setting has no effect while it is set.`
                  : "Public base URL, used for links in notifications, OAuth redirects and passkeys. Passkeys work only at this address, so changing it means adding new ones."
              }
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

interface WaitlistResponse {
  count: number;
  entries: { email: string; created_at: number }[];
}

/** The OpenPing Hosted waitlist (canonical install only): the count, the latest sign-ups and a CSV. */
function WaitlistSection({ waitlist }: { waitlist: WaitlistResponse }) {
  return (
    <section id="waitlist" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle>Hosted waitlist</CardTitle>
          <a
            href="/api/waitlist/export.csv"
            className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface"
          >
            Download CSV
          </a>
        </CardHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card className="bg-surface-2/40 p-4">
            <Stat label="People waiting" value={waitlist.count.toLocaleString()} />
          </Card>
          <Card className="bg-surface-2/40 p-4">
            <Stat label="Goal before building Hosted" value="20 in 8 weeks" />
          </Card>
        </div>
        {waitlist.entries.length > 0 ? (
          <ul className="mt-4 divide-y divide-line text-sm">
            {waitlist.entries.slice(0, 10).map((e) => (
              <li key={e.email} className="flex items-center justify-between gap-3 py-2">
                <span className="truncate text-ink">{e.email}</span>
                <span className="shrink-0 text-xs text-ink-faint">{formatRelativeTime(e.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-ink-muted">No one yet. The landing page's pricing section collects sign-ups.</p>
        )}
      </Card>
    </section>
  );
}

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
                    : "-"
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
                  <table className="w-full min-w-[680px] text-left text-sm">
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
                        <th
                          scope="col"
                          className="px-3 py-2 text-right font-medium"
                          title="Second checks made before alerting; cleared ones passed, so no incident opened"
                        >
                          Re-checks
                        </th>
                        <th
                          scope="col"
                          className="px-3 py-2 text-right font-medium"
                          title="Database round trips the run made"
                        >
                          DB calls
                        </th>
                        <th
                          scope="col"
                          className="px-3 py-2 text-right font-medium"
                          title="Wall-clock time, mostly spent waiting on the database"
                        >
                          Duration
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {diag.recentRuns.map((run) => (
                        <tr key={run.id} className="text-ink-muted">
                          <td className="px-3 py-2 font-mono text-xs text-ink-faint">
                            {run.cron ?? "-"}
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
                          <td
                            className="px-3 py-2 text-right tabular-nums whitespace-nowrap"
                            title={recheckTitle(run)}
                          >
                            {run.confirmations == null ? "-" : run.confirmations}
                            {(run.confirmationsCleared ?? 0) > 0 && (
                              <span className="text-ink-faint"> ({run.confirmationsCleared} cleared)</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {run.d1Queries ?? "-"}
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
// Encryption keys (MASTER_KEY rotation)
// ---------------------------------------------------------------------------

interface KeyClassStatus {
  id: string;
  label: string;
  rows: number;
  current: number;
  previous: number;
  legacy: number;
  unsealed: number;
  unreadable: number;
}
interface UnreadableValue {
  class: string;
  id: string;
  field: string;
  reason: string;
}
interface RekeyStatusResponse {
  encryptionConfigured: boolean;
  currentKeyId: string | null;
  previousKey: { configured: boolean; valid: boolean; keyId: string | null; sameAsCurrent: boolean };
  classes: KeyClassStatus[];
  needsReencryption: number;
  dependsOnPreviousKey: number;
  unverified: number;
  unreadable: UnreadableValue[];
  unreadableCount: number;
  safeToRemovePreviousKey: boolean;
  summary: string;
}
interface RekeyBatchResponse {
  done: boolean;
  cursor: string | null;
  stats: {
    scanned: number;
    rewritten: number;
    reencrypted: number;
    sealed: number;
    unchanged: number;
    conflicts: number;
  };
  unreadable: UnreadableValue[];
}
interface PassProgress {
  scanned: number;
  total: number;
  reencrypted: number;
  sealed: number;
  unreadable: number;
}

const UNREADABLE_REASONS: Record<string, string> = {
  unknown_key: "sealed with a key that is not configured",
  decrypt_failed: "opens with neither key",
  invalid_format: "not a recognised ciphertext",
  invalid_json: "stored JSON cannot be read",
  no_key: "no key configured",
};

const RUNBOOK_URL =
  "https://github.com/n8watkins/open-ping/blob/main/docs/SECURITY.md#rotating-master_key";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * MASTER_KEY rotation: which key protects what, and a button that runs the
 * batched re-encryption pass (POST /api/admin/rekey) until it reports done.
 */
function EncryptionSection({ csrf }: { csrf: string | undefined }) {
  const { data, loading, error, reload } =
    useFetch<RekeyStatusResponse>("/api/admin/rekey/status");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<PassProgress | null>(null);
  const [passError, setPassError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  async function reencrypt() {
    if (!data) return;
    const total = data.classes.reduce((n, c) => n + c.rows, 0);
    const p: PassProgress = { scanned: 0, total, reencrypted: 0, sealed: 0, unreadable: 0 };
    setRunning(true);
    setFinished(false);
    setPassError(null);
    setProgress({ ...p });
    try {
      let cursor: string | null = null;
      do {
        const batch: RekeyBatchResponse = await api<RekeyBatchResponse>("/api/admin/rekey", {
          method: "POST",
          csrf,
          json: { cursor },
        });
        p.scanned += batch.stats.scanned;
        p.reencrypted += batch.stats.reencrypted;
        p.sealed += batch.stats.sealed;
        p.unreadable += batch.unreadable.length;
        // Rows created mid-pass can push the count past the starting total.
        p.total = Math.max(p.total, p.scanned);
        setProgress({ ...p });
        cursor = batch.cursor;
      } while (cursor);
      setFinished(true);
    } catch (e) {
      setPassError(errMessage(e, "The re-encryption pass stopped."));
    } finally {
      setRunning(false);
      void reload();
    }
  }

  const blocked =
    !data || !data.encryptionConfigured || (data.previousKey.configured && !data.previousKey.valid);
  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.scanned / progress.total) * 100))
    : running ? 0 : 100;

  return (
    <section id="encryption" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle>Encryption keys</CardTitle>
          {data && <KeyStateBadge status={data} />}
        </CardHeader>

        {loading && !data ? (
          <SectionSpinner />
        ) : error && !data ? (
          <ErrorBanner>Could not load key status: {error}</ErrorBanner>
        ) : data ? (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KeyVal
                label="Current key id"
                value={
                  <span className="font-mono">{data.currentKeyId ?? "Not configured"}</span>
                }
                valueClass={data.currentKeyId ? undefined : "text-down"}
              />
              <KeyVal
                label="Previous key id"
                value={
                  !data.previousKey.configured ? (
                    <span className="text-ink-muted">Not set</span>
                  ) : !data.previousKey.valid ? (
                    "Invalid"
                  ) : (
                    <span className="font-mono">{data.previousKey.keyId}</span>
                  )
                }
                valueClass={
                  data.previousKey.configured && !data.previousKey.valid ? "text-down" : undefined
                }
              />
              <KeyVal
                label="On previous key"
                value={fmt(data.dependsOnPreviousKey)}
                valueClass={data.dependsOnPreviousKey ? "text-degraded" : undefined}
              />
              <KeyVal
                label="Unreadable"
                value={fmt(data.unreadableCount)}
                valueClass={data.unreadableCount ? "text-down" : undefined}
              />
            </div>

            <p
              role="status"
              className={cn(
                "rounded-lg border px-3 py-2 text-sm",
                data.safeToRemovePreviousKey
                  ? "border-up/40 bg-up/10 text-up"
                  : data.unreadableCount || !data.encryptionConfigured
                    ? "border-down/40 bg-down/10 text-down"
                    : "border-line bg-surface-2/40 text-ink-muted",
              )}
            >
              {data.summary}
            </p>

            <div>
              <h4 className="mb-2 text-xs font-medium text-ink-muted">Protected values</h4>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {data.classes.map((c) => (
                  <li
                    key={c.id}
                    className="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                  >
                    <span className="text-sm text-ink">{c.label}</span>
                    <ClassCounts c={c} />
                  </li>
                ))}
              </ul>
            </div>

            {data.unreadable.length > 0 && (
              <div>
                <h4 className="mb-2 text-xs font-medium text-ink-muted">
                  Unreadable values (left unchanged; re-create or delete them)
                </h4>
                <ul className="divide-y divide-line rounded-lg border border-down/40 text-sm">
                  {data.unreadable.map((u) => (
                    <li key={`${u.class}/${u.id}/${u.field}`} className="px-3 py-2">
                      <div className="text-ink">
                        {data.classes.find((c) => c.id === u.class)?.label ?? u.class}
                        <span className="text-ink-faint"> · {u.field}</span>
                      </div>
                      <div className="mt-0.5 break-all font-mono text-xs text-ink-faint">{u.id}</div>
                      <div className="mt-0.5 text-xs text-down">
                        {UNREADABLE_REASONS[u.reason] ?? u.reason}
                      </div>
                    </li>
                  ))}
                </ul>
                {data.unreadableCount > data.unreadable.length && (
                  <p className="mt-2 text-xs text-ink-faint">
                    Showing {data.unreadable.length} of {fmt(data.unreadableCount)}.
                  </p>
                )}
              </div>
            )}

            {progress && (running || finished || passError) && (
              <div className="space-y-2">
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-surface-2"
                  role="progressbar"
                  aria-label="Re-encryption progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                >
                  <div
                    className={cn("h-full rounded-full transition-[width]", passError ? "bg-down" : "bg-accent")}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-xs text-ink-muted">
                  {running
                    ? `Re-encrypting… ${progress.scanned.toLocaleString()} of ${progress.total.toLocaleString()} rows checked`
                    : finished
                      ? passSummary(progress)
                      : `Stopped after ${progress.scanned.toLocaleString()} rows. Running it again resumes safely.`}
                </p>
              </div>
            )}
            {passError && <ErrorBanner>Re-encryption failed: {passError}</ErrorBanner>}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                onClick={() => void reencrypt()}
                disabled={running || blocked}
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
              >
                {running ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Re-encrypt now
              </button>
              <a
                href={RUNBOOK_URL}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
              >
                How to rotate MASTER_KEY
              </a>
            </div>
            <p className="text-xs text-ink-faint">
              Re-encrypting is safe to repeat: it rewrites only values that are not yet on the
              current key, in small batches, and never changes a value it cannot read.
            </p>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

/** "Done: 8 values re-encrypted, 1 unreadable value left unchanged." (zero parts omitted). */
function passSummary(p: PassProgress): string {
  const parts = [
    p.reencrypted ? `${plural(p.reencrypted, "value")} re-encrypted` : null,
    p.sealed ? `${plural(p.sealed, "plaintext value")} encrypted for the first time` : null,
    p.unreadable ? `${plural(p.unreadable, "unreadable value")} left unchanged` : null,
  ].filter(Boolean);
  return parts.length
    ? `Done: ${parts.join(", ")}.`
    : "Done: every value was already on the current key.";
}

function KeyStateBadge({ status }: { status: RekeyStatusResponse }) {
  const [tone, label] = !status.encryptionConfigured
    ? (["down", "Encryption off"] as const)
    : status.previousKey.configured && !status.previousKey.valid
      ? (["down", "Previous key invalid"] as const)
      : status.previousKey.configured
        ? status.safeToRemovePreviousKey
          ? (["up", "Previous key no longer needed"] as const)
          : (["degraded", "Rotation in progress"] as const)
        : (["up", "Single key"] as const);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        tone === "up" && "border-up/40 bg-up/10 text-up",
        tone === "down" && "border-down/40 bg-down/10 text-down",
        tone === "degraded" && "border-degraded/40 bg-degraded/10 text-degraded",
      )}
    >
      <KeyRound className="size-3.5" />
      {label}
    </span>
  );
}

function ClassCounts({ c }: { c: KeyClassStatus }) {
  const parts: { text: string; className: string }[] = [];
  if (c.current) parts.push({ text: `${fmt(c.current)} current`, className: "text-ink-muted" });
  if (c.previous) parts.push({ text: `${fmt(c.previous)} previous key`, className: "text-degraded" });
  if (c.legacy) parts.push({ text: `${fmt(c.legacy)} legacy format`, className: "text-degraded" });
  if (c.unsealed) parts.push({ text: `${fmt(c.unsealed)} not encrypted`, className: "text-degraded" });
  if (c.unreadable) parts.push({ text: `${fmt(c.unreadable)} unreadable`, className: "text-down" });
  if (parts.length === 0) {
    return <span className="text-xs text-ink-faint">Nothing stored</span>;
  }
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">
      {parts.map((p) => (
        <span key={p.text} className={p.className}>
          {p.text}
        </span>
      ))}
    </span>
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
            <span className="font-mono text-ink">{version ?? "-"}</span>
          </span>
          <span className="text-ink-faint">
            Uptime monitoring that runs in your own Cloudflare account.
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

/** Tooltip for a run's Re-checks cell. */
function recheckTitle(run: SchedulerRun): string | undefined {
  if (run.confirmations == null) return undefined;
  const parts = [
    `${run.confirmations} second check${run.confirmations === 1 ? "" : "s"} before alerting`,
    `${run.confirmationsCleared ?? 0} passed (no incident)`,
  ];
  if ((run.confirmationsDeferred ?? 0) > 0) {
    parts.push(`${run.confirmationsDeferred} left for the next run (budget)`);
  }
  return parts.join(", ");
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
