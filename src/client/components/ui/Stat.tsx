import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Label + large value block, used to build metric grids. */
export function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: ReactNode;
  valueClass?: string;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-ink-muted">{label}</div>
      <div className={cn("mt-2 whitespace-nowrap text-xl font-semibold tabular-nums text-ink sm:text-2xl", valueClass)}>
        {value}
      </div>
    </div>
  );
}
