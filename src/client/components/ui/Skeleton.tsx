import { cn } from "../../lib/cn";

/** A loading placeholder block with the shared shimmer (`.skeleton` in index.css). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("skeleton", className)} />;
}
