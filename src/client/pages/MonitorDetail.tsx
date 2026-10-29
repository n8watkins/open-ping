import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Loader2,
  Play,
  Pause,
  Pencil,
  Trash2,
  Copy,
  Check,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { api, ApiError, safeHttpUrl } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { cn } from "../lib/cn";
import {
  formatMs,
  formatRelativeTime,
  formatDuration,
  formatDateTime,
  formatShortDateTime,
} from "../lib/format";
import { STATE_META, type MonitorState } from "../../shared/states";
import { monitorTypeLabel, type MonitorType } from "../lib/types";
import { StatusPill } from "../components/ui/StatusPill";
import { Card, CardHeader, CardTitle } from "../components/ui/Card";
import { RangeControl } from "../components/ui/RangeControl";
import { Skeleton } from "../components/ui/Skeleton";
import { describeCause } from "../components/incidents/grouping";
import {
  AvailabilityCard,
  ResponseCard,
  type DowntimeWindows,
  type UptimeWindows,
} from "../components/charts/MonitorHistoryPanel";
import { useTimeRange } from "../lib/time-range";
import type { MonitorHistoryResponse } from "../../shared/time-range";
import { Stat } from "../components/ui/Stat";
import { EmptyState } from "../components/ui/EmptyState";
import { CertificatePanel } from "../components/monitors/CertificatePanel";
import type { CertificateDetail } from "../components/monitors/certificate";

// --- Wire shape of GET /api/monitors/:id/detail (see worker routes/monitors.ts) ---
interface MonitorInfo {
  id: string;
  name: string;
  type: MonitorType;
  config: { url?: string } & Record<string, unknown>;
  schedule: { mode: string } & Record<string, unknown>;
  heartbeatToken: string | null;
  intervalSeconds: number;
  graceSeconds: number | null;
  paused: boolean;
}

interface MonitorStateRow {
  state: MonitorState;
  state_since: number | null;
  last_checked_at: number | null;
  last_success_at: number | null;
  last_duration_ms: number | null;
  last_status_code: number | null;
  last_error: string | null;
  next_check_at: number | null;
  active_incident_id: string | null;
  is_flapping: number | boolean | null;
}

interface Sample {
  at: number;
  ok: number | boolean;
  state: MonitorState;
  durationMs: number | null;
  statusCode: number | null;
  error: string | null;
  // Type-specific detail (DNS resolved records, domain expiry, …). Present only
  // when the backend includes it; always read defensively.
  meta?: unknown;
}

interface IncidentRow {
  id: string;
  status: "open" | "resolved";
  title: string | null;
  startedAt: number;
  resolvedAt: number | null;
  durationSeconds: number | null;
  error: string | null;
}

interface DetailResponse {
  monitor: MonitorInfo;
  state: MonitorStateRow | null;
  uptime: UptimeWindows;
  /** Downtime and its suspended share per uptime window (absent from older workers). */
  downtime?: DowntimeWindows;
  latency: { avg: number | null; min: number | null; max: number | null };
  incidentMetrics: {
    totalIncidents: number;
    totalDowntimeSeconds: number;
    mtbfSeconds: number | null;
    mttrSeconds: number | null;
    longestSeconds: number | null;
    mostRecentAt: number | null;
  };
  recentSamples: Sample[];
  recentIncidents: IncidentRow[];
  /** SSL certificate monitors: the last read, or null before the first. */
  certificate?: CertificateDetail | null;
}

interface TestOutcome {
  state: MonitorState;
  ok: boolean;
  durationMs?: number | null;
  statusCode?: number | null;
  error?: string | null;
  meta?: unknown;
}

/** Defensive reader for the type-specific `meta` blob on a sample/outcome. */
interface SampleMeta {
  records?: string[];
  expiresAt?: string;
  daysUntil?: number;
  /** Domain monitors: when the expiry date was read from RDAP (epoch ms). */
  checkedAt?: number;
  /** Domain monitors: the latest RDAP refresh failed, so the earlier read was used. */
  lookupError?: { code: string; at: number };
  /** Certificate monitors: why the certificate can't be read from a Worker. */
  cantCheck?: { message: string };
}

/** Why a domain monitor's latest RDAP refresh failed, in words. */
function lookupFailure(code: string): string {
  switch (code) {
    case "rdap_rate_limited":
      return "rate limited";
    case "rdap_timeout":
      return "timed out";
    case "rdap_no_expiry":
      return "no expiry date";
    default:
      return "RDAP error";
  }
}
function readMeta(meta: unknown): SampleMeta {
  if (!meta || typeof meta !== "object") return {};
  const m = meta as Record<string, unknown>;
  const out: SampleMeta = {};
  if (Array.isArray(m.records)) {
    out.records = m.records.filter((r): r is string => typeof r === "string");
  }
  if (typeof m.expiresAt === "string") out.expiresAt = m.expiresAt;
  if (typeof m.daysUntil === "number") out.daysUntil = m.daysUntil;
  if (typeof m.checkedAt === "number") out.checkedAt = m.checkedAt;
  const le = m.lookupError as Record<string, unknown> | undefined;
  if (le && typeof le === "object" && typeof le.code === "string" && typeof le.at === "number") {
    out.lookupError = { code: le.code, at: le.at };
  }
  const cc = m.cantCheck as Record<string, unknown> | undefined;
  if (cc && typeof cc === "object" && typeof cc.message === "string") out.cantCheck = { message: cc.message };
  return out;
}

const btn =
  "inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-ink-faint/40 hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50";
const btnDanger =
  "inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-down transition-colors hover:border-down/40 hover:bg-down/10 disabled:cursor-not-allowed disabled:opacity-50";
const btnAccent =
  "inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover";

const NOTICE_CLASS = {
  ok: "border-up/40 bg-up/10 text-up",
  error: "border-down/40 bg-down/10 text-down",
} as const;

/** Label/value row used inside the "current state" panel. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="min-w-0 truncate text-right text-ink">{children}</span>
    </div>
  );
}

export default function MonitorDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { csrf } = useBootstrap();

  const { data, loading, error, reload } = useFetch<DetailResponse>(
    id ? `/api/monitors/${id}/detail` : null,
  );
  const [range, setRange] = useTimeRange("monitor");
  const history = useFetch<MonitorHistoryResponse>(
    id ? `/api/monitors/${id}/history?range=${range}` : null,
  );

  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: keyof typeof NOTICE_CLASS; text: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [oneTimeHeartbeatToken, setOneTimeHeartbeatToken] = useState<string | null>(() => {
    const state = location.state as { heartbeatToken?: unknown } | null;
    return typeof state?.heartbeatToken === "string" ? state.heartbeatToken : null;
  });

  // A new monitor's first check runs as it is created (worker
  // checks/first-check.ts); a slow one finishes a few seconds later. While a
  // polled monitor has never been checked, refresh until its state arrives.
  const awaitingFirstCheck =
    !!data?.monitor &&
    data.monitor.type !== "heartbeat" &&
    !data.monitor.paused &&
    (data.state?.state ?? "unknown") === "unknown";
  const pollsLeft = useRef(20);
  useEffect(() => {
    if (!awaitingFirstCheck || pollsLeft.current <= 0) return;
    const timer = setTimeout(() => {
      pollsLeft.current--;
      void reload();
    }, 3000);
    return () => clearTimeout(timer);
  }, [awaitingFirstCheck, data, reload]);

  // Once the first check lands, refresh the history so it shows up.
  const wasAwaiting = useRef(false);
  const reloadHistory = history.reload;
  useEffect(() => {
    if (awaitingFirstCheck) wasAwaiting.current = true;
    else if (wasAwaiting.current) {
      wasAwaiting.current = false;
      void reloadHistory();
    }
  }, [awaitingFirstCheck, reloadHistory]);

  // Keep the creation token in component memory only. Clearing router history
  // state means a reload or later Back navigation cannot reveal it again.
  useEffect(() => {
    const state = location.state as { heartbeatToken?: unknown } | null;
    if (typeof state?.heartbeatToken === "string") {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate]);

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-5xl animate-fade" aria-busy="true" aria-label="Loading monitor">
        <Skeleton className="h-4 w-24" />
        <div className="mt-4 flex items-center justify-between gap-4">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-9 w-72 max-w-[45%]" />
        </div>
        <Skeleton className="mt-6 h-16 w-full rounded-card" />
        <Skeleton className="mt-10 h-[230px] w-full rounded-card" />
        <Skeleton className="mt-4 h-[340px] w-full rounded-card" />
      </div>
    );
  }

  if (error || !data?.monitor) {
    return (
      <div className="mx-auto max-w-5xl">
        <EmptyState
          icon={<AlertTriangle className="size-6" />}
          title="Monitor not found"
          description="This monitor may have been deleted, or the link is incorrect."
          action={
            <Link to="/monitors" className={btnAccent}>
              Back to monitors
            </Link>
          }
        />
      </div>
    );
  }

  const { monitor, state, uptime, incidentMetrics, recentSamples, recentIncidents } = data;
  const scheduleMode = monitor.schedule.mode.replace(/_/g, " ");
  const currentState: MonitorState = state?.state ?? "unknown";
  const heartbeatToken = oneTimeHeartbeatToken ?? monitor.heartbeatToken;
  const ingestUrl = heartbeatToken
    ? `${window.location.origin}/hb/${heartbeatToken}`
    : null;
  // Only link the target when it is http(s); a `javascript:` config value would
  // otherwise execute from the href (rel/target do not prevent that).
  const targetUrl = monitor.config.url ?? null;
  const safeTargetUrl = safeHttpUrl(targetUrl);

  // Per-type target fields (config is an untyped blob; read each defensively).
  const cfg = monitor.config as Record<string, unknown>;
  const dnsHostname = typeof cfg.hostname === "string" ? cfg.hostname : null;
  const dnsRecordType = typeof cfg.recordType === "string" ? cfg.recordType : null;
  const tcpHost = typeof cfg.host === "string" ? cfg.host : null;
  const tcpPort = typeof cfg.port === "number" ? cfg.port : null;
  const domainName = typeof cfg.domain === "string" ? cfg.domain : null;
  const certWarnDays = Array.isArray(cfg.warnDays)
    ? cfg.warnDays.filter((d): d is number => typeof d === "number")
    : [];

  // Latest sample's type-specific detail (resolved DNS records, domain expiry).
  const latestMeta = readMeta(recentSamples.at(-1)?.meta);

  async function onTest() {
    if (!id) return;
    setPending("test");
    setNotice(null);
    try {
      const res = await api<{ outcome: TestOutcome; applied: boolean }>(
        `/api/monitors/${id}/test`,
        { method: "POST", csrf: csrf ?? undefined },
      );
      const o = res.outcome;
      const meta = readMeta(o.meta);
      const parts = [
        STATE_META[o.state].label,
        o.statusCode != null ? `HTTP ${o.statusCode}` : null,
        o.durationMs != null ? formatMs(o.durationMs) : null,
        o.error ? o.error : null,
        meta.records && meta.records.length > 0
          ? meta.records.join(", ")
          : null,
        meta.expiresAt
          ? `expires ${new Date(meta.expiresAt).toLocaleDateString()}${
              meta.daysUntil != null ? ` (in ${meta.daysUntil}d)` : ""
            }`
          : null,
        meta.cantCheck ? meta.cantCheck.message : null,
      ].filter(Boolean);
      setNotice({ tone: o.ok ? "ok" : "error", text: `Test: ${parts.join(" · ")}` });
    } catch (e) {
      setNotice({
        tone: "error",
        text: e instanceof ApiError ? e.message : "Test failed",
      });
    } finally {
      setPending(null);
    }
  }

  async function onPauseToggle() {
    if (!id) return;
    const action = monitor.paused ? "resume" : "pause";
    setPending("pause");
    setNotice(null);
    try {
      await api(`/api/monitors/${id}/${action}`, { method: "POST", csrf: csrf ?? undefined });
      await reload();
    } catch (e) {
      setNotice({
        tone: "error",
        text: e instanceof ApiError ? e.message : "Could not update monitor",
      });
    } finally {
      setPending(null);
    }
  }

  async function onDelete() {
    if (!id) return;
    if (!confirm(`Delete monitor "${monitor.name}"? This cannot be undone.`)) return;
    setPending("delete");
    setNotice(null);
    try {
      await api(`/api/monitors/${id}`, { method: "DELETE", csrf: csrf ?? undefined });
      navigate("/monitors");
    } catch (e) {
      setNotice({
        tone: "error",
        text: e instanceof ApiError ? e.message : "Could not delete monitor",
      });
      setPending(null);
    }
  }

  async function copyIngest() {
    if (!ingestUrl) return;
    try {
      await navigator.clipboard.writeText(ingestUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; ignore silently.
    }
  }

  async function rotateIngestToken() {
    if (!id) return;
    if (ingestUrl && !confirm("Rotate this heartbeat token? The current URL will stop working.")) {
      return;
    }
    setPending("rotate-token");
    setNotice(null);
    try {
      const result = await api<{ heartbeatToken: string }>(
        `/api/monitors/${id}/rotate-heartbeat-token`,
        { method: "POST", csrf: csrf ?? undefined },
      );
      setOneTimeHeartbeatToken(result.heartbeatToken);
      setNotice({
        tone: "ok",
        text: "Heartbeat token rotated. Copy the new URL now because it cannot be shown again.",
      });
    } catch (e) {
      setNotice({
        tone: "error",
        text: e instanceof ApiError ? e.message : "Could not rotate heartbeat token",
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        to="/monitors"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="size-4" />
        Monitors
      </Link>

      {/* Header */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{monitor.name}</h1>
            <StatusPill state={currentState} />
            {state?.is_flapping ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-degraded/40 bg-degraded/10 px-2 py-0.5 text-xs font-medium text-degraded">
                Flapping
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm capitalize text-ink-muted">
            {monitorTypeLabel(monitor.type)} · {scheduleMode}
          </p>
          {awaitingFirstCheck && (
            <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-ink-faint" role="status">
              <Loader2 className="size-3 animate-spin" />
              First check running…
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {monitor.type !== "heartbeat" && (
            <button onClick={onTest} disabled={pending !== null} className={btn}>
              {pending === "test" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Test now
            </button>
          )}
          <button onClick={onPauseToggle} disabled={pending !== null} className={btn}>
            {pending === "pause" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : monitor.paused ? (
              <Play className="size-4" />
            ) : (
              <Pause className="size-4" />
            )}
            {monitor.paused ? "Resume" : "Pause"}
          </button>
          <Link to={`/monitors/${id}/edit`} className={btn}>
            <Pencil className="size-4" />
            Edit
          </Link>
          <button onClick={onDelete} disabled={pending !== null} className={btnDanger}>
            {pending === "delete" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            Delete
          </button>
        </div>
      </div>

      {notice && (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={cn(
            "mt-4 rounded-lg border px-3 py-2 text-sm",
            NOTICE_CLASS[notice.tone],
          )}
        >
          {notice.text}
        </div>
      )}

      {/* Target */}
      <Card className="mt-4">
        {monitor.type === "heartbeat" ? (
          <div>
            <div className="text-xs font-medium text-ink-muted">Heartbeat ingest URL</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-ink">
                {ingestUrl ?? "Stored securely. Rotate the token to get a new URL."}
              </code>
              {ingestUrl && (
                <button onClick={copyIngest} className={btn}>
                  {copied ? <Check className="size-4 text-up" /> : <Copy className="size-4" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              )}
              <button
                onClick={rotateIngestToken}
                disabled={pending !== null}
                className={btn}
              >
                {pending === "rotate-token" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ShieldCheck className="size-4" />
                )}
                {ingestUrl ? "Rotate" : "Generate new URL"}
              </button>
            </div>
            <div className="mt-2 text-xs text-ink-faint">
              Expected every {formatDuration(monitor.intervalSeconds)} · grace{" "}
              {formatDuration(monitor.graceSeconds ?? 0)}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-ink-muted">Target</div>
              {monitor.type === "http" ? (
                safeTargetUrl ? (
                  <a
                    href={safeTargetUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block truncate font-mono text-sm text-accent hover:underline"
                  >
                    {targetUrl}
                  </a>
                ) : targetUrl ? (
                  <span className="mt-1 block truncate font-mono text-sm text-ink">
                    {targetUrl}
                  </span>
                ) : (
                  <span className="mt-1 block text-sm text-ink-faint">-</span>
                )
              ) : monitor.type === "dns" ? (
                <>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="truncate font-mono text-sm text-ink">
                      {dnsHostname ?? "-"}
                    </span>
                    {dnsRecordType && (
                      <span className="shrink-0 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-faint">
                        {dnsRecordType}
                      </span>
                    )}
                  </div>
                  {latestMeta.records && latestMeta.records.length > 0 && (
                    <div className="mt-1 truncate font-mono text-xs text-ink-faint">
                      Resolved: {latestMeta.records.join(", ")}
                    </div>
                  )}
                </>
              ) : monitor.type === "tcp" ? (
                <span className="mt-1 block truncate font-mono text-sm text-ink">
                  {tcpHost ?? "-"}
                  {tcpPort != null ? `:${tcpPort}` : ""}
                </span>
              ) : monitor.type === "cert" ? (
                <span className="mt-1 block truncate font-mono text-sm text-ink">
                  {tcpHost ?? "-"}
                  {tcpPort != null && tcpPort !== 443 ? `:${tcpPort}` : ""}
                </span>
              ) : (
                <>
                  <span className="mt-1 block truncate font-mono text-sm text-ink">
                    {domainName ?? "-"}
                  </span>
                  {latestMeta.expiresAt && (
                    <div className="mt-1 text-xs text-ink-faint">
                      Expires {new Date(latestMeta.expiresAt).toLocaleDateString()}
                      {latestMeta.daysUntil != null
                        ? ` · in ${latestMeta.daysUntil} days`
                        : ""}
                      {latestMeta.checkedAt != null && !latestMeta.lookupError
                        ? ` · read ${formatRelativeTime(latestMeta.checkedAt)}`
                        : ""}
                    </div>
                  )}
                  {latestMeta.lookupError && latestMeta.checkedAt != null && (
                    <div className="mt-1 text-xs text-degraded">
                      Last lookup failed ({lookupFailure(latestMeta.lookupError.code)}), using
                      the expiry read {formatRelativeTime(latestMeta.checkedAt)}
                    </div>
                  )}
                </>
              )}
            </div>
            <span className="shrink-0 text-xs text-ink-faint">
              Checks every {formatDuration(monitor.intervalSeconds)}
            </span>
          </div>
        )}
      </Card>

      {monitor.type === "cert" && <CertificatePanel detail={data.certificate} warnDays={certWarnDays} />}

      {/* History over the chosen range */}
      <section className="mt-8" aria-labelledby="history-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="history-heading" className="text-sm font-semibold text-ink">
            History
          </h2>
          <RangeControl value={range} onChange={setRange} />
        </div>
        {history.error && !history.data ? (
          <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
            Could not load history: {history.error}
          </p>
        ) : (
          <div className="stagger grid gap-4">
            <AvailabilityCard
              history={history.data}
              range={range}
              uptime={uptime}
              downtime={data.downtime}
              monitorName={monitor.name}
            />
            <ResponseCard
              history={history.data}
              range={range}
              intervalSeconds={monitor.intervalSeconds}
              monitorName={monitor.name}
            />
          </div>
        )}
      </section>

      {/* Current state + incident metrics */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Current state</CardTitle>
            <StatusPill state={currentState} />
          </CardHeader>
          <div className="divide-y divide-line">
            <InfoRow label="In this state for">
              {state?.state_since != null ? (
                <span title={`Since ${formatDateTime(state.state_since)}`}>
                  {formatDuration((Date.now() - state.state_since) / 1000)}
                </span>
              ) : (
                "-"
              )}
            </InfoRow>
            <InfoRow label="Last check">
              {state?.last_checked_at != null ? (
                <span title={formatDateTime(state.last_checked_at)}>
                  {formatRelativeTime(state.last_checked_at)}
                </span>
              ) : (
                "Never"
              )}
            </InfoRow>
            <InfoRow label="Next check">
              <NextCheck
                at={state?.next_check_at ?? null}
                paused={monitor.paused}
                offHours={currentState === "scheduled_off"}
              />
            </InfoRow>
            <InfoRow label="Last success">
              {state?.last_success_at != null ? (
                <span title={formatDateTime(state.last_success_at)}>
                  {formatRelativeTime(state.last_success_at)}
                </span>
              ) : (
                "-"
              )}
            </InfoRow>
            <InfoRow label="Last status">
              {state?.last_status_code != null ? state.last_status_code : "-"}
            </InfoRow>
            <InfoRow label="Last latency">{formatMs(state?.last_duration_ms ?? null)}</InfoRow>
            {state?.last_error ? (
              <InfoRow label="Last error">
                <span className="text-down">{state.last_error}</span>
              </InfoRow>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Incidents</CardTitle>
            {incidentMetrics.mostRecentAt != null && (
              <span className="text-xs text-ink-faint">
                latest {formatRelativeTime(incidentMetrics.mostRecentAt)}
              </span>
            )}
          </CardHeader>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Total" value={incidentMetrics.totalIncidents} />
            <Stat
              label="Downtime"
              value={formatDuration(incidentMetrics.totalDowntimeSeconds)}
            />
            <Stat
              label="Longest"
              value={
                incidentMetrics.longestSeconds != null
                  ? formatDuration(incidentMetrics.longestSeconds)
                  : "-"
              }
            />
            <Stat
              label="MTBF"
              value={
                incidentMetrics.mtbfSeconds != null
                  ? formatDuration(incidentMetrics.mtbfSeconds)
                  : "-"
              }
            />
            <Stat
              label="MTTR"
              value={
                incidentMetrics.mttrSeconds != null
                  ? formatDuration(incidentMetrics.mttrSeconds)
                  : "-"
              }
            />
          </div>
        </Card>
      </div>

      {/* Recent incidents */}
      <RecentIncidents
        incidents={recentIncidents}
        total={incidentMetrics.totalIncidents}
        monitorId={monitor.id}
      />
    </div>
  );
}

/**
 * When the next check is due. The scheduler runs every 12 minutes, so a
 * check whose time has just passed is "due now"; one well past it is
 * overdue (the scheduler may not be running).
 */
const DUE_GRACE_MS = 15 * 60 * 1000;

function NextCheck({ at, paused, offHours }: { at: number | null; paused: boolean; offHours: boolean }) {
  if (paused) return <span className="text-ink-faint">Paused</span>;
  if (at == null) return <>-</>;
  const now = Date.now();
  const title = formatDateTime(at);
  if (at > now) {
    return (
      <span title={title}>
        {formatRelativeTime(at, now)}
        {offHours && <span className="text-ink-faint"> (when hours resume)</span>}
      </span>
    );
  }
  if (now - at <= DUE_GRACE_MS) return <span title={title}>Due now</span>;
  return (
    <span title={`Was due ${title}`} className="text-degraded">
      Overdue by {formatDuration((now - at) / 1000)}
    </span>
  );
}

const INCIDENTS_COLLAPSED = 5;

function RecentIncidents({
  incidents,
  total,
  monitorId,
}: {
  incidents: IncidentRow[];
  total: number;
  monitorId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? incidents : incidents.slice(0, INCIDENTS_COLLAPSED);
  const hidden = incidents.length - shown.length;
  const listId = "recent-incidents-list";

  return (
    <section className="mt-8" aria-labelledby="recent-incidents-heading">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="recent-incidents-heading" className="text-sm font-semibold text-ink">
          Recent incidents
          {total > 0 && <span className="ml-2 font-normal text-ink-faint tabular-nums">{total}</span>}
        </h2>
        {total > 0 && (
          <Link
            to={`/incidents?monitorId=${encodeURIComponent(monitorId)}`}
            className="inline-flex items-center gap-1 rounded text-sm text-ink-muted transition-colors hover:text-ink"
          >
            All in Incidents <ArrowRight className="size-3.5" />
          </Link>
        )}
      </div>
      {incidents.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="size-6" />}
          title="No incidents recorded"
          description="This monitor has not had any incidents."
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <ul id={listId} className="divide-y divide-line">
            {shown.map((inc, i) => (
              <li
                key={inc.id}
                className={cn(i >= INCIDENTS_COLLAPSED && "animate-enter")}
              >
                <Link
                  to={`/incidents?incident=${encodeURIComponent(inc.id)}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{inc.title ?? "Incident"}</div>
                    <div className="mt-0.5 truncate text-xs text-ink-faint">
                      <span title={formatDateTime(inc.startedAt)}>{formatShortDateTime(inc.startedAt)}</span>
                      {" · "}
                      {formatRelativeTime(inc.startedAt)}
                      {inc.error ? ` · ${describeCause(inc.error)}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs sm:gap-4">
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 font-medium capitalize",
                        inc.status === "open" ? "border-down/40 bg-down/10 text-down" : "border-line text-ink-muted",
                      )}
                    >
                      {inc.status}
                    </span>
                    <span className="w-14 text-right tabular-nums text-ink-muted">
                      {inc.durationSeconds != null ? formatDuration(inc.durationSeconds) : "ongoing"}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {(hidden > 0 || expanded) && incidents.length > INCIDENTS_COLLAPSED && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-controls={listId}
              className="flex w-full items-center justify-center gap-1.5 border-t border-line px-4 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-2/50 hover:text-ink"
            >
              {expanded ? "Show fewer" : `Show ${hidden} more`}
              <ChevronDown
                className={cn("size-4 transition-transform duration-(--duration-base)", expanded && "rotate-180")}
              />
            </button>
          )}
        </Card>
      )}
    </section>
  );
}
