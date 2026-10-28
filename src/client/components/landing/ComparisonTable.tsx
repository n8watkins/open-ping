import { Check, Cloud, Minus, Sparkles, X } from "lucide-react";
import { HOSTED_PLAN_LIMITS, HOSTED_PRICE_YEARLY, HOSTED_TRIAL_DAYS } from "../../../shared/hosted-offer";

/**
 * Truthful feature comparison: self-hosted OpenPing vs a typical hosted uptime
 * SaaS. Every OpenPing claim maps to a real, shipped feature. No ICMP/UDP/DNS/
 * SSL-expiry/multi-region claims (we don't have those yet).
 *
 * Once Hosted opens (`open`), a column for OpenPing Hosted joins them, so a
 * visitor sees both OpenPings against the usual SaaS in one table.
 *
 * Responsive: a real <table> that scrolls horizontally inside its own container
 * on narrow screens (the page never overflows) and a min-width keeps columns
 * legible.
 */

type Cell =
  | { kind: "yes"; note?: string }
  | { kind: "no"; note?: string }
  | { kind: "text"; text: string };

interface Row {
  feature: string;
  unique?: boolean;
  op: Cell;
  /** OpenPing Hosted, shown only once it's open. */
  hosted: Cell;
  saas: Cell;
}

const ROWS: Row[] = [
  {
    feature: "Number of monitors",
    op: { kind: "text", text: "No monitor cap" },
    hosted: { kind: "text", text: `${HOSTED_PLAN_LIMITS.monitors}, one plan, no tiers` },
    saas: { kind: "text", text: "Tiered caps (50 / 100 / 200…)" },
  },
  {
    feature: "Price",
    op: { kind: "text", text: "$0 in your own account, on Cloudflare's free plan" },
    hosted: { kind: "text", text: `$${HOSTED_PRICE_YEARLY} a year, after a ${HOSTED_TRIAL_DAYS}-day free trial` },
    saas: { kind: "text", text: "Monthly subscription, per tier" },
  },
  {
    feature: "Schedule-aware monitoring",
    unique: true,
    op: { kind: "yes" },
    hosted: { kind: "yes" },
    saas: { kind: "no" },
  },
  {
    feature: "HTTP / API + keyword & JSON assertions",
    op: { kind: "yes" },
    hosted: { kind: "yes" },
    saas: { kind: "text", text: "Varies, often higher tiers" },
  },
  {
    feature: "Status pages + embeddable widget",
    op: { kind: "yes" },
    hosted: { kind: "yes", note: `Yes, ${HOSTED_PLAN_LIMITS.statusPages} pages` },
    saas: { kind: "text", text: "Often limited / paid" },
  },
  {
    feature: "Incident history + MTBF / MTTR",
    op: { kind: "yes" },
    hosted: { kind: "yes" },
    saas: { kind: "text", text: "Retention varies by plan" },
  },
  {
    feature: "Email · Discord · Webhook · Web Push alerts",
    op: { kind: "yes" },
    hosted: { kind: "yes" },
    saas: { kind: "text", text: "Some channels gated by plan" },
  },
  {
    feature: "Your data stays in your own account",
    op: { kind: "yes" },
    hosted: { kind: "text", text: "A database for you alone" },
    saas: { kind: "no", note: "Stored on their servers" },
  },
  {
    feature: "No vendor lock-in (MIT, runs in your account)",
    op: { kind: "yes" },
    hosted: { kind: "yes", note: "Yes, export any time" },
    saas: { kind: "no" },
  },
];

function CellView({ cell, positive }: { cell: Cell; positive: boolean }) {
  if (cell.kind === "yes") {
    return (
      <span className="inline-flex items-center gap-2 text-sm font-medium text-up">
        <Check className="size-4 shrink-0" />
        <span>{cell.note ?? "Yes"}</span>
      </span>
    );
  }
  if (cell.kind === "no") {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-ink-faint">
        <X className="size-4 shrink-0 text-down/70" />
        <span>{cell.note ?? "No"}</span>
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-2 text-sm ${
        positive ? "text-ink" : "text-ink-muted"
      }`}
    >
      <Minus className="size-4 shrink-0 text-ink-faint/60" />
      <span>{cell.text}</span>
    </span>
  );
}

export function ComparisonTable({ open = false }: { open?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className={`w-full border-collapse text-left ${open ? "min-w-[52rem]" : "min-w-[40rem]"}`}>
        <thead>
          <tr className="border-b border-line">
            <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Feature
            </th>
            <th className="bg-accent-soft/40 px-5 py-4">
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
                <span className="grid size-6 place-items-center rounded-md bg-accent text-canvas">
                  {open ? <Cloud className="size-3.5" /> : <Sparkles className="size-3.5" />}
                </span>
                OpenPing
                <span className="hidden text-xs font-normal text-ink-muted sm:inline">
                  {open ? "(self-hosted)" : "(your own account)"}
                </span>
              </span>
            </th>
            {open && (
              <th className="bg-accent-soft/25 px-5 py-4">
                <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
                  <span className="grid size-6 place-items-center rounded-md bg-surface-2 text-accent ring-1 ring-line">
                    <Sparkles className="size-3.5" />
                  </span>
                  OpenPing Hosted
                </span>
              </th>
            )}
            <th className="px-5 py-4 text-sm font-semibold text-ink-muted">
              Hosted uptime SaaS
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr
              key={row.feature}
              className="border-b border-line/70 last:border-b-0"
            >
              <th
                scope="row"
                className="px-5 py-3.5 text-sm font-medium text-ink"
              >
                <span className="inline-flex flex-wrap items-center gap-2">
                  {row.feature}
                  {row.unique && (
                    <span className="rounded-full border border-accent/40 bg-accent-soft/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                      Unique
                    </span>
                  )}
                </span>
              </th>
              <td className="bg-accent-soft/20 px-5 py-3.5 align-top">
                <CellView cell={row.op} positive />
              </td>
              {open && (
                <td className="bg-accent-soft/10 px-5 py-3.5 align-top">
                  <CellView cell={row.hosted} positive />
                </td>
              )}
              <td className="px-5 py-3.5 align-top">
                <CellView cell={row.saas} positive={false} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
