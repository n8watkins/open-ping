import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  Github,
  Globe,
  Mail,
  Network,
  Percent,
  Search,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "../../components/Logo";

const GITHUB_URL = "https://github.com/n8watkins/open-ping";

/** Shared metadata for the tools index + individual tool pages. */
export interface ToolMeta {
  slug: string;
  title: string;
  tagline: string;
  icon: LucideIcon;
}

export const TOOLS: ToolMeta[] = [
  {
    slug: "uptime-calculator",
    title: "Uptime calculator",
    tagline: "Turn an SLA percentage into allowed downtime — or the reverse.",
    icon: Percent,
  },
  {
    slug: "subnet-calculator",
    title: "Subnet calculator",
    tagline: "Break down any IPv4 CIDR: network, broadcast, mask, host range.",
    icon: Network,
  },
  {
    slug: "cron-tester",
    title: "Cron expression tester",
    tagline: "Validate a cron schedule and preview its next run times.",
    icon: Clock,
  },
  {
    slug: "dns-lookup",
    title: "DNS lookup",
    tagline: "Query A, AAAA, CNAME, MX, TXT, NS, and SOA records instantly.",
    icon: Search,
  },
  {
    slug: "mx-lookup",
    title: "MX lookup",
    tagline: "Find a domain's mail servers and their priorities.",
    icon: Mail,
  },
];

/* ------------------------------------------------------------------ *
 * Page shell — header + footer shared across every tool page.
 * ------------------------------------------------------------------ */

function ToolsHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-canvas/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
        <Link to="/" aria-label="OpenPing home">
          <Logo />
        </Link>
        <nav className="flex items-center gap-2 text-sm">
          <Link
            to="/tools"
            className="rounded-lg px-3 py-2 font-medium text-ink-muted transition-colors hover:text-ink"
          >
            All tools
          </Link>
          <Link
            to="/login"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 font-semibold text-canvas transition-colors hover:bg-accent-hover"
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}

function ToolsFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-5xl flex-col items-start justify-between gap-4 px-4 py-10 sm:flex-row sm:items-center sm:px-6">
        <div className="flex items-center gap-3 text-sm text-ink-muted">
          <Logo compact />
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-muted">
          <Link to="/tools" className="transition-colors hover:text-ink">
            Free tools
          </Link>
          <Link to="/" className="transition-colors hover:text-ink">
            Home
          </Link>
          <Link to="/status" className="transition-colors hover:text-ink">
            Live status
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
          >
            <Github className="size-4" />
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}

/** Subtle "monitor this for real" call-to-action back to the product. */
export function ToolCTA() {
  return (
    <div className="mt-10 overflow-hidden rounded-card border border-accent/30 bg-accent-soft/30 px-6 py-8">
      <div className="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-ink">
            Monitor this for real
            <span className="text-accent">.</span>
          </h2>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-ink-muted">
            OpenPing is free, open-source uptime monitoring and status pages that
            run entirely in your own Cloudflare account. Deploy in minutes.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <Link
            to="/login"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-canvas shadow-lg shadow-accent/20 transition-colors hover:bg-accent-hover"
          >
            Get started
            <ArrowRight className="size-4" />
          </Link>
          <Link
            to="/"
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
          >
            <Globe className="size-4" />
            Learn more
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Standard chrome + heading for a single tool page. Sets the document title and
 * renders a back-to-tools link, the title/intro, the tool itself, and the CTA.
 */
export function ToolLayout({
  icon: Icon,
  title,
  intro,
  children,
}: {
  icon: LucideIcon;
  title: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} — OpenPing free tools`;
  }, [title]);

  return (
    <div className="flex min-h-full flex-col bg-canvas text-ink">
      <ToolsHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <Link
          to="/tools"
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="size-4" />
          Back to all tools
        </Link>

        <div className="mt-6 flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
            <Icon className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              {title}
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{intro}</p>
          </div>
        </div>

        <div className="mt-8">{children}</div>

        <ToolCTA />
      </main>
      <ToolsFooter />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Small shared presentational helpers used across tools.
 * ------------------------------------------------------------------ */

/** A bordered surface card used to group form controls or results. */
export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-card border border-line bg-surface p-5 sm:p-6 ${className}`}>
      {children}
    </div>
  );
}

/** A labelled key/value result row, used in tables of computed output. */
export function ResultRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-line/60 py-2.5 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="font-mono text-sm font-medium text-ink sm:text-right">{children}</dd>
    </div>
  );
}

/** An inline error/notice banner for invalid input. */
export function Notice({
  tone = "error",
  children,
}: {
  tone?: "error" | "info";
  children: ReactNode;
}) {
  const cls =
    tone === "error"
      ? "border-down/40 bg-down/10 text-down"
      : "border-line bg-surface-2 text-ink-muted";
  return (
    <p className={`rounded-lg border px-3.5 py-2.5 text-sm ${cls}`}>{children}</p>
  );
}
