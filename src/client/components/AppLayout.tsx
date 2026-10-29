import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, Navigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Activity,
  AlertTriangle,
  Wrench,
  Bell,
  Code2,
  Settings,
  Globe,
  Loader2,
  WifiOff,
  LogOut,
  MoreHorizontal,
  User,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import { api } from "../lib/api";
import { Logo } from "./Logo";
import { useBootstrap } from "../lib/bootstrap";
import { useFetch } from "../lib/useFetch";
import type { OverviewResponse } from "../lib/types";
import { shellTransitionKey } from "../lib/section-routes";
import { clearSavedData, offlineBanner, offlineSummary, precacheApp, useSavedAt } from "../lib/offline";
import { InstallNavButton, IosInstallSheet, hasNavEntry } from "./InstallApp";
import { useInstallState } from "../lib/install";
import { PAGE_REFRESHED_EVENT } from "../lib/pull-to-refresh";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

// Static class maps (no dynamic Tailwind interpolation) for the header pill.
const STATUS_PILL = {
  operational: { dot: "bg-up", text: "text-up", label: "Operational" },
  degraded: { dot: "bg-degraded", text: "text-degraded", label: "Degraded" },
  down: { dot: "bg-down", text: "text-down", label: "Down" },
  suspended: { dot: "bg-suspended", text: "text-suspended", label: "Suspended" },
  // Offline: what's on screen is saved or stale, so no live status is claimed.
  offline: { dot: "bg-ink-faint", text: "text-ink-muted", label: "Offline" },
} as const;

/** Only a live problem pulses; operational and offline stay still. */
const PULSING: ReadonlySet<(typeof STATUS_PILL)[keyof typeof STATUS_PILL]> = new Set([
  STATUS_PILL.down,
  STATUS_PILL.suspended,
  STATUS_PILL.degraded,
]);

/** The sidebar's one-line summary: what's wrong, or that all is well. */
function statusSummary(counts: OverviewResponse["counts"] | undefined): string {
  if (!counts) return "Checking";
  const parts: string[] = [];
  if (counts.down) parts.push(`${counts.down} down`);
  if (counts.suspended) parts.push(`${counts.suspended} suspended`);
  if (counts.degraded) parts.push(`${counts.degraded} degraded`);
  if (parts.length === 0 && counts.openIncidents) parts.push(`${counts.openIncidents} open incident${counts.openIncidents === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "All systems operational";
}

/** Derive the overall header status from real overview counts. */
function deriveStatus(counts: OverviewResponse["counts"] | undefined) {
  if (!counts) return STATUS_PILL.operational;
  if ((counts.down ?? 0) > 0) return STATUS_PILL.down;
  // `suspended` is a down-family outage but shown distinctly; it ranks below a
  // hard `down` but above merely-degraded.
  if ((counts.suspended ?? 0) > 0) return STATUS_PILL.suspended;
  if ((counts.degraded ?? 0) > 0 || counts.openIncidents > 0) return STATUS_PILL.degraded;
  return STATUS_PILL.operational;
}

const MONITORING_NAV: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/monitors", label: "Monitors", icon: Activity },
  { to: "/incidents", label: "Incidents", icon: AlertTriangle },
  { to: "/status-page", label: "Status pages", icon: Globe },
  { to: "/maintenance", label: "Maintenance", icon: Wrench },
];
// Where alerts go, how code reaches OpenPing, and the install itself.
const CONFIGURE_NAV: NavItem[] = [
  { to: "/alerts", label: "Alerts", icon: Bell },
  { to: "/developers", label: "Developers", icon: Code2 },
  { to: "/settings", label: "Settings", icon: Settings },
];
const NAV: NavItem[] = [...MONITORING_NAV, ...CONFIGURE_NAV];
const MOBILE_NAV = NAV.slice(0, 4);
const MOBILE_MORE_NAV = NAV.slice(4);

function isActivePath(pathname: string, to: string): boolean {
  return to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`);
}

export function AppLayout() {
  // Offline on a device with a saved Overview, the shell opens on that
  // (savedSession) instead of a sign-in page that can't work either.
  const { loading, status, me, csrf, savedSession: offlineShell } = useBootstrap();

  // Signed in: save the whole app for offline use (public/sw.js).
  const signedIn = !!me?.authenticated;
  useEffect(() => {
    if (signedIn) precacheApp();
  }, [signedIn]);

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST", csrf: csrf ?? undefined });
    } catch {
      // Ignore - clear the local view and head to login regardless.
    }
    await clearSavedData();
    // Full reload so bootstrap/auth state (and any PWA cache) resets cleanly.
    window.location.assign("/login");
  }

  // Real overall status for the header pill (skipped until authenticated).
  const { data: overview, reload: reloadOverview } = useFetch<OverviewResponse>(
    me?.authenticated || offlineShell ? "/api/overview" : null,
  );

  // Surface offline/stale state (PWA cache): listen for connectivity changes.
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [installStepsOpen, setInstallStepsOpen] = useState(false);
  const closeInstallSteps = useCallback(() => setInstallStepsOpen(false), []);
  const savedAt = useSavedAt();
  const { pathname } = useLocation();
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  // The phone "More" menu closes on navigation, Escape, or a tap outside it.
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileMenuOpen(false);
        moreButtonRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!moreRef.current?.contains(t) && !moreButtonRef.current?.contains(t)) setMobileMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [mobileMenuOpen]);

  // A page pulled to refresh: the header status follows.
  useEffect(() => {
    const onRefreshed = () => void reloadOverview();
    window.addEventListener(PAGE_REFRESHED_EVENT, onRefreshed);
    return () => window.removeEventListener(PAGE_REFRESHED_EVENT, onRefreshed);
  }, [reloadOverview]);

  // The shell's own look on phones: no rubber-band scrolling of the page and
  // instant tap feedback (index.css, under html[data-shell="app"]).
  useEffect(() => {
    document.documentElement.dataset.shell = "app";
    return () => {
      delete document.documentElement.dataset.shell;
    };
  }, []);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (loading) {
    return (
      <div className="grid min-h-full place-items-center">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }
  if (!me?.authenticated && !offlineShell) return <Navigate to="/login" replace />;
  // Once the administrator has authenticated, finish any incomplete setup
  // before exposing the admin workspace. This also supports deployments that
  // preconfigure the admin identity as a Worker secret.
  if (status && !status.setupComplete) return <Navigate to="/setup" replace />;

  const moreActive = MOBILE_MORE_NAV.some((item) => isActivePath(pathname, item.to));
  // Date.now() only decides whether the saved time needs its date too.
  const now = Date.now();
  const banner = offlineBanner({ online: online && !offlineShell, savedAt, now });
  // While the banner shows, the pill and the summary never claim live status.
  const pill = banner ? STATUS_PILL.offline : deriveStatus(overview?.counts);
  const summary = banner ? offlineSummary(savedAt, now) : statusSummary(overview?.counts);

  return (
    <div className="flex min-h-full">
      {/* Skip link: first focusable element, jumps keyboard/SR users past the
          nav straight to the main content. Visually hidden until focused. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:border focus:border-line focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-ink"
      >
        Skip to content
      </a>
      {/* Desktop sidebar: stays put while the page scrolls. */}
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line bg-surface/55 px-3 py-4 md:flex">
        <div className="px-2 pb-5">
          <Logo />
        </div>
        <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
          <ul className="flex flex-col gap-0.5">
            {MONITORING_NAV.map((item) => (
              <li key={item.to}>
                <SidebarLink item={item} />
              </li>
            ))}
          </ul>
          <div>
            <div className="mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-ink-faint uppercase">Configure</div>
            <ul className="flex flex-col gap-0.5">
              {CONFIGURE_NAV.map((item) => (
                <li key={item.to}>
                  <SidebarLink item={item} />
                </li>
              ))}
            </ul>
          </div>
        </nav>
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <InstallNavButton variant="sidebar" onShowSteps={() => setInstallStepsOpen(true)} />
          <NavLink
            to="/"
            end
            title={summary}
            className={cn(
              "flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs leading-snug transition-colors duration-150 hover:bg-surface-2/70",
              pill.text,
            )}
          >
            <span className="relative mt-[3px] grid size-2 shrink-0 place-items-center" aria-hidden>
              {PULSING.has(pill) && (
                <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", pill.dot)} />
              )}
              <span className={cn("relative size-2 rounded-full", pill.dot)} />
            </span>
            <span className="min-w-0 font-medium">{summary}</span>
          </NavLink>
          {me?.identity && (
            <div className="flex items-center justify-between gap-2 px-2.5">
              <span
                className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted"
                title={`Signed in (${me.identityKind ?? "session"}) as ${me.identity}`}
              >
                <User className="size-3.5 shrink-0" />
                <span className="truncate">{me.identity}</span>
              </span>
              <button
                type="button"
                onClick={logout}
                title="Sign out"
                aria-label="Sign out"
                className="-mr-1.5 rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <LogOut className="size-3.5" />
              </button>
            </div>
          )}
          <div className="px-2.5 font-mono text-[10px] text-ink-faint">OpenPing v{__OP_VERSION__}</div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center justify-between border-b border-line bg-canvas/90 pt-[env(safe-area-inset-top)] pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] backdrop-blur md:hidden">
          <div>
            <Logo compact />
          </div>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs",
                pill.text,
              )}
              title={summary}
            >
              <span className={cn("size-2 rounded-full", pill.dot)} />
              {pill.label}
            </span>
            {me?.identity && (
              <div className="flex items-center gap-2 border-l border-line pl-3">
                <button
                  type="button"
                  onClick={logout}
                  title="Sign out"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <LogOut className="size-3.5" />
                  <span className="hidden sm:inline">Sign out</span>
                </button>
              </div>
            )}
          </div>
        </header>

        {banner && (
          <div
            role="status"
            className="flex items-center justify-center gap-2 border-b border-degraded/40 bg-degraded/10 px-4 py-1.5 text-xs text-degraded"
          >
            <WifiOff className="size-3.5 shrink-0" />
            {banner}
          </div>
        )}

        {status && !status.encryptionConfigured && (
          <div className="flex items-center justify-center gap-2 border-b border-down/40 bg-down/10 px-4 py-2 text-xs text-down">
            Encryption at rest is disabled. Configure a valid 32-byte MASTER_KEY before storing credentials.
          </div>
        )}

        <main
          id="main-content"
          className="flex-1 py-6 pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(6rem+env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] md:px-8 md:py-7 md:pb-8"
        >
          {/* Each page eases in when you arrive (reduced motion: no movement). */}
          <div key={shellTransitionKey(pathname)} className="animate-enter">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Mobile bottom nav */}
      {mobileMenuOpen && (
        <div
          ref={moreRef}
          id="mobile-more-menu"
          className="fixed right-[max(0.75rem,env(safe-area-inset-right))] bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 w-52 origin-bottom-right animate-enter rounded-card border border-line bg-surface p-1.5 shadow-2xl md:hidden"
        >
          <ul>
            {MOBILE_MORE_NAV.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                        isActive ? "bg-accent-soft text-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon className={cn("size-[18px]", isActive && "text-accent")} />
                        {item.label}
                      </>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>
          <InstallMenuEntry
            onShowSteps={() => {
              setMobileMenuOpen(false);
              setInstallStepsOpen(true);
            }}
          />
        </div>
      )}
      <IosInstallSheet open={installStepsOpen} onClose={closeInstallSteps} />
      <nav
        aria-label="Mobile"
        className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface/95 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] backdrop-blur md:hidden"
      >
        {MOBILE_NAV.map((item) => (
          <BottomLink key={item.to} item={item} />
        ))}
        <button
          ref={moreButtonRef}
          type="button"
          onClick={() => setMobileMenuOpen((open) => !open)}
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-more-menu"
          aria-label="More navigation"
          className={cn(
            "relative flex min-w-0 flex-1 flex-col items-center gap-1 px-0.5 py-2 text-[10px] font-medium transition-colors",
            mobileMenuOpen || moreActive ? "text-accent" : "text-ink-muted",
          )}
        >
          <BottomIndicator active={moreActive} />
          <MoreHorizontal className="size-5 shrink-0" />
          <span className="w-full truncate text-center leading-tight">More</span>
        </button>
      </nav>
    </div>
  );
}

/** The More menu's install entry, under a divider, when there is one to offer. */
function InstallMenuEntry({ onShowSteps }: { onShowSteps: () => void }) {
  const state = useInstallState();
  if (!hasNavEntry(state)) return null;
  return (
    <div className="mt-1.5 border-t border-line pt-1.5">
      <InstallNavButton variant="menu" onShowSteps={onShowSteps} />
    </div>
  );
}

function SidebarLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      className={({ isActive }) =>
        cn(
          "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150",
          isActive ? "bg-accent-soft text-ink" : "text-ink-muted hover:bg-surface-2/70 hover:text-ink",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden
            className={cn(
              "absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent transition-all duration-200",
              isActive ? "opacity-100" : "scale-y-50 opacity-0",
            )}
          />
          <Icon
            className={cn(
              "size-[18px] shrink-0 transition-colors duration-150",
              isActive ? "text-accent" : "text-ink-faint group-hover:text-ink-muted",
            )}
          />
          {item.label}
        </>
      )}
    </NavLink>
  );
}

/** The accent line over the active bottom-nav item. */
function BottomIndicator({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute inset-x-4 top-0 h-0.5 rounded-full bg-accent transition-opacity duration-200",
        active ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

function BottomLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      className={({ isActive }) =>
        cn(
          "relative flex min-w-0 flex-1 flex-col items-center gap-1 px-0.5 py-2 text-[10px] font-medium transition-colors",
          isActive ? "text-accent" : "text-ink-muted hover:text-ink",
        )
      }
    >
      {({ isActive }) => (
        <>
          <BottomIndicator active={isActive} />
          <Icon className="size-5 shrink-0" />
          <span className="w-full truncate text-center leading-tight">{item.label}</span>
        </>
      )}
    </NavLink>
  );
}
