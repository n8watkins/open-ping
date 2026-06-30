import { CheckCircle2 } from "lucide-react";
import { UptimeBar } from "../ui/UptimeBar";
import type { MonitorState } from "../../../shared/states";

/*
 * Illustrative public-status-page mockup, built from OpenPing's own tokens.
 * Not a real status page and not a copied screenshot — a faithful preview of
 * the bundled status page so visitors see what they get.
 */

function strip(faults: number[] = []): { state: MonitorState }[] {
  return Array.from({ length: 40 }, (_, i) => ({
    state: (faults.includes(i) ? "down" : "up") as MonitorState,
  }));
}

const SERVICES: { name: string; uptime: string; segments: { state: MonitorState }[] }[] = [
  { name: "Website", uptime: "100%", segments: strip() },
  { name: "API", uptime: "99.98%", segments: strip([22]) },
  { name: "Dashboard", uptime: "99.95%", segments: strip([12, 13]) },
  { name: "Webhooks", uptime: "100%", segments: strip() },
];

export function StatusMockup() {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface shadow-2xl shadow-black/40">
      <div className="border-b border-line bg-surface-2/60 px-5 py-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold tracking-tight text-ink">
            Acme — Status
          </span>
          <span className="text-[11px] text-ink-faint">status.acme.dev</span>
        </div>
      </div>

      <div className="p-5">
        {/* Overall banner */}
        <div className="flex items-center gap-3 rounded-card border border-up/30 bg-up/5 p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-up/15 text-up">
            <CheckCircle2 className="size-5" />
          </span>
          <div>
            <div className="text-base font-semibold tracking-tight text-ink">
              All systems operational
            </div>
            <div className="text-xs text-ink-muted">Updated 1 minute ago</div>
          </div>
        </div>

        {/* Services */}
        <div className="mt-4 divide-y divide-line rounded-card border border-line">
          {SERVICES.map((s) => (
            <div key={s.name} className="px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ink">{s.name}</span>
                <span className="text-xs text-ink-muted">{s.uptime} uptime</span>
              </div>
              <div className="mt-2.5">
                <UptimeBar segments={s.segments} />
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between text-[11px] text-ink-faint">
          <span>90 days ago</span>
          <span>Today</span>
        </div>
      </div>
    </div>
  );
}
