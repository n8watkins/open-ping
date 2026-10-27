import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bug,
  CalendarClock,
  Check,
  Cloud,
  Code2,
  Database,
  Github,
  Globe,
  HeartPulse,
  Hourglass,
  Infinity as InfinityIcon,
  Menu,
  MessageSquare,
  Network,
  PauseCircle,
  Plug,
  Server,
  ShieldCheck,
  Smartphone,
  Star,
  Terminal,
  Webhook,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "../components/Logo";
import { LiveStatusPanel } from "../components/landing/LiveStatusPanel";
import { TOOLS } from "./tools/ToolLayout";
import { StatusMockup } from "../components/landing/StatusMockup";
import { PhoneMockup } from "../components/landing/PhoneMockup";
import { ComparisonTable } from "../components/landing/ComparisonTable";
import { FaqAccordion, type FaqItem } from "../components/landing/FaqAccordion";
import { SignInModal } from "../components/landing/SignInModal";
import { useCountUp, useReveal } from "../components/landing/useReveal";

const GITHUB_URL = "https://github.com/n8watkins/open-ping";
const GITHUB_ISSUES_URL = "https://github.com/n8watkins/open-ping/issues";
const DEPLOY_URL = `${GITHUB_URL}#deploy-your-own`;
const N8BUILDS_URL = "https://n8builds.dev";
const KOFI_URL = "https://ko-fi.com/n8watkins";
const KOFI_ENABLED = !KOFI_URL.includes("REPLACE_ME");

/* ------------------------------------------------------------------ *
 * Scoped landing-only animation styles.
 *
 * Per the brief these keyframes/utility classes live in a <style> element
 * rendered by a landing component instead of editing src/client/index.css. They
 * are global once mounted (so the portaled sign-in modal can use them too) and
 * every nonessential animation is disabled under prefers-reduced-motion.
 * ------------------------------------------------------------------ */

function LandingStyles() {
  return (
    <style>{`
      .op-reveal {
        opacity: 0;
        transform: translateY(24px);
        transition: opacity .7s cubic-bezier(.16,1,.3,1), transform .7s cubic-bezier(.16,1,.3,1);
        will-change: opacity, transform;
      }
      .op-reveal.op-in { opacity: 1; transform: none; }

      .op-lift { transition: transform .25s ease, border-color .25s ease, box-shadow .25s ease; }
      .op-lift:hover {
        transform: translateY(-4px);
        border-color: rgba(133,149,173,0.4);
        box-shadow: 0 18px 40px -24px rgba(0,0,0,0.75);
      }

      @keyframes op-float-a { 0%,100% { transform: translate3d(0,0,0) } 50% { transform: translate3d(26px,-30px,0) } }
      @keyframes op-float-b { 0%,100% { transform: translate3d(0,0,0) } 50% { transform: translate3d(-28px,22px,0) } }
      .op-blob-a { animation: op-float-a 16s ease-in-out infinite; }
      .op-blob-b { animation: op-float-b 21s ease-in-out infinite; }

      @keyframes op-live { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
      .op-live-dot { animation: op-live 2s ease-in-out infinite; }

      /* A scrollbar in OpenPing's colours. */
      html { scrollbar-color: rgba(109,139,255,.45) var(--color-canvas); }
      ::-webkit-scrollbar { width: 10px; }
      ::-webkit-scrollbar-track { background: var(--color-canvas); }
      ::-webkit-scrollbar-thumb { border: 2px solid var(--color-canvas); border-radius: 999px; background: linear-gradient(#6d8bff, #2fbf6e); }

      /* How it works: each step lights in turn while its section is on screen,
         with a dot running along the arrow to the next one. */
      @keyframes op-flow-glow {
        0%, 100% { border-color: var(--color-line); box-shadow: none; }
        6%, 20% { border-color: rgba(109,139,255,.6); box-shadow: 0 0 26px rgba(109,139,255,.18); }
        28% { border-color: var(--color-line); box-shadow: none; }
      }
      @keyframes op-flow-x { 0% { left: 0; opacity: 0 } 15%, 85% { opacity: 1 } 100% { left: calc(100% - 6px); opacity: 0 } }
      @keyframes op-flow-y { 0% { top: 0; opacity: 0 } 15%, 85% { opacity: 1 } 100% { top: calc(100% - 6px); opacity: 0 } }
      .op-flow-node { animation: op-flow-glow 6s ease-in-out infinite; }
      .op-flow-dot { animation: op-flow-y 6s linear infinite; opacity: 0; }
      @media (min-width: 768px) { .op-flow-dot { animation-name: op-flow-x; } }
      .op-reveal:not(.op-in) .op-flow-node, .op-reveal:not(.op-in) .op-flow-dot { animation-play-state: paused; }

      @media (prefers-reduced-motion: reduce) {
        .op-reveal { opacity: 1 !important; transform: none !important; transition: none !important; }
        .op-lift { transition: none !important; }
        .op-lift:hover { transform: none !important; }
        .op-blob-a, .op-blob-b, .op-live-dot, .op-flow-node, .op-flow-dot { animation: none !important; }
      }
    `}</style>
  );
}

/* ------------------------------------------------------------------ *
 * Small presentational helpers (local to the landing page).
 * ------------------------------------------------------------------ */

/** Ko-fi's cup with a heart, in Ko-fi's red (the page's own background around it). */
function KofiCup({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={`text-[#ff5e5b] ${className}`}>
      <path d="M4 6h13a4 4 0 0 1 0 8h-1.1A6 6 0 0 1 10 18H8a6 6 0 0 1-6-6V7a1 1 0 0 1 1-1Zm13 2v4a2 2 0 0 0 0-4Z" />
      <path fill="#fff" d="M9.2 9.1c.8-.8 2.1-.8 2.9 0 .8.8.8 2.1 0 2.9L9.2 15l-2.9-3c-.8-.8-.8-2.1 0-2.9.8-.8 2.1-.8 2.9 0Z" transform="translate(.3 -.3)" />
    </svg>
  );
}

/** The n8builds mark beside OpenPing's logo, as on Scribe's site: the N8 icon and the name, linking home. */
function N8buildsMark() {
  return (
    <a
      href={N8BUILDS_URL}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex items-center gap-2 whitespace-nowrap text-sm font-semibold leading-none text-ink-muted transition-colors hover:text-ink"
    >
      <img src="/n8builds-icon.png" alt="" width={22} height={22} className="rounded-md ring-1 ring-white/10 transition group-hover:ring-white/25" />
      n8builds
    </a>
  );
}

/** The repo on GitHub: the star count first (read at build time), then the GitHub mark and name. */
function StarButton() {
  const stars = __OP_STARS__;
  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      aria-label={stars == null ? "OpenPing on GitHub" : `OpenPing on GitHub, ${stars} ${stars === 1 ? "star" : "stars"}`}
      className="inline-flex h-9 items-center overflow-hidden rounded-lg border border-line bg-surface text-sm font-semibold text-ink transition-colors hover:border-accent/50"
    >
      {stars != null && (
        <span className="flex h-full items-center gap-1 border-r border-line px-2.5 tabular-nums text-ink-muted">
          <Star className="size-3.5 fill-[#e3b341] text-[#e3b341]" aria-hidden />
          {stars.toLocaleString()}
        </span>
      )}
      <span className="flex items-center gap-1.5 px-2.5">
        <Github className="size-4" aria-hidden />
        GitHub
      </span>
    </a>
  );
}

/** Scroll-reveal wrapper: fades/slides its children in as they enter view. */
function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const { ref, visible } = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`op-reveal ${visible ? "op-in" : ""} ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/** Animated count-up number that starts when scrolled into view. */
function StatNumber({
  value,
  prefix = "",
  suffix = "",
}: {
  value: number;
  prefix?: string;
  suffix?: string;
}) {
  const { ref, visible } = useReveal<HTMLSpanElement>();
  const n = useCountUp(value, visible);
  return (
    <span ref={ref}>
      {prefix}
      {Math.round(n)}
      {suffix}
    </span>
  );
}

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
    <section id={id} className={`px-4 sm:px-6 ${id ? "scroll-mt-24" : ""} ${className}`}>
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
      className={`op-lift inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-canvas shadow-lg shadow-accent/20 hover:bg-accent-hover ${className}`}
    >
      {children}
    </a>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function Landing() {
  const [signInOpen, setSignInOpen] = useState(false);
  const openSignIn = useCallback(() => setSignInOpen(true), []);
  const closeSignIn = useCallback(() => setSignInOpen(false), []);

  useEffect(() => {
    document.title = "OpenPing: uptime monitoring in your own Cloudflare account";
  }, []);

  return (
    <div className="min-h-full scroll-smooth bg-canvas text-ink">
      <LandingStyles />
      <Nav onSignIn={openSignIn} />

      <main>
        <Hero />
        <TrustStrip />
        <HowItWorks />
        <ScheduleAware />
        <Features />
        <StatusPages />
        <Alerts />
        <FreeTools />
        <Comparison />
        <QuickStart />
        <FaqSection />
        <BottomCta />
      </main>

      <Footer onSignIn={openSignIn} />

      <SignInModal open={signInOpen} onClose={closeSignIn} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 1. Nav: transparent at the top, solid + shrunk on scroll, hamburger on mobile
 * ------------------------------------------------------------------ */

const NAV_LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#status-pages", label: "Status pages" },
  { href: "#faq", label: "FAQ" },
];

function Nav({ onSignIn }: { onSignIn: () => void }) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-40 transition-all duration-300 ${
        scrolled
          ? "border-b border-line bg-surface/90 shadow-lg shadow-black/20 backdrop-blur"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <div
        className={`mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 transition-all duration-300 sm:px-6 ${
          scrolled ? "h-14" : "h-16 sm:h-20"
        }`}
      >
        <div className="flex items-center gap-3">
          <Link to="/" aria-label="OpenPing home">
            <Logo />
          </Link>
          <span aria-hidden="true" className="hidden h-5 w-px bg-line lg:block" />
          <span className="hidden lg:flex">
            <N8buildsMark />
          </span>
        </div>

        <nav className="hidden items-center gap-6 whitespace-nowrap text-sm text-ink-muted xl:flex">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className="transition-colors hover:text-ink">
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 whitespace-nowrap md:flex">
          {KOFI_ENABLED && (
            <a
              href={KOFI_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-semibold text-ink transition-colors hover:border-[#ff5e5b]/60"
            >
              <KofiCup className="size-[1.125rem]" />
              Ko-fi
            </a>
          )}
          <StarButton />
          {/* Sign-in is for the install's own admin: in the bar only when there's
              room, and always in the footer and the phone menu. */}
          <button
            type="button"
            onClick={onSignIn}
            className="hidden rounded-lg px-2.5 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink 2xl:inline-flex"
          >
            Sign in
          </button>
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

        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          className="grid size-11 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink md:hidden"
        >
          {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      {menuOpen && (
        <div
          id="mobile-nav"
          className="border-t border-line bg-surface/95 backdrop-blur md:hidden"
        >
          <nav className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3 text-sm">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setMenuOpen(false)}
                className="rounded-lg px-3 py-3 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                {l.label}
              </a>
            ))}
            <div className="my-2 h-px bg-line" />
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onSignIn();
              }}
              className="rounded-lg px-3 py-3 text-left text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Sign in
            </button>
            {KOFI_ENABLED && (
              <a
                href={KOFI_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => setMenuOpen(false)}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-3 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <KofiCup className="size-[1.125rem]" />
                Support on Ko-fi
              </a>
            )}
            <a
              href={N8BUILDS_URL}
              target="_blank"
              rel="noreferrer"
              onClick={() => setMenuOpen(false)}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-3 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <img src="/n8builds-icon.png" alt="" width={18} height={18} className="rounded" />
              More from n8builds.dev
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              onClick={() => setMenuOpen(false)}
              className="mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3.5 py-3 font-semibold text-canvas transition-colors hover:bg-accent-hover"
            >
              <Github className="size-4" />
              Deploy your own
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Hero: the promise, the differentiator in one line, and a live product shot
 * ------------------------------------------------------------------ */

const HERO_POINTS = [
  "HTTP, heartbeat, DNS, TCP and domain-expiry checks",
  "Public status pages with incidents and maintenance",
  "Alerts by email, Discord, webhook or phone push",
];

function Hero() {
  return (
    <div className="relative overflow-hidden">
      {/* Mesh / gradient flourish (inline styles only, no index.css edits). */}
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
        className="op-blob-a pointer-events-none absolute -left-24 -top-24 -z-10 size-72 rounded-full opacity-50 blur-3xl"
        style={{ background: "radial-gradient(circle, rgba(109,139,255,0.28), transparent 70%)" }}
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

      <Section className="pt-10 pb-12 sm:pt-16 sm:pb-16">
        <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
          <Reveal>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs font-medium text-ink-muted transition-colors hover:border-ink-faint/40 hover:text-ink"
            >
              <span className="size-1.5 rounded-full bg-up" />
              Open source · MIT · Runs on Cloudflare's free plan
            </a>

            <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl xl:text-[3.5rem]">
              Uptime monitoring in{" "}
              <span className="text-accent">your own Cloudflare account</span>
            </h1>

            <p className="mt-5 max-w-xl text-pretty text-lg leading-relaxed text-ink-muted">
              No subscription, and nobody else holding your data. Apps that
              sleep by design are watched only during their hours, so a quiet
              night never counts as an outage.
            </p>

            <ul className="mt-6 space-y-2.5">
              {HERO_POINTS.map((b) => (
                <li key={b} className="flex items-start gap-3 text-sm text-ink-muted">
                  <Check className="mt-0.5 size-4 shrink-0 text-up" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <PrimaryCTA href={DEPLOY_URL}>
                <Github className="size-4" />
                Deploy your own
                <ArrowRight className="size-4" />
              </PrimaryCTA>
              <Link
                to="/status"
                className="op-lift inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-5 py-3 text-sm font-semibold text-ink hover:bg-surface-2"
              >
                <Globe className="size-4" />
                View live status
              </Link>
            </div>
            <p className="mt-4 flex items-center gap-2 text-sm text-ink-muted">
              <Wrench className="size-4 shrink-0 text-ink-faint" />
              <span>
                Or{" "}
                <Link to="/tools" className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent">
                  try the free tools
                </Link>
                , no sign-up needed.
              </span>
            </p>
          </Reveal>

          <Reveal delay={150} className="relative">
            <div
              aria-hidden
              className="absolute -inset-4 -z-10 rounded-[2rem] opacity-60 blur-2xl"
              style={{
                background:
                  "radial-gradient(50% 50% at 50% 50%, rgba(109,139,255,0.18), transparent 70%)",
              }}
            />
            <LiveStatusPanel />
          </Reveal>
        </div>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Trust strip (honest: no fabricated metrics)
 * ------------------------------------------------------------------ */

const TRUST_ITEMS: { icon: LucideIcon; label: string }[] = [
  { icon: ShieldCheck, label: "Your data stays in your account" },
  { icon: Cloud, label: "Fits Cloudflare's free plan" },
  { icon: Server, label: "No central service" },
  { icon: Code2, label: "MIT licensed" },
];

function TrustStrip() {
  return (
    <Section className="pb-10">
      <Reveal>
        <div className="rounded-card border border-line bg-surface/50 px-6 py-4">
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-ink-muted">
            {TRUST_ITEMS.map(({ icon: Icon, label }) => (
              <span key={label} className="inline-flex items-center gap-2">
                <Icon className="size-4 text-accent" />
                {label}
              </span>
            ))}
          </div>
        </div>
      </Reveal>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 4. How it works: the whole loop, drawn inside the visitor's own Cloudflare
 * account (wrangler.jsonc: the 12-minute cron; scheduler.ts: due checks,
 * capped at 200 a run; db: D1; routes/public.ts: status pages;
 * notifications/: alerts).
 * ------------------------------------------------------------------ */

const FLOW: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: CalendarClock, title: "Every 12 minutes", body: "A Cron Trigger wakes your Worker." },
  { icon: Server, title: "Your Worker", body: "Checks whatever is due: HTTP, TCP, DNS, domains and heartbeats." },
  { icon: Database, title: "Your D1 database", body: "Keeps every result, incident and the rolled-up history." },
];

function FlowArrow({ delay }: { delay: string }) {
  return (
    <span aria-hidden="true" className="relative flex items-center justify-center py-1 text-ink-faint md:px-1 md:py-0">
      <span className="absolute inset-x-1/2 top-0 h-full w-0 md:inset-x-0 md:top-1/2 md:h-0 md:w-full">
        <span
          className="op-flow-dot absolute left-[-3px] size-1.5 rounded-full bg-accent shadow-[0_0_10px_#6d8bff] md:top-[-3px] md:left-auto"
          style={{ animationDelay: delay }}
        />
      </span>
      <ArrowRight className="size-4 rotate-90 md:rotate-0" />
    </span>
  );
}

function HowItWorks() {
  return (
    <Section id="how-it-works" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading
          eyebrow="How it works"
          title={
            <>
              It all runs in <span className="text-accent">your</span> Cloudflare account
            </>
          }
          subtitle="There is no OpenPing server in the middle. Your Worker does the checking and your database keeps the history."
        />
      </Reveal>
      <Reveal delay={100} className="mx-auto mt-12 max-w-5xl">
        <div className="relative rounded-3xl border-2 border-dashed border-accent/35 bg-accent-soft/10 px-4 pt-10 pb-5 sm:px-7">
          <p className="absolute -top-3.5 left-6 flex items-center gap-2 rounded-full border border-accent/40 bg-canvas px-3 py-1 text-sm font-semibold text-accent">
            <Cloud className="size-4" aria-hidden />
            Your Cloudflare account
          </p>
          <ol className="flex flex-col md:flex-row md:items-stretch">
            {FLOW.map((step, i) => (
              <li key={step.title} className="contents">
                {i > 0 && <FlowArrow delay={`${i * 1.6 - 0.6}s`} />}
                <div
                  className="op-flow-node flex flex-1 items-start gap-3 rounded-xl border border-line bg-surface p-4"
                  style={{ animationDelay: `${i * 1.6}s` }}
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                    <step.icon className="size-5" aria-hidden />
                  </span>
                  <span>
                    <span className="block font-semibold text-ink">{step.title}</span>
                    <span className="mt-0.5 block text-sm leading-relaxed text-ink-muted">{step.body}</span>
                  </span>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-3 rounded-xl border border-line bg-surface/70 px-4 py-3">
              <Globe className="size-5 shrink-0 text-up" aria-hidden />
              <p className="text-sm text-ink-muted">
                <span className="font-semibold text-ink">Status pages</span>, served by the same Worker
              </p>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-line bg-surface/70 px-4 py-3">
              <Bell className="size-5 shrink-0 text-degraded" aria-hidden />
              <p className="text-sm text-ink-muted">
                <span className="font-semibold text-ink">Alerts</span> by email, Discord, webhook or phone push
              </p>
            </div>
          </div>
        </div>
        <p className="mt-5 text-center text-sm text-ink-muted">
          The only things that leave your account are the checks themselves and the alerts you set up.
        </p>
      </Reveal>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 5. Schedule-aware (the differentiator)
 * ------------------------------------------------------------------ */

const SCHEDULE_POINTS = [
  "Always on, business hours, or your own weekly schedule, per monitor.",
  "Outside those hours a monitor reads \"Scheduled off\" and stays out of the uptime math.",
  "Keep a free-tier app awake while it matters, then let it sleep.",
];

/** A Monday at a glance: checks only between 09:00 and 18:00, the rest Scheduled off. */
function DayTimeline() {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div className="mt-5" aria-label="Monday: checked from 09:00 to 18:00, scheduled off the rest of the day" role="img">
      <div className="mb-2 flex items-center justify-between text-xs text-ink-faint">
        <span className="font-semibold text-ink-muted">Monday</span>
        <span>5 checks an hour while it's on</span>
      </div>
      <div className="flex h-8 gap-[2px] overflow-hidden rounded-lg">
        {hours.map((h) => {
          const on = h >= 9 && h < 18;
          return (
            <span
              key={h}
              className={`relative flex-1 ${
                on
                  ? "bg-up/25"
                  : "bg-[repeating-linear-gradient(135deg,rgba(148,163,184,.12)_0_4px,transparent_4px_8px)]"
              }`}
            >
              {on && (
                <span className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-around px-[1px]">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <span key={i} className="h-3 w-[2px] rounded-full bg-up" />
                  ))}
                </span>
              )}
            </span>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[0.65rem] text-ink-faint">
        <span>00:00</span>
        <span className="text-up">09:00</span>
        <span className="text-up">18:00</span>
        <span>24:00</span>
      </div>
    </div>
  );
}

function ScheduleAware() {
  return (
    <Section id="schedule-aware" className="py-14 sm:py-20">
      <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-14">
        <Reveal>
          <SectionHeading
            align="left"
            eyebrow="Schedule-aware"
            title={
              <>
                Monitor on <span className="text-accent">your</span> schedule, not the clock's
              </>
            }
            subtitle="Free hosting sleeps by design, so a plain monitor reports an outage every night or keeps the app awake around the clock. OpenPing checks each service only during the hours you choose."
          />
          <ul className="mt-6 space-y-3">
            {SCHEDULE_POINTS.map((p) => (
              <li key={p} className="flex items-start gap-3 text-sm text-ink-muted">
                <Check className="mt-0.5 size-4 shrink-0 text-up" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={120}>
          <div className="rounded-card border border-line bg-surface p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink">
              <CalendarClock className="size-4 text-accent" />
              demo-app.onrender.com · schedule
            </div>
            <div className="space-y-2">
              {[
                { d: "Mon to Fri", h: "09:00 to 18:00", on: true },
                { d: "Saturday", h: "Scheduled off", on: false },
                { d: "Sunday", h: "Scheduled off", on: false },
              ].map((r) => (
                <div
                  key={r.d}
                  className="flex items-center justify-between rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm"
                >
                  <span className="font-medium text-ink">{r.d}</span>
                  <span className={`inline-flex items-center gap-2 ${r.on ? "text-up" : "text-scheduled"}`}>
                    <span className={`size-1.5 rounded-full ${r.on ? "bg-up" : "bg-scheduled"}`} />
                    {r.h}
                  </span>
                </div>
              ))}
            </div>
            <DayTimeline />
            <p className="mt-4 rounded-lg border border-scheduled/30 bg-scheduled/10 px-4 py-3 text-xs leading-relaxed text-ink-muted">
              Off-hours checks are skipped and don't count against uptime, so the
              number reflects the hours that matter.
            </p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 5. Features: what it checks, then what it does with the results
 * ------------------------------------------------------------------ */

const CHECKS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Globe, title: "HTTP and API", body: "Methods, headers, body and auth; expected status, latency budgets, keyword and JSON assertions." },
  { icon: HeartPulse, title: "Heartbeat and cron", body: "Give a job a URL to ping. A missed ping opens an incident." },
  { icon: Network, title: "DNS records", body: "A, AAAA, CNAME, MX or TXT, and what they should resolve to." },
  { icon: Plug, title: "TCP ports", body: "Databases, brokers and anything else that isn't HTTP." },
  { icon: Hourglass, title: "Domain expiry", body: "A heads-up before a registration lapses, read from RDAP." },
  { icon: PauseCircle, title: "Suspended apps", body: "A host that suspended an app shows as Suspended, apart from a crash." },
];

const INTERNALS = [
  "Incidents open and close on their own, with flapping protection",
  "MTBF and MTTR per monitor",
  "History rolls up so storage never grows unbounded",
  "Monitor secrets encrypted with AES-GCM",
  "Single admin: GitHub or email magic-link sign-in",
  "Admin CLI and API tokens",
];

function Features() {
  return (
    <Section id="features" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading
          eyebrow="Monitoring"
          title="Checks for everything your users depend on"
          subtitle="From public endpoints to background jobs, OpenPing tells you the moment one breaks."
        />
      </Reveal>

      <Reveal delay={100} className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CHECKS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="op-lift flex gap-4 rounded-card border border-line bg-surface p-5">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
              <Icon className="size-5" />
            </span>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-ink">{title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">{body}</p>
            </div>
          </div>
        ))}
      </Reveal>

      <Reveal delay={160} className="mt-4 rounded-card border border-line bg-surface/60 px-5 py-5 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-ink-faint">Under the hood</p>
        <ul className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {INTERNALS.map((p) => (
            <li key={p} className="flex items-start gap-2.5 text-sm text-ink-muted">
              <Check className="mt-0.5 size-4 shrink-0 text-up" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </Reveal>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 6. Status pages (live demo CTA)
 * ------------------------------------------------------------------ */

function StatusPages() {
  return (
    <Section id="status-pages" className="py-14 sm:py-20">
      <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-14">
        <Reveal className="order-2 lg:order-1 relative">
          <div
            aria-hidden
            className="absolute -inset-4 -z-10 rounded-[2rem] opacity-50 blur-2xl"
            style={{ background: "radial-gradient(50% 50% at 50% 50%, rgba(47,191,110,0.16), transparent 70%)" }}
          />
          <StatusMockup />
        </Reveal>
        <Reveal delay={120} className="order-1 lg:order-2">
          <SectionHeading
            align="left"
            eyebrow="Status pages"
            title="A status page your users will trust"
            subtitle="90-day uptime bars, incident history and maintenance notices, in your colors and with your logo. Embed it as a widget or an SVG badge."
          />
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              to="/status"
              className="op-lift inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-canvas shadow-lg shadow-accent/20 hover:bg-accent-hover"
            >
              <Globe className="size-4" />
              See a live status page
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 7. Alerts, on any channel and on your phone
 * ------------------------------------------------------------------ */

const CHANNELS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Bell, title: "Email", body: "Delivered through Resend" },
  { icon: MessageSquare, title: "Discord", body: "Straight to your channel" },
  { icon: Webhook, title: "Signed webhooks", body: "To your own endpoints" },
  { icon: Smartphone, title: "Phone push", body: "An installable Android app" },
];

function Alerts() {
  return (
    <Section id="alerts" className="py-14 sm:py-20">
      <div className="grid items-center gap-10 lg:grid-cols-[1.2fr_1fr] lg:gap-14">
        <Reveal>
          <SectionHeading
            align="left"
            eyebrow="Alerts"
            title="Know the moment something breaks"
            subtitle="Route alerts to one channel or all of them. Install the dashboard on your phone for push notifications, no app store needed."
          />
          <ul className="mt-7 grid gap-3 sm:grid-cols-2">
            {CHANNELS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex items-center gap-3 rounded-card border border-line bg-surface p-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink">{title}</span>
                  <span className="block text-xs text-ink-muted">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={120} className="flex justify-center">
          <PhoneMockup />
        </Reveal>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 8. Free tools anyone can use, no sign-up
 * ------------------------------------------------------------------ */

function FreeTools() {
  return (
    <Section id="free-tools" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading
          eyebrow="Free tools"
          title="Handy without an account"
          subtitle="Small utilities from the same toolbox, free for anyone to use."
        />
      </Reveal>
      <Reveal delay={100} className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map(({ slug, title, tagline, icon: Icon }) => (
          <Link
            key={slug}
            to={`/tools/${slug}`}
            className="op-lift group flex items-start gap-4 rounded-card border border-line bg-surface p-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
              <Icon className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-base font-semibold text-ink">
                {title}
                <ArrowUpRight className="size-4 text-ink-faint transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </span>
              <span className="mt-1 block text-sm leading-relaxed text-ink-muted">{tagline}</span>
            </span>
          </Link>
        ))}
      </Reveal>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 9. Comparison: OpenPing vs hosted uptime SaaS, and what it costs to run
 * ------------------------------------------------------------------ */

const COMPARISON_STATS: { value: ReactNode; label: string; aria?: string }[] = [
  { value: <InfinityIcon className="mx-auto size-7" aria-hidden />, label: "Monitors", aria: "Unlimited monitors" },
  { value: "$0", label: "Per month" },
  { value: <StatNumber value={90} suffix="-day" />, label: "Uptime history" },
  { value: <StatNumber value={4} />, label: "Alert channels" },
];

function Comparison() {
  return (
    <Section id="comparison" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading
          eyebrow="OpenPing vs hosted SaaS"
          title="No tiers, no seat prices, no vendor"
          subtitle="Hosted uptime tools cap your monitors, charge more for faster checks and keep your data. With OpenPing the limits, the bill and the data are yours."
        />
      </Reveal>

      <Reveal delay={100} className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {COMPARISON_STATS.map((s, i) => (
          <div key={i} className="rounded-card border border-line bg-surface px-4 py-5 text-center">
            <div className="text-2xl font-semibold text-accent sm:text-3xl" aria-label={s.aria}>
              {s.value}
            </div>
            <div className="mt-1 text-xs font-medium uppercase tracking-wide text-ink-faint">{s.label}</div>
          </div>
        ))}
      </Reveal>

      <Reveal delay={140} className="mt-8">
        <ComparisonTable />
      </Reveal>

      <p className="mt-4 text-center text-xs text-ink-faint">
        One Worker, one D1 database and a check run every 12 minutes: a typical
        personal or small-team setup stays inside Cloudflare's free plan.
      </p>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 10. Quick start
 * ------------------------------------------------------------------ */

const STEPS: { n: string; title: string; body: string }[] = [
  { n: "1", title: "Clone and deploy", body: "Wrangler creates the Worker, the D1 database and the schedule in your Cloudflare account." },
  { n: "2", title: "Sign in and add monitors", body: "Sign in with GitHub or an email link, then add checks and their schedules." },
  { n: "3", title: "Publish and get alerted", body: "Turn on a status page and connect email, Discord, webhooks or your phone." },
];

function QuickStart() {
  return (
    <Section id="quick-start" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading
          eyebrow="Quick start"
          title="From clone to monitoring in minutes"
          subtitle="No account on someone else's platform. Deploy once, and it's yours."
        />
      </Reveal>
      <Reveal delay={100} className="mt-10 grid gap-3 md:grid-cols-3">
        {STEPS.map((s) => (
          <div key={s.n} className="rounded-card border border-line bg-surface p-5">
            <div className="flex items-center gap-3">
              <span className="grid size-8 place-items-center rounded-full bg-accent text-sm font-bold text-canvas">{s.n}</span>
              <h3 className="text-base font-semibold text-ink">{s.title}</h3>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-muted">{s.body}</p>
          </div>
        ))}
      </Reveal>

      <Reveal delay={140} className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
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
            <span className="text-up"># live on your *.workers.dev</span>
          </code>
        </pre>
      </Reveal>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 11. FAQ
 * ------------------------------------------------------------------ */

// Ordered by what people ask before deploying. What it checks, schedules and
// alerts each have their own section above, so they aren't repeated here.
const FAQS: FaqItem[] = [
  {
    q: "Is OpenPing really free?",
    a: "The software is free and MIT licensed. It runs on Cloudflare Workers, D1 and a scheduled check run, which for typical personal and small-team use fits inside Cloudflare's free plan. Very large installs may outgrow it.",
  },
  {
    q: "Where does my data live?",
    a: "In your own Cloudflare account. Monitor settings, check results, incidents and history are stored in your D1 database. There is no OpenPing cloud. The only things that leave your account are the checks themselves and the alerts you set up (through Resend, Discord, a webhook or your phone).",
  },
  {
    q: "How often does it check?",
    a: "The scheduler runs every 12 minutes and checks each monitor that's due, most overdue first. That keeps a small install well inside the free plan; the schedule is one line in wrangler.jsonc if your plan allows more runs.",
  },
  {
    q: "How do I deploy it?",
    a: (
      <>
        Clone the repository, run <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">npm install</code>, create the
        D1 database and run <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">npm run deploy</code>. The full guide is in the{" "}
        <a href={DEPLOY_URL} target="_blank" rel="noreferrer" className="text-accent underline">
          README
        </a>
        .
      </>
    ),
  },
  {
    q: "Who can sign in?",
    a: "OpenPing has a single administrator. You sign in with GitHub or an email magic link, and only the identity you configure gets in.",
  },
  {
    q: "Can I automate it?",
    a: "Yes. A bundled admin CLI and API tokens let you create monitors, manage settings and script your whole setup.",
  },
];

function FaqSection() {
  return (
    <Section id="faq" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading eyebrow="FAQ" title="Questions, answered" />
      </Reveal>
      <Reveal delay={100} className="mx-auto mt-10 max-w-3xl">
        <FaqAccordion items={FAQS} />
      </Reveal>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 12. Closing CTA, with the open-source invitation folded in
 * ------------------------------------------------------------------ */

function BottomCta() {
  return (
    <Section className="py-14 sm:py-24">
      <Reveal>
        <div className="relative overflow-hidden rounded-card border border-line bg-surface px-6 py-12 text-center sm:px-12 sm:py-14">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{ background: "radial-gradient(60% 100% at 50% 0%, rgba(109,139,255,0.20), transparent 70%)" }}
          />
          <h2 className="mx-auto max-w-2xl text-balance text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Own your uptime monitoring
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-base leading-relaxed text-ink-muted">
            Free, open source and yours. Found a rough edge or have an idea? Issues
            and pull requests are welcome.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <PrimaryCTA href={DEPLOY_URL}>
              <Github className="size-4" />
              Deploy your own
              <ArrowRight className="size-4" />
            </PrimaryCTA>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="op-lift inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-5 py-3 text-sm font-semibold text-ink hover:bg-surface-2"
            >
              <Star className="size-4" />
              Star on GitHub
            </a>
            <a
              href={GITHUB_ISSUES_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm font-semibold text-ink-muted transition-colors hover:text-ink"
            >
              <Bug className="size-4" />
              Open an issue
            </a>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 17. Footer
 * ------------------------------------------------------------------ */

function Footer({ onSignIn }: { onSignIn: () => void }) {
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
            <a href="#comparison" className="transition-colors hover:text-ink">
              Compare
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
            <button
              type="button"
              onClick={onSignIn}
              className="transition-colors hover:text-ink"
            >
              Sign in
            </button>
          </nav>
        </div>

        {/* Support / star / other-projects CTAs */}
        <div className="mt-10 flex flex-wrap items-center gap-3 border-t border-line pt-8">
          {KOFI_ENABLED && (
            <a
              href={KOFI_URL}
              target="_blank"
              rel="noreferrer"
              className="op-lift inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink hover:border-[#ff5e5b]/60"
            >
              <KofiCup className="size-[1.125rem]" />
              Support on Ko-fi
            </a>
          )}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="op-lift inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2"
          >
            <Star className="size-4" />
            Star on GitHub
          </a>
          <a
            href={N8BUILDS_URL}
            target="_blank"
            rel="noreferrer"
            className="op-lift inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2"
          >
            <img src="/n8builds-icon.png" alt="" width={18} height={18} className="rounded" />
            More projects
            <span className="text-ink-muted">n8builds.dev</span>
            <ArrowUpRight className="size-4 text-ink-faint" />
          </a>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-line pt-6 text-xs text-ink-faint sm:flex-row sm:items-center">
          <p>MIT licensed · Self-hosted on your own Cloudflare account.</p>
          <p>© {new Date().getFullYear()} OpenPing</p>
        </div>
      </div>
    </footer>
  );
}
