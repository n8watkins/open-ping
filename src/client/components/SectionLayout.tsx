import { Suspense, useEffect, useRef, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { PageTitle } from "./ui/PageTitle";

export interface SectionNavItem {
  to: string;
  label: string;
  /** One short line under the label in the desktop list. */
  hint: string;
  icon: LucideIcon;
}

/**
 * A page split into sub-pages (Settings, Developers): the title, a side list
 * of sub-pages on wide screens and a row of scrollable tabs on phones, and the
 * current sub-page, which eases in each time it changes.
 */
export function SectionLayout({
  title,
  description,
  items,
  label,
  children,
}: {
  title: string;
  description: ReactNode;
  items: SectionNavItem[];
  /** The navigation's accessible name, like "Settings sections". */
  label: string;
  /** Defaults to the matched child route. */
  children?: ReactNode;
}) {
  const { pathname } = useLocation();
  const tabsRef = useRef<HTMLElement>(null);
  // Keep the phone tab for the current sub-page in view (it may start off-screen).
  useEffect(() => {
    const strip = tabsRef.current;
    const active = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !active) return;
    const left = active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [pathname]);
  return (
    <div className="mx-auto max-w-6xl">
      <PageTitle description={description}>{title}</PageTitle>

      {/* Phones and tablets: one row of tabs that scrolls sideways on its own. */}
      <nav ref={tabsRef} aria-label={label} className="-mx-4 mt-5 overflow-x-auto px-4 [scrollbar-width:none] lg:hidden">
        <ul className="flex w-max gap-1.5 pb-1">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-150",
                      isActive
                        ? "border-accent/50 bg-accent-soft text-ink"
                        : "border-line bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink",
                    )
                  }
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  {item.label}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-4 grid gap-6 lg:mt-7 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
        <nav aria-label={label} className="hidden lg:block">
          <ul className="sticky top-6 space-y-1">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        "group relative flex gap-3 rounded-lg px-3 py-2 transition-colors duration-150",
                        isActive ? "bg-accent-soft" : "hover:bg-surface-2/70",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span
                          aria-hidden
                          className={cn(
                            "absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-accent transition-opacity duration-200",
                            isActive ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <Icon
                          aria-hidden
                          className={cn(
                            "mt-0.5 size-4 shrink-0 transition-colors duration-150",
                            isActive ? "text-accent" : "text-ink-faint group-hover:text-ink-muted",
                          )}
                        />
                        <span className="min-w-0">
                          <span
                            className={cn(
                              "block text-sm font-medium transition-colors duration-150",
                              isActive ? "text-ink" : "text-ink-muted group-hover:text-ink",
                            )}
                          >
                            {item.label}
                          </span>
                          <span className="mt-0.5 block text-xs leading-snug text-ink-faint">{item.hint}</span>
                        </span>
                      </>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>

        <div key={pathname} className="min-w-0 animate-fade">
          <Suspense fallback={<SubPageFallback />}>{children ?? <Outlet />}</Suspense>
        </div>
      </div>
    </div>
  );
}

/** While a sub-page's code loads: the shape of a card, not a spinner. */
function SubPageFallback() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-48 rounded-card" />
      <div className="skeleton h-32 rounded-card opacity-70" />
    </div>
  );
}
