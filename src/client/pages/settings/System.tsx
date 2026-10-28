import { useState } from "react";
import { CheckCircle2, ChevronDown, ExternalLink, XCircle } from "lucide-react";
import { useFetch } from "../../lib/useFetch";
import { formatMs, formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { Stat } from "../../components/ui/Stat";
import { Chip, ErrorBanner, KeyVal, SectionSkeleton, fmt } from "./shared";

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

/** How many scheduler runs show before "Show all". */
const RUNS_SHOWN = 5;
const REPO_URL = "https://github.com/n8watkins/open-ping";

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

/** Tooltip for a run's Re-checks cell. */
function recheckTitle(run: SchedulerRun): string | undefined {
  if (run.confirmations == null) return undefined;
  const parts = [
    `${run.confirmations} second check${run.confirmations === 1 ? "" : "s"} before alerting`,
    `${run.confirmationsCleared ?? 0} passed (no incident)`,
  ];
  if ((run.confirmationsDeferred ?? 0) > 0) {
    parts.push(`${run.confirmationsDeferred} left for the next run (budget or RDAP rate limit)`);
  }
  return parts.join(", ");
}

/** Settings > System: scheduler health, the database, usage and retention, and the version. */
export default function SystemSettings() {
  const diag = useFetch<DiagnosticsResponse>("/api/diagnostics");
  const usage = useFetch<UsageResponse>("/api/diagnostics/usage");
  return (
    <div className="stagger space-y-6 [&>*]:animate-enter">
      <SchedulerCard diag={diag.data} loading={diag.loading && !diag.data} error={diag.data ? null : diag.error} />
      <DatabaseCard
        diag={diag.data}
        usage={usage.data}
        loading={diag.loading && !diag.data}
        error={diag.data ? null : diag.error}
      />
      <UsageCard usage={usage.data} loading={usage.loading && !usage.data} error={usage.data ? null : usage.error} />
      <AboutCard version={diag.data?.version ?? null} />
    </div>
  );
}

function SchedulerCard({
  diag,
  loading,
  error,
}: {
  diag: DiagnosticsResponse | null;
  loading: boolean;
  error: string | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const runs = diag ? (showAll ? diag.recentRuns : diag.recentRuns.slice(0, RUNS_SHOWN)) : [];
  const hidden = diag ? diag.recentRuns.length - RUNS_SHOWN : 0;
  const lastOk = diag?.recentRuns[0]?.ok;

  return (
    <section id="diagnostics" className="scroll-mt-6">
      <Card className="p-5">
        <CardHeader>
          <CardTitle>Scheduler</CardTitle>
          {diag && diag.recentRuns.length > 0 && (
            <Chip tone={lastOk === 0 ? "down" : "up"}>
              {lastOk === 0 ? <XCircle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
              {lastOk === 0 ? "Last run failed" : "Running normally"}
            </Chip>
          )}
        </CardHeader>
        {loading ? (
          <SectionSkeleton rows={4} />
        ) : error ? (
          <ErrorBanner>Could not load diagnostics: {error}</ErrorBanner>
        ) : diag ? (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KeyVal
                label="Last successful run"
                value={diag.lastSuccessfulRun ? formatRelativeTime(diag.lastSuccessfulRun.startedAt) : "-"}
              />
              <KeyVal
                label="Last failed run"
                value={diag.lastFailedRun ? formatRelativeTime(diag.lastFailedRun.startedAt) : "Never"}
                valueClass={diag.lastFailedRun ? "text-down" : undefined}
              />
              <KeyVal label="Monitors on" value={`${diag.counts.monitorsEnabled ?? 0} of ${diag.counts.monitors ?? 0}`} />
              <KeyVal
                label="Open incidents"
                value={fmt(diag.counts.incidentsOpen)}
                valueClass={diag.counts.incidentsOpen ? "text-down" : undefined}
              />
            </div>

            <div>
              <h4 className="mb-2 text-xs font-medium text-ink-muted">Recent runs</h4>
              {diag.recentRuns.length === 0 ? (
                <p className="text-sm text-ink-faint">No runs recorded yet.</p>
              ) : (
                <>
                  <div className="overflow-x-auto rounded-lg border border-line">
                    <table className="w-full min-w-[640px] text-left text-sm">
                      <thead>
                        <tr className="border-b border-line text-xs text-ink-faint">
                          <th scope="col" className="px-3 py-2 font-medium">Started</th>
                          <th scope="col" className="px-3 py-2 font-medium">Status</th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">Checked</th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">Failures</th>
                          <th
                            scope="col"
                            className="px-3 py-2 text-right font-medium"
                            title="Second checks made before alerting; cleared ones passed, so no incident opened"
                          >
                            Re-checks
                          </th>
                          <th scope="col" className="px-3 py-2 text-right font-medium" title="Database round trips the run made">
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
                        {runs.map((run, i) => (
                          <tr
                            key={run.id}
                            className={cn("text-ink-muted transition-colors hover:bg-surface-2/40", i >= RUNS_SHOWN && "animate-fade")}
                          >
                            <td className="px-3 py-2 whitespace-nowrap" title={run.cron ? `Cron ${run.cron}` : undefined}>
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
                                <span className="inline-flex items-center gap-1 text-down" title={run.error ?? undefined}>
                                  <XCircle className="size-3.5" /> failed
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{run.monitorsChecked ?? 0}</td>
                            <td
                              className={cn("px-3 py-2 text-right tabular-nums", (run.checkFailures ?? 0) > 0 && "text-down")}
                            >
                              {run.checkFailures ?? 0}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums" title={recheckTitle(run)}>
                              {run.confirmations == null ? "-" : run.confirmations}
                              {(run.confirmationsCleared ?? 0) > 0 && (
                                <span className="text-ink-faint"> ({run.confirmationsCleared} cleared)</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{run.d1Queries ?? "-"}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatMs(run.durationMs)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {hidden > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowAll((v) => !v)}
                      aria-expanded={showAll}
                      className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      {showAll ? "Show fewer" : `Show ${hidden} more`}
                      <ChevronDown className={cn("size-3.5 transition-transform duration-200", showAll && "rotate-180")} />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

function DatabaseCard({
  diag,
  usage,
  loading,
  error,
}: {
  diag: DiagnosticsResponse | null;
  usage: UsageResponse | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <section id="database" className="scroll-mt-6">
      <Card className="p-5">
        <CardHeader>
          <CardTitle>Database</CardTitle>
          {diag && (
            <Chip tone={diag.dbOk ? "up" : "down"}>
              {diag.dbOk ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
              {diag.dbOk ? "Reachable" : "Unreachable"}
            </Chip>
          )}
        </CardHeader>
        {loading ? (
          <SectionSkeleton rows={2} />
        ) : error ? (
          <ErrorBanner>Could not load table counts: {error}</ErrorBanner>
        ) : diag ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KeyVal label="Estimated size" value={usage ? formatBytes(usage.estimatedDbBytes) : "-"} />
            <KeyVal label="Samples" value={fmt(diag.counts.samples)} />
            <KeyVal label="Summaries" value={fmt(diag.counts.summaries)} />
            <KeyVal label="Channels" value={fmt(diag.counts.channels)} />
            <KeyVal label="Push devices" value={fmt(diag.counts.pushSubscriptions)} />
            <KeyVal label="Outbox pending" value={fmt(diag.counts.outboxPending)} />
            <KeyVal
              label="Outbox dead"
              value={fmt(diag.counts.outboxDead)}
              valueClass={diag.counts.outboxDead ? "text-down" : undefined}
            />
          </div>
        ) : null}
      </Card>
    </section>
  );
}

function UsageCard({ usage, loading, error }: { usage: UsageResponse | null; loading: boolean; error: string | null }) {
  return (
    <section id="usage" className="scroll-mt-6">
      <Card className="p-5">
        <CardHeader>
          <CardTitle>Usage and retention</CardTitle>
          <Chip tone="neutral">Estimates; the Cloudflare dashboard has the real numbers</Chip>
        </CardHeader>
        {loading ? (
          <SectionSkeleton rows={2} />
        ) : error ? (
          <ErrorBanner>Could not load usage estimates: {error}</ErrorBanner>
        ) : usage ? (
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Card className="bg-surface-2/40 p-4">
                <Stat label="Scheduled runs a day" value={usage.scheduledExecutionsPerDay.toLocaleString()} />
              </Card>
              <Card className="bg-surface-2/40 p-4">
                <Stat label="HTTP checks a day" value={usage.httpChecksPerDay.toLocaleString()} />
              </Card>
              <Card className="bg-surface-2/40 p-4">
                <Stat
                  label="DB reads / writes a day"
                  value={`${usage.dbReadsPerDayEstimate.toLocaleString()} / ${usage.dbWritesPerDayEstimate.toLocaleString()}`}
                />
              </Card>
            </div>
            <div id="retention" className="scroll-mt-6 border-t border-line pt-4">
              <h4 className="mb-2 text-xs font-medium text-ink-muted">Data kept</h4>
              <dl className="grid grid-cols-3 gap-3">
                {[
                  ["Raw samples", `${usage.retention.sampleHours} h`],
                  ["Hourly summaries", `${usage.retention.hourlyDays} d`],
                  ["Daily summaries", `${usage.retention.dailyDays} d`],
                ].map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="truncate text-xs text-ink-faint">{k}</dt>
                    <dd className="mt-0.5 text-sm font-medium tabular-nums text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-ink-faint">Older data is rolled up into summaries and pruned automatically.</p>
            </div>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

function AboutCard({ version }: { version: string | null }) {
  return (
    <section id="about" className="scroll-mt-6">
      <Card className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">
            OpenPing <span className="font-mono text-ink-muted">{version ? `v${version}` : ""}</span>
          </div>
          <p className="text-sm text-ink-muted">Uptime monitoring that runs in your own Cloudflare account.</p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {[
            ["Release notes", `${REPO_URL}/blob/main/CHANGELOG.md`],
            ["Docs", `${REPO_URL}/tree/main/docs`],
            ["Source", REPO_URL],
          ].map(([label, href]) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-ink-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              {label}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ))}
        </div>
      </Card>
    </section>
  );
}
