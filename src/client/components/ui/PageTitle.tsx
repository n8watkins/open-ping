import type { ReactNode } from "react";

/**
 * Every app page's heading, in one style: the landing's weight and size, with
 * the brand's accent full stop, and an optional line under it.
 */
export function PageTitle({ children, description }: { children: ReactNode; description?: ReactNode }) {
  return (
    <div className="min-w-0">
      <h1 className="text-2xl font-semibold tracking-tight">
        {children}
        <span className="text-accent">.</span>
      </h1>
      {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
    </div>
  );
}
