/**
 * Billing on app.<domain>: the account page's billing section, /billing and
 * /billing/upgrade. Phone first, in the platform's own components (../ui.ts):
 * one column, full-width 48 px buttons, every choice a plain form post.
 */

import type { PlanId, TenantStatus } from "../../../src/shared/hosted-contract";
import { Html, html, notice, renderPage } from "../ui";
import type { BillingReason } from "./state";

/** What the customer pays, for the pages (Stripe's Prices are what's charged). */
export const PRICE_TEXT = { hosted: "$24 a year", fast: "$12 a year", both: "$36 a year" } as const;

export interface BillingView {
  /** Billing is set up (STRIPE_* present); otherwise paid plans "open soon". */
  available: boolean;
  /** The account has an OpenPing. */
  hasTenant: boolean;
  /** Billing's own state (tenants.status), not the owner's suspension. */
  status: TenantStatus;
  plan: PlanId;
  reason: BillingReason | null;
  trialEndsAt: number | null;
  /** The subscription that decides, if any. */
  subscription: {
    status: string;
    renewsAt: number | null;
    cancelAtPeriodEnd: boolean;
    endedAt: number | null;
    paymentFailedAt: number | null;
    nextPaymentAttempt: number | null;
    /** A change (the add-on) waiting for its invoice to be paid, until Stripe drops it. */
    pending: { until: number; invoiceUrl: string } | null;
  } | null;
  /** A Stripe Customer exists, so the Customer Portal can open. */
  hasCustomer: boolean;
}

export function dateText(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function daysLeft(until: number, now: number): string {
  const days = Math.max(0, Math.ceil((until - now) / 86_400_000));
  return days === 1 ? "1 day left" : `${days} days left`;
}

/** "1-minute" with a non-breaking hyphen, so a narrow screen never splits it across lines. */
const ONE_MINUTE = "1\u2011minute";

function form(action: string, label: string, kind: "primary" | "secondary", fields: Record<string, string> = {}): Html {
  return html`<form method="post" action="${action}">${Object.entries(fields).map(
    ([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`,
  )}<button class="button ${kind}" type="submit">${label}</button></form>`;
}

function subscribeButtons(primary: "hosted" | "hosted_fast" = "hosted"): Html {
  const hosted = form("/billing/checkout", `Subscribe for ${PRICE_TEXT.hosted}`, primary === "hosted" ? "primary" : "secondary", { plan: "hosted" });
  // The price never splits, so a narrow phone wraps the label after the colon.
  const fast = form("/billing/checkout", `${ONE_MINUTE} checks: ${PRICE_TEXT.both.replace(/ /g, "\u00a0")}`, primary === "hosted_fast" ? "primary" : "secondary", { plan: "hosted_fast" });
  return html`<div class="stack">${primary === "hosted" ? [hosted, fast] : [fast, hosted]}</div>
<p class="hint">Plus tax where it applies. Paid securely with Stripe; cancel any time.</p>`;
}

const manage = (label = "Manage billing", kind: "primary" | "secondary" = "secondary") => form("/billing/portal", label, kind);

const PLAN_LINE: Record<PlanId, string> = {
  trial: "Free trial: 5 monitors, 1 status page, email alerts, checks every 12 minutes.",
  hosted: "Hosted, yearly: 20 monitors, 2 status pages, every alert channel, checks every 12 minutes.",
  hosted_fast: `Hosted with ${ONE_MINUTE} checks: 20 monitors, 2 status pages, every alert channel, checks every minute.`,
};

/**
 * The billing section: what the customer has, what happens next, and the one
 * or two things they can do about it. `focus` "upgrade" leads with the next
 * plan up (the tenant's 402 answers link there).
 */
export function billingSection(view: BillingView, now: number, focus: "billing" | "upgrade" = "billing", level: 1 | 2 = 2): Html {
  const h = (text: string) => (level === 1 ? html`<h1>${text}</h1>` : html`<h2>${text}</h2>`);
  // The badge leads the billing page; the account page has the tenant's own just above.
  const badge = (label: string, tone?: string) =>
    level === 1 ? html`<p class="badge"${tone ? new Html(` style="--tone: var(${tone})"`) : ""}>${label}</p>` : "";
  if (!view.available) {
    return html`${h("Billing")}<p>Paid plans open soon: ${PRICE_TEXT.hosted}, and ${PRICE_TEXT.fast} more for 1-minute checks. Your trial keeps running until then.</p>`;
  }
  if (!view.hasTenant) {
    return html`${h("Billing")}<p>Create your OpenPing first; its 14-day trial needs no card.</p>`;
  }
  const sub = view.subscription;
  const renews = sub?.renewsAt ? dateText(sub.renewsAt) : null;

  if (view.status === "trial") {
    return html`${badge(view.trialEndsAt ? `Trial, ${daysLeft(view.trialEndsAt, now)}` : "Trial")}
${h(focus === "upgrade" ? "Choose your plan" : "Billing")}
<p>${PLAN_LINE.trial}${view.trialEndsAt && level === 1 ? ` It ends on ${dateText(view.trialEndsAt)}.` : ""}</p>
<p>Subscribe for 20 monitors, 2 status pages and every alert channel. Add ${ONE_MINUTE} checks for ${PRICE_TEXT.fast} more.</p>
${subscribeButtons(focus === "upgrade" ? "hosted_fast" : "hosted")}`;
  }

  if (view.status === "suspended") {
    if (view.reason === "trial_ended" || view.reason === "canceled" || !sub) {
      const why =
        view.reason === "canceled"
          ? `Your subscription ended${sub?.endedAt ? ` on ${dateText(sub.endedAt)}` : ""}.`
          : `Your free trial ended${view.trialEndsAt ? ` on ${dateText(view.trialEndsAt)}` : ""}.`;
      return html`${badge("Paused", "--suspended")}
${h("Billing")}
<p>${why} Your OpenPing's checks are paused and its status page is offline. Your monitors and history are kept for 30 days.</p>
<p>Subscribe to turn it back on right away.</p>
${subscribeButtons(focus === "upgrade" ? "hosted_fast" : "hosted")}
${view.hasCustomer ? html`<div class="stack spaced">${manage("Past invoices")}</div>` : ""}`;
    }
    return html`${badge("Paused", "--suspended")}
${h("Billing")}
<p>${view.reason === "paused" ? "Your subscription is paused." : "Your payments didn't go through after several tries."} Your OpenPing's checks are paused and its status page is offline. Your monitors and history are kept for 30 days.</p>
<div class="stack">${manage(view.reason === "paused" ? "Resume in billing" : "Pay and turn it back on", "primary")}</div>`;
  }

  const fast = view.plan === "hosted_fast";
  const pastDue = view.status === "past_due";
  const lines: (Html | string)[] = [];
  if (pastDue) {
    lines.push(
      notice(
        sub?.nextPaymentAttempt
          ? `Your last payment didn't go through. Stripe tries again on ${dateText(sub.nextPaymentAttempt)}; your checks keep running until then.`
          : "Your last payment didn't go through. Update your card to keep your checks running.",
        "error",
      ),
    );
  }
  const renewal = sub?.cancelAtPeriodEnd
    ? renews
      ? `Ends on ${renews}; it won't renew.`
      : "It won't renew."
    : renews
      ? `Renews on ${renews} for ${fast ? PRICE_TEXT.both : PRICE_TEXT.hosted}.`
      : "";
  if (sub?.pending && !fast) {
    lines.push(
      html`<div class="offer lead-offer"><h3>${ONE_MINUTE} checks are waiting on a payment</h3>
<p>The payment for them didn't go through, so they weren't added. Pay the invoice by ${dateText(sub.pending.until)} to add them; nothing changes until then.</p>
<div class="stack"><a class="button primary" href="${sub.pending.invoiceUrl}" rel="noreferrer">Pay the invoice</a></div></div>`,
    );
  }
  const upgrade =
    !fast && !pastDue && !sub?.pending
      ? html`<div class="offer${focus === "upgrade" ? " lead-offer" : ""}"><h3>${ONE_MINUTE} checks</h3>
<p>Check every monitor as often as once a minute, for ${PRICE_TEXT.fast} more. You pay for the rest of this year now, then it renews with your plan.</p>
${form("/billing/add-fast", `Add for ${PRICE_TEXT.fast}`, focus === "upgrade" ? "primary" : "secondary")}</div>`
      : "";
  const upgradeNote =
    focus === "upgrade" && fast
      ? html`<p>You have the fastest checks Hosted offers. Every plan holds 20 monitors and 2 status pages; write to support if you need more.</p>`
      : "";
  return html`${pastDue ? badge("Payment due", "--degraded") : badge("Active", "--up")}
${h(focus === "upgrade" && !fast && !pastDue ? "Upgrade" : "Billing")}
${lines}
<p>${PLAN_LINE[view.plan]} ${renewal}</p>
${upgradeNote}
${upgrade}
<div class="stack spaced">${manage(pastDue ? "Update payment method" : "Manage billing", pastDue ? "primary" : "secondary")}</div>
<p class="hint">Change your card, download invoices or cancel in Stripe's billing page.</p>`;
}

/** Extra styles for the billing pieces. */
export const BILLING_STYLE = `
.offer { border: 1px solid var(--line); border-radius: 0.75rem; padding: 16px; background: var(--surface-2); margin: 16px 0 0; }
.offer h3 { font-size: 0.9375rem; font-weight: 650; margin: 0 0 4px; color: var(--ink); }
.offer p { font-size: 0.9375rem; }
.offer.lead-offer { border-color: var(--accent); }
.offer + p { margin-top: 16px; }
.stack.spaced { margin-top: 16px; }
.stack form + form { margin-top: 12px; }
`;

export function billingPage(input: { view: BillingView; now: number; focus: "billing" | "upgrade"; flash?: { message: string; tone: "ok" | "error" } | null; status?: number }): Response {
  return renderPage({
    title: input.focus === "upgrade" ? "Upgrade" : "Billing",
    status: input.status,
    homeHref: "/account",
    style: BILLING_STYLE,
    main: html`${input.flash ? notice(input.flash.message, input.flash.tone) : ""}
${billingSection(input.view, input.now, input.focus, 1)}
<p class="switch"><a href="/account">Back to your account</a></p>`,
  });
}
