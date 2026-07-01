import { useEffect, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Loader2,
  Wrench,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { StatusPill } from "../components/ui/StatusPill";
import { cn } from "../lib/cn";
import { formatRelativeTime } from "../lib/format";
import type { MonitorState } from "../../shared/states";

/* ------------------------------------------------------------------ *
 * Embeddable status widget (mounted at /embed). Renders inside an
 * <iframe> on an EXTERNAL host page, so it reuses ONLY the already
 * public, redacted payload from GET /api/public/status (same endpoint
 * the public status page uses) — it never reaches for monitor config,
 * tokens, headers, or internal errors. The framing headers for this
 * route are widened in src/worker/index.ts so the iframe can load
 * cross-origin; everything else stays SAMEORIGIN.
 * ------------------------------------------------------------------ */

// Only the slice of the public payload this compact card needs. The full
// shape (bars, incidents, maintenance, branding) is intentionally ignored.
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
  | "suspended"
  | "maintenance"
  | "scheduled_off"
  | "unknown";

interface PublicService {
  id: string;
  name: string;
  state: ServiceState;
}

interface ServiceGroup {
  name: string | null;
  services: PublicService[];
}

interface WidgetResponse {
  page?: { name?: string };
  enabled?: boolean;
  overall?: Overall;
  updatedAt?: number;
  groups?: ServiceGroup[];
}

const REFRESH_MS = 60_000;

/* ------------------------------------------------------------------ *
 * Token maps (no dynamic Tailwind interpolation so the static
 * extractor keeps every utility class).
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
    icon: <CheckCircle2 className="size-5" />,
    label: "All systems operational",
  },
  degraded: {
    card: "border-degraded/30 bg-degraded/5",
    iconWrap: "bg-degraded/15",
    text: "text-degraded",
    icon: <AlertTriangle className="size-5" />,
    label: "Some systems degraded",
  },
  partial_outage: {
    card: "border-warming/30 bg-warming/5",
    iconWrap: "bg-warming/15",
    text: "text-warming",
    icon: <AlertTriangle className="size-5" />,
    label: "Partial outage",
  },
  major_outage: {
    card: "border-down/30 bg-down/5",
    iconWrap: "bg-down/15",
    text: "text-down",
    icon: <AlertOctagon className="size-5" />,
    label: "Major outage",
  },
  maintenance: {
    card: "border-maint/30 bg-maint/5",
    iconWrap: "bg-maint/15",
    text: "text-maint",
    icon: <Wrench className="size-5" />,
    label: "Maintenance underway",
  },
  all_off: {
    card: "border-line bg-surface-2/40",
    iconWrap: "bg-surface-2",
    text: "text-ink-muted",
    icon: <CircleSlash className="size-5" />,
    label: "No public services",
  },
};

// Public service states map onto the shared MonitorState palette so the widget
// can reuse the existing <StatusPill>; labels mirror the public status page.
const STATE_TO_MONITOR: Record<ServiceState, MonitorState> = {
  operational: "up",
  degraded: "degraded",
  down: "down",
  suspended: "suspended",
  maintenance: "maintenance",
  scheduled_off: "scheduled_off",
  unknown: "unknown",
};

const STATE_LABEL: Record<ServiceState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
  suspended: "Suspended",
  maintenance: "Maintenance",
  scheduled_off: "Scheduled off",
  unknown: "Unknown",
};

/* ------------------------------------------------------------------ *
 * Widget
 * ------------------------------------------------------------------ */

export default function Embed() {
  const [params] = useSearchParams();
  // Default to dark to match OpenPing; only an explicit ?theme=light flips it.
  const theme = params.get("theme") === "light" ? "light" : "dark";

  // Optional per-category slug: scopes the widget to one status page. Absent =>
  // the default page (unchanged behavior). Encoded so it is a safe query value.
  const slug = params.get("slug");
  const path = `/api/public/status${
    slug ? `?slug=${encodeURIComponent(slug)}` : ""
  }`;

  const { data, loading, error, reload } = useFetch<WidgetResponse>(path);

  // Keep the embedded card live without reloading the host page.
  useEffect(() => {
    const id = setInterval(() => {
      void reload();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [reload]);

  // Make the iframe document transparent so the card blends into the host page
  // regardless of its background (index.css paints the body with the app canvas
  // color; this route-scoped override clears it without editing that file).
  useEffect(() => {
    const prevHtml = document.documentElement.style.background;
    const prevBody = document.body.style.background;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    return () => {
      document.documentElement.style.background = prevHtml;
      document.body.style.background = prevBody;
    };
  }, []);

  // Best-effort auto-resize: broadcast our content height so a host that opts in
  // can size the <iframe> to fit. Only a height integer is posted (no data), so
  // a wildcard target origin is acceptable. Hosts that ignore it just use the
  // height they set on the <iframe>.
  useEffect(() => {
    const post = () => {
      const height = Math.ceil(
        document.documentElement.getBoundingClientRect().height,
      );
      window.parent?.postMessage({ type: "openping:resize", height }, "*");
    };
    post();
    window.addEventListener("resize", post);
    return () => window.removeEventListener("resize", post);
  }, [data, theme]);

  let body: ReactNode;
  if (loading && !data) {
    body = (
      <div className="grid h-24 place-items-center">
        <Loader2 className="size-5 animate-spin text-ink-faint" />
      </div>
    );
  } else if (error || !data) {
    body = <Message text="Status unavailable." />;
  } else if (data.enabled === false) {
    body = <Message text="Status page not enabled." />;
  } else {
    const overall = data.overall ?? "all_off";
    const meta = OVERALL_META[overall];
    const services = (data.groups ?? []).flatMap((g) => g.services ?? []);

    body = (
      <>
        <div
          className={cn(
            "flex items-center gap-3 rounded-card border p-3",
            meta.card,
          )}
        >
          <span
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-full",
              meta.iconWrap,
              meta.text,
            )}
          >
            {meta.icon}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-tight">
              {meta.label}
            </div>
            {data.updatedAt != null && (
              <div className="text-xs text-ink-faint">
                Updated {formatRelativeTime(data.updatedAt)}
              </div>
            )}
          </div>
        </div>

        {services.length > 0 && (
          <ul className="mt-2.5 divide-y divide-line rounded-card border border-line bg-surface">
            {services.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm text-ink">
                  {s.name}
                </span>
                <StatusPill
                  state={STATE_TO_MONITOR[s.state]}
                  label={STATE_LABEL[s.state]}
                />
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  const pageName = data?.page?.name ?? "OpenPing";

  return (
    <div data-theme={theme} className="text-ink">
      <div className="mx-auto max-w-md p-3">
        {body}
        <div className="mt-2 flex items-center justify-between text-[11px] text-ink-faint">
          <span className="truncate">{pageName}</span>
          <a
            href={`/status${slug ? `/${encodeURIComponent(slug)}` : ""}`}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 transition-colors hover:text-ink-muted"
          >
            View status →
          </a>
        </div>
      </div>
    </div>
  );
}

function Message({ text }: { text: string }) {
  return (
    <div className="grid h-24 place-items-center rounded-card border border-line bg-surface px-3 text-center text-sm text-ink-muted">
      {text}
    </div>
  );
}
