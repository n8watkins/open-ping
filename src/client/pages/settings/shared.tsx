import type { ButtonHTMLAttributes, ReactNode } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";

/** GET /api/settings: the non-secret settings (routes/settings.ts). */
export interface AppSettings {
  timezone?: string | null;
  app_url?: string | null;
  email_from?: string | null;
  [key: string]: unknown;
}
export interface SettingsResponse {
  settings: AppSettings;
}

export function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const d = e.data as { error?: string; message?: string; issues?: Array<{ message?: string }> } | null;
    const issue = d?.issues?.find((i) => typeof i.message === "string")?.message;
    if (issue) return issue;
    if (d && typeof d.message === "string") return d.message;
    if (d && typeof d.error === "string") return d.error;
  }
  return e instanceof Error ? e.message : fallback;
}

export function fmt(n: number | undefined): string {
  return (n ?? 0).toLocaleString();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Placeholder rows while a card loads, shaped roughly like what arrives. */
export function SectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 py-1" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-9" style={{ opacity: 1 - i * 0.18 }} />
      ))}
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
      {children}
    </p>
  );
}

export function KeyVal({ label, value, valueClass }: { label: string; value: ReactNode; valueClass?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-2/40 px-3 py-2">
      <div className="truncate text-xs text-ink-faint">{label}</div>
      <div className={cn("mt-0.5 truncate text-sm font-medium tabular-nums text-ink", valueClass)}>{value}</div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs leading-relaxed text-ink-faint">{hint}</span>}
    </label>
  );
}

/** A small rounded status chip for a card header. */
export function Chip({ tone, children }: { tone: "up" | "down" | "degraded" | "neutral"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        tone === "up" && "border-up/40 bg-up/10 text-up",
        tone === "down" && "border-down/40 bg-down/10 text-down",
        tone === "degraded" && "border-degraded/40 bg-degraded/10 text-degraded",
        tone === "neutral" && "border-line bg-surface-2 text-ink-muted",
      )}
    >
      {children}
    </span>
  );
}

/** The primary button with an optional spinner. */
export function PrimaryButton({
  children,
  busy,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors duration-150 hover:bg-accent-hover disabled:opacity-60",
        className,
      )}
    >
      {busy && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function SecondaryButton({ children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-60",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** "Saved" next to a save button, easing in. */
export function SavedNote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span role="status" className="inline-flex animate-fade items-center gap-1.5 text-sm text-up">
      <CheckCircle2 className="size-4" />
      Saved
    </span>
  );
}
