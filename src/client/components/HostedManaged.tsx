import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, Cloud } from "lucide-react";
import { Logo } from "./Logo";
import { Card, CardHeader, CardTitle } from "./ui/Card";
import type { HostedAccount } from "../lib/bootstrap";

/**
 * What an OpenPing on OpenPing Hosted shows where a self-hosted install has
 * something the platform now does instead (docs/hosted/CONTRACT.md, section 2):
 * the setup wizard, SETUP_TOKEN recovery, and parts of Settings.
 */

const primaryLink =
  "flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 text-sm font-semibold text-canvas transition-opacity hover:opacity-90";

/** A full page in place of /setup or /recover. */
export function HostedManagedScreen({
  title,
  children,
  action,
  back,
}: {
  title: string;
  children: ReactNode;
  /** The main way on: a platform URL (`href`) or a route in this app (`to`). */
  action: { label: string; href?: string; to?: string };
  back?: { label: string; to: string };
}) {
  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <main className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-card border border-line bg-surface p-6 text-center">
          <span className="mx-auto grid size-11 place-items-center rounded-full bg-accent-soft text-accent">
            <Cloud className="size-5" aria-hidden />
          </span>
          <p className="mt-4 text-xs font-semibold tracking-wide text-ink-faint uppercase">Managed by OpenPing Hosted</p>
          <h1 className="mt-1.5 text-lg font-semibold tracking-tight text-balance text-ink">{title}</h1>
          <div className="mt-3 space-y-2 text-sm leading-relaxed text-ink-muted">{children}</div>
          <div className="mt-6">
            {action.to ? (
              <Link to={action.to} className={primaryLink}>
                {action.label}
              </Link>
            ) : (
              <a href={action.href} className={primaryLink}>
                {action.label}
              </a>
            )}
          </div>
        </div>
        {back && (
          <p className="mt-6 text-center">
            <Link to={back.to} className="inline-flex min-h-11 items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
              <ArrowLeft className="size-4" aria-hidden />
              {back.label}
            </Link>
          </p>
        )}
      </main>
    </div>
  );
}

const PLAN_LABEL: Record<HostedAccount["plan"], string> = {
  trial: "Free trial",
  hosted: "OpenPing Hosted",
  hosted_fast: "OpenPing Hosted with 1-minute checks",
};

function planLine(account: HostedAccount): string {
  if (account.status === "trial" && account.trialEndsAt) {
    const ends = new Date(account.trialEndsAt).toLocaleDateString(undefined, { dateStyle: "medium" });
    return `${PLAN_LABEL[account.plan]}, until ${ends}`;
  }
  if (account.status === "past_due") return `${PLAN_LABEL[account.plan]}, payment due`;
  return PLAN_LABEL[account.plan];
}

const outlineLink =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 text-sm font-medium text-ink transition-colors duration-150 hover:bg-surface-2";

/** Settings: this OpenPing runs on OpenPing Hosted, with the account and billing links. */
export function HostedManagedCard({ account }: { account: HostedAccount }) {
  // The one thing to do next, when there is one: pay, or move off the trial.
  const next =
    account.status === "past_due"
      ? { label: "Update payment", href: account.billingUrl }
      : account.status === "trial"
        ? { label: "Upgrade", href: account.upgradeUrl }
        : null;
  return (
    <Card className="p-5">
      <CardHeader>
        <CardTitle>Managed by OpenPing Hosted</CardTitle>
      </CardHeader>
      <p className="-mt-1 text-sm leading-relaxed text-ink-muted">
        OpenPing Hosted runs this OpenPing for you: its address, sign-in, email delivery, encryption keys and updates.
        Your account and billing live there.
      </p>
      <div className="mt-4 rounded-lg border border-line bg-surface-2/40 px-3 py-2">
        <div className="text-xs text-ink-faint">Plan</div>
        <div className="mt-0.5 text-sm font-medium text-ink">{planLine(account)}</div>
      </div>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {next && (
          <a
            href={next.href}
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-medium text-canvas transition-colors duration-150 hover:bg-accent-hover"
          >
            {next.label}
            <ArrowUpRight className="size-4" aria-hidden />
          </a>
        )}
        <a href={account.accountUrl} className={outlineLink}>
          Account
          <ArrowUpRight className="size-4 text-ink-faint" aria-hidden />
        </a>
        <a href={account.billingUrl} className={outlineLink}>
          Billing
          <ArrowUpRight className="size-4 text-ink-faint" aria-hidden />
        </a>
      </div>
    </Card>
  );
}
