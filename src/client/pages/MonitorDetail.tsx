import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
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
  formatPct,
  formatRelativeTime,
  formatDuration,
  formatDateTime,
} from "../lib/format";
import { STATE_META, type MonitorState } from "../../shared/states";
import { monitorTypeLabel, type MonitorType } from "../lib/types";
import { StatusPill } from "../components/ui/StatusPill";
import { UptimeBar } from "../components/ui/UptimeBar";
import { Sparkline } from "../components/ui/Sparkline";
import { Card, CardHeader, CardTitle } from "../components/ui/Card";
import { Stat } from "../components/ui/Stat";
import { EmptyState } from "../components/ui/EmptyState";

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
  uptime: { d1: number; d7: number; d30: number; d365: number };
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

/** Tint an uptime percentage by health, using only static utility classes. */
function uptimeClass(pct: number): string | undefined {
  if (pct >= 99.9) return "text-up";
  if (pct >= 98) return undefined;
  if (pct >= 95) return "text-degraded";
  return "text-down";
}

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
  const { csrf } = useBootstrap();

  const { data, loading, error, reload } = useFetch<DetailResponse>(
    id ? `/api/monitors/${id}/detail` : null,
  );

  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: keyof typeof NOTICE_CLASS; text: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  if (loading && !data) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
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

  const { monitor, state, uptime, latency, incidentMetrics, recentSamples, recentIncidents } = data;
  const scheduleMode = monitor.schedule.mode.replace(/_/g, " ");
  const currentState: MonitorState = state?.state ?? "unknown";
  const ingestUrl = monitor.heartbeatToken
    ? `${window.location.origin}/hb/${monitor.heartbeatToken}`
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

  // Latest sample's type-specific detail (resolved DNS records, domain expiry).
  const latestMeta = readMeta(recentSamples.at(-1)?.meta);

  const latencyPoints = recentSamples
    .filter((s) => s.durationMs != null)
    .map((s) => s.durationMs as number);

  const segments = recentSamples.map((s) => ({
    state: s.state,
    title: `${formatDateTime(s.at)} · ${s.ok ? "ok" : s.error ?? "fail"}`,
  }));

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
            <h1 className="truncate text-xl font-semibold tracking-tight">{monitor.name}</h1>
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
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
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
                {ingestUrl ?? "—"}
              </code>
              {ingestUrl && (
                <button onClick={copyIngest} className={btn}>
                  {copied ? <Check className="size-4 text-up" /> : <Copy className="size-4" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              )}
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
                  <span className="mt-1 block text-sm text-ink-faint">—</span>
                )
              ) : monitor.type === "dns" ? (
                <>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="truncate font-mono text-sm text-ink">
                      {dnsHostname ?? "—"}
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
                  {tcpHost ?? "—"}
                  {tcpPort != null ? `:${tcpPort}` : ""}
                </span>
              ) : (
                <>
                  <span className="mt-1 block truncate font-mono text-sm text-ink">
                    {domainName ?? "—"}
                  </span>
                  {latestMeta.expiresAt && (
                    <div className="mt-1 text-xs text-ink-faint">
                      Expires {new Date(latestMeta.expiresAt).toLocaleDateString()}
                      {latestMeta.daysUntil != null
                        ? ` · in ${latestMeta.daysUntil} days`
                        : ""}
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

      {/* Uptime + latency */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Uptime</CardTitle>
            <span className="text-xs text-ink-faint">{recentSamples.length} checks · 24h</span>
          </CardHeader>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="24 hours" value={formatPct(uptime.d1)} valueClass={uptimeClass(uptime.d1)} />
            <Stat label="7 days" value={formatPct(uptime.d7)} valueClass={uptimeClass(uptime.d7)} />
            <Stat label="30 days" value={formatPct(uptime.d30)} valueClass={uptimeClass(uptime.d30)} />
            <Stat
              label="365 days"
              value={formatPct(uptime.d365)}
              valueClass={uptimeClass(uptime.d365)}
            />
          </div>
          <div className="mt-4 border-t border-line pt-4">
            {segments.length > 0 ? (
              <UptimeBar segments={segments} />
            ) : (
              <p className="text-sm text-ink-muted">No checks in the last 24 hours.</p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Response time</CardTitle>
            <span className="text-xs text-ink-faint">last 24h</span>
          </CardHeader>
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Average" value={formatMs(latency.avg)} />
            <Stat label="Min" value={formatMs(latency.min)} />
            <Stat label="Max" value={formatMs(latency.max)} />
          </div>
          <div className="mt-4 border-t border-line pt-4">
            {latencyPoints.length > 0 ? (
              <Sparkline points={latencyPoints} className="h-12 w-full" />
            ) : (
              <p className="text-sm text-ink-muted">No latency samples yet.</p>
            )}
          </div>
        </Card>
      </div>

      {/* Current state + incident metrics */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Current state</CardTitle>
            <StatusPill state={currentState} />
          </CardHeader>
          <div className="divide-y divide-line">
            <InfoRow label="Time in state">
              {state?.state_since != null ? formatRelativeTime(state.state_since) : "—"}
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
              {state?.next_check_at != null ? (
                <span title={formatDateTime(state.next_check_at)}>
                  {formatRelativeTime(state.next_check_at)}
                </span>
              ) : (
                "—"
              )}
            </InfoRow>
            <InfoRow label="Last success">
              {state?.last_success_at != null ? (
                <span title={formatDateTime(state.last_success_at)}>
                  {formatRelativeTime(state.last_success_at)}
                </span>
              ) : (
                "—"
              )}
            </InfoRow>
            <InfoRow label="Last status">
              {state?.last_status_code != null ? state.last_status_code : "—"}
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
                last {formatRelativeTime(incidentMetrics.mostRecentAt)}
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
                  : "—"
              }
            />
            <Stat
              label="MTBF"
              value={
                incidentMetrics.mtbfSeconds != null
                  ? formatDuration(incidentMetrics.mtbfSeconds)
                  : "—"
              }
            />
            <Stat
              label="MTTR"
              value={
                incidentMetrics.mttrSeconds != null
                  ? formatDuration(incidentMetrics.mttrSeconds)
                  : "—"
              }
            />
          </div>
        </Card>
      </div>

      {/* Recent incidents */}
      <h2 className="mt-8 mb-3 text-sm font-medium text-ink-muted">Recent incidents</h2>
      {recentIncidents.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="size-6" />}
          title="No incidents recorded"
          description="This monitor has not had any incidents."
        />
      ) : (
        <Card className="divide-y divide-line p-0">
          {recentIncidents.map((inc) => (
            <div key={inc.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{inc.title ?? "Incident"}</div>
                <div className="mt-0.5 truncate text-xs text-ink-faint">
                  Started {formatRelativeTime(inc.startedAt)}
                  {inc.error ? ` · ${inc.error}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-4 text-xs">
                <span
                  className={cn(
                    "rounded-full border border-line px-2 py-0.5 font-medium capitalize",
                    inc.status === "open" ? "text-down" : "text-ink-muted",
                  )}
                >
                  {inc.status}
                </span>
                <span className="w-16 text-right text-ink-muted">
                  {inc.durationSeconds != null ? formatDuration(inc.durationSeconds) : "ongoing"}
                </span>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
