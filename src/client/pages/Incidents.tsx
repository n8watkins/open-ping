import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, CalendarRange, Download, Loader2, Search, X } from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { api } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { cn } from "../lib/cn";
import type { IncidentSummary as IncidentSummaryBase } from "../lib/types";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { PageTitle } from "../components/ui/PageTitle";
import { PullToRefresh } from "../components/PullToRefresh";
import { StatusPill } from "../components/ui/StatusPill";
import { formatDateTime, formatDuration, formatRelativeTime } from "../lib/format";
import { coloCity } from "../../shared/colos";
import { IncidentUpdatesEditor, type IncidentUpdateItem } from "../components/IncidentUpdatesEditor";
import { EventList, EventListSkeleton, CauseTag } from "../components/incidents/EventList";
import { IncidentSummary } from "../components/incidents/IncidentSummary";
import {
  causeLabel,
  groupIncidents,
  sectionByMonth,
  sortEvents,
  summarizeEvents,
  type EventSort,
  type MonthSection,
} from "../components/incidents/grouping";
import { RANGE_PRESETS, matchPreset, presetRange, rangeLabel } from "../components/incidents/range";

// The list endpoint returns the documented IncidentSummary plus a couple of
// internal fields surfaced only on this private dashboard.
interface IncidentRow extends IncidentSummaryBase {
  monitorId?: string;
  httpStatus?: number | null;
  rootCause?: string | null;
  /** A second check agreed before the incident opened (confirm before alerting). */
  confirmed?: boolean;
  /** The Cloudflare data center (IATA code) that second check ran in, when it ran elsewhere. */
  confirmedFrom?: string | null;
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
  /** Status updates, newest first. */
  updates?: IncidentUpdateItem[];
}

type StatusFilter = "all" | "open" | "resolved";

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
];

// The API sorts the page it returns; the page then sorts the grouped events
// the same way (see components/incidents/grouping.ts).
const SORT_OPTIONS: { value: EventSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "longest", label: "Longest downtime" },
];

/** The largest page the list API returns; grouping covers this many incidents. */
const PAGE_LIMIT = 500;

const SECONDARY_BTN =
  "inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-2 hover:text-ink";

const SEGMENT_BTN =
  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-(--duration-fast)";

function durationLabel(inc: { status: string; durationSeconds: number | null }): string {
  if (inc.status === "open") return "ongoing";
  return inc.durationSeconds != null ? formatDuration(inc.durationSeconds) : "-";
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
  const [sort, setSort] = useState<EventSort>("newest");
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
    // The date inputs give "YYYY-MM-DD"; the server expects epoch-ms. Convert
    // to local start-of-day / end-of-day so the range is inclusive.
    if (from) {
      const ms = new Date(from + "T00:00:00").getTime();
      if (Number.isFinite(ms)) sp.set("from", String(ms));
    }
    if (to) {
      const ms = new Date(to + "T23:59:59.999").getTime();
      if (Number.isFinite(ms)) sp.set("to", String(ms));
    }
    if (sort !== "newest") sp.set("sort", sort);
    return sp.toString();
  }, [status, monitorId, q, from, to, sort]);

  const listPath = useMemo(() => {
    const sp = new URLSearchParams(filterQs);
    sp.set("limit", String(PAGE_LIMIT));
    return `/api/incidents?${sp.toString()}`;
  }, [filterQs]);

  const csvHref = `/api/incidents/export.csv${filterQs ? `?${filterQs}` : ""}`;
  const jsonHref = `/api/incidents/export.json${filterQs ? `?${filterQs}` : ""}`;

  const { data, loading, error, reload } = useFetch<IncidentListResponse>(listPath);

  // Detail panel.
  // An alert's "View incident" link opens it here: /incidents?incident=<id>.
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get("incident"));
  const detailPath = selectedId ? `/api/incidents/${selectedId}` : null;
  const {
    data: detail,
    loading: detailLoading,
    error: detailError,
    reload: reloadDetail,
  } = useFetch<IncidentDetailResponse>(detailPath);

  // Escape closes the panel (on phones it covers the list).
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

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

  // Group the page into events (incidents that started together), then sort
  // and section them for display.
  const incidents = useMemo(() => data?.incidents ?? [], [data?.incidents]);
  const events = useMemo(() => groupIncidents(incidents), [incidents]);
  const summary = useMemo(() => summarizeEvents(events), [events]);
  const sections = useMemo((): MonthSection<IncidentRow>[] => {
    const sorted = sortEvents(events, sort);
    if (sort === "longest") {
      // Month headers only make sense in time order.
      return [
        {
          key: "all",
          label: "",
          events: sorted,
          downtimeSeconds: summary.downtimeSeconds,
        },
      ];
    }
    return sectionByMonth(sorted);
  }, [events, sort, summary.downtimeSeconds]);

  // Expanded groups: what the owner toggled, and by default the group holding
  // the selected incident (so a deep link lands on a visible row).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const selectedEventKey = useMemo(
    () =>
      selectedId
        ? (events.find((e) => e.incidents.length > 1 && e.incidents.some((i) => i.id === selectedId))?.key ?? null)
        : null,
    [events, selectedId],
  );
  const expanded = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) {
      if (e.incidents.length < 2) continue;
      if (toggled[e.key] ?? e.key === selectedEventKey) set.add(e.key);
    }
    return set;
  }, [events, toggled, selectedEventKey]);
  function toggle(key: string) {
    setToggled((t) => ({ ...t, [key]: !expanded.has(key) }));
  }

  const activePreset = matchPreset(from, to);
  const label = rangeLabel(from, to);
  const filtered = status !== "all" || !!q || !!monitorId || !!from || !!to;
  const partial =
    data && data.total > incidents.length
      ? `Showing the newest ${incidents.length} of ${data.total} incidents. Narrow the dates, or export for all of them.`
      : null;

  return (
    <div className="mx-auto max-w-6xl">
      <PullToRefresh onRefresh={() => Promise.all([reload(), selectedId ? reloadDetail() : null])} />
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <PageTitle>Incidents</PageTitle>
          {loading && data && <Loader2 className="size-4 animate-spin text-ink-faint" aria-label="Updating" />}
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
        <div className="inline-flex self-start rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="Incident status">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              aria-pressed={status === tab.value}
              onClick={() => setStatus(tab.value)}
              className={cn(
                SEGMENT_BTN,
                status === tab.value ? "bg-surface-2 text-ink" : "text-ink-muted hover:text-ink",
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
            aria-label="Search incidents"
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
          onChange={(e) => setSort(e.target.value as EventSort)}
          aria-label="Sort incidents"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] sm:flex-wrap" role="group" aria-label="Date range">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              aria-pressed={activePreset === p.value}
              onClick={() => {
                const r = presetRange(p.value);
                setFrom(r.from);
                setTo(r.to);
              }}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-(--duration-fast)",
                activePreset === p.value
                  ? "border-accent/50 bg-accent-soft text-ink"
                  : "border-line text-ink-muted hover:border-ink-faint/40 hover:text-ink",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-faint">
          <CalendarRange className="size-4 shrink-0" aria-hidden />
          <input
            type="date"
            className="input w-full py-1.5 scheme-dark md:w-auto"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="From date"
            title="From date"
          />
          <span>to</span>
          <input
            type="date"
            className="input w-full py-1.5 scheme-dark md:w-auto"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            aria-label="To date"
            title="To date"
          />
        </div>
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

      {/* Summary, list + detail */}
      <div
        className={cn(
          "mt-5 grid items-start gap-6",
          selectedId && "lg:grid-cols-[minmax(0,1fr)_400px]",
        )}
      >
        <div className="min-w-0 space-y-5">
          {loading && !data ? (
            <>
              <div aria-hidden className="skeleton h-[7.5rem] rounded-card!" />
              <EventListSkeleton />
              <span className="sr-only" role="status">Loading incidents</span>
            </>
          ) : (
            <>
              <IncidentSummary rangeLabel={label} summary={summary} partial={partial} />
              {incidents.length === 0 ? (
                <EmptyState
                  icon={<AlertTriangle className="size-6 text-accent" />}
                  title={filtered ? "No incidents match" : "No incidents yet"}
                  description={
                    filtered
                      ? "Nothing matches these filters. Try a wider date range or clear the search."
                      : "Incidents appear here when a monitor goes down. Monitors that go down together show as one event."
                  }
                />
              ) : (
                <EventList
                  sections={sections}
                  expanded={expanded}
                  onToggle={toggle}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              )}
            </>
          )}
        </div>

        {selectedId && (
          <div
            className="fixed inset-0 z-40 overflow-y-auto bg-canvas/90 p-3 backdrop-blur-sm animate-fade lg:sticky lg:inset-auto lg:top-6 lg:z-auto lg:self-start lg:overflow-visible lg:bg-transparent lg:p-0 lg:backdrop-blur-none"
            role="dialog"
            aria-label="Incident details"
          >
            <Card className="p-0 animate-enter">
              {detailLoading && !detail ? (
                <div className="space-y-3 p-4" aria-hidden>
                  <div className="skeleton h-4 w-2/3" />
                  <div className="skeleton h-3 w-1/3" />
                  <div className="skeleton h-24 w-full" />
                  <div className="skeleton h-16 w-full" />
                </div>
              ) : detailError ? (
                <div className="flex items-start justify-between gap-3 p-4">
                  <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
                    Could not load incident: {detailError}
                  </p>
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    className="text-ink-faint transition-colors hover:text-ink"
                    aria-label="Close panel"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ) : detail ? (
                <DetailPanel
                  key={detail.incident.id}
                  detail={detail}
                  csrf={csrf ?? undefined}
                  onUpdatesChanged={reloadDetail}
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
  csrf: string | undefined;
  onUpdatesChanged: () => Promise<void>;
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
    <div className="lg:max-h-[calc(100vh_-_3rem)] lg:overflow-y-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-line p-4">
        <div className="min-w-0">
          <div className="truncate font-medium">{incidentTitle(inc)}</div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            {inc.monitorName && <span className="truncate text-xs text-ink-faint">{inc.monitorName}</span>}
            <CauseTag cause={causeLabel(inc)} />
          </div>
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
          value={inc.resolvedAt != null ? formatDateTime(inc.resolvedAt) : "-"}
        />
        <Meta label="Duration" value={durationLabel(inc)} />
        <Meta label="HTTP status" value={inc.httpStatus != null ? String(inc.httpStatus) : "-"} />
        {inc.confirmed && (
          <p className="col-span-2 text-xs text-ink-muted">
            {inc.confirmedFrom ? (
              <>
                Confirmed from{" "}
                <span className="font-medium text-ink" title={`Cloudflare data center ${inc.confirmedFrom}`}>
                  {coloCity(inc.confirmedFrom)}
                </span>{" "}
                by a second check before alerting.
              </>
            ) : (
              "Confirmed by a second check before alerting."
            )}
          </p>
        )}
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
              <p className="text-sm text-ink">{causeLabel({ ...inc, error: null }) ?? inc.rootCause}</p>
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

      {/* Public status updates */}
      <IncidentUpdatesEditor
        incidentId={inc.id}
        updates={p.detail.updates ?? []}
        isPublic={inc.public ?? false}
        csrf={p.csrf}
        onChanged={p.onUpdatesChanged}
      />

      {/* Editable annotations */}
      <div className="space-y-4 p-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-muted">Private notes</span>
          <textarea
            className="input"
            rows={3}
            value={p.privateNotes}
            onChange={(e) => p.setPrivateNotes(e.target.value)}
            placeholder="Internal notes, never shown publicly."
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-muted">Public summary</span>
          <textarea
            className="input"
            rows={2}
            value={p.publicMessage}
            onChange={(e) => p.setPublicMessage(e.target.value)}
            placeholder="One line shown above the status updates on the public page."
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
      <dd className="mt-0.5 break-words text-ink">{value}</dd>
    </div>
  );
}
