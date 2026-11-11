import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * A monitor's site icon, served by OpenPing itself (the Worker keeps it, so the
 * browser never asks the monitored site or a third party). `iconAt` is when it
 * was fetched and busts the browser's cache; without one, or if the image fails
 * to load, `fallback` (the state avatar) shows instead.
 */
export function SiteIcon({
  monitorId,
  iconAt,
  size = "size-7",
  dot,
  fallback,
}: {
  monitorId: string;
  iconAt: number | null | undefined;
  size?: string;
  /** A small state-coloured dot on the corner, so the icon still says up or down. */
  dot?: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (iconAt == null || failed) return <>{fallback}</>;
  return (
    <span aria-hidden className={cn("relative grid shrink-0 place-items-center rounded-md bg-surface-2", size)}>
      <img
        src={`/api/monitors/${encodeURIComponent(monitorId)}/icon?v=${iconAt}`}
        alt=""
        width={20}
        height={20}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="size-5 rounded-[3px] object-contain"
      />
      {dot && <span className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface", dot)} />}
    </span>
  );
}
