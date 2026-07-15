import { useEffect, useState } from "react";
import { NavLink, Outlet, Navigate } from "react-router-dom";
import {
  LayoutDashboard,
  Activity,
  AlertTriangle,
  Wrench,
  Plug,
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
} as const;

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

const NAV: NavItem[] = [
  { to: "/monitors", label: "Monitoring", icon: Activity },
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/incidents", label: "Incidents", icon: AlertTriangle },
  { to: "/status-page", label: "Status pages", icon: Globe },
  { to: "/maintenance", label: "Maintenance", icon: Wrench },
  { to: "/integrations", label: "Integrations & API", icon: Plug },
  { to: "/settings", label: "Settings", icon: Settings },
];
const MOBILE_NAV = NAV.slice(0, 4);
const MOBILE_MORE_NAV = NAV.slice(4);

export function AppLayout() {
  const { loading, status, me, csrf } = useBootstrap();

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST", csrf: csrf ?? undefined });
    } catch {
      // Ignore — clear the local view and head to login regardless.
    }
    // Full reload so bootstrap/auth state (and any PWA cache) resets cleanly.
    window.location.assign("/login");
  }

  // Real overall status for the header pill (skipped until authenticated).
  const { data: overview } = useFetch<OverviewResponse>(
    me?.authenticated ? "/api/overview" : null,
  );
  const pill = deriveStatus(overview?.counts);

  // Surface offline/stale state (PWA cache): listen for connectivity changes.
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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
  if (!me?.authenticated) return <Navigate to="/login" replace />;
  // Once the administrator has authenticated, finish any incomplete setup
  // before exposing the admin workspace. This also supports deployments that
  // preconfigure the admin identity as a Worker secret.
  if (status && !status.setupComplete) return <Navigate to="/setup" replace />;

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
      {/* Desktop sidebar */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface/55 px-3 py-4 md:flex">
        <div className="px-2 pb-5">
          <Logo />
        </div>
        <nav aria-label="Primary" className="flex flex-1 flex-col gap-1">
          {NAV.map((item) => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </nav>
        <div className="border-t border-line px-2 pt-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className={cn("inline-flex items-center gap-1.5 text-xs", pill.text)}>
              <span className={cn("size-1.5 rounded-full", pill.dot)} />
              {pill.label}
            </span>
            <span className="text-[10px] text-ink-faint">v0.1.0</span>
          </div>
          {me?.identity && (
            <div className="flex items-center justify-between gap-2">
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
                className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <LogOut className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-line px-4 md:hidden">
          <div>
            <Logo compact />
          </div>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs",
                pill.text,
              )}
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

        {!online && (
          <div className="flex items-center justify-center gap-2 border-b border-degraded/40 bg-degraded/10 px-4 py-1.5 text-xs text-degraded">
            <WifiOff className="size-3.5" />
            You're offline — data may be stale.
          </div>
        )}

        {status && !status.encryptionConfigured && (
          <div className="flex items-center justify-center gap-2 border-b border-down/40 bg-down/10 px-4 py-2 text-xs text-down">
            Encryption at rest is disabled. Configure a valid 32-byte MASTER_KEY before storing credentials.
          </div>
        )}

        <main
          id="main-content"
          className="flex-1 px-4 py-6 pb-[calc(6rem+env(safe-area-inset-bottom))] md:px-8 md:py-7 md:pb-8"
        >
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom nav */}
      {mobileMenuOpen && (
        <div className="fixed right-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 w-52 rounded-card border border-line bg-surface p-2 shadow-2xl md:hidden">
          {MOBILE_MORE_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMobileMenuOpen(false)}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium",
                    isActive ? "bg-accent-soft text-ink" : "text-ink-muted hover:bg-surface-2",
                  )
                }
              >
                <Icon className="size-[18px]" />
                {item.label}
              </NavLink>
            );
          })}
        </div>
      )}
      <nav
        aria-label="Mobile"
        className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {MOBILE_NAV.map((item) => (
          <BottomLink key={item.to} item={item} />
        ))}
        <button
          type="button"
          onClick={() => setMobileMenuOpen((open) => !open)}
          aria-expanded={mobileMenuOpen}
          aria-label="More navigation"
          className={cn(
            "flex min-w-0 flex-1 flex-col items-center gap-1 px-0.5 py-2 text-[10px] font-medium transition-colors",
            mobileMenuOpen ? "text-accent" : "text-ink-muted",
          )}
        >
          <MoreHorizontal className="size-5 shrink-0" />
          <span>More</span>
        </button>
      </nav>
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
          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-accent-soft text-ink"
            : "text-ink-muted hover:bg-surface-2 hover:text-ink",
        )
      }
    >
      <Icon className="size-[18px]" />
      {item.label}
    </NavLink>
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
          "flex min-w-0 flex-1 flex-col items-center gap-1 px-0.5 py-2 text-[10px] font-medium transition-colors",
          isActive ? "text-accent" : "text-ink-muted",
        )
      }
    >
      <Icon className="size-5 shrink-0" />
      <span className="w-full truncate text-center leading-tight">{item.label}</span>
    </NavLink>
  );
}
