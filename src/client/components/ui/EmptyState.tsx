import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Centered dashed-border placeholder for empty collections. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-line bg-surface/40 px-6 py-16 text-center",
        className,
      )}
    >
      {icon && (
        <span className="grid size-12 place-items-center rounded-full bg-accent-soft text-accent">
          {icon}
        </span>
      )}
      <h2 className="text-base font-medium text-ink">{title}</h2>
      {description && <p className="max-w-sm text-sm text-ink-muted">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
