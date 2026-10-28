import { useEffect, useMemo, useState } from "react";
import { CalendarPlus, CalendarRange } from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { api, ApiError } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { PageTitle } from "../components/ui/PageTitle";
import { MaintenanceExplainer } from "../components/maintenance/Explainer";
import { QuickPause } from "../components/maintenance/QuickPause";
import { WindowForm } from "../components/maintenance/WindowForm";
import { ActiveWindowCard, PastWindows, UpcomingRow } from "../components/maintenance/WindowLists";
import { choiceSummary, type MonitorOption } from "../components/maintenance/MonitorPicker";
import { partitionWindows, type MaintenanceWindowItem } from "../components/maintenance/windows";

/**
 * Maintenance: what it is for, "pause alerts now", a scheduler for planned
 * windows, and the active (live countdown), upcoming and past windows. Reads
 * and writes the /api/maintenance routes as they are; the Overview reads the
 * same list.
 */

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const d = e.data as { message?: string; error?: string } | null;
    if (d && typeof d.message === "string") return d.message;
    if (d && typeof d.error === "string") return d.error;
  }
  return e instanceof Error ? e.message : fallback;
}

function SectionHeading({ children, count }: { children: string; count?: number }) {
  return (
    <h2 className="mb-2 flex items-baseline gap-2 px-1 text-sm font-semibold text-ink">
      {children}
      {count != null && count > 0 && <span className="text-xs font-normal text-ink-faint">{count}</span>}
    </h2>
  );
}

function ListSkeleton() {
  return (
    <div aria-hidden className="space-y-3">
      <div className="skeleton h-4 w-24" />
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-4 border-b border-line px-4 py-3 last:border-b-0">
            <div className="skeleton h-11 w-12 shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="skeleton h-3.5 w-40" />
              <div className="skeleton h-3 w-64 max-w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Maintenance() {
  const { csrf } = useBootstrap();
  const { data, loading, error, reload } = useFetch<{ windows: MaintenanceWindowItem[] }>("/api/maintenance");
  const { data: monData } = useFetch<{ monitors: MonitorOption[] }>("/api/monitors");

  const monitors = useMemo(
    () =>
      (monData?.monitors ?? [])
        .map((m) => ({ id: m.id, name: m.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [monData?.monitors],
  );
  const monitorsById = useMemo(() => new Map(monitors.map((m) => [m.id, m.name])), [monitors]);
  const scopeText = (w: MaintenanceWindowItem) =>
    choiceSummary(w.scope === "monitors" && w.monitorIds?.length ? w.monitorIds : "all", monitorsById);

  const windows = useMemo(() => data?.windows ?? [], [data?.windows]);

  // Wall clock: every second while a window is active (the countdown), else
  // every 30 s so upcoming windows move to active on time.
  const [now, setNow] = useState(() => Date.now());
  const parts = useMemo(() => partitionWindows(windows, now), [windows, now]);
  const hasActive = parts.active.length > 0;
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), hasActive ? 1000 : 30_000);
    return () => clearInterval(id);
  }, [hasActive]);

  const [mode, setMode] = useState<{ kind: "none" } | { kind: "new" } | { kind: "edit"; id: string }>({
    kind: "none",
  });
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<string | null>(null);

  async function act(w: MaintenanceWindowItem, run: () => Promise<unknown>, fallback: string) {
    setBusy((b) => ({ ...b, [w.id]: true }));
    setRowError(null);
    try {
      await run();
      await reload();
      setNow(Date.now());
    } catch (e) {
      setRowError(errMessage(e, fallback));
    } finally {
      setBusy((b) => ({ ...b, [w.id]: false }));
    }
  }

  const endNow = (w: MaintenanceWindowItem) =>
    act(w, () => api(`/api/maintenance/${w.id}/end`, { method: "POST", csrf: csrf ?? undefined }), "Could not end the window.");
  const extend = (w: MaintenanceWindowItem) =>
    act(
      w,
      () =>
        api(`/api/maintenance/${w.id}`, {
          method: "PUT",
          csrf: csrf ?? undefined,
          json: { endsAt: w.endsAt + 30 * 60_000 },
        }),
      "Could not extend the window.",
    );
  const remove = (w: MaintenanceWindowItem) => {
    if (!window.confirm(`Delete "${w.title ?? "this maintenance window"}"?`)) return;
    void act(
      w,
      () => api(`/api/maintenance/${w.id}`, { method: "DELETE", csrf: csrf ?? undefined }),
      "Could not delete the window.",
    );
  };

  const editing = mode.kind === "edit" ? windows.find((w) => w.id === mode.id) ?? null : null;
  const exampleMonitor = monitors[0]?.name ?? "your app";
  const formOpen = mode.kind === "new" || editing != null;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageTitle description="Pause alerts during planned work, and tell visitors it's planned.">
          Maintenance
        </PageTitle>
        {!formOpen && (
          <button
            type="button"
            onClick={() => setMode({ kind: "new" })}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-canvas transition-colors duration-(--duration-fast) hover:bg-accent-hover"
          >
            <CalendarPlus className="size-4" />
            Plan maintenance
          </button>
        )}
      </div>

      {formOpen && (
        <div className="mt-5">
          <WindowForm
            key={editing?.id ?? "new"}
            existing={editing}
            monitors={monitors}
            csrf={csrf ?? undefined}
            errorMessage={errMessage}
            onSaved={() => {
              setMode({ kind: "none" });
              void reload();
            }}
            onCancel={() => setMode({ kind: "none" })}
          />
        </div>
      )}

      <div className="stagger mt-5 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <MaintenanceExplainer exampleMonitor={exampleMonitor} />
        <QuickPause
          monitors={monitors}
          csrf={csrf ?? undefined}
          errorMessage={errMessage}
          onCreated={async () => {
            await reload();
            setNow(Date.now());
          }}
        />
      </div>

      {rowError && (
        <p role="alert" className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          {rowError}
        </p>
      )}

      <div className="mt-8 space-y-8">
        {loading && !data ? (
          <>
            <ListSkeleton />
            <span className="sr-only" role="status">Loading maintenance windows</span>
          </>
        ) : error ? (
          <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
            Could not load maintenance windows: {error}
          </p>
        ) : (
          <>
            {parts.active.length > 0 && (
              <section aria-label="Active maintenance">
                <SectionHeading count={parts.active.length}>Active now</SectionHeading>
                <div className="space-y-3">
                  {parts.active.map((entry) => (
                    <ActiveWindowCard
                      key={entry.win.id}
                      entry={entry}
                      now={now}
                      scopeText={scopeText(entry.win)}
                      busy={!!busy[entry.win.id]}
                      onEnd={() => void endNow(entry.win)}
                      onExtend={entry.win.recurrence ? undefined : () => void extend(entry.win)}
                      onEdit={() => setMode({ kind: "edit", id: entry.win.id })}
                    />
                  ))}
                </div>
              </section>
            )}

            <section aria-label="Upcoming maintenance">
              <SectionHeading count={parts.upcoming.length}>Upcoming</SectionHeading>
              {parts.upcoming.length === 0 ? (
                <div className="flex flex-col items-start gap-3 rounded-card border border-dashed border-line bg-surface/40 px-4 py-6 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-maint/15 text-maint">
                      <CalendarRange className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-medium text-ink">Nothing planned</p>
                      <p className="text-xs text-ink-muted">
                        Plan the next upgrade or migration here, so nobody gets paged for it.
                      </p>
                    </div>
                  </div>
                  {!formOpen && (
                    <button
                      type="button"
                      onClick={() => setMode({ kind: "new" })}
                      className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-ink transition-colors duration-(--duration-fast) hover:bg-surface-2"
                    >
                      <CalendarPlus className="size-3.5" /> Plan maintenance
                    </button>
                  )}
                </div>
              ) : (
                <ul className="stagger divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
                  {parts.upcoming.map((entry) => (
                    <UpcomingRow
                      key={entry.win.id}
                      entry={entry}
                      now={now}
                      scopeText={scopeText(entry.win)}
                      busy={!!busy[entry.win.id]}
                      onEdit={() => setMode({ kind: "edit", id: entry.win.id })}
                      onDelete={() => remove(entry.win)}
                    />
                  ))}
                </ul>
              )}
            </section>

            <PastWindows entries={parts.past} scopeText={scopeText} busyIds={busy} onDelete={remove} />
          </>
        )}
      </div>
    </div>
  );
}
