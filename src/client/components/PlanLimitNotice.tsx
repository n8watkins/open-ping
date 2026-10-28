import { ArrowUpRight, Gauge } from "lucide-react";
import type { PlanLimitBody } from "../../shared/hosted-contract";
import { planLimitMessage, planLimitTitle } from "../lib/plan-limits";
import { cn } from "../lib/cn";

/**
 * A plan limit, said plainly with the way out: the server's one-sentence
 * message (or the same sentence worked out before a form is filled in) and an
 * Upgrade button to the platform. Hosted mode only; a self-hosted install
 * never has one to show.
 */
export function PlanLimitNotice({
  limit,
  className,
  id,
}: {
  limit: PlanLimitBody;
  className?: string;
  id?: string;
}) {
  return (
    <div
      id={id}
      role="status"
      className={cn(
        "flex flex-col gap-3 rounded-card border border-accent/30 bg-accent-soft/50 p-4 sm:flex-row sm:items-center sm:gap-4",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
          <Gauge className="size-4.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{planLimitTitle(limit)}</p>
          <p className="mt-0.5 text-sm leading-relaxed text-pretty text-ink-muted">{planLimitMessage(limit)}</p>
        </div>
      </div>
      <a
        href={limit.upgradeUrl}
        className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-medium text-canvas transition-colors duration-150 hover:bg-accent-hover"
      >
        Upgrade
        <ArrowUpRight className="size-4" aria-hidden />
      </a>
    </div>
  );
}
