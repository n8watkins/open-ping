import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bug,
  CalendarClock,
  Check,
  Cloud,
  Database,
  Github,
  Globe,
  HeartPulse,
  Hourglass,
  Menu,
  MessageSquare,
  Network,
  PauseCircle,
  Plug,
  Server,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Star,
  Terminal,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "../components/Logo";
import { TOOLS } from "./tools/ToolLayout";
import { PhoneMockup } from "../components/landing/PhoneMockup";
import { ComparisonTable } from "../components/landing/ComparisonTable";
import { FaqAccordion, type FaqItem } from "../components/landing/FaqAccordion";
import { SignInModal } from "../components/landing/SignInModal";
import { WaitlistForm } from "../components/landing/WaitlistForm";
import { HostingTable } from "../components/landing/HostingTable";
import { prefersReducedMotion, useCountUp, useReveal } from "../components/landing/useReveal";
import {
  HOSTED_FAST_CHECKS_YEARLY,
  HOSTED_PLAN_LIMITS,
  HOSTED_PRICE_YEARLY,
  HOSTED_SUPPORT_EMAIL,
  HOSTED_TRIAL_DAYS,
  HOSTED_TRIAL_LIMITS,
  landingMeta,
} from "../../shared/hosted-offer";
import { CHANNEL_KINDS } from "../../shared/notifications";
import { useBootstrap } from "../lib/bootstrap";
import { HOSTED_CLOSED, hostedOffer, type HostedOffer } from "../lib/hosted-offer";
import { setPageMeta } from "../lib/meta";
import { track, type TrackedEvent } from "../lib/track";

const GITHUB_URL = "https://github.com/n8watkins/open-ping";
const GITHUB_ISSUES_URL = "https://github.com/n8watkins/open-ping/issues";
const HOSTED_PLAN_URL = `${GITHUB_URL}/blob/main/docs/HOSTED_PLAN.md`;
/** Where every "Deploy free" button goes: the step-by-step guide. */
const DEPLOY_PATH = "/install";
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

      /* The hero's product shot: tilted back, it settles flat as it comes in. */
      .op-reveal.op-tilt {
        transform: perspective(1400px) rotateX(14deg) translateY(36px) scale(.96);
        transform-origin: 50% 0;
        transition: opacity 1s cubic-bezier(.16,1,.3,1), transform 1.2s cubic-bezier(.16,1,.3,1);
      }
      .op-reveal.op-tilt.op-in { transform: none; }

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
      className="inline-flex h-9 items-center overflow-hidden rounded-lg border border-line bg-surface text-sm font-semibold text-ink transition-colors hover:border-accent/50"
    >
      {stars != null && (
        <span className="flex h-full items-center gap-1 border-r border-line px-2.5 tabular-nums text-ink-muted">
          <Star className="size-3.5 fill-[#e3b341] text-[#e3b341]" aria-hidden />
          {stars.toLocaleString()}
          {/* Spoken, not shown: the link reads "12 stars, OpenPing on GitHub",
              built from its visible text so voice control matches it. */}
          <span className="sr-only">{stars === 1 ? " star," : " stars,"}</span>
        </span>
      )}
      <span className="flex items-center gap-1.5 px-2.5">
        <Github className="size-4" aria-hidden />
        <span className="sr-only">OpenPing on </span>
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
      <h2 className="text-balance text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
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

/* ------------------------------------------------------------------ *
 * The Hosted offer: a waitlist until HOSTED_SIGNUP_URL is set, then a free
 * trial (lib/hosted-offer.ts). Every section that mentions Hosted reads it
 * here, so the page never mixes "join the waitlist" with "start a trial".
 * ------------------------------------------------------------------ */

const OfferContext = createContext<HostedOffer>(HOSTED_CLOSED);

function useOffer(): HostedOffer {
  return useContext(OfferContext);
}

const TRIAL = HOSTED_TRIAL_LIMITS;
const PLAN = HOSTED_PLAN_LIMITS;
/** "14 days with 5 monitors, 1 status page and email alerts" */
const TRIAL_INCLUDES = `${HOSTED_TRIAL_DAYS} days with ${TRIAL.monitors} monitors, ${TRIAL.statusPages} status page and email alerts`;

/** A "Start a free trial" button: the platform's sign-up page, in this tab. Renders nothing while Hosted is closed. */
function TrialLink({ event, className, children }: { event: TrackedEvent; className: string; children: ReactNode }) {
  const offer = useOffer();
  if (!offer.open) return null;
  return (
    <a href={offer.signupUrl} onClick={() => track(event)} className={className}>
      {children}
    </a>
  );
}

/** Reveal a row of cards one after another (the shared animate-enter and stagger tokens in index.css). */
function StaggerReveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const { ref, visible } = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={`${visible ? "stagger [&>*]:animate-enter" : "[&>*]:opacity-0"} ${className}`}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

/**
 * Take the visitor to the Hosted waitlist: scroll the Hosted card into view and
 * put the cursor in its email field. Links that call it keep href="#pricing",
 * so they still work without it.
 */
function goToWaitlist() {
  const card = document.getElementById("hosted-card");
  const input = document.getElementById("waitlist-email");
  card?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
  input?.focus({ preventScroll: true });
  history.replaceState(null, "", "#pricing");
}

export default function Landing() {
  const { status } = useBootstrap();
  return <LandingPage offer={hostedOffer(status)} />;
}

/** The page itself, for a given Hosted offer (Landing reads it from the server). */
export function LandingPage({ offer }: { offer: HostedOffer }) {
  const [signInOpen, setSignInOpen] = useState(false);
  const openSignIn = useCallback(() => {
    track("signin_open");
    setSignInOpen(true);
  }, []);
  const closeSignIn = useCallback(() => setSignInOpen(false), []);

  useEffect(() => {
    setPageMeta(landingMeta(offer.open));
  }, [offer.open]);

  useEffect(() => {
    track("landing_view");
    // The page renders after the app shell loads, too late for the browser's
    // own jump to a link like /#pricing, so make it here.
    const target = window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
    if (target) requestAnimationFrame(() => target.scrollIntoView());
  }, []);

  return (
    <OfferContext.Provider value={offer}>
      <div className="min-h-full scroll-smooth bg-canvas text-ink">
        <LandingStyles />
        <Nav />

        {/* Once Hosted opens, the two ways to run it come straight after the
            hero, and How it works moves into the self-host half of the page
            (docs/LANDING_AND_LOGIN_PLAN.md, section order). */}
        {offer.open ? (
          <main>
            <Hero />
            <Pricing />
            <ScheduleAware />
            <Features />
            <HowItWorks />
            <FreePlan />
            <Comparison />
            <QuickStart />
            <FreeTools />
            <FaqSection />
            <BottomCta />
          </main>
        ) : (
          <main>
            <Hero />
            <ScheduleAware />
            <HowItWorks />
            <Pricing />
            <Features />
            <FreePlan />
            <Comparison />
            <QuickStart />
            <FreeTools />
            <FaqSection />
            <BottomCta />
          </main>
        )}

        <Footer onSignIn={openSignIn} />

        <SignInModal open={signInOpen} onClose={closeSignIn} />
      </div>
    </OfferContext.Provider>
  );
}

/* ------------------------------------------------------------------ *
 * 1. Nav: transparent at the top, solid + shrunk on scroll, hamburger on mobile
 * ------------------------------------------------------------------ */

const NAV_LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

function Nav() {
  const offer = useOffer();
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
        data-header-row
        className={`mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 transition-all duration-300 sm:px-6 ${
          scrolled ? "h-14" : "h-16 sm:h-20"
        }`}
      >
        <div className="flex shrink-0 items-center gap-4">
          <Link to="/" aria-label="OpenPing home">
            <Logo />
          </Link>
          <span aria-hidden="true" className="hidden h-5 w-px bg-line lg:block" />
          <span className="hidden lg:flex">
            <N8buildsMark />
          </span>
        </div>

        <nav aria-label="Main" className="hidden items-center gap-6 whitespace-nowrap text-sm text-ink-muted md:flex">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className="transition-colors hover:text-ink">
              {l.label}
            </a>
          ))}
          {offer.open && (
            <Link to={DEPLOY_PATH} onClick={() => track("nav_deploy")} className="hidden transition-colors hover:text-ink lg:inline">
              Self-host
            </Link>
          )}
        </nav>

        {offer.open ? (
          <div className="hidden items-center gap-2 whitespace-nowrap md:flex">
            <span className="hidden xl:inline-flex">
              <StarButton />
            </span>
            <a
              href={offer.signInUrl}
              className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Log in
            </a>
            <TrialLink
              event="nav_trial"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-semibold text-canvas transition-colors hover:bg-accent-hover"
            >
              Start free trial
              <ArrowRight className="size-4" aria-hidden />
            </TrialLink>
          </div>
        ) : (
          <div className="hidden items-center gap-2 whitespace-nowrap md:flex">
            <span className="hidden lg:inline-flex">
              <StarButton />
            </span>
            <Link
              to={DEPLOY_PATH}
              onClick={() => track("nav_deploy")}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-semibold text-canvas transition-colors hover:bg-accent-hover"
            >
              Deploy free
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        )}

        {/* Phones: the one header button is the main call to action. */}
        <div className="ml-auto flex items-center gap-1 md:hidden">
          {offer.open ? (
            <TrialLink
              event="nav_trial"
              className="inline-flex h-9 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-canvas transition-colors hover:bg-accent-hover"
            >
              Start free trial
            </TrialLink>
          ) : (
            <Link
              to={DEPLOY_PATH}
              onClick={() => track("nav_deploy")}
              className="inline-flex h-9 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-canvas transition-colors hover:bg-accent-hover"
            >
              Deploy free
            </Link>
          )}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            className="grid size-11 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div id="mobile-nav" className="border-t border-line bg-surface/95 backdrop-blur md:hidden">
          <nav aria-label="Main" className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3 text-sm">
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
            {offer.open ? (
              <a
                href={offer.signInUrl}
                className="rounded-lg px-3 py-3 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                Log in to OpenPing Hosted
              </a>
            ) : (
              <a
                href="#pricing"
                onClick={(e) => {
                  e.preventDefault();
                  setMenuOpen(false);
                  goToWaitlist();
                }}
                className="rounded-lg px-3 py-3 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                Join the Hosted waitlist
              </a>
            )}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              onClick={() => setMenuOpen(false)}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-3 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Github className="size-4" aria-hidden />
              OpenPing on GitHub
            </a>
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
            <Link
              to={DEPLOY_PATH}
              onClick={() => track("nav_deploy")}
              className={
                offer.open
                  ? "mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-3.5 font-semibold text-ink transition-colors hover:border-accent/50"
                  : "mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-accent px-3.5 font-semibold text-canvas transition-colors hover:bg-accent-hover"
              }
            >
              Deploy free to your Cloudflare
              <ArrowRight className="size-4" aria-hidden />
            </Link>
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
  "HTTP, DNS, TCP and heartbeats",
  "Status pages and alerts",
  "Off-hours aware",
  "MIT licensed",
];

/** The two ways to run OpenPing, side by side, so the hero answers "which one, and what does it cost?". */
function PathCards() {
  return useOffer().open ? <TrialPathCards /> : <WaitlistPathCards />;
}

/**
 * Once Hosted opens: the trial leads, because the Hosted visitor needs the
 * least persuading to start and a developer finds the free path anyway
 * (docs/LANDING_AND_LOGIN_PLAN.md, "Copy: after Hosted launches").
 */
function TrialPathCards() {
  return (
    <div className="mx-auto mt-9 grid max-w-3xl gap-3 text-left sm:grid-cols-2">
      <div className="relative flex flex-col rounded-card border border-accent/60 bg-surface p-4 shadow-xl shadow-accent/10 min-[400px]:p-5">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-card"
          style={{ background: "radial-gradient(90% 70% at 0% 0%, rgba(109,139,255,0.14), transparent 70%)" }}
        />
        <div className="relative flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-accent">Let me run it</h2>
          <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">
            <span className="op-live-dot size-1.5 rounded-full bg-accent" aria-hidden />
            {HOSTED_TRIAL_DAYS}-day free trial
          </span>
        </div>
        <p className="relative mt-2 flex items-baseline gap-2">
          <span className="text-3xl font-semibold tracking-tight text-ink">${HOSTED_PRICE_YEARLY}</span>
          <span className="text-sm text-ink-muted">a year, OpenPing Hosted</span>
        </p>
        <p className="relative mt-2 text-sm leading-relaxed text-ink-muted">
          Nothing to set up. Sign up, add your sites, take your data with you any time.
        </p>
        <TrialLink
          event="hero_trial"
          className="op-lift relative mt-4 inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 text-sm font-semibold text-canvas shadow-lg shadow-accent/20 hover:bg-accent-hover"
        >
          Start a free trial
          <ArrowRight className="size-4" aria-hidden />
        </TrialLink>
        <p className="relative mt-2.5 text-center text-xs text-ink-faint">
          {TRIAL.monitors} monitors for {HOSTED_TRIAL_DAYS} days. No card needed.
        </p>
      </div>

      <div className="flex flex-col rounded-card border border-line bg-surface/80 p-4 min-[400px]:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink-muted">Run it yourself</h2>
          <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-up/30 bg-up/10 px-2 py-0.5 text-xs font-semibold text-up">
            Always free
          </span>
        </div>
        <p className="mt-2 flex items-baseline gap-2">
          <span className="text-3xl font-semibold tracking-tight text-ink">Free</span>
          <span className="text-sm text-ink-muted">in your own Cloudflare</span>
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Every feature, your data in your account. About 5 minutes with the Deploy to Cloudflare button.
        </p>
        <Link
          to={DEPLOY_PATH}
          onClick={() => track("hero_deploy")}
          className="op-lift mt-4 inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface-2 px-3 text-sm font-semibold text-ink hover:border-accent/50"
        >
          Deploy free to your Cloudflare
          <ArrowRight className="size-4" aria-hidden />
        </Link>
        <p className="mt-2.5 text-center text-xs text-ink-faint">MIT licensed. Nothing to sign up for.</p>
      </div>
    </div>
  );
}

/** While Hosted is a waitlist: the free path leads, and Hosted is clearly the secondary choice. */
function WaitlistPathCards() {
  return (
    <div className="mx-auto mt-9 grid max-w-3xl gap-3 text-left sm:grid-cols-2">
      <div className="relative flex flex-col rounded-card border border-accent/60 bg-surface p-4 shadow-xl shadow-accent/10 min-[400px]:p-5">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-card"
          style={{ background: "radial-gradient(90% 70% at 0% 0%, rgba(109,139,255,0.14), transparent 70%)" }}
        />
        <div className="relative flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-accent">Run it yourself</h2>
          <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-up/30 bg-up/10 px-2 py-0.5 text-xs font-semibold text-up">
            <span className="op-live-dot size-1.5 rounded-full bg-up" aria-hidden />
            Available now
          </span>
        </div>
        <p className="relative mt-2 flex items-baseline gap-2">
          <span className="text-3xl font-semibold tracking-tight text-ink">Free</span>
          <span className="text-sm text-ink-muted">in your own Cloudflare</span>
        </p>
        <p className="relative mt-2 text-sm leading-relaxed text-ink-muted">
          Every feature, your data in your account. About 20 minutes, step by step.
        </p>
        <Link
          to={DEPLOY_PATH}
          onClick={() => track("hero_deploy")}
          className="op-lift relative mt-4 inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 text-sm font-semibold text-canvas shadow-lg shadow-accent/20 hover:bg-accent-hover"
        >
          Deploy free to your Cloudflare
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>

      <div className="flex flex-col rounded-card border border-line bg-surface/80 p-4 min-[400px]:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink-muted">Let me run it</h2>
          <span className="shrink-0 whitespace-nowrap rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-semibold text-ink-muted">
            Not open yet
          </span>
        </div>
        <p className="mt-2 flex items-baseline gap-2">
          <span className="text-3xl font-semibold tracking-tight text-ink">$24</span>
          <span className="text-sm text-ink-muted">a year, OpenPing Hosted</span>
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Nothing to set up. Sign in, add your sites, take your data with you any time.
        </p>
        <a
          href="#pricing"
          onClick={(e) => {
            e.preventDefault();
            track("hero_waitlist");
            goToWaitlist();
          }}
          className="op-lift mt-4 inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-4 text-sm font-semibold text-ink hover:border-accent/50"
        >
          Join the Hosted waitlist
        </a>
      </div>
    </div>
  );
}

function Hero() {
  const open = useOffer().open;
  return (
    <div className="relative overflow-hidden">
      {/* Glow and a faint grid behind the headline. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(55% 45% at 50% -5%, rgba(109,139,255,0.26), transparent 70%), radial-gradient(35% 35% at 85% 20%, rgba(47,191,110,0.10), transparent 70%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(31,44,68,0.6) 1px, transparent 1px), linear-gradient(to bottom, rgba(31,44,68,0.6) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(60% 50% at 50% 0%, black, transparent 75%)",
          WebkitMaskImage: "radial-gradient(60% 50% at 50% 0%, black, transparent 75%)",
        }}
      />

      <Section className="pt-10 pb-6 sm:pt-14">
        <Reveal className="mx-auto max-w-4xl text-center">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs font-medium text-ink-muted transition-colors hover:border-ink-faint/40 hover:text-ink"
          >
            <Github className="size-3.5" aria-hidden />
            Open source, MIT licensed
          </a>

          {open ? (
            <>
              <h1 className="mx-auto mt-6 max-w-3xl text-balance text-[2rem] font-semibold leading-[1.05] tracking-tight text-ink sm:text-6xl">
                Uptime monitoring that <span className="whitespace-nowrap text-accent">knows your hours</span>
              </h1>

              <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-ink-muted sm:text-lg">
                Checks, status pages and alerts that only count the hours an app is meant to be up. Let me host it for
                ${HOSTED_PRICE_YEARLY} a year, or run it free in your own Cloudflare account.
              </p>
            </>
          ) : (
            <>
              <h1 className="mx-auto mt-6 max-w-3xl text-balance text-[2rem] font-semibold leading-[1.05] tracking-tight text-ink sm:text-6xl">
                Uptime monitoring on <span className="whitespace-nowrap text-accent">your own</span> Cloudflare
              </h1>

              <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-ink-muted sm:text-lg">
                Checks, status pages and alerts for your sites and APIs, with schedules that know when an app is meant
                to be asleep. Run it free in your own Cloudflare account. A hosted version is coming.
              </p>
            </>
          )}

          <ul className="mx-auto mt-6 grid max-w-md grid-cols-2 gap-x-5 gap-y-2 text-left sm:max-w-lg lg:flex lg:max-w-none lg:justify-center lg:gap-x-6">
            {HERO_POINTS.map((b) => (
              <li key={b} className="flex items-start gap-2 text-sm text-ink-muted lg:whitespace-nowrap">
                <Check className="mt-0.5 size-4 shrink-0 text-up" aria-hidden />
                {b}
              </li>
            ))}
          </ul>

          <PathCards />

          <p className="mt-5 text-sm text-ink-muted">
            Or{" "}
            <Link
              to="/status"
              onClick={() => track("hero_status")}
              className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent"
            >
              see a live status page
            </Link>{" "}
            and{" "}
            <Link
              to="/tools"
              onClick={() => track("hero_tools")}
              className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent"
            >
              try the free tools
            </Link>
            , no sign-up needed.
          </p>
        </Reveal>
      </Section>

      {/* The real app, in a browser window that tilts flat as it comes into view. */}
      <Section className="pb-14 sm:pb-20">
        <Reveal delay={150} className="op-tilt relative mx-auto max-w-5xl">
          <div
            aria-hidden
            className="absolute -inset-x-10 -top-10 bottom-10 -z-10 rounded-[3rem] opacity-70 blur-3xl"
            style={{ background: "radial-gradient(50% 50% at 50% 40%, rgba(109,139,255,0.25), transparent 70%)" }}
          />
          <figure className="overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/50">
            <div aria-hidden className="flex items-center gap-3 border-b border-line bg-surface-2/60 px-4 py-2.5">
              <span className="flex gap-1.5">
                <span className="size-2.5 rounded-full bg-[#ff5f57]" />
                <span className="size-2.5 rounded-full bg-[#febc2e]" />
                <span className="size-2.5 rounded-full bg-[#28c840]" />
              </span>
              <span className="mx-auto max-w-[60%] truncate rounded-md bg-canvas/60 px-3 py-1 font-mono text-[11px] text-ink-faint">
                openping.your-account.workers.dev
              </span>
              <span className="w-[42px]" />
            </div>
            <img
              src="/landing/app-overview.webp"
              alt="The OpenPing overview: one monitor down, one degraded, and every monitor with its recent checks"
              width={1360}
              height={860}
              className="block h-auto w-full"
              loading="eager"
              decoding="async"
            />
            <figcaption className="sr-only">The signed-in OpenPing overview, with demo data.</figcaption>
          </figure>
        </Reveal>
      </Section>
    </div>
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
  const open = useOffer().open;
  return (
    <Section id="how-it-works" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading
          eyebrow={open ? "How self-hosting works" : "How it works"}
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
        <p className="mx-auto mt-2 max-w-2xl text-center text-sm text-ink-faint">
          That's the free path. With Hosted, the same Worker and database run in my Cloudflare account instead, a
          separate copy for each customer.
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
  "Single admin: passkey, GitHub or email magic-link sign-in",
  "Admin CLI and API tokens",
];

/* ------------------------------------------------------------------ *
 * 7. Alerts, on any channel and on your phone
 * ------------------------------------------------------------------ */

const CHANNELS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Bell, title: "Email", body: "Delivered through Resend" },
  { icon: MessageSquare, title: "Discord", body: "Straight to your channel" },
  { icon: Webhook, title: "Signed webhooks", body: "To your own endpoints" },
  { icon: Smartphone, title: "Phone push", body: "An installable Android app" },
];

type FeatureTab = "checks" | "status-pages" | "alerts";

const FEATURE_TABS: { id: FeatureTab; label: string }[] = [
  { id: "checks", label: "Checks" },
  { id: "status-pages", label: "Status pages" },
  { id: "alerts", label: "Alerts" },
];

function ChecksPanel() {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CHECKS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="op-lift flex gap-4 rounded-card border border-line bg-surface p-5">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
              <Icon className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-ink">{title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">{body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-card border border-line bg-surface/60 px-5 py-5 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-ink-faint">Under the hood</p>
        <ul className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {INTERNALS.map((p) => (
            <li key={p} className="flex items-start gap-2.5 text-sm text-ink-muted">
              <Check className="mt-0.5 size-4 shrink-0 text-up" aria-hidden />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function StatusPagesPanel() {
  return (
    <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
      <div className="relative">
        <div
          aria-hidden
          className="absolute -inset-4 -z-10 rounded-[2rem] opacity-50 blur-2xl"
          style={{ background: "radial-gradient(50% 50% at 50% 50%, rgba(47,191,110,0.16), transparent 70%)" }}
        />
        <figure className="overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/40">
          <div aria-hidden className="flex items-center gap-3 border-b border-line bg-surface-2/60 px-4 py-2.5">
            <span className="flex gap-1.5">
              <span className="size-2.5 rounded-full bg-[#ff5f57]" />
              <span className="size-2.5 rounded-full bg-[#febc2e]" />
              <span className="size-2.5 rounded-full bg-[#28c840]" />
            </span>
            <span className="truncate font-mono text-[11px] text-ink-faint">status.your-domain.com</span>
          </div>
          <img
            src="/landing/status-page.webp"
            alt="An OpenPing status page: a partial outage banner, the open incident, and 90-day uptime bars for each service"
            width={800}
            height={620}
            className="block h-auto w-full"
            loading="lazy"
            decoding="async"
          />
          <figcaption className="sr-only">A public OpenPing status page, with demo data.</figcaption>
        </figure>
      </div>
      <div>
        <h3 className="text-2xl font-semibold tracking-tight text-ink">A status page your users will trust</h3>
        <p className="mt-3 text-base leading-relaxed text-ink-muted">
          90-day uptime bars, incident history and maintenance notices, in your colors and with your logo. One page per
          group of services if you like, and an embeddable widget or SVG badge for your own site.
        </p>
        <Link
          to="/status"
          className="op-lift mt-6 inline-flex h-11 items-center gap-2 rounded-lg border border-line bg-surface-2 px-5 text-sm font-semibold text-ink hover:border-accent/50"
        >
          <Globe className="size-4" aria-hidden />
          See a live status page
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

function AlertsPanel() {
  return (
    <div className="grid items-center gap-8 lg:grid-cols-[1.2fr_1fr] lg:gap-12">
      <div>
        <h3 className="text-2xl font-semibold tracking-tight text-ink">Know the moment something breaks</h3>
        <p className="mt-3 text-base leading-relaxed text-ink-muted">
          Route alerts to one channel or all of them. Install the dashboard on your phone for push notifications, no
          app store needed.
        </p>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {CHANNELS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex items-center gap-3 rounded-card border border-line bg-surface p-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                <Icon className="size-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{title}</span>
                <span className="block text-xs text-ink-muted">{body}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex justify-center">
        <PhoneMockup />
      </div>
    </div>
  );
}

/**
 * What it checks, the status pages and the alerts, as one section with tabs
 * (WAI-ARIA tabs: arrow keys, Home and End move between them). Every panel
 * stays in the page, hidden when not selected, so its text is still there for
 * search engines and for find-in-page once it's picked.
 */
function Features() {
  const [active, setActive] = useState<FeatureTab>("checks");
  const baseId = useId();
  const tabRefs = useRef<Partial<Record<FeatureTab, HTMLButtonElement | null>>>({});

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const index = FEATURE_TABS.findIndex((t) => t.id === active);
    let next: number;
    if (e.key === "ArrowRight") next = (index + 1) % FEATURE_TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + FEATURE_TABS.length) % FEATURE_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = FEATURE_TABS.length - 1;
    else return;
    e.preventDefault();
    const id = FEATURE_TABS[next]!.id;
    setActive(id);
    tabRefs.current[id]?.focus();
  }

  return (
    <Section id="features" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading
          eyebrow="Features"
          title="Checks, status pages and alerts in one place"
          subtitle="From public endpoints to background jobs, OpenPing tells you the moment one breaks, and tells your users too."
        />
      </Reveal>

      <Reveal delay={100} className="mt-10">
        <div className="flex justify-center">
          <div
            role="tablist"
            aria-label="Features"
            onKeyDown={onKeyDown}
            className="inline-flex rounded-xl border border-line bg-surface p-1"
          >
            {FEATURE_TABS.map((t) => {
              const selected = t.id === active;
              return (
                <button
                  key={t.id}
                  ref={(el) => {
                    tabRefs.current[t.id] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${baseId}-tab-${t.id}`}
                  aria-selected={selected}
                  aria-controls={`${baseId}-panel-${t.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActive(t.id)}
                  className={
                    selected
                      ? "h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-canvas sm:px-5"
                      : "h-10 rounded-lg px-4 text-sm font-medium text-ink-muted transition-colors hover:text-ink sm:px-5"
                  }
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        {FEATURE_TABS.map((t) => (
          <div
            key={t.id}
            role="tabpanel"
            id={`${baseId}-panel-${t.id}`}
            aria-labelledby={`${baseId}-tab-${t.id}`}
            hidden={t.id !== active}
            tabIndex={0}
            className="mt-8 rounded-card focus-visible:outline-offset-4"
          >
            {t.id === "checks" && <ChecksPanel />}
            {t.id === "status-pages" && <StatusPagesPanel />}
            {t.id === "alerts" && <AlertsPanel />}
          </div>
        ))}
      </Reveal>
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
  { value: "12 min", label: "Between checks" },
  { value: "$0", label: "Per month" },
  { value: <StatNumber value={90} suffix="-day" />, label: "Uptime history" },
  { value: <StatNumber value={CHANNEL_KINDS.length} />, label: "Alert channels" },
];

/** Once Hosted opens: both prices up front, then the same history and channels. */
const COMPARISON_STATS_OPEN: { value: ReactNode; label: string; aria?: string }[] = [
  { value: "$0", label: "Self-hosted" },
  { value: <StatNumber value={HOSTED_PRICE_YEARLY} prefix="$" />, label: "A year, Hosted" },
  { value: <StatNumber value={90} suffix="-day" />, label: "Uptime history" },
  { value: <StatNumber value={CHANNEL_KINDS.length} />, label: "Alert channels" },
];

function Comparison() {
  const open = useOffer().open;
  return (
    <Section id="comparison" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading
          eyebrow="OpenPing vs hosted SaaS"
          title="No tiers, no seat prices, no vendor"
          subtitle={
            open
              ? `Hosted uptime tools cap your monitors, charge more for faster checks and keep your data. OpenPing is free in your own account, or one flat $${HOSTED_PRICE_YEARLY} a year hosted, and your data can always leave with you.`
              : "Hosted uptime tools cap your monitors, charge more for faster checks and keep your data. With OpenPing the limits, the bill and the data are yours."
          }
        />
      </Reveal>

      <Reveal delay={100} className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(open ? COMPARISON_STATS_OPEN : COMPARISON_STATS).map((s, i) => (
          <div key={i} className="rounded-card border border-line bg-surface px-4 py-5 text-center">
            <div className="text-2xl font-semibold text-accent sm:text-3xl" aria-label={s.aria}>
              {s.value}
            </div>
            <div className="mt-1 text-xs font-medium uppercase tracking-wide text-ink-faint">{s.label}</div>
          </div>
        ))}
      </Reveal>

      <Reveal delay={140} className="mt-8">
        <ComparisonTable open={open} />
      </Reveal>

      <p className="mt-4 text-center text-xs text-ink-faint">
        OpenPing sets no monitor cap; Cloudflare's per-run limits do. On the free
        plan about 24 monitors fit at once, checked every 12 minutes (see below).
      </p>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 10. Quick start
 * ------------------------------------------------------------------ */

const STEPS: { n: string; title: string; body: string }[] = [
  { n: "1", title: "Clone and deploy", body: "Wrangler creates the Worker, the D1 database and the schedule in your Cloudflare account." },
  { n: "2", title: "Sign in and add monitors", body: "Sign in with a passkey, GitHub or an email link, then add checks and their schedules." },
  { n: "3", title: "Publish and get alerted", body: "Turn on a status page and connect email, Discord, webhooks or your phone." },
];

/* ------------------------------------------------------------------ *
 * What the Cloudflare Free plan covers (docs/FREE_TIER.md, lib/budget.ts):
 * each cron run may make 50 D1 queries and 50 fetches, which fits about 24
 * passing checks (every check's writes share one batch); the rest wait for the next run.
 * ------------------------------------------------------------------ */

const PLAN_FACTS: { value: string; label: string; body: string }[] = [
  {
    value: "Every 12 min",
    label: "How often",
    body: "A Cron Trigger runs the checks that are due, most overdue first.",
  },
  {
    value: "About 24",
    label: "Monitors on at once, Free plan",
    body: "Cloudflare allows 50 database queries per run on Free. Anything that doesn't fit waits one run.",
  },
  {
    value: "Up to 200",
    label: "Per run on Workers Paid",
    body: "Set WORKERS_PLAN to \"paid\" in wrangler.jsonc and redeploy.",
  },
];

/* ------------------------------------------------------------------ *
 * Pricing: free in your own account, or Hosted (coming soon, waitlist)
 * ------------------------------------------------------------------ */

const OWN_ACCOUNT_POINTS = [
  "Every feature, MIT licensed",
  "Your data never leaves your account",
  "Fits Cloudflare's free plan for about 24 monitors at once; Workers Paid for more",
  "About 20 minutes, step by step",
];

const HOSTED_POINTS = [
  "Nothing to set up: sign in and add your sites",
  "20 monitors, checked every 12 minutes",
  "2 status pages and every alert channel",
  "A failure confirmed from a second region before it alerts",
  "Optional 1-minute checks for $12 a year more",
];

/** Count the pricing section once per page view, when most of a card is on screen. */
function usePricingView() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          track("pricing_view");
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return ref;
}

/** The free card beside the trial: the quick Deploy to Cloudflare path, as /install describes it. */
const OWN_ACCOUNT_POINTS_OPEN = [
  ...OWN_ACCOUNT_POINTS.slice(0, -1),
  "About 5 minutes with the Deploy to Cloudflare button, no terminal needed",
];

/** Once Hosted opens: what the paid plan includes (docs/HOSTED_PLAN.md, "The offer"). */
const HOSTED_POINTS_OPEN = [
  "Nothing to set up: sign up and add your sites",
  `${PLAN.monitors} monitors, checked every 12 minutes`,
  `${PLAN.statusPages} status pages and every alert channel`,
  "A failure confirmed from a second region before it alerts",
  `Optional 1-minute checks for $${HOSTED_FAST_CHECKS_YEARLY} a year more`,
  "Updates and the servers are on me",
];

/** The two paths in one glance, once both are open: cost, where it runs, and that they never mix. */
const TWO_PATHS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Cloud,
    title: "Self-hosted: free",
    body: "Runs in your own Cloudflare account. You pay Cloudflare only if you outgrow its free plan (Workers Paid is $5 a month).",
  },
  {
    icon: Sparkles,
    title: `Hosted: $${HOSTED_PRICE_YEARLY} a year`,
    body: "Your own OpenPing with a database of its own, run in my Cloudflare account. No Cloudflare account needed.",
  },
  {
    icon: ShieldCheck,
    title: "Independent and private",
    body: "Every install stands alone. OpenPing never sees a self-hosted one, and no Hosted customer shares a database with another.",
  },
  {
    icon: ArrowLeftRight,
    title: "Move either way",
    body: "Export from one and import into the other, whenever you like. Nothing locks you to either path.",
  },
];

/** The free card. `featured` while Hosted is a waitlist (the one complete offer); plain beside the trial. */
function OwnAccountCard({ featured }: { featured: boolean }) {
  return (
    <div
      className={`op-lift relative flex flex-col rounded-card border bg-surface p-5 sm:p-7 ${
        featured ? "border-accent/60" : "border-line"
      }`}
    >
      {featured && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 rounded-card"
          style={{ background: "radial-gradient(80% 60% at 50% 0%, rgba(109,139,255,0.16), transparent 70%)" }}
        />
      )}
      <div className="flex items-center justify-between gap-3">
        <h3 className={`text-sm font-semibold ${featured ? "text-accent" : "text-ink"}`}>In your own Cloudflare account</h3>
        <span className="shrink-0 whitespace-nowrap rounded-full border border-up/30 bg-up/10 px-2.5 py-0.5 text-xs font-semibold text-up">
          {featured ? "Available now" : "Always free"}
        </span>
      </div>
      <p className="mt-2 text-4xl font-semibold tracking-tight text-ink">Free</p>
      <ul className="mt-5 space-y-2.5 text-sm text-ink-muted">
        {(featured ? OWN_ACCOUNT_POINTS : OWN_ACCOUNT_POINTS_OPEN).map((p) => (
          <li key={p} className="flex gap-2.5">
            <Check className="mt-0.5 size-4 shrink-0 text-up" aria-hidden />
            {p}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-6">
        <Link
          to={DEPLOY_PATH}
          onClick={() => track("pricing_deploy")}
          className={
            featured
              ? "op-lift inline-flex h-11 w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 text-sm font-semibold text-canvas shadow-lg shadow-accent/20 hover:bg-accent-hover"
              : "op-lift inline-flex h-11 w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface-2 px-3 text-sm font-semibold text-ink hover:border-accent/50"
          }
        >
          Deploy free to your Cloudflare
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

/** The Hosted card while it's a waitlist: the price, what it will include and the email form. */
function HostedWaitlistCard() {
  return (
    <div id="hosted-card" className="op-lift relative flex scroll-mt-28 flex-col rounded-card border border-line bg-surface p-5 sm:p-7">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">OpenPing Hosted</h3>
        <span className="shrink-0 whitespace-nowrap rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-ink-muted">
          Not open yet
        </span>
      </div>
      <p className="mt-2 text-4xl font-semibold tracking-tight text-ink">
        $24<span className="text-lg font-medium text-ink-muted"> a year</span>
      </p>
      <ul className="mt-5 space-y-2.5 text-sm text-ink-muted">
        {HOSTED_POINTS.map((p) => (
          <li key={p} className="flex gap-2.5">
            <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            {p}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-6">
        <WaitlistForm onJoined={() => track("waitlist_join")} />
        <a
          href={HOSTED_PLAN_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-ink-muted underline decoration-line underline-offset-4 hover:text-ink hover:decoration-accent"
        >
          Where Hosted is up to
          <ArrowUpRight className="size-3.5" aria-hidden />
        </a>
      </div>
    </div>
  );
}

/** The Hosted card once it's open: the trial leads, the price follows it. */
function HostedTrialCard() {
  return (
    <div
      id="hosted-card"
      className="op-lift relative flex scroll-mt-28 flex-col rounded-card border border-accent/60 bg-surface p-5 shadow-xl shadow-accent/10 sm:p-7"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 rounded-card"
        style={{ background: "radial-gradient(80% 60% at 50% 0%, rgba(109,139,255,0.16), transparent 70%)" }}
      />
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-accent">OpenPing Hosted</h3>
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-accent/40 bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent">
          <span className="op-live-dot size-1.5 rounded-full bg-accent" aria-hidden />
          {HOSTED_TRIAL_DAYS}-day free trial
        </span>
      </div>
      <p className="mt-2 text-4xl font-semibold tracking-tight text-ink">
        ${HOSTED_PRICE_YEARLY}
        <span className="text-lg font-medium text-ink-muted"> a year</span>
      </p>
      <ul className="mt-5 space-y-2.5 text-sm text-ink-muted">
        {HOSTED_POINTS_OPEN.map((p) => (
          <li key={p} className="flex gap-2.5">
            <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            {p}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-6">
        <TrialLink
          event="pricing_trial"
          className="op-lift inline-flex h-11 w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 text-sm font-semibold text-canvas shadow-lg shadow-accent/20 hover:bg-accent-hover"
        >
          Start a free trial
          <ArrowRight className="size-4" aria-hidden />
        </TrialLink>
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          Free for {TRIAL_INCLUDES}. No card needed, cancel any time, and your monitors can move to your own Cloudflare
          whenever you like.
        </p>
      </div>
    </div>
  );
}

function Pricing() {
  const cardsRef = usePricingView();
  const offer = useOffer();
  return (
    <Section id="pricing" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading
          eyebrow="Pricing"
          title="Run it yourself for free, or let me run it"
          subtitle={
            offer.open
              ? `The software is the same either way. Run it free in your own Cloudflare account, or let me run it for you on OpenPing Hosted, starting with a ${HOSTED_TRIAL_DAYS}\u2011day free trial.`
              : "The software is the same either way. One path is free in your own Cloudflare account; the other is a hosted plan for people who'd rather not touch Cloudflare."
          }
        />
      </Reveal>
      <Reveal delay={100} className="mx-auto mt-10 max-w-5xl">
        <div ref={cardsRef} className="grid items-stretch gap-4 md:grid-cols-2">
          {offer.open ? (
            <>
              <HostedTrialCard />
              <OwnAccountCard featured={false} />
            </>
          ) : (
            <>
              <OwnAccountCard featured />
              <HostedWaitlistCard />
            </>
          )}
        </div>

        {offer.open && (
          <StaggerReveal className="mt-4 grid gap-3 sm:grid-cols-2">
            {TWO_PATHS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex gap-3.5 rounded-card border border-line bg-surface/60 p-4 sm:p-5">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                  <Icon className="size-[1.125rem]" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-ink">{title}</h4>
                  <p className="mt-1 text-sm leading-relaxed text-ink-muted">{body}</p>
                </div>
              </div>
            ))}
          </StaggerReveal>
        )}

        <div className="mx-auto mt-6 flex max-w-3xl items-start gap-3 rounded-card border border-line bg-surface/60 px-4 py-4 sm:items-center sm:px-5">
          <img src="/n8builds-icon.png" alt="" width={36} height={36} className="mt-0.5 shrink-0 rounded-lg ring-1 ring-white/10 sm:mt-0" />
          {offer.open ? (
            <p className="text-sm leading-relaxed text-ink-muted">
              Hosted is run by{" "}
              <a href={N8BUILDS_URL} target="_blank" rel="noreferrer" className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent">
                Nathan Watkins (n8builds)
              </a>
              , the person who writes OpenPing. Hosted accounts live at{" "}
              <span className="font-mono text-xs text-ink">{offer.host}</span>, separate from any install you run
              yourself. Questions?{" "}
              <a href={`mailto:${HOSTED_SUPPORT_EMAIL}`} className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent">
                {HOSTED_SUPPORT_EMAIL}
              </a>
            </p>
          ) : (
            <p className="text-pretty text-sm leading-relaxed text-ink-muted">
              Hosted is run by{" "}
              <a href={N8BUILDS_URL} target="_blank" rel="noreferrer" className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent">
                Nathan Watkins (n8builds)
              </a>
              , the person who writes OpenPing. Hosted accounts will have an address of their own, separate from any
              install you run yourself.
            </p>
          )}
        </div>
      </Reveal>

      <Reveal delay={140} className="mx-auto mt-12 max-w-5xl">
        <h3 className="text-center text-xl font-semibold tracking-tight text-ink sm:text-2xl">Self-host or Hosted, side by side</h3>
        <div className="mt-6">
          <HostingTable open={offer.open} />
        </div>
      </Reveal>
    </Section>
  );
}

function FreePlan() {
  return (
    <Section id="free-plan" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading
          eyebrow="Honest limits"
          title="What Cloudflare's free plan covers"
          subtitle="OpenPing has no monitor cap of its own. What fits is set by Cloudflare's per-run limits, so here are the real numbers."
        />
      </Reveal>
      <Reveal delay={100} className="mx-auto mt-10 grid max-w-5xl gap-4 md:grid-cols-3">
        {PLAN_FACTS.map((f) => (
          <div key={f.label} className="op-lift rounded-card border border-line bg-surface p-6">
            <p className="text-3xl font-semibold tracking-tight text-ink">{f.value}</p>
            <p className="mt-1 text-sm font-semibold text-accent">{f.label}</p>
            <p className="mt-3 text-sm leading-relaxed text-ink-muted">{f.body}</p>
          </div>
        ))}
      </Reveal>
      <Reveal delay={150}>
        <p className="mx-auto mt-6 max-w-3xl text-center text-sm text-ink-muted">
          Monitors outside their hours cost nothing, so business-hours apps stretch the free plan further.{" "}
          <a
            href={`${GITHUB_URL}/blob/main/docs/FREE_TIER.md`}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent"
          >
            The full numbers and sources
          </a>
        </p>
      </Reveal>
    </Section>
  );
}

function QuickStart() {
  return (
    <Section id="quick-start" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading
          eyebrow="Quick start"
          title="From clone to monitoring in minutes"
          subtitle={
            <>
              No account on someone else's platform. Deploy once, and it's yours.{" "}
              <Link to="/install" className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent">
                The full step-by-step guide
              </Link>
            </>
          }
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
            <span className="text-ink-faint">$ </span>npx wrangler secret put MASTER_KEY
            {"  "}
            <span className="text-up"># and SETUP_TOKEN</span>
            {"\n"}
            <span className="text-ink-faint">$ </span>npm run deploy
            {"  "}
            <span className="text-up"># creates the database, live on *.workers.dev</span>
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
    a: "Yes. The software is free and MIT licensed, and it runs in your own Cloudflare account, which for typical personal and small-team use fits inside Cloudflare's free plan. Every feature is in the free version; nothing is held back for Hosted.",
  },
  {
    q: "Is there a hosted version?",
    a: (
      <>
        Planned, not open yet. OpenPing Hosted will be $24 a year for people who'd rather not run it themselves.{" "}
        <a
          href="#pricing"
          onClick={(e) => {
            e.preventDefault();
            goToWaitlist();
          }}
          className="text-accent underline"
        >
          Join the waitlist
        </a>{" "}
        to hear once when it opens, and see{" "}
        <a href={HOSTED_PLAN_URL} target="_blank" rel="noreferrer" className="text-accent underline">
          where Hosted is up to
        </a>
        .
      </>
    ),
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
        Clone the repository, create the D1 database, set two secrets, apply the migrations and run{" "}
        <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">npm run deploy</code>. The{" "}
        <Link to="/install" className="text-accent underline">
          step-by-step guide
        </Link>{" "}
        walks through each one.
      </>
    ),
  },
  {
    q: "Who can sign in?",
    a: "In your own Cloudflare account, only you: OpenPing has one administrator, who signs in with a passkey, GitHub or an email link, and the OpenPing project never sees that install. OpenPing Hosted, when it opens, will have normal accounts with email, Google or GitHub sign-in, kept separate from any install you run yourself.",
  },
  {
    q: "Can I automate it?",
    a: "Yes. A bundled admin CLI and API tokens let you create monitors, manage settings and script your whole setup.",
  },
];

const BACKUP_DOC_URL = `${GITHUB_URL}/blob/main/docs/BACKUP.md`;

/** One of the FAQ answers both states share, by its question. */
function sharedFaq(q: string): FaqItem {
  const item = FAQS.find((f) => f.q === q);
  if (!item) throw new Error(`No FAQ "${q}"`);
  return item;
}

/** The FAQ once Hosted opens: Hosted's questions first, then the ones both paths share. */
const FAQS_OPEN: FaqItem[] = [
  {
    q: "What is OpenPing Hosted?",
    a: (
      <>
        The same OpenPing, run for you by me: ${HOSTED_PRICE_YEARLY} a year for {PLAN.monitors} monitors checked every 12
        minutes, {PLAN.statusPages} status pages and every alert channel, with 1-minute checks for{" "}
        {`$${HOSTED_FAST_CHECKS_YEARLY}`} a year more. Each customer gets their own OpenPing with a database of its own.{" "}
        <TrialLink event="pricing_trial" className="text-accent underline">
          Start a free trial
        </TrialLink>
        , no card needed.
      </>
    ),
  },
  {
    q: "How does the free trial work?",
    a: `For ${HOSTED_TRIAL_DAYS} days you get ${TRIAL.monitors} monitors checked every 12 minutes, ${TRIAL.statusPages} status page and email alerts, with no card. Add a card any time to keep going at $${HOSTED_PRICE_YEARLY} a year. If you don't, checks stop when the trial ends and your data is deleted 30 days later, with an email before each step.`,
  },
  sharedFaq("Is OpenPing really free?"),
  {
    q: "Can I move between Hosted and self-hosted?",
    a: (
      <>
        Yes, both ways, because each install stands alone. Export your data from one and import it into the other: from
        Hosted, deploy OpenPing free to your own Cloudflare and import the file; from your own install, import it into
        your Hosted account, up to its {PLAN.monitors} monitors. Monitors, maintenance windows and incident history come
        across; alert channels, credentials and status pages are set up again, so no secret travels in the file.{" "}
        <a href={BACKUP_DOC_URL} target="_blank" rel="noreferrer" className="text-accent underline">
          How export and import work
        </a>
        .
      </>
    ),
  },
  {
    q: "Where does my data live?",
    a: "Self-hosted, in your own Cloudflare account: monitor settings, check results, incidents and history are stored in your D1 database, and the OpenPing project never sees them. On Hosted, in a database used only by your OpenPing, in my Cloudflare account. I can read it because I run the service, and I only look when you ask for help or to fix the service.",
  },
  {
    q: "How often does it check?",
    a: "Every 12 minutes, each monitor that's due, most overdue first. On Hosted, the 1-minute add-on checks every minute. In your own account, the schedule is one line in wrangler.jsonc if your Cloudflare plan allows more runs.",
  },
  sharedFaq("How do I deploy it?"),
  {
    q: "Who can sign in?",
    a: "In your own Cloudflare account, only you: OpenPing has one administrator, who signs in with a passkey, GitHub or an email link, and the OpenPing project never sees that install. On OpenPing Hosted you have your own account, signed in with an email link or code, a passkey or GitHub, kept separate from any install you run yourself.",
  },
  {
    q: "Where do I get help?",
    a: (
      <>
        On Hosted, email{" "}
        <a href={`mailto:${HOSTED_SUPPORT_EMAIL}`} className="text-accent underline">
          {HOSTED_SUPPORT_EMAIL}
        </a>{" "}
        and you'll hear back from me. Self-hosted, open an{" "}
        <a href={GITHUB_ISSUES_URL} target="_blank" rel="noreferrer" className="text-accent underline">
          issue on GitHub
        </a>
        .
      </>
    ),
  },
  sharedFaq("Can I automate it?"),
];

function FaqSection() {
  const open = useOffer().open;
  return (
    <Section id="faq" className="py-14 sm:py-20">
      <Reveal>
        <SectionHeading eyebrow="FAQ" title="Questions, answered" />
      </Reveal>
      <Reveal delay={100} className="mx-auto mt-10 max-w-3xl">
        <FaqAccordion items={open ? FAQS_OPEN : FAQS} />
      </Reveal>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 12. Closing CTA, with the open-source invitation folded in
 * ------------------------------------------------------------------ */

function BottomCta() {
  const open = useOffer().open;
  return (
    <Section className="py-14 sm:py-24">
      <Reveal>
        <div className="relative overflow-hidden rounded-card border border-line bg-surface px-4 py-12 text-center sm:px-12 sm:py-14">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{ background: "radial-gradient(60% 100% at 50% 0%, rgba(109,139,255,0.20), transparent 70%)" }}
          />
          <h2 className="mx-auto max-w-2xl text-balance text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Own your uptime monitoring
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-base leading-relaxed text-ink-muted">
            {open
              ? `Start a ${HOSTED_TRIAL_DAYS}-day free trial of OpenPing Hosted, or run it free in your own Cloudflare account.`
              : "Run it free in your own Cloudflare account today, or get on the list for the hosted version."}
          </p>
          {open ? (
            <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
              <TrialLink
                event="cta_trial"
                className="op-lift inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-5 text-sm font-semibold text-canvas shadow-lg shadow-accent/20 hover:bg-accent-hover"
              >
                Start a free trial
                <ArrowRight className="size-4" aria-hidden />
              </TrialLink>
              <Link
                to={DEPLOY_PATH}
                onClick={() => track("cta_deploy")}
                className="op-lift inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface-2 px-5 text-sm font-semibold text-ink hover:border-accent/50"
              >
                Deploy free to your Cloudflare
              </Link>
            </div>
          ) : (
          <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <Link
              to={DEPLOY_PATH}
              onClick={() => track("cta_deploy")}
              className="op-lift inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-5 text-sm font-semibold text-canvas shadow-lg shadow-accent/20 hover:bg-accent-hover"
            >
              Deploy free to your Cloudflare
              <ArrowRight className="size-4" aria-hidden />
            </Link>
            <a
              href="#pricing"
              onClick={(e) => {
                e.preventDefault();
                track("cta_waitlist");
                goToWaitlist();
              }}
              className="op-lift inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-5 text-sm font-semibold text-ink hover:border-accent/50"
            >
              Join the Hosted waitlist
            </a>
          </div>
          )}
          <p className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-ink-muted">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-ink">
              <Star className="size-4" aria-hidden />
              Star on GitHub
            </a>
            <a href={GITHUB_ISSUES_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-ink">
              <Bug className="size-4" aria-hidden />
              Found a rough edge? Open an issue
            </a>
          </p>
        </div>
      </Reveal>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 17. Footer
 * ------------------------------------------------------------------ */

const FOOTER_LINKS: { label: string; href?: string; to?: string }[] = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Features", href: "#features" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
  { label: "Install guide", to: "/install" },
  { label: "Live status", to: "/status" },
  { label: "Free tools", to: "/tools" },
];

function Footer({ onSignIn }: { onSignIn: () => void }) {
  const offer = useOffer();
  return (
    <footer className="border-t border-line">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-8 md:flex-row">
          <div>
            <Logo />
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-ink-muted">
              {offer.open
                ? `Uptime monitoring and status pages, free in your own Cloudflare account or hosted for $${HOSTED_PRICE_YEARLY} a year.`
                : "Uptime monitoring and status pages, free in your own Cloudflare account. A hosted version is planned."}
            </p>
          </div>

          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-10 gap-y-3 text-sm text-ink-muted sm:grid-cols-3">
            {FOOTER_LINKS.map((l) =>
              l.to ? (
                <Link key={l.label} to={l.to} className="transition-colors hover:text-ink">
                  {l.label}
                </Link>
              ) : (
                <a key={l.label} href={l.href} className="transition-colors hover:text-ink">
                  {l.label}
                </a>
              ),
            )}
            {offer.open && (
              <a href={offer.signInUrl} className="transition-colors hover:text-ink">
                Hosted log in
              </a>
            )}
            <button type="button" onClick={onSignIn} className="text-left transition-colors hover:text-ink">
              Owner sign-in
            </button>
          </nav>
        </div>

        {/* Support / star / other-projects */}
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
            <Star className="size-4" aria-hidden />
            Star on GitHub
          </a>
          <a
            href={N8BUILDS_URL}
            target="_blank"
            rel="noreferrer"
            className="op-lift inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2"
          >
            <img src="/n8builds-icon.png" alt="" width={18} height={18} className="rounded" />
            More from n8builds
            <ArrowUpRight className="size-4 text-ink-faint" aria-hidden />
          </a>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-line pt-6 text-xs text-ink-faint sm:flex-row sm:items-center">
          <p>MIT licensed. Made by Nathan Watkins (n8builds).</p>
          <p>© {new Date().getFullYear()} OpenPing</p>
        </div>
      </div>
    </footer>
  );
}
