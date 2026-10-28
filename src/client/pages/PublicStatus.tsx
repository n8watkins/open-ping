import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  Hourglass,
  History,
  Loader2,
  MoonStar,
  Wrench,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { safeHttpUrl } from "../lib/api";
import { Logo } from "../components/Logo";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { cn } from "../lib/cn";
import { setPageMeta } from "../lib/meta";
import {
  formatDateTime,
  formatDuration,
  formatMs,
  formatPct,
  formatRelativeTime,
  formatShortDateTime,
  formatSince,
} from "../lib/format";
import {
  INCIDENT_UPDATE_LABELS,
  type IncidentUpdateStatus,
} from "../../shared/incident-updates";

/* ------------------------------------------------------------------ *
 * Response shape (GET /api/public/status). Defined locally - the
 * public status page is a standalone, unauthenticated surface.
 * ------------------------------------------------------------------ */

type Overall =
  | "operational"
  | "degraded"
  | "partial_outage"
  | "major_outage"
  | "maintenance"
  | "all_off"
  | "awaiting_data";

type ServiceState =
  | "operational"
  | "degraded"
  | "down"
  | "suspended"
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
  /** When an off-hours service went off (epoch ms); null otherwise. Optional
   *  so a feed from an older OpenPing without the field still renders. */
  since?: number | null;
  bars: UptimeBarPoint[];
}

interface ServiceGroup {
  name: string | null;
  services: PublicService[];
}

interface PublicIncidentUpdate {
  id: string;
  status: IncidentUpdateStatus;
  message: string;
  at: number;
}

interface PublicIncident {
  id: string;
  title: string;
  /** The admin's one-line summary. */
  message: string | null;
  startedAt: number;
  resolvedAt: number | null;
  durationSeconds: number | null;
  monitorName: string | null;
  /** Status updates, newest first. Optional for an older server. */
  updates?: PublicIncidentUpdate[];
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
  // Every service on the page has yet to be checked: say so instead of
  // claiming anything is operational.
  awaiting_data: {
    card: "border-line bg-surface-2/40",
    iconWrap: "bg-surface-2",
    text: "text-ink-muted",
    icon: <Hourglass className="size-6" />,
    label: "Waiting for the first checks",
  },
};

// `all_off` with services on the page means every one of them is outside its
// operating schedule (an empty page is the "No public services" case above).
const ALL_SCHEDULED_OFF_META: OverallMeta = {
  card: "border-scheduled/30 bg-scheduled/5",
  iconWrap: "bg-scheduled/15",
  text: "text-scheduled",
  icon: <MoonStar className="size-6" />,
  label: "All services are scheduled off",
};

/** Banner copy for the overall status, telling the two all_off cases apart. */
function overallMetaFor(overall: Overall, serviceCount: number): OverallMeta {
  return overall === "all_off" && serviceCount > 0
    ? ALL_SCHEDULED_OFF_META
    : // A newer server may send a state this build doesn't know yet.
      (OVERALL_META[overall] ?? OVERALL_META.all_off);
}

interface StateMeta {
  dot: string;
  text: string;
  label: string;
}

const SERVICE_STATE_META: Record<ServiceState, StateMeta> = {
  operational: { dot: "bg-up", text: "text-up", label: "Operational" },
  degraded: { dot: "bg-degraded", text: "text-degraded", label: "Degraded" },
  down: { dot: "bg-down", text: "text-down", label: "Down" },
  suspended: { dot: "bg-suspended", text: "text-suspended", label: "Suspended" },
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

/** Where "Powered by OpenPing" points: the project's own site. */
const OPENPING_SITE = "https://openping.n8builds.dev";

/**
 * The public status page, at /status, /status/:slug, and at `/` for signed-out
 * visitors on a HOME_PAGE="status" install (`asHome`), where a disabled page
 * becomes a short "no public status page" screen instead of a bare notice.
 */
export default function PublicStatus({ asHome = false }: { asHome?: boolean } = {}) {
  // Optional per-category slug from the `/status/:slug` route; `/status` (no
  // param) still resolves to the default page. Encode it so it is a safe query
  // value. The response JSON shape is identical with or without a slug.
  const { slug } = useParams();
  const path = `/api/public/status${
    slug ? `?slug=${encodeURIComponent(slug)}` : ""
  }`;
  const { data, loading, error } = useFetch<PublicStatusResponse>(path);

  // An unknown slug returns HTTP 404 `{ error: "not_found" }`; the api() helper
  // surfaces that server error string as the fetch error, so this is a missing
  // page (distinct from a generic fetch failure).
  const notFound = error === "not_found";

  const pageName = data?.page.name;
  const pageDescription = data?.page.description;
  const pageEnabled = data?.enabled;
  useEffect(() => {
    if (!pageName) return;
    if (pageEnabled === false) {
      // Nothing public to find here, so keep it out of search results.
      setPageMeta({ title: asHome ? pageName : `${pageName} | Status`, noindex: true });
      return;
    }
    setPageMeta({
      title: `${pageName} | Status`,
      description: pageDescription || `Live status and uptime history for ${pageName}.`,
    });
  }, [asHome, pageName, pageDescription, pageEnabled]);

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

  if (notFound) {
    return (
      <Notice
        title="Page not found"
        message="This status page doesn't exist."
      />
    );
  }

  if (error || !data) {
    return <Notice message="This status page is currently unavailable." />;
  }

  if (!data.enabled) {
    return asHome ? <NoPublicPage /> : <Notice message="This status page is not enabled." />;
  }

  const { page, overall, updatedAt, groups, activeIncidents, recentIncidents } = data;
  const serviceCount = groups.reduce((n, g) => n + g.services.length, 0);
  const overallMeta = overallMetaFor(overall, serviceCount);
  const activeMaintenance = data.maintenance.active;
  const hasCallouts = activeMaintenance.length > 0 || activeIncidents.length > 0;

  const accentStyle: CSSProperties | undefined = page.accent
    ? ({ "--color-accent": page.accent } as CSSProperties)
    : undefined;

  // Admin-supplied URLs render on this unauthenticated page, so only emit them
  // when they are http(s); a `javascript:` value would otherwise execute from
  // an href/src (rel/target do not prevent that).
  const safeLogo = safeHttpUrl(page.logo);
  const safeHomepage = safeHttpUrl(page.homepage);

  return (
    <div className="min-h-full bg-canvas text-ink" data-theme={effectiveTheme} style={accentStyle}>
      <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
        {/* Header */}
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {safeLogo ? (
              <img
                src={safeLogo}
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
                <p className="text-sm text-pretty break-words text-ink-muted">
                  {page.description}
                </p>
              )}
            </div>
          </div>
          {safeHomepage && (
            <a
              href={safeHomepage}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
            >
              Visit site
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </header>

        <main>
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
                {/* Off-hours means no recent checks, so "Updated 2d ago" would
                    read like a dead monitor: name the last check instead. */}
                {overallMeta === ALL_SCHEDULED_OFF_META
                  ? `Last check ${formatSince(updatedAt)}`
                  : `Updated ${formatRelativeTime(updatedAt)}`}
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
                id={`incident-${inc.id}`}
              >
                <IncidentTimeline updates={inc.updates} />
              </Callout>
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
                <div key={inc.id} id={`incident-${inc.id}`} className="scroll-mt-6 px-4 py-3.5">
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
                      {inc.monitorName && inc.message && ": "}
                      {inc.message}
                    </p>
                  )}
                  <IncidentTimeline updates={inc.updates} />
                </div>
              ))}
            </Card>
          )}
        </section>
        </main>

        {/* Footer */}
        <footer className="mt-12 border-t border-line pt-6 text-center text-xs text-ink-faint">
          {page.footer && <p className="text-ink-muted">{page.footer}</p>}
          {page.attribution && (
            <p className={cn(page.footer && "mt-2")}>
              Powered by{" "}
              <a
                href={OPENPING_SITE}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-ink-muted underline decoration-line underline-offset-4 hover:text-ink hover:decoration-accent"
              >
                OpenPing
              </a>
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

const BAR_STATE_LABEL: Record<BarState, string> = {
  up: "operational",
  degraded: "degraded",
  down: "down",
  none: "no data",
};

/**
 * Text summary of the daily uptime strip so the history is not conveyed by
 * color/hover alone (WCAG 1.4.1). Reads overall uptime plus per-state day counts.
 */
function barsSummary(service: PublicService, bars: UptimeBarPoint[]): string {
  const counts = bars.reduce<Partial<Record<BarState, number>>>((acc, b) => {
    acc[b.state] = (acc[b.state] ?? 0) + 1;
    return acc;
  }, {});
  const parts = (Object.keys(counts) as BarState[]).map(
    (s) => `${counts[s]} ${BAR_STATE_LABEL[s]}`,
  );
  const prefix =
    service.uptime90d != null
      ? `${formatPct(service.uptime90d)} uptime over ${bars.length} days`
      : `Uptime history over ${bars.length} days`;
  return `${prefix}: ${parts.join(", ")}`;
}

function ServiceRow({ service }: { service: PublicService }) {
  const meta = SERVICE_STATE_META[service.state];
  const bars = service.bars.slice(-90);
  const offSince =
    service.state === "scheduled_off" && service.since != null
      ? service.since
      : null;

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
            <span>
              {meta.label}
              {offSince != null && (
                <span className="font-normal text-ink-muted" title={formatDateTime(offSince)}>
                  {" "}since {formatSince(offSince)}
                </span>
              )}
            </span>
          </span>
        </div>
      </div>

      {service.showUptime && bars.length > 0 && (
        <div className="mt-3">
          <div
            role="img"
            aria-label={barsSummary(service, bars)}
            className="flex h-7 items-stretch gap-px"
          >
            {bars.map((bar, i) => (
              <div
                key={i}
                title={`${bar.date}: ${
                  bar.uptimePct == null ? "no data" : formatPct(bar.uptimePct)
                }`}
                aria-hidden="true"
                className={cn(
                  "flex-1 rounded-[2px] first:rounded-l last:rounded-r",
                  BAR_META[bar.state],
                )}
              />
            ))}
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-faint">
            <span>90 days ago</span>
            {/* A service that was never checked has earned no uptime yet. */}
            <span>
              {service.uptime90d != null
                ? `${formatPct(service.uptime90d)} uptime`
                : "No data yet"}
            </span>
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
  id,
  children,
}: {
  toneClass: string;
  icon: ReactNode;
  title: string;
  meta?: string;
  message?: string | null;
  id?: string;
  children?: ReactNode;
}) {
  return (
    <div id={id} className={cn("scroll-mt-6 rounded-card border p-4", toneClass)}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h3 className="text-sm font-semibold text-ink">{title}</h3>
            {meta && <span className="text-xs text-ink-faint">{meta}</span>}
          </div>
          {message && <p className="mt-1 text-sm text-ink-muted">{message}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}

/** Dot and label color per update status (explicit classes for the extractor). */
const UPDATE_TONE: Record<IncidentUpdateStatus, { dot: string; text: string }> = {
  investigating: { dot: "bg-down", text: "text-down" },
  identified: { dot: "bg-warming", text: "text-warming" },
  monitoring: { dot: "bg-maint", text: "text-maint" },
  resolved: { dot: "bg-up", text: "text-up" },
};

/**
 * An incident's status updates, newest first, each with its status, when it
 * was posted (relative and absolute) and the admin's message.
 */
function IncidentTimeline({ updates }: { updates?: PublicIncidentUpdate[] }) {
  if (!updates || updates.length === 0) return null;
  return (
    <ol aria-label="Updates" className="mt-3 space-y-3 border-l border-line pl-4">
      {updates.map((u) => {
        const tone = UPDATE_TONE[u.status] ?? UPDATE_TONE.investigating;
        return (
          <li key={u.id} className="relative">
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-1.5 -left-[21px] size-2 rounded-full ring-2 ring-canvas",
                tone.dot,
              )}
            />
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className={cn("text-xs font-semibold", tone.text)}>
                {INCIDENT_UPDATE_LABELS[u.status] ?? u.status}
              </span>
              <time
                dateTime={new Date(u.at).toISOString()}
                title={formatDateTime(u.at)}
                className="text-xs text-ink-faint"
              >
                {formatRelativeTime(u.at)} · {formatShortDateTime(u.at)}
              </time>
            </div>
            <p className="mt-0.5 text-sm break-words whitespace-pre-line text-ink-muted">
              {u.message}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * `/` on a HOME_PAGE="status" install whose status page is turned off: say so
 * plainly, and leave the owner a small way in.
 */
function NoPublicPage() {
  return (
    <div className="grid min-h-full place-items-center bg-canvas px-4 text-ink">
      <main className="max-w-sm text-center">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <h1 className="text-balance text-lg font-semibold tracking-tight text-ink">
          This OpenPing has no public status page
        </h1>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-ink-muted">
          Its owner monitors their services here privately and hasn't published a status page.
        </p>
        <p className="mt-8 flex items-center justify-center gap-3 text-xs text-ink-faint">
          <Link to="/login" className="underline decoration-line underline-offset-4 hover:text-ink hover:decoration-accent">
            Owner sign-in
          </Link>
          <span aria-hidden="true">·</span>
          <span>
            Powered by{" "}
            <a
              href={OPENPING_SITE}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-line underline-offset-4 hover:text-ink hover:decoration-accent"
            >
              OpenPing
            </a>
          </span>
        </p>
      </main>
    </div>
  );
}

function Notice({ title, message }: { title?: string; message: string }) {
  return (
    <div className="grid min-h-full place-items-center bg-canvas px-4 text-ink">
      <div className="text-center">
        <div className="mb-5 flex justify-center">
          <Logo />
        </div>
        {title && (
          <h1 className="mb-1 text-lg font-semibold tracking-tight text-ink">
            {title}
          </h1>
        )}
        <p className="text-sm text-ink-muted">{message}</p>
      </div>
    </div>
  );
}
