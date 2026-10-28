import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Elevated, bordered surface container with default padding. */
export function Card({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-card border border-line bg-surface p-4", className)}>
      {children}
    </div>
  );
}

/** Optional header row for a Card - title on the left, actions on the right. */
export function CardHeader({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-center justify-between gap-3", className)}>
      {children}
    </div>
  );
}

/**
 * Title text styled for use inside a CardHeader. An h3 by default; pass
 * `as="h2"` for a card that sits right under the page's h1, so headings
 * don't skip a level.
 */
export function CardTitle({
  children,
  className,
  as: Tag = "h3",
}: {
  children?: ReactNode;
  className?: string;
  as?: "h2" | "h3";
}) {
  return <Tag className={cn("text-sm font-semibold tracking-tight text-ink", className)}>{children}</Tag>;
}
