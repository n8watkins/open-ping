import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Github } from "lucide-react";
import { Logo } from "../../components/Logo";
import { TOOLS, ToolCTA } from "./ToolLayout";

const GITHUB_URL = "https://github.com/n8watkins/open-ping";

/** Public index of OpenPing's free, client-side utility tools (/tools). */
export default function ToolsIndex() {
  useEffect(() => {
    document.title = "Free tools — OpenPing";
  }, []);

  return (
    <div className="flex min-h-full flex-col bg-canvas text-ink">
      <header className="sticky top-0 z-30 border-b border-line/80 bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
          <Link to="/" aria-label="OpenPing home">
            <Logo />
          </Link>
          <nav className="flex items-center gap-2 text-sm">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden items-center gap-1.5 rounded-lg px-3 py-2 font-medium text-ink-muted transition-colors hover:text-ink sm:inline-flex"
            >
              <Github className="size-4" />
              GitHub
            </a>
            <Link
              to="/login"
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 font-semibold text-canvas transition-colors hover:bg-accent-hover"
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-12 sm:px-6 sm:py-16">
        <div className="max-w-2xl">
          <div className="mb-3 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-accent">
            Free · No sign-up · Runs in your browser
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Free tools<span className="text-accent">.</span>
          </h1>
          <p className="mt-4 text-base leading-relaxed text-ink-muted sm:text-lg">
            A handful of fast, no-nonsense utilities for people who keep things
            online. Everything runs entirely in your browser — nothing is sent to
            a server.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TOOLS.map(({ slug, title, tagline, icon: Icon }) => (
            <Link
              key={slug}
              to={`/tools/${slug}`}
              className="group flex flex-col rounded-card border border-line bg-surface p-5 transition-colors hover:border-accent/40 hover:bg-surface-2"
            >
              <span className="grid size-10 place-items-center rounded-lg bg-accent-soft text-accent">
                <Icon className="size-5" />
              </span>
              <h2 className="mt-4 flex items-center gap-1.5 text-base font-semibold text-ink">
                {title}
                <ArrowRight className="size-4 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{tagline}</p>
            </Link>
          ))}
        </div>

        <ToolCTA />
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-5xl flex-col items-start justify-between gap-4 px-4 py-10 sm:flex-row sm:items-center sm:px-6">
          <Logo compact />
          <p className="text-xs text-ink-faint">
            MIT licensed · Self-hosted on your own Cloudflare account.
          </p>
        </div>
      </footer>
    </div>
  );
}
