import { cn } from "../lib/cn";

/** OpenPing wordmark + concentric "ping" glyph. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative grid size-8 place-items-center rounded-lg bg-accent-soft">
        <span className="size-2 rounded-full bg-accent" />
        <span className="absolute size-4 rounded-full border border-accent/50" />
        <span className="absolute size-6 rounded-full border border-accent/20" />
      </span>
      {!compact && (
        <span className="text-base font-semibold tracking-tight text-ink">
          Open<span className="text-accent">Ping</span>
        </span>
      )}
      {compact && (
        <span className={cn("text-base font-semibold tracking-tight text-ink")}>
          Open<span className="text-accent">Ping</span>
        </span>
      )}
    </div>
  );
}
