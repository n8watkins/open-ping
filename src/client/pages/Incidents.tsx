import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Download, Loader2, Search, X } from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { api } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { cn } from "../lib/cn";
import type { IncidentSummary } from "../lib/types";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { StatusPill } from "../components/ui/StatusPill";
import { formatDateTime, formatDuration, formatRelativeTime } from "../lib/format";

// The list endpoint returns the documented IncidentSummary plus a couple of
// internal fields surfaced only on this private dashboard.
interface IncidentRow extends IncidentSummary {
  httpStatus?: number | null;
  rootCause?: string | null;
}

interface IncidentListResponse {
  incidents: IncidentRow[];
  total: number;
}

interface IncidentEvent {
  at: number;
  kind: string;
  message: string;
}

// The detail endpoint additionally returns the editable annotation fields.
interface IncidentDetail extends IncidentRow {
  privateNotes?: string | null;
  publicMessage?: string | null;
  public?: boolean;
  resolution?: string | null;
}

interface IncidentDetailResponse {
  incident: IncidentDetail;
  events: IncidentEvent[];
}

type StatusFilter = "all" | "open" | "resolved";

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
];

// Sort values are passed straight through to the API (see assumptions).
const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "longest", label: "Longest downtime" },
];

const SECONDARY_BTN =
  "inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink";

function durationLabel(inc: { status: string; durationSeconds: number | null }): string {
  if (inc.status === "open") return "ongoing";
  return inc.durationSeconds != null ? formatDuration(inc.durationSeconds) : "—";
}

function incidentTitle(inc: { title: string | null; monitorName?: string }): string {
  return inc.title ?? `${inc.monitorName ?? "Monitor"} incident`;
}

export default function Incidents() {
  const { csrf } = useBootstrap();
  const [searchParams, setSearchParams] = useSearchParams();
  const monitorId = searchParams.get("monitorId") ?? "";

  // Filters.
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");

  // Debounce the free-text search into the query that actually drives fetches.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 350);
    return () => clearTimeout(t);
  }, [qInput]);

  const filterQs = useMemo(() => {
    const sp = new URLSearchParams();
    if (status !== "all") sp.set("status", status);
    if (monitorId) sp.set("monitorId", monitorId);
    if (q) sp.set("q", q);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    if (sort) sp.set("sort", sort);
    return sp.toString();
  }, [status, monitorId, q, from, to, sort]);

  const listPath = useMemo(() => {
    const sp = new URLSearchParams(filterQs);
    sp.set("limit", "200");
    return `/api/incidents?${sp.toString()}`;
  }, [filterQs]);

  const csvHref = `/api/incidents/export.csv${filterQs ? `?${filterQs}` : ""}`;
  const jsonHref = `/api/incidents/export.json${filterQs ? `?${filterQs}` : ""}`;

  const { data, loading, error, reload } = useFetch<IncidentListResponse>(listPath);

  // Detail panel.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailPath = selectedId ? `/api/incidents/${selectedId}` : null;
  const {
    data: detail,
    loading: detailLoading,
    error: detailError,
    reload: reloadDetail,
  } = useFetch<IncidentDetailResponse>(detailPath);

  // Editable annotation fields, hydrated whenever the detail loads.
  const [privateNotes, setPrivateNotes] = useState("");
  const [publicMessage, setPublicMessage] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [resolution, setResolution] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const inc = detail?.incident;
    setSaveError(null);
    setSaved(false);
    if (!inc) return;
    setPrivateNotes(inc.privateNotes ?? "");
    setPublicMessage(inc.publicMessage ?? "");
    setIsPublic(inc.public ?? false);
    setResolution(inc.resolution ?? "");
  }, [detail]);

  async function save() {
    if (!selectedId) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await api(`/api/incidents/${selectedId}`, {
        method: "PATCH",
        json: { privateNotes, publicMessage, public: isPublic, resolution },
        csrf: csrf ?? undefined,
      });
      setSaved(true);
      await Promise.all([reloadDetail(), reload()]);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save changes.");
    } finally {
      setSaving(false);
    }
  }

  function clearMonitor() {
    const next = new URLSearchParams(searchParams);
    next.delete("monitorId");
    setSearchParams(next);
  }

  if (loading && !data) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }

  const incidents = data?.incidents ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Incidents</h1>
          {loading && data && <Loader2 className="size-4 animate-spin text-ink-faint" />}
        </div>
        <div className="flex items-center gap-2">
          <a href={csvHref} className={SECONDARY_BTN}>
            <Download className="size-4" />
            CSV
          </a>
          <a href={jsonHref} className={SECONDARY_BTN}>
            <Download className="size-4" />
            JSON
          </a>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              aria-pressed={status === tab.value}
              onClick={() => setStatus(tab.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                status === tab.value
                  ? "bg-surface-2 text-ink"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
          <input
            className="input pl-9"
            placeholder="Search incidents…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setQ(qInput);
            }}
          />
        </div>

        <select
          className="input w-full sm:w-auto"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          aria-label="Sort incidents"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <input
          type="date"
          className="input w-full sm:w-auto"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="From date"
          title="From date"
        />
        <input
          type="date"
          className="input w-full sm:w-auto"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="To date"
          title="To date"
        />
      </div>

      {monitorId && (
        <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 text-xs text-ink-muted">
          Filtered to a single monitor
          <button
            type="button"
            onClick={clearMonitor}
            className="text-ink-faint transition-colors hover:text-ink"
            aria-label="Clear monitor filter"
          >
            <X className="size-3" />
          </button>
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          Could not load incidents: {error}
        </p>
      )}

      {/* List + detail */}
      <div
        className={cn(
          "mt-5 grid items-start gap-6",
          selectedId && "lg:grid-cols-[1fr_400px]",
        )}
      >
        <div className="min-w-0">
          {incidents.length === 0 ? (
            <EmptyState
              icon={<AlertTriangle className="size-6 text-accent" />}
              title="No incidents"
              description="Nothing matches the current filters. Incidents appear here when a monitor goes down."
            />
          ) : (
            <>
              {data && (
                <p className="mb-3 text-xs text-ink-faint">
                  {data.total} incident{data.total === 1 ? "" : "s"}
                </p>
              )}
              <Card className="divide-y divide-line p-0">
                {incidents.map((inc) => (
                  <button
                    key={inc.id}
                    type="button"
                    onClick={() => setSelectedId(inc.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-surface-2",
                      selectedId === inc.id && "bg-surface-2",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <StatusPill
                        state={inc.status === "open" ? "down" : "up"}
                        label={inc.status === "open" ? "Open" : "Resolved"}
                      />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{incidentTitle(inc)}</div>
                        <div className="truncate text-xs text-ink-faint">
                          {inc.monitorName ?? "—"}
                        </div>
                      </div>
                    </div>
                    <div className="hidden shrink-0 items-center gap-6 text-xs text-ink-muted sm:flex">
                      <span className="w-16 text-right">
                        {formatRelativeTime(inc.startedAt)}
                      </span>
                      <span className="w-16 text-right">{durationLabel(inc)}</span>
                    </div>
                  </button>
                ))}
              </Card>
            </>
          )}
        </div>

        {selectedId && (
          <div className="lg:sticky lg:top-6 lg:self-start">
            <Card className="p-0">
              {detailLoading && !detail ? (
                <div className="grid place-items-center py-16">
                  <Loader2 className="size-5 animate-spin text-ink-faint" />
                </div>
              ) : detailError ? (
                <div className="p-4">
                  <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
                    Could not load incident: {detailError}
                  </p>
                </div>
              ) : detail ? (
                <DetailPanel
                  detail={detail}
                  onClose={() => setSelectedId(null)}
                  privateNotes={privateNotes}
                  setPrivateNotes={setPrivateNotes}
                  publicMessage={publicMessage}
                  setPublicMessage={setPublicMessage}
                  isPublic={isPublic}
                  setIsPublic={setIsPublic}
                  resolution={resolution}
                  setResolution={setResolution}
                  saving={saving}
                  saveError={saveError}
                  saved={saved}
                  onSave={save}
                />
              ) : null}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

interface DetailPanelProps {
  detail: IncidentDetailResponse;
  onClose: () => void;
  privateNotes: string;
  setPrivateNotes: (v: string) => void;
  publicMessage: string;
  setPublicMessage: (v: string) => void;
  isPublic: boolean;
  setIsPublic: (v: boolean) => void;
  resolution: string;
  setResolution: (v: string) => void;
  saving: boolean;
  saveError: string | null;
  saved: boolean;
  onSave: () => void;
}

function DetailPanel(p: DetailPanelProps) {
  const inc = p.detail.incident;
  const events = p.detail.events ?? [];

  return (
    <div className="max-h-[calc(100vh_-_3rem)] overflow-y-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-line p-4">
        <div className="min-w-0">
          <div className="truncate font-medium">{incidentTitle(inc)}</div>
          {inc.monitorName && (
            <div className="mt-0.5 truncate text-xs text-ink-faint">{inc.monitorName}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusPill
            state={inc.status === "open" ? "down" : "up"}
            label={inc.status === "open" ? "Open" : "Resolved"}
          />
          <button
            type="button"
            onClick={p.onClose}
            className="text-ink-faint transition-colors hover:text-ink"
            aria-label="Close panel"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* Meta */}
      <dl className="grid grid-cols-2 gap-4 border-b border-line p-4 text-sm">
        <Meta label="Started" value={formatDateTime(inc.startedAt)} />
        <Meta
          label="Resolved"
          value={inc.resolvedAt != null ? formatDateTime(inc.resolvedAt) : "—"}
        />
        <Meta label="Duration" value={durationLabel(inc)} />
        <Meta label="HTTP status" value={inc.httpStatus != null ? String(inc.httpStatus) : "—"} />
      </dl>

      {(inc.error || inc.rootCause) && (
        <div className="space-y-3 border-b border-line p-4">
          {inc.error && (
            <div>
              <div className="mb-1 text-xs font-medium text-ink-muted">Error</div>
              <pre className="overflow-x-auto rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-xs whitespace-pre-wrap text-down">
                {inc.error}
              </pre>
            </div>
          )}
          {inc.rootCause && (
            <div>
              <div className="mb-1 text-xs font-medium text-ink-muted">Root cause</div>
              <p className="text-sm text-ink">{inc.rootCause}</p>
            </div>
          )}
        </div>
      )}

      {/* Timeline */}
      {events.length > 0 && (
        <div className="border-b border-line p-4">
          <div className="mb-3 text-xs font-medium text-ink-muted">Timeline</div>
          <ol className="space-y-3">
            {events.map((ev, i) => (
              <li key={i} className="flex gap-3 text-sm">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium capitalize">{ev.kind}</span>
                    <span className="text-xs text-ink-faint" title={formatDateTime(ev.at)}>
                      {formatRelativeTime(ev.at)}
                    </span>
                  </div>
                  {ev.message && <p className="text-ink-muted">{ev.message}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Editable annotations */}
      <div className="space-y-4 p-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-muted">Private notes</span>
          <textarea
            className="input"
            rows={3}
            value={p.privateNotes}
            onChange={(e) => p.setPrivateNotes(e.target.value)}
            placeholder="Internal notes — never shown publicly."
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-muted">Public message</span>
          <textarea
            className="input"
            rows={3}
            value={p.publicMessage}
            onChange={(e) => p.setPublicMessage(e.target.value)}
            placeholder="Shown on the public status page when enabled."
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-muted">Resolution</span>
          <textarea
            className="input"
            rows={2}
            value={p.resolution}
            onChange={(e) => p.setResolution(e.target.value)}
            placeholder="How was this incident resolved?"
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={p.isPublic}
            onChange={(e) => p.setIsPublic(e.target.checked)}
            className="size-4 rounded border-line bg-surface-2 accent-accent"
          />
          Show on public status page
        </label>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={p.onSave}
            disabled={p.saving}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {p.saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </button>
          {p.saved && !p.saving && <span className="text-xs text-up">Saved</span>}
          {p.saveError && <span className="text-xs text-down">{p.saveError}</span>}
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-ink">{value}</dd>
    </div>
  );
}
