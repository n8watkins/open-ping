import { BatteryFull, Bell, Signal, Wifi } from "lucide-react";
import { Logo } from "../Logo";
import { StatusPill } from "../ui/StatusPill";
import type { MonitorState } from "../../../shared/states";

/**
 * Original CSS phone-device frame (rounded bezel, notch, status bar) showing a
 * push notification + a compact status view. Built entirely from OpenPing tokens
 * and UI primitives — no third-party device art or screenshots. The incoming
 * push slides in via a scoped keyframe that is disabled under reduced motion.
 */

const COMPACT: { name: string; state: MonitorState; meta: string }[] = [
  { name: "api.acme.dev", state: "up", meta: "118 ms" },
  { name: "checkout-service", state: "degraded", meta: "410 ms" },
  { name: "staging.acme.dev", state: "scheduled_off", meta: "off-hours" },
];

const DOT: Record<string, string> = {
  up: "bg-up",
  degraded: "bg-degraded",
  scheduled_off: "bg-scheduled",
};

export function PhoneMockup() {
  return (
    <div className="relative">
      <style>{`
        @keyframes op-push-in {
          0% { opacity: 0; transform: translateY(-14px) scale(0.96) }
          12% { opacity: 1; transform: translateY(0) scale(1) }
          88% { opacity: 1; transform: translateY(0) scale(1) }
          100% { opacity: 1; transform: translateY(0) scale(1) }
        }
        .op-push { animation: op-push-in 5.5s ease-out 0.4s both }
        @media (prefers-reduced-motion: reduce) {
          .op-push { animation: none !important }
        }
      `}</style>

      {/* Soft glow behind the device */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-6 -z-10 rounded-[3rem] opacity-60 blur-2xl"
        style={{
          background:
            "radial-gradient(50% 50% at 50% 40%, rgba(109,139,255,0.20), transparent 70%)",
        }}
      />

      {/* Device bezel */}
      <div className="mx-auto w-[16rem] max-w-full rounded-[2.5rem] border border-line bg-surface-2 p-2.5 shadow-2xl shadow-black/50">
        {/* Screen */}
        <div className="relative overflow-hidden rounded-[2rem] border border-line bg-canvas">
          {/* Notch */}
          <div className="pointer-events-none absolute left-1/2 top-0 z-10 h-5 w-28 -translate-x-1/2 rounded-b-2xl bg-surface-2" />

          {/* Status bar */}
          <div className="flex items-center justify-between px-5 pb-2 pt-2.5 text-[10px] font-medium text-ink-muted">
            <span>9:41</span>
            <span className="flex items-center gap-1">
              <Signal className="size-3" />
              <Wifi className="size-3" />
              <BatteryFull className="size-3.5" />
            </span>
          </div>

          <div className="px-3 pb-5 pt-1">
            {/* Incoming push notification */}
            <div className="op-push flex items-start gap-2.5 rounded-2xl border border-line bg-surface/95 p-3 shadow-lg shadow-black/30 backdrop-blur">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft">
                <Bell className="size-4 text-accent" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2 text-[10px] text-ink-faint">
                  <span className="font-semibold uppercase tracking-wide">
                    OpenPing
                  </span>
                  <span>now</span>
                </div>
                <p className="mt-0.5 text-xs font-medium text-ink">
                  checkout-service is degraded
                </p>
                <p className="text-[11px] text-ink-muted">
                  Response time 410 ms · threshold 300 ms
                </p>
              </div>
            </div>

            {/* Compact status view */}
            <div className="mt-3 rounded-2xl border border-line bg-surface/70 p-3">
              <div className="flex items-center justify-between">
                <Logo compact />
                <StatusPill state="degraded" />
              </div>

              <div className="mt-3 space-y-2">
                {COMPACT.map((m) => (
                  <div
                    key={m.name}
                    className="flex items-center justify-between rounded-lg border border-line bg-surface-2/50 px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${DOT[m.state] ?? "bg-paused"}`}
                      />
                      <span className="truncate text-xs font-medium text-ink">
                        {m.name}
                      </span>
                    </div>
                    <span className="shrink-0 text-[10px] text-ink-faint">
                      {m.meta}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
                {[
                  { k: "Up", v: "12", c: "text-up" },
                  { k: "Degraded", v: "1", c: "text-degraded" },
                  { k: "Off", v: "2", c: "text-scheduled" },
                ].map((s) => (
                  <div
                    key={s.k}
                    className="rounded-lg border border-line bg-surface-2/40 py-1.5"
                  >
                    <div className={`text-sm font-semibold ${s.c}`}>{s.v}</div>
                    <div className="text-[9px] uppercase tracking-wide text-ink-faint">
                      {s.k}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
