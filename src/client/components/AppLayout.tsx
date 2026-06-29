import { NavLink, Outlet } from "react-router-dom";
import {
  LayoutDashboard,
  Activity,
  AlertTriangle,
  Wrench,
  Plug,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import { Logo } from "./Logo";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/monitors", label: "Monitors", icon: Activity },
  { to: "/incidents", label: "Incidents", icon: AlertTriangle },
  { to: "/maintenance", label: "Maintenance", icon: Wrench },
  { to: "/integrations", label: "Integrations", icon: Plug },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppLayout() {
  return (
    <div className="flex min-h-full">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface/40 px-3 py-5 md:flex">
        <div className="px-2 pb-6">
          <Logo />
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((item) => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </nav>
        <div className="px-2 pt-4 text-xs text-ink-faint">
          OpenPing · v0.1.0
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-line px-4 md:px-6">
          <div className="md:hidden">
            <Logo compact />
          </div>
          <div className="hidden text-sm text-ink-muted md:block">
            Self-hosted uptime monitoring
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-muted">
              <span className="size-2 rounded-full bg-up" />
              Operational
            </span>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 pb-24 md:px-6 md:pb-8">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface/95 backdrop-blur md:hidden">
        {NAV.map((item) => (
          <BottomLink key={item.to} item={item} />
        ))}
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
          "flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-medium transition-colors",
          isActive ? "text-accent" : "text-ink-faint",
        )
      }
    >
      <Icon className="size-5" />
      {item.label}
    </NavLink>
  );
}
