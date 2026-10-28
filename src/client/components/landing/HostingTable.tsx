import { Cloud, Sparkles } from "lucide-react";

/**
 * Self-host vs OpenPing Hosted, row by row (docs/LANDING_AND_LOGIN_PLAN.md,
 * section 1, and docs/HOSTED_PLAN.md for the Hosted numbers). Hosted isn't
 * open yet, so its column describes the plan, and the heading says so.
 *
 * A real table from md up; on phones the same rows as a stacked list, since
 * three columns of sentences don't fit 360 px. Only one of the two is ever
 * displayed, so assistive tech reads the content once.
 */

interface Row {
  label: string;
  own: string;
  hosted: string;
}

const ROWS: Row[] = [
  {
    label: "Price",
    own: "Free on Cloudflare's free plan; Workers Paid is $5 a month if you outgrow it",
    hosted: "$24 a year; 1-minute checks $12 a year more",
  },
  {
    label: "Set-up",
    own: "About 20 minutes: a Cloudflare account, a terminal and a few commands",
    hosted: "About a minute: sign in and add a site",
  },
  {
    label: "Monitors",
    own: "No cap of its own; about 24 at once on the free plan, up to 200 a run on Workers Paid",
    hosted: "20",
  },
  {
    label: "Checks",
    own: "Every 12 minutes by default; you can change it",
    hosted: "Every 12 minutes, or every minute with the add-on",
  },
  { label: "Status pages", own: "As many as you like", hosted: "2" },
  {
    label: "Where your data lives",
    own: "Your D1 database, in your Cloudflare account",
    hosted: "A database for you alone, in my Cloudflare account",
  },
  {
    label: "Who can see it",
    own: "Only you",
    hosted: "You, and me only to keep the service running or when you ask for help",
  },
  { label: "Updates", own: "You pull and redeploy", hosted: "Automatic" },
  { label: "Help", own: "GitHub issues", hosted: "Email support" },
  {
    label: "Leaving",
    own: "It's already yours",
    hosted: "Export everything, or move to your own Cloudflare in one import",
  },
  {
    label: "Sign-in",
    own: "GitHub or an email link, for you as the only admin",
    hosted: "Email, Google or GitHub",
  },
];

function OwnHeading() {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent text-canvas">
        <Cloud className="size-3.5" aria-hidden />
      </span>
      In your own Cloudflare
    </span>
  );
}

function HostedHeading() {
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-surface-2 text-accent ring-1 ring-line">
        <Sparkles className="size-3.5" aria-hidden />
      </span>
      OpenPing Hosted
      <span className="text-xs font-normal text-ink-muted">(planned)</span>
    </span>
  );
}

export function HostingTable() {
  return (
    <div>
      <div className="hidden overflow-hidden rounded-card border border-line bg-surface md:block">
      <table className="w-full table-fixed border-collapse text-left">
        <caption className="sr-only">Running OpenPing in your own Cloudflare account compared with OpenPing Hosted</caption>
        <colgroup>
          <col className="w-[22%]" />
          <col className="w-[39%]" />
          <col className="w-[39%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              <span className="sr-only">Compare</span>
            </th>
            <th scope="col" className="bg-accent-soft/40 px-5 py-4">
              <OwnHeading />
            </th>
            <th scope="col" className="px-5 py-4">
              <HostedHeading />
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label} className="border-b border-line/70 last:border-b-0">
              <th scope="row" className="px-5 py-3.5 align-top text-sm font-medium text-ink">
                {row.label}
              </th>
              <td className="bg-accent-soft/20 px-5 py-3.5 align-top text-sm leading-relaxed text-ink">{row.own}</td>
              <td className="px-5 py-3.5 align-top text-sm leading-relaxed text-ink-muted">{row.hosted}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface md:hidden">
        <p className="sr-only">Running OpenPing in your own Cloudflare account compared with OpenPing Hosted.</p>
        <div aria-hidden="true" className="grid grid-cols-2 border-b border-line text-xs font-semibold">
          <span className="bg-accent-soft/40 px-3 py-2.5 text-accent">Your own Cloudflare</span>
          <span className="px-3 py-2.5 text-ink-muted">Hosted (planned)</span>
        </div>
        <ul className="divide-y divide-line">
          {ROWS.map((row) => (
            <li key={row.label}>
              <p className="px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">{row.label}</p>
              <dl className="grid grid-cols-2 text-[0.8125rem] leading-snug">
                <div className="px-3 pt-1.5 pb-3">
                  <dt className="sr-only">In your own Cloudflare</dt>
                  <dd className="text-ink">{row.own}</dd>
                </div>
                <div className="border-l border-line/70 px-3 pt-1.5 pb-3">
                  <dt className="sr-only">OpenPing Hosted</dt>
                  <dd className="text-ink-muted">{row.hosted}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
