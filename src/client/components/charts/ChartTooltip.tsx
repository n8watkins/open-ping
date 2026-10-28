import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * The floating readout shared by the strips and charts. Positioned above its
 * anchor at `x` (px inside a `relative` parent of `width` px); near either edge
 * it anchors to that side so it never spills out of the card.
 */
export function ChartTooltip({
  x,
  width,
  children,
  className,
}: {
  x: number;
  width: number;
  children: ReactNode;
  className?: string;
}) {
  const align = x < width * 0.22 ? "left" : x > width * 0.78 ? "right" : "center";
  return (
    <div
      role="presentation"
      className={cn(
        "pointer-events-none absolute bottom-full z-20 mb-2 w-max max-w-[16rem] animate-fade rounded-lg border border-line bg-canvas/95 px-3 py-2 text-xs text-ink-muted shadow-xl shadow-black/40 backdrop-blur-sm",
        className,
      )}
      style={{
        left: align === "left" ? Math.max(0, x - 12) : align === "right" ? undefined : x,
        right: align === "right" ? Math.max(0, width - x - 12) : undefined,
        transform: align === "center" ? "translateX(-50%)" : undefined,
      }}
    >
      {children}
    </div>
  );
}
