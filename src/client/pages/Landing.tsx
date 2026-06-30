import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Bell,
  CalendarClock,
  Check,
  Cloud,
  Code2,
  Database,
  ExternalLink,
  Gauge,
  Github,
  Globe,
  HeartPulse,
  KeyRound,
  LineChart,
  MessageSquare,
  PauseCircle,
  Server,
  ShieldCheck,
  Smartphone,
  Terminal,
  Webhook,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "../components/Logo";
import { DashboardMockup } from "../components/landing/DashboardMockup";
import { StatusMockup } from "../components/landing/StatusMockup";

const GITHUB_URL = "https://github.com/n8watkins/open-ping";

/* ------------------------------------------------------------------ *
 * Small presentational helpers (local to the landing page).
 * ------------------------------------------------------------------ */

function Section({
  id,
  className = "",
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`px-4 sm:px-6 ${className}`}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}

function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = "center",
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  align?: "center" | "left";
}) {
  return (
    <div className={align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      {eyebrow && (
        <div className="mb-3 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-accent">
          {eyebrow}
        </div>
      )}
      <h2 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-4 text-base leading-relaxed text-ink-muted sm:text-lg">
          {subtitle}
        </p>
      )}
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  children,
  accent = false,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className={`group rounded-card border bg-surface p-5 transition-colors hover:border-ink-faint/40 ${
        accent ? "border-accent/40 bg-accent-soft/30" : "border-line"
      }`}
    >
      <span
        className={`grid size-10 place-items-center rounded-lg ${
          accent ? "bg-accent text-canvas" : "bg-accent-soft text-accent"
        }`}
      >
        <Icon className="size-5" />
      </span>
      <h3 className="mt-4 text-base font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">{children}</p>
    </div>
  );
}

function PrimaryCTA({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-canvas shadow-lg shadow-accent/20 transition-colors hover:bg-accent-hover ${className}`}
    >
      {children}
    </a>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function Landing() {
  useEffect(() => {
    document.title = "OpenPing — Self-hosted uptime monitoring on your Cloudflare account";
  }, []);

  return (
    <div className="min-h-full scroll-smooth bg-canvas text-ink">
      <Nav />

      <main>
        <Hero />
        <TrustStrip />
        <MonitoringTypes />
        <FreeTierBand />
        <OpenSourceProof />
        <ScheduleAware />
        <StatusPages />
        <QuickStart />
        <AdvancedFeatures />
        <Integrations />
        <MobileMonitoring />
        <Faq />
        <BottomCta />
      </main>

      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 1. Nav
 * ------------------------------------------------------------------ */

function Nav() {
  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-canvas/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" aria-label="OpenPing home">
          <Logo />
        </Link>

        <nav className="hidden items-center gap-7 text-sm text-ink-muted md:flex">
          <a href="#features" className="transition-colors hover:text-ink">
            Features
          </a>
          <a href="#schedule-aware" className="transition-colors hover:text-ink">
            Schedule-aware
          </a>
          <a href="#status-pages" className="transition-colors hover:text-ink">
            Status pages
          </a>
          <a href="#faq" className="transition-colors hover:text-ink">
            FAQ
          </a>
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

        <div className="flex items-center gap-2">
          <Link
            to="/login"
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
          >
            Sign in
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-canvas transition-colors hover:bg-accent-hover"
          >
            <Github className="size-4" />
            <span className="hidden sm:inline">Deploy your own</span>
            <span className="sm:hidden">Deploy</span>
          </a>
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Hero
 * ------------------------------------------------------------------ */

const HERO_BULLETS = [
  "Schedule-aware checks — only watch apps when they actually matter",
  "HTTP/API & heartbeat monitoring with keyword + JSON assertions",
  "Incidents, status pages, and alerts to Email, Discord & Web Push",
];

function Hero() {
  return (
    <div className="relative overflow-hidden">
      {/* Mesh / gradient flourish (inline styles only — no index.css edits). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(60% 50% at 50% -5%, rgba(109,139,255,0.22), transparent 70%), radial-gradient(40% 40% at 85% 10%, rgba(47,191,110,0.10), transparent 70%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(31,44,68,0.6) 1px, transparent 1px), linear-gradient(to bottom, rgba(31,44,68,0.6) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(70% 60% at 50% 0%, black, transparent 75%)",
          WebkitMaskImage: "radial-gradient(70% 60% at 50% 0%, black, transparent 75%)",
        }}
      />

      <Section className="pt-16 pb-12 sm:pt-24 sm:pb-16">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs font-medium text-ink-muted transition-colors hover:border-ink-faint/40 hover:text-ink"
            >
              <span className="size-1.5 rounded-full bg-up" />
              Open source · MIT licensed · Runs on your Cloudflare account
            </a>

            <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl lg:text-6xl">
              Uptime monitoring that runs{" "}
              <span className="text-accent">entirely in your own cloud</span>
            </h1>

            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-muted">
              OpenPing is a self-hosted uptime monitor and public status page that
              deploys to <span className="text-ink">your</span> Cloudflare account —
              no SaaS, no subscription, no third party holding your data. Fits
              comfortably inside Cloudflare's free tier.
            </p>

            <ul className="mt-7 space-y-3">
              {HERO_BULLETS.map((b) => (
                <li key={b} className="flex items-start gap-3 text-sm text-ink-muted">
                  <Check className="mt-0.5 size-4 shrink-0 text-up" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <PrimaryCTA href={GITHUB_URL}>
                <Github className="size-4" />
                Deploy your own
                <ArrowRight className="size-4" />
              </PrimaryCTA>
              <Link
                to="/status"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
              >
                <Globe className="size-4" />
                View live status
              </Link>
            </div>

            <p className="mt-4 text-xs text-ink-faint">
              Worker + D1 + a cron trigger. Deploy with Wrangler in a few minutes.
            </p>
          </div>

          <div className="relative">
            <div
              aria-hidden
              className="absolute -inset-4 -z-10 rounded-[2rem] opacity-60 blur-2xl"
              style={{
                background:
                  "radial-gradient(50% 50% at 50% 50%, rgba(109,139,255,0.18), transparent 70%)",
              }}
            />
            <DashboardMockup />
          </div>
        </div>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Trust strip (honest — no fabricated metrics)
 * ------------------------------------------------------------------ */

const TRUST_ITEMS: { icon: LucideIcon; label: string }[] = [
  { icon: ShieldCheck, label: "100% your data" },
  { icon: Cloud, label: "Cloudflare free tier" },
  { icon: Code2, label: "MIT licensed" },
  { icon: Server, label: "No central service" },
  { icon: Github, label: "Open source" },
];

function TrustStrip() {
  return (
    <Section className="pb-12">
      <div className="rounded-card border border-line bg-surface/50 px-6 py-5">
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4 text-sm text-ink-muted">
          {TRUST_ITEMS.map(({ icon: Icon, label }) => (
            <span key={label} className="inline-flex items-center gap-2">
              <Icon className="size-4 text-accent" />
              {label}
            </span>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 4. Monitoring types grid (6 cards)
 * ------------------------------------------------------------------ */

function MonitoringTypes() {
  return (
    <Section id="features" className="py-16 sm:py-20">
      <SectionHeading
        eyebrow="Monitoring"
        title="Watch everything that matters"
        subtitle="From public endpoints to background cron jobs, OpenPing checks the things your users depend on — and tells you the moment they break."
      />

      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FeatureCard icon={CalendarClock} title="Schedule-aware checks" accent>
          The OpenPing signature. Check (and optionally keep awake) apps only
          during the operating hours that matter. Outside them they read
          "Scheduled off" and never count against uptime.
        </FeatureCard>
        <FeatureCard icon={Globe} title="HTTP & API monitoring">
          Custom methods, headers, request body, and auth. Assert on expected
          status codes, response-time thresholds, keywords, and JSON values.
        </FeatureCard>
        <FeatureCard icon={HeartPulse} title="Heartbeat / cron">
          Give any scheduled job a heartbeat URL to ping. If the expected ping
          doesn't arrive in time, OpenPing opens an incident.
        </FeatureCard>
        <FeatureCard icon={Gauge} title="Response-time thresholds">
          Flag a monitor as degraded before it goes fully down by setting
          warning and critical latency budgets.
        </FeatureCard>
        <FeatureCard icon={PauseCircle} title='Distinct "Suspended" status'>
          OpenPing detects when a host has suspended an app (e.g. Render's
          free tier) and shows it distinctly from a hard outage.
        </FeatureCard>
        <FeatureCard icon={Activity} title="Keyword & JSON assertions">
          A 200 isn't always healthy. Require a body to contain a phrase, or a
          JSON field to equal a value, before a check passes.
        </FeatureCard>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 5. Free-tier / scale band (replaces UR's enterprise CTA — honest)
 * ------------------------------------------------------------------ */

function FreeTierBand() {
  return (
    <Section className="py-4">
      <div className="relative overflow-hidden rounded-card border border-accent/30 bg-accent-soft/40 px-6 py-12 sm:px-12">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 opacity-60"
          style={{
            background:
              "radial-gradient(50% 120% at 100% 0%, rgba(109,139,255,0.20), transparent 70%)",
          }}
        />
        <div className="grid items-center gap-8 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              Built to run for free
            </h2>
            <p className="mt-3 max-w-xl text-base leading-relaxed text-ink-muted">
              OpenPing is a single Cloudflare Worker backed by D1 and a cron
              trigger that runs every 12 minutes. For typical personal and
              small-team setups, that fits inside Cloudflare's free tier — so
              your monitoring bill stays at $0.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <PrimaryCTA href={GITHUB_URL}>
                <Github className="size-4" />
                Deploy your own
              </PrimaryCTA>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
              >
                Read the docs
                <ExternalLink className="size-4" />
              </a>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { k: "Worker", v: "1 endpoint" },
              { k: "Database", v: "D1 (SQLite)" },
              { k: "Schedule", v: "cron / 12 min" },
              { k: "Monthly cost", v: "$0" },
            ].map((s) => (
              <div
                key={s.k}
                className="rounded-card border border-line bg-surface/70 p-4"
              >
                <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                  {s.k}
                </div>
                <div className="mt-1 text-lg font-semibold text-ink">{s.v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 6. Open-source proof (replaces fabricated testimonials/ratings)
 * ------------------------------------------------------------------ */

const PROOF_POINTS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Server,
    title: "No central service",
    body: "There's no OpenPing cloud. Your install talks to nobody but the endpoints you ask it to check. Nothing phones home.",
  },
  {
    icon: ShieldCheck,
    title: "Your data, your account",
    body: "Checks, incidents, and history live in your own D1 database inside your Cloudflare account — not a vendor's multi-tenant store.",
  },
  {
    icon: Code2,
    title: "Auditable & MIT licensed",
    body: "Every line is open for you to read, fork, and change. Use it commercially, modify it freely — no strings attached.",
  },
];

function OpenSourceProof() {
  return (
    <Section className="py-16 sm:py-20">
      <SectionHeading
        eyebrow="Why self-host"
        title="Honest monitoring, owned by you"
        subtitle="No fake star counts here. The pitch is simpler: you run the code, you hold the data, and you can verify every claim on this page in the repo."
      />

      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {PROOF_POINTS.map(({ icon: Icon, title, body }) => (
          <div
            key={title}
            className="rounded-card border border-line bg-surface p-6"
          >
            <span className="grid size-10 place-items-center rounded-lg bg-accent-soft text-accent">
              <Icon className="size-5" />
            </span>
            <h3 className="mt-4 text-base font-semibold text-ink">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">{body}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-col items-center justify-between gap-4 rounded-card border border-line bg-surface/60 px-6 py-5 sm:flex-row">
        <p className="text-sm text-ink-muted">
          Read the source, open an issue, or send a pull request.
        </p>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
        >
          <Github className="size-4" />
          View on GitHub
          <ExternalLink className="size-3.5 text-ink-faint" />
        </a>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 7. Schedule-aware deep-dive (the differentiator)
 * ------------------------------------------------------------------ */

const SCHEDULE_POINTS = [
  "Define operating hours per monitor — always-on, business hours, or a custom schedule.",
  "Outside those hours a monitor reads \"Scheduled off\" and is excluded from uptime math.",
  "Optionally keep free-tier apps warm during hours that matter, then let them sleep.",
  "No more 3am pages for a staging box that's supposed to be asleep.",
];

function ScheduleAware() {
  return (
    <Section id="schedule-aware" className="py-16 sm:py-20">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div className="order-2 lg:order-1">
          <div className="rounded-card border border-line bg-surface p-6">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink">
              <CalendarClock className="size-4 text-accent" />
              staging.acme.dev · schedule
            </div>
            <div className="space-y-2">
              {[
                { d: "Mon–Fri", h: "09:00 – 18:00", on: true },
                { d: "Saturday", h: "Scheduled off", on: false },
                { d: "Sunday", h: "Scheduled off", on: false },
              ].map((r) => (
                <div
                  key={r.d}
                  className="flex items-center justify-between rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm"
                >
                  <span className="font-medium text-ink">{r.d}</span>
                  <span
                    className={`inline-flex items-center gap-2 ${
                      r.on ? "text-up" : "text-scheduled"
                    }`}
                  >
                    <span
                      className={`size-1.5 rounded-full ${
                        r.on ? "bg-up" : "bg-scheduled"
                      }`}
                    />
                    {r.h}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-4 rounded-lg border border-scheduled/30 bg-scheduled/10 px-4 py-3 text-xs text-ink-muted">
              Off-hours checks are skipped and don't count against uptime — your
              numbers reflect the hours that actually matter.
            </p>
          </div>
        </div>

        <div className="order-1 lg:order-2">
          <SectionHeading
            align="left"
            eyebrow="The differentiator"
            title={
              <>
                Monitor on <span className="text-accent">your</span> schedule,
                not the clock's
              </>
            }
            subtitle="Most monitors assume everything runs 24/7. Real apps don't. OpenPing checks each service only during the hours you choose — the feature you won't find in the usual uptime tools."
          />
          <ul className="mt-7 space-y-3">
            {SCHEDULE_POINTS.map((p) => (
              <li key={p} className="flex items-start gap-3 text-sm text-ink-muted">
                <Check className="mt-0.5 size-4 shrink-0 text-up" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 8. Status pages section (live demo CTA)
 * ------------------------------------------------------------------ */

function StatusPages() {
  return (
    <Section id="status-pages" className="py-16 sm:py-20">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <SectionHeading
            align="left"
            eyebrow="Public status pages"
            title="A status page your users will actually trust"
            subtitle="Publish a polished, configurable status page with uptime bars, incident history, and scheduled-maintenance notices. Light or dark theme, your accent color, your logo."
          />
          <ul className="mt-7 space-y-3">
            {[
              "Group services, show or hide per-monitor uptime.",
              "90-day uptime bars and recent incident timeline.",
              "Custom accent, logo, footer, and theme.",
              "Served from your Worker — no extra hosting.",
            ].map((p) => (
              <li key={p} className="flex items-start gap-3 text-sm text-ink-muted">
                <Check className="mt-0.5 size-4 shrink-0 text-up" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <div className="mt-8">
            <Link
              to="/status"
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-canvas shadow-lg shadow-accent/20 transition-colors hover:bg-accent-hover"
            >
              <Globe className="size-4" />
              View the live demo status page
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>

        <div className="relative">
          <div
            aria-hidden
            className="absolute -inset-4 -z-10 rounded-[2rem] opacity-50 blur-2xl"
            style={{
              background:
                "radial-gradient(50% 50% at 50% 50%, rgba(47,191,110,0.16), transparent 70%)",
            }}
          />
          <StatusMockup />
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 9. Quick start ("start in seconds")
 * ------------------------------------------------------------------ */

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: "1",
    title: "Clone & deploy",
    body: "Clone the repo and run Wrangler. It provisions a Worker, a D1 database, and a cron trigger in your own Cloudflare account.",
  },
  {
    n: "2",
    title: "Sign in & add monitors",
    body: "Sign in with GitHub OAuth or an email magic link, then add HTTP or heartbeat monitors with the checks and schedules you need.",
  },
  {
    n: "3",
    title: "Publish & get alerted",
    body: "Flip on your public status page and connect Email, Discord, webhooks, or mobile Web Push. You're monitoring in minutes.",
  },
];

function QuickStart() {
  return (
    <Section className="py-16 sm:py-20">
      <SectionHeading
        eyebrow="Quick setup"
        title="From clone to monitoring in minutes"
        subtitle="No account to create on someone else's platform. Deploy once, and it's yours."
      />
      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <div key={s.n} className="relative rounded-card border border-line bg-surface p-6">
            <div className="flex size-9 items-center justify-center rounded-full bg-accent text-sm font-bold text-canvas">
              {s.n}
            </div>
            <h3 className="mt-4 text-base font-semibold text-ink">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">{s.body}</p>
            {i < STEPS.length - 1 && (
              <ArrowRight className="absolute -right-3 top-1/2 hidden size-5 -translate-y-1/2 text-line md:block" />
            )}
          </div>
        ))}
      </div>

      <div className="mt-6 overflow-hidden rounded-card border border-line bg-surface">
        <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-4 py-2 text-xs text-ink-faint">
          <Terminal className="size-3.5" />
          terminal
        </div>
        <pre className="overflow-x-auto px-4 py-4 text-sm leading-relaxed text-ink-muted">
          <code>
            <span className="text-ink-faint">$ </span>git clone {GITHUB_URL}.git
            {"\n"}
            <span className="text-ink-faint">$ </span>npm install
            {"\n"}
            <span className="text-ink-faint">$ </span>npm run db:create
            {"\n"}
            <span className="text-ink-faint">$ </span>npm run deploy
            {"  "}
            <span className="text-up"># → live on your *.workers.dev</span>
          </code>
        </pre>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 10. Advanced features (6 modules)
 * ------------------------------------------------------------------ */

function AdvancedFeatures() {
  return (
    <Section className="py-16 sm:py-20">
      <SectionHeading
        eyebrow="Under the hood"
        title="Serious monitoring internals"
        subtitle="The details that separate a toy from a tool you can rely on."
      />
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FeatureCard icon={ShieldCheck} title="Incidents & recovery">
          Outages open incidents automatically and close on recovery, with
          flapping protection so a flaky check doesn't spam you.
        </FeatureCard>
        <FeatureCard icon={LineChart} title="MTBF & MTTR">
          Track mean time between failures and mean time to recovery per monitor
          to see what's actually reliable.
        </FeatureCard>
        <FeatureCard icon={Database} title="Compact history">
          History rolls up from samples to intervals to hourly, daily, then
          monthly — so storage never grows unbounded.
        </FeatureCard>
        <FeatureCard icon={KeyRound} title="Single-admin auth">
          GitHub OAuth plus email magic-link sign-in. One configured
          administrator — no sprawling user table to secure.
        </FeatureCard>
        <FeatureCard icon={Terminal} title="Admin CLI & API tokens">
          Automate everything with the bundled admin CLI and Bearer API tokens —
          create monitors, push config, script your setup.
        </FeatureCard>
        <FeatureCard icon={Zap} title="Edge-native">
          Runs on Cloudflare Workers and D1, close to the network — fast checks
          without servers to patch or scale.
        </FeatureCard>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 11. Integrations
 * ------------------------------------------------------------------ */

const CHANNELS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Bell,
    title: "Email",
    body: "Transactional alerts delivered through Resend.",
  },
  {
    icon: MessageSquare,
    title: "Discord",
    body: "Rich incident messages straight to your channel.",
  },
  {
    icon: Webhook,
    title: "Signed webhooks",
    body: "Cryptographically signed POSTs to your own endpoints.",
  },
  {
    icon: Smartphone,
    title: "Mobile Web Push",
    body: "Installable Android PWA with push notifications.",
  },
];

function Integrations() {
  return (
    <Section className="py-16 sm:py-20">
      <SectionHeading
        eyebrow="Notifications"
        title="Get told the instant something breaks"
        subtitle="Route alerts where your team already is. Configure one channel or all of them."
      />
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CHANNELS.map(({ icon: Icon, title, body }) => (
          <div
            key={title}
            className="rounded-card border border-line bg-surface p-5 text-center"
          >
            <span className="mx-auto grid size-12 place-items-center rounded-xl bg-accent-soft text-accent">
              <Icon className="size-6" />
            </span>
            <h3 className="mt-4 text-base font-semibold text-ink">{title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 12. Mobile monitoring
 * ------------------------------------------------------------------ */

function MobileMonitoring() {
  return (
    <Section className="py-16 sm:py-20">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <SectionHeading
            align="left"
            eyebrow="On the go"
            title="Your monitors in your pocket"
            subtitle="OpenPing installs as a Progressive Web App on Android. Add it to your home screen and receive push notifications the moment a monitor changes state — no app store required."
          />
          <ul className="mt-7 space-y-3">
            {[
              "Installable PWA — add to home screen, runs full-screen.",
              "Web Push alerts for downtime, recovery, and incidents.",
              "Offline-aware UI that flags stale data when you lose signal.",
              "Same dashboard, sized for a phone.",
            ].map((p) => (
              <li key={p} className="flex items-start gap-3 text-sm text-ink-muted">
                <Check className="mt-0.5 size-4 shrink-0 text-up" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex justify-center">
          {/* Original phone mockup, tokens only. */}
          <div className="w-64 rounded-[2rem] border border-line bg-surface p-3 shadow-2xl shadow-black/40">
            <div className="rounded-[1.4rem] border border-line bg-canvas p-4">
              <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-line" />
              <div className="flex items-center justify-between">
                <Logo compact />
                <span className="inline-flex items-center gap-1.5 rounded-full border border-up/30 bg-up/10 px-2 py-0.5 text-[10px] font-medium text-up">
                  <span className="size-1 rounded-full bg-up" />
                  Up
                </span>
              </div>
              <div className="mt-4 space-y-2.5">
                {[
                  { n: "api.acme.dev", s: "up", t: "118 ms" },
                  { n: "checkout", s: "degraded", t: "410 ms" },
                  { n: "staging", s: "scheduled", t: "off-hours" },
                ].map((m) => (
                  <div
                    key={m.n}
                    className="flex items-center justify-between rounded-lg border border-line bg-surface-2/50 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`size-1.5 rounded-full ${
                          m.s === "up"
                            ? "bg-up"
                            : m.s === "degraded"
                              ? "bg-degraded"
                              : "bg-scheduled"
                        }`}
                      />
                      <span className="text-xs font-medium text-ink">{m.n}</span>
                    </div>
                    <span className="text-[10px] text-ink-faint">{m.t}</span>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft/40 px-3 py-2 text-[10px] text-ink-muted">
                <Bell className="size-3.5 text-accent" />
                Push: checkout-service degraded
              </div>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 13. FAQ (native details/summary — accessible, zero-JS)
 * ------------------------------------------------------------------ */

const FAQS: { q: string; a: ReactNode }[] = [
  {
    q: "Is OpenPing really free?",
    a: "The software is free and open source under the MIT license. It runs on Cloudflare Workers, D1, and a cron trigger, which for typical personal and small-team usage fits inside Cloudflare's free tier — so your running cost is $0. Very large installs may eventually exceed free-tier limits.",
  },
  {
    q: "Where does my data live?",
    a: "Entirely in your own Cloudflare account. Monitor configuration, check results, incidents, and history are stored in your D1 database. There is no OpenPing cloud and nothing is sent to us — there is no \"us\" in the data path.",
  },
  {
    q: "What makes schedule-aware monitoring different?",
    a: "Most uptime tools assume every service runs 24/7. OpenPing lets you define operating hours per monitor. Outside those hours the monitor shows \"Scheduled off\" and is excluded from uptime calculations, so you don't get paged for a staging app that's meant to be asleep — and you can optionally keep free-tier apps warm only during the hours that matter.",
  },
  {
    q: "What can it monitor?",
    a: "HTTP/API endpoints (with custom methods, headers, body, auth, expected status codes, response-time thresholds, and keyword or JSON assertions) and heartbeat / cron jobs that ping a URL on a schedule.",
  },
  {
    q: "How do alerts work?",
    a: "OpenPing sends notifications via Email (through Resend), Discord, signed webhooks, and installable mobile Web Push. Incidents open automatically on failure and close on recovery, with flapping protection to avoid noisy repeat alerts.",
  },
  {
    q: "How do I sign in?",
    a: "OpenPing is single-administrator. You authenticate with GitHub OAuth or an email magic link, and only the identity you configure can sign in to the dashboard.",
  },
  {
    q: "Won't the history grow forever?",
    a: "No. History is automatically compacted from raw samples to intervals, then hourly, daily, and monthly rollups. You keep long-term trends without your database growing without bound.",
  },
  {
    q: "Can I automate it?",
    a: "Yes. There's a bundled admin CLI and Bearer API-token authentication, so you can create and update monitors, manage configuration, and script your entire setup.",
  },
  {
    q: "How do I deploy it?",
    a: (
      <>
        Clone the repository, run <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">npm install</code>, create the
        D1 database, and run <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">npm run deploy</code> with Wrangler.
        Full instructions are in the{" "}
        <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="text-accent underline">
          GitHub repository
        </a>
        .
      </>
    ),
  },
];

function Faq() {
  return (
    <Section id="faq" className="py-16 sm:py-20">
      <SectionHeading eyebrow="FAQ" title="Frequently asked questions" />
      <div className="mx-auto mt-12 max-w-3xl space-y-3">
        {FAQS.map((f) => (
          <details
            key={f.q}
            className="group rounded-card border border-line bg-surface px-5 [&_summary::-webkit-details-marker]:hidden"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-sm font-semibold text-ink">
              {f.q}
              <ArrowRight className="size-4 shrink-0 text-ink-faint transition-transform group-open:rotate-90" />
            </summary>
            <div className="pb-5 text-sm leading-relaxed text-ink-muted">{f.a}</div>
          </details>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 14. Bottom CTA band
 * ------------------------------------------------------------------ */

function BottomCta() {
  return (
    <Section className="py-16 sm:py-24">
      <div className="relative overflow-hidden rounded-card border border-line bg-surface px-6 py-14 text-center sm:px-12">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(60% 100% at 50% 0%, rgba(109,139,255,0.20), transparent 70%)",
          }}
        />
        <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Own your uptime monitoring today
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-ink-muted">
          Deploy OpenPing to your own Cloudflare account in minutes. Free,
          open source, and entirely yours.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <PrimaryCTA href={GITHUB_URL}>
            <Github className="size-4" />
            Deploy your own
            <ArrowRight className="size-4" />
          </PrimaryCTA>
          <Link
            to="/status"
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
          >
            <Globe className="size-4" />
            View live status
          </Link>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 15. Footer
 * ------------------------------------------------------------------ */

function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <div>
            <Logo />
            <p className="mt-3 max-w-xs text-sm text-ink-muted">
              Self-hosted uptime monitoring and status pages that run entirely in
              your own Cloudflare account.
            </p>
          </div>

          <nav className="flex flex-wrap gap-x-8 gap-y-3 text-sm text-ink-muted">
            <a href="#features" className="transition-colors hover:text-ink">
              Features
            </a>
            <a href="#schedule-aware" className="transition-colors hover:text-ink">
              Schedule-aware
            </a>
            <a href="#status-pages" className="transition-colors hover:text-ink">
              Status pages
            </a>
            <a href="#faq" className="transition-colors hover:text-ink">
              FAQ
            </a>
            <Link to="/status" className="transition-colors hover:text-ink">
              Live status
            </Link>
            <Link to="/login" className="transition-colors hover:text-ink">
              Sign in
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

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-line pt-6 text-xs text-ink-faint sm:flex-row sm:items-center">
          <p>MIT licensed · Self-hosted on your own Cloudflare account.</p>
          <p>© {new Date().getFullYear()} OpenPing</p>
        </div>
      </div>
    </footer>
  );
}
