import type { ReactNode } from "react";
import { Logo } from "./Logo";

/** The not-found and error pages: the logo, a heading, one sentence and the ways out. */
export function EdgePage({
  label,
  title,
  children,
  actions,
}: {
  label: string;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="grid min-h-full place-items-center px-4 py-16">
      <main className="w-full max-w-md text-center">
        <a href="/" className="inline-flex rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
          <Logo />
        </a>
        <p className="mt-10 text-xs font-semibold uppercase tracking-[0.18em] text-accent">{label}</p>
        <h1 className="mt-2 text-balance text-3xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-3 text-pretty text-sm text-ink-muted">{children}</p>
        <div className="mx-auto mt-8 flex max-w-xs flex-col gap-3 sm:max-w-none sm:flex-row sm:justify-center">{actions}</div>
      </main>
    </div>
  );
}

export const primaryAction =
  "inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
export const secondaryAction =
  "inline-flex items-center justify-center rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
