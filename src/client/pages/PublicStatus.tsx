import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  History,
  Loader2,
  Wrench,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { Logo } from "../components/Logo";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { cn } from "../lib/cn";
import {
  formatDateTime,
  formatDuration,
  formatMs,
  formatPct,
  formatRelativeTime,
} from "../lib/format";

/* ------------------------------------------------------------------ *
 * Response shape (GET /api/public/status). Defined locally — the
 * public status page is a standalone, unauthenticated surface.
 * ------------------------------------------------------------------ */

type Overall =
  | "operational"
  | "degraded"
  | "partial_outage"
  | "major_outage"
  | "maintenance"
  | "all_off";

type ServiceState =
  | "operational"
  | "degraded"
  | "down"
  | "maintenance"
  | "scheduled_off"
  | "unknown";

type BarState = "up" | "degraded" | "down" | "none";

interface UptimeBarPoint {
  date: string;
  uptimePct: number | null;
  state: BarState;
}

interface PublicService {
  id: string;
  name: string;
  description: string | null;
  state: ServiceState;
  showUptime: boolean;
  uptime90d: number | null;
  latestMs: number | null;
  bars: UptimeBarPoint[];
}

interface ServiceGroup {
  name: string | null;
  services: PublicService[];
}

interface PublicIncident {
  id: string;
  title: string;
  message: string | null;
  startedAt: number;
  resolvedAt: number | null;
  durationSeconds: number | null;
  monitorName: string | null;
}

interface MaintenanceWindow {
  // The server does not expose the window's internal title (it can hold private
  // labels); the callout uses a generic heading and the admin's public message.
  message: string | null;
  startsAt: number;
  endsAt: number;
}

interface PageMeta {
  name: string;
  description: string | null;
  logo: string | null;
  accent: string | null;
  theme: string | null;
  homepage: string | null;
  footer: string | null;
  attribution: boolean;
}

interface PublicStatusResponse {
  page: PageMeta;
  enabled: boolean;
  overall: Overall;
  updatedAt: number;
  groups: ServiceGroup[];
  activeIncidents: PublicIncident[];
  recentIncidents: PublicIncident[];
  maintenance: {
    active: MaintenanceWindow[];
    upcoming: MaintenanceWindow[];
  };
}

/* ------------------------------------------------------------------ *
 * Explicit token -> class maps (no dynamic Tailwind interpolation so
 * the static extractor keeps every utility).
 * ------------------------------------------------------------------ */

interface OverallMeta {
  card: string;
  iconWrap: string;
  text: string;
  icon: ReactNode;
  label: string;
}

const OVERALL_META: Record<Overall, OverallMeta> = {
  operational: {
    card: "border-up/30 bg-up/5",
    iconWrap: "bg-up/15",
    text: "text-up",
    icon: <CheckCircle2 className="size-6" />,
    label: "All systems operational",
  },
  degraded: {
    card: "border-degraded/30 bg-degraded/5",
    iconWrap: "bg-degraded/15",
    text: "text-degraded",
    icon: <AlertTriangle className="size-6" />,
    label: "Some systems degraded",
  },
  partial_outage: {
    card: "border-warming/30 bg-warming/5",
    iconWrap: "bg-warming/15",
    text: "text-warming",
    icon: <AlertTriangle className="size-6" />,
    label: "Partial outage",
  },
  major_outage: {
    card: "border-down/30 bg-down/5",
    iconWrap: "bg-down/15",
    text: "text-down",
    icon: <AlertOctagon className="size-6" />,
    label: "Major outage",
  },
  maintenance: {
    card: "border-maint/30 bg-maint/5",
    iconWrap: "bg-maint/15",
    text: "text-maint",
    icon: <Wrench className="size-6" />,
    label: "Scheduled maintenance underway",
  },
  all_off: {
    card: "border-line bg-surface-2/40",
    iconWrap: "bg-surface-2",
    text: "text-ink-muted",
    icon: <CircleSlash className="size-6" />,
    label: "No public services",
  },
};

interface StateMeta {
  dot: string;
  text: string;
  label: string;
}

const SERVICE_STATE_META: Record<ServiceState, StateMeta> = {
  operational: { dot: "bg-up", text: "text-up", label: "Operational" },
  degraded: { dot: "bg-degraded", text: "text-degraded", label: "Degraded" },
  down: { dot: "bg-down", text: "text-down", label: "Down" },
  maintenance: { dot: "bg-maint", text: "text-maint", label: "Maintenance" },
  scheduled_off: { dot: "bg-scheduled", text: "text-scheduled", label: "Scheduled off" },
  unknown: { dot: "bg-paused", text: "text-paused", label: "Unknown" },
};

const BAR_META: Record<BarState, string> = {
  up: "bg-up",
  degraded: "bg-degraded",
  down: "bg-down",
  none: "bg-line",
};

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function PublicStatus() {
  const { data, loading, error } = useFetch<PublicStatusResponse>(
    "/api/public/status",
  );

  useEffect(() => {
    if (data?.page.name) document.title = `${data.page.name} — Status`;
  }, [data?.page.name]);

  // Apply the configured theme: light/dark explicitly, or follow the visitor's
  // OS preference when "system". The resolved value drives data-theme on the
  // page wrapper (light tokens live in index.css under [data-theme="light"]).
  const configuredTheme = data?.page.theme ?? "system";
  const [systemLight, setSystemLight] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: light)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (e: MediaQueryListEvent) => setSystemLight(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const effectiveTheme =
    configuredTheme === "light"
      ? "light"
      : configuredTheme === "dark"
        ? "dark"
        : systemLight
          ? "light"
          : "dark";

  if (loading && !data) {
    return (
      <div className="grid min-h-full place-items-center bg-canvas text-ink">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }

  if (error || !data) {
    return <Notice message="This status page is currently unavailable." />;
  }

  if (!data.enabled) {
    return <Notice message="This status page is not enabled." />;
  }

  const { page, overall, updatedAt, groups, activeIncidents, recentIncidents } = data;
  const overallMeta = OVERALL_META[overall];
  const activeMaintenance = data.maintenance.active;
  const hasCallouts = activeMaintenance.length > 0 || activeIncidents.length > 0;

  const accentStyle: CSSProperties | undefined = page.accent
    ? ({ "--color-accent": page.accent } as CSSProperties)
    : undefined;

  return (
    <div className="min-h-full bg-canvas text-ink" data-theme={effectiveTheme} style={accentStyle}>
      <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
        {/* Header */}
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {page.logo ? (
              <img
                src={page.logo}
                alt={page.name}
                className="size-9 shrink-0 rounded-lg object-contain"
              />
            ) : (
              <Logo compact />
            )}
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight">
                {page.name}
              </h1>
              {page.description && (
                <p className="truncate text-sm text-ink-muted">{page.description}</p>
              )}
            </div>
          </div>
          {page.homepage && (
            <a
              href={page.homepage}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
            >
              Visit site
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </header>

        {/* Overall status banner */}
        <section className={cn("mt-8 rounded-card border p-6", overallMeta.card)}>
          <div className="flex items-center gap-4">
            <span
              className={cn(
                "grid size-12 shrink-0 place-items-center rounded-full",
                overallMeta.iconWrap,
                overallMeta.text,
              )}
            >
              {overallMeta.icon}
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight">
                {overallMeta.label}
              </h2>
              <p
                className="mt-0.5 text-sm text-ink-muted"
                title={formatDateTime(updatedAt)}
              >
                Updated {formatRelativeTime(updatedAt)}
              </p>
            </div>
          </div>
        </section>

        {/* Active maintenance + incidents */}
        {hasCallouts && (
          <div className="mt-6 space-y-3">
            {activeMaintenance.map((m, i) => (
              <Callout
                key={`maint-${i}`}
                toneClass="border-maint/30 bg-maint/5"
                icon={<Wrench className="size-5 text-maint" />}
                title="Scheduled maintenance"
                meta={`${formatDateTime(m.startsAt)} – ${formatDateTime(m.endsAt)}`}
                message={m.message}
              />
            ))}
            {activeIncidents.map((inc) => (
              <Callout
                key={inc.id}
                toneClass="border-down/30 bg-down/5"
                icon={<AlertOctagon className="size-5 text-down" />}
                title={inc.title}
                meta={
                  inc.monitorName
                    ? `${inc.monitorName} · Started ${formatRelativeTime(inc.startedAt)}`
                    : `Started ${formatRelativeTime(inc.startedAt)}`
                }
                message={inc.message}
              />
            ))}
          </div>
        )}

        {/* Service groups */}
        {groups.map((group, gi) => (
          <section key={`group-${gi}`} className="mt-8">
            <h2 className="mb-3 text-sm font-semibold tracking-tight text-ink-muted">
              {group.name || "Services"}
            </h2>
            {group.services.length === 0 ? (
              <Card className="text-sm text-ink-faint">No services in this group.</Card>
            ) : (
              <Card className="divide-y divide-line p-0">
                {group.services.map((service) => (
                  <ServiceRow key={service.id} service={service} />
                ))}
              </Card>
            )}
          </section>
        ))}

        {/* Recent incidents */}
        <section className="mt-10">
          <h2 className="mb-3 text-sm font-semibold tracking-tight text-ink-muted">
            Recent incidents
          </h2>
          {recentIncidents.length === 0 ? (
            <EmptyState
              icon={<History className="size-6" />}
              title="No recent incidents"
              description="There have been no reported incidents recently."
            />
          ) : (
            <Card className="divide-y divide-line p-0">
              {recentIncidents.map((inc) => (
                <div key={inc.id} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <h3 className="text-sm font-medium text-ink">{inc.title}</h3>
                    <span className="text-xs text-ink-faint">
                      {formatRelativeTime(inc.startedAt)}
                      {inc.durationSeconds != null &&
                        ` · ${formatDuration(inc.durationSeconds)}`}
                    </span>
                  </div>
                  {(inc.monitorName || inc.message) && (
                    <p className="mt-1 text-sm text-ink-muted">
                      {inc.monitorName && (
                        <span className="text-ink-faint">{inc.monitorName}</span>
                      )}
                      {inc.monitorName && inc.message && " — "}
                      {inc.message}
                    </p>
                  )}
                </div>
              ))}
            </Card>
          )}
        </section>

        {/* Footer */}
        <footer className="mt-12 border-t border-line pt-6 text-center text-xs text-ink-faint">
          {page.footer && <p className="text-ink-muted">{page.footer}</p>}
          {page.attribution && (
            <p className={cn(page.footer && "mt-2")}>
              Powered by <span className="font-medium text-ink-muted">OpenPing</span>
            </p>
          )}
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

function ServiceRow({ service }: { service: PublicService }) {
  const meta = SERVICE_STATE_META[service.state];
  const bars = service.bars.slice(-90);

  return (
    <div className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-ink">{service.name}</div>
          {service.description && (
            <p className="mt-0.5 text-sm text-ink-muted">{service.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs">
          {service.showUptime && service.uptime90d != null && (
            <span className="hidden text-ink-muted sm:inline">
              {formatPct(service.uptime90d)}
            </span>
          )}
          {service.latestMs != null && (
            <span className="hidden text-ink-faint sm:inline">
              {formatMs(service.latestMs)}
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 font-medium",
              meta.text,
            )}
          >
            <span className={cn("size-1.5 rounded-full", meta.dot)} />
            {meta.label}
          </span>
        </div>
      </div>

      {service.showUptime && bars.length > 0 && (
        <div className="mt-3">
          <div className="flex h-7 items-stretch gap-px">
            {bars.map((bar, i) => (
              <div
                key={i}
                title={`${bar.date}: ${
                  bar.uptimePct == null ? "no data" : formatPct(bar.uptimePct)
                }`}
                className={cn(
                  "flex-1 rounded-[2px] first:rounded-l last:rounded-r",
                  BAR_META[bar.state],
                )}
              />
            ))}
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-faint">
            <span>90 days ago</span>
            {service.uptime90d != null && (
              <span>{formatPct(service.uptime90d)} uptime</span>
            )}
            <span>Today</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Callout({
  toneClass,
  icon,
  title,
  meta,
  message,
}: {
  toneClass: string;
  icon: ReactNode;
  title: string;
  meta?: string;
  message?: string | null;
}) {
  return (
    <div className={cn("rounded-card border p-4", toneClass)}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h3 className="text-sm font-semibold text-ink">{title}</h3>
            {meta && <span className="text-xs text-ink-faint">{meta}</span>}
          </div>
          {message && <p className="mt-1 text-sm text-ink-muted">{message}</p>}
        </div>
      </div>
    </div>
  );
}

function Notice({ message }: { message: string }) {
  return (
    <div className="grid min-h-full place-items-center bg-canvas px-4 text-ink">
      <div className="text-center">
        <div className="mb-5 flex justify-center">
          <Logo />
        </div>
        <p className="text-sm text-ink-muted">{message}</p>
      </div>
    </div>
  );
}
