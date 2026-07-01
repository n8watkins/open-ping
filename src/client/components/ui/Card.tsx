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

/** Optional header row for a Card — title on the left, actions on the right. */
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

/** Title text styled for use inside a CardHeader. */
export function CardTitle({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <h3 className={cn("text-sm font-semibold tracking-tight text-ink", className)}>
      {children}
    </h3>
  );
}
