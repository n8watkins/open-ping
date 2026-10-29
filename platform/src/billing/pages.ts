/**
 * Billing on app.<domain>: the account page's billing section, /billing and
 * /billing/upgrade. Phone first, in the platform's own components (../ui.ts):
 * one column, full-width 48 px buttons, every choice a plain form post.
 *
 * What is sold (decision D13): the yearly plan, the fast checks add-on, and
 * packs of more monitors and more fast monitors. Prices and sizes come from
 * the shared constants (src/shared/hosted-offer.ts and the contract's PACKS),
 * the same ones the landing page shows; Stripe's Prices are what is charged.
 */

import {
  PACKS,
  type LimitKind,
  type PackKind,
  type PackQuantities,
  type PlanId,
  type PlanLimits,
  type TenantStatus,
} from "../../../src/shared/hosted-contract";
import {
  HOSTED_FAST_CHECKS_YEARLY,
  HOSTED_FAST_LIMITS,
  HOSTED_FAST_PACK_YEARLY,
  HOSTED_MONITOR_PACK_YEARLY,
  HOSTED_PLAN_LIMITS,
  HOSTED_PRICE_YEARLY,
  HOSTED_TRIAL_DAYS,
} from "../../../src/shared/hosted-offer";
import { Html, SUPPORT_EMAIL, html, notice, renderPage } from "../ui";
import { pendingText, type BillingReason, type PendingItem } from "./state";

const year = (dollars: number) => `$${dollars} a year`;

/** What the customer pays, for the pages (Stripe's Prices are what's charged). */
export const PRICE_TEXT = {
  hosted: year(HOSTED_PRICE_YEARLY),
  fast: year(HOSTED_FAST_CHECKS_YEARLY),
  both: year(HOSTED_PRICE_YEARLY + HOSTED_FAST_CHECKS_YEARLY),
  monitorPack: year(HOSTED_MONITOR_PACK_YEARLY),
  fastPack: year(HOSTED_FAST_PACK_YEARLY),
} as const;

/** What a subscription bills, by kind: Stripe's own quantities, which may be past a cap or not count. */
export interface BilledItems {
  fast: number;
  monitor_pack: number;
  fast_pack: number;
}

/** What Stripe charges a year for these items, in dollars (the plan itself always once). */
export function billedTotal(billed: BilledItems): number {
  return (
    HOSTED_PRICE_YEARLY +
    billed.fast * HOSTED_FAST_CHECKS_YEARLY +
    billed.monitor_pack * HOSTED_MONITOR_PACK_YEARLY +
    billed.fast_pack * HOSTED_FAST_PACK_YEARLY
  );
}

/** "$12.00" from cents. */
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** What a plan with these packs costs a year, in dollars. */
export function yearlyTotal(plan: PlanId, packs: PackQuantities): number {
  if (plan === "trial") return 0;
  return (
    HOSTED_PRICE_YEARLY +
    (plan === "hosted_fast" ? HOSTED_FAST_CHECKS_YEARLY : 0) +
    packs.monitors * HOSTED_MONITOR_PACK_YEARLY +
    packs.fast_monitors * HOSTED_FAST_PACK_YEARLY
  );
}

/** "2 monitor packs, 1 fast monitor pack", or "None": the admin console and the plan line. */
export function packsText(packs: PackQuantities): string {
  const parts = [
    packs.monitors ? `${packs.monitors} monitor ${packs.monitors === 1 ? "pack" : "packs"}` : "",
    packs.fast_monitors ? `${packs.fast_monitors} fast monitor ${packs.fast_monitors === 1 ? "pack" : "packs"}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "None";
}

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
  /** The packs billing recorded, as they count on the plan. */
  packs: PackQuantities;
  /** What the tenant's OpenPing is told it may have: the plan, its packs and any support grant. */
  limits: PlanLimits;
  /**
   * What the deciding subscription bills, by Stripe's quantities (null for a
   * subscription saved before they were kept): the renewal total, and packs
   * that are billed but don't count (fast packs without the add-on).
   */
  billed: BilledItems | null;
  /** About how much removed packs left as a credit on the next renewal, in cents. */
  creditCents: number;
  /** What the tenant last reported having, or null before its first report. */
  usage: { monitors: number; fastMonitors: number | null; statusPages: number } | null;
  /** The subscription that decides, if any. */
  subscription: {
    status: string;
    renewsAt: number | null;
    cancelAtPeriodEnd: boolean;
    endedAt: number | null;
    paymentFailedAt: number | null;
    nextPaymentAttempt: number | null;
    /** A change (the add-on, a pack) waiting for its invoice to be paid, until Stripe drops it. */
    pending: { until: number; invoiceUrl: string; items: PendingItem[] } | null;
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
const ONE_MINUTE = "1‑minute";
/** A price that never splits across lines. */
const nb = (text: string) => text.replace(/ /g, " ");

function form(action: string, label: string, kind: "primary" | "secondary", fields: Record<string, string> = {}): Html {
  return html`<form method="post" action="${action}">${Object.entries(fields).map(
    ([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`,
  )}<button class="button ${kind}" type="submit">${label}</button></form>`;
}

const FAST = HOSTED_FAST_LIMITS.fastMonitors;

/** A number of things, "1 monitor" or "45 monitors". */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The packs a customer can choose at Checkout, for "More than 20 monitors?". */
function packChoices(kind: PackKind): Html[] {
  const pack = PACKS[kind];
  const unit = kind === "monitors" ? "monitors" : "fast monitors";
  const price = kind === "monitors" ? HOSTED_MONITOR_PACK_YEARLY : HOSTED_FAST_PACK_YEARLY;
  return Array.from({ length: pack.max + 1 }, (_, n) =>
    html`<option value="${String(n)}">${n === 0 ? "None" : `${n * pack.adds} more ${unit}, $${n * price} a year`}</option>`,
  );
}

function subscribeButtons(primary: "hosted" | "hosted_fast" = "hosted"): Html {
  const hosted = form("/billing/checkout", `Subscribe for ${PRICE_TEXT.hosted}`, primary === "hosted" ? "primary" : "secondary", { plan: "hosted" });
  // The price never splits, so a narrow phone wraps the label after the colon.
  const fast = form("/billing/checkout", `${ONE_MINUTE} checks: ${nb(PRICE_TEXT.both)}`, primary === "hosted_fast" ? "primary" : "secondary", { plan: "hosted_fast" });
  return html`<div class="stack">${primary === "hosted" ? [hosted, fast] : [fast, hosted]}</div>
<details class="more"><summary>More than ${String(HOSTED_PLAN_LIMITS.monitors)} monitors?</summary>
<form method="post" action="/billing/checkout" class="choose">
<div class="field"><label for="checkout-plan">Plan</label><select id="checkout-plan" name="plan">
<option value="hosted">Hosted, ${PRICE_TEXT.hosted}</option>
<option value="hosted_fast"${primary === "hosted_fast" ? new Html(" selected") : ""}>With ${ONE_MINUTE} checks on ${String(FAST)} monitors, ${PRICE_TEXT.both}</option>
</select></div>
<div class="field"><label for="checkout-monitor-packs">Monitor packs</label><select id="checkout-monitor-packs" name="monitor_packs">${packChoices("monitors")}</select>
<p class="hint">${String(PACKS.monitors.adds)} more monitors each, ${PRICE_TEXT.monitorPack}, up to ${String(PACKS.monitors.max)}.</p></div>
<div class="field"><label for="checkout-fast-packs">Fast monitor packs</label><select id="checkout-fast-packs" name="fast_packs">${packChoices("fast_monitors")}</select>
<p class="hint">${String(PACKS.fast_monitors.adds)} more ${ONE_MINUTE} monitors each, ${PRICE_TEXT.fastPack}, up to ${String(PACKS.fast_monitors.max)}; only with ${ONE_MINUTE} checks.</p></div>
<button class="button secondary" type="submit">Continue to checkout</button>
</form></details>
<p class="hint">Plus tax where it applies. Paid securely with Stripe; cancel any time.</p>`;
}

const manage = (label = "Manage billing", kind: "primary" | "secondary" = "secondary") => form("/billing/portal", label, kind);

/** The plan, in one sentence, with its packs counted in. */
function planLine(plan: PlanId, limits: PlanLimits): string {
  const monitors = count(limits.monitors, "monitor", "monitors");
  const pages = count(limits.statusPages, "status page", "status pages");
  switch (plan) {
    case "trial":
      return `Free trial: ${monitors}, ${pages}, email alerts, checks every 12 minutes.`;
    case "hosted":
      return `Hosted, yearly: ${monitors}, ${pages}, every alert channel, checks every 12 minutes.`;
    case "hosted_fast":
      return `Hosted with ${ONE_MINUTE} checks: ${monitors}, ${pages}, every alert channel; ${limits.fastMonitors} of the monitors checked as often as every minute, the rest every 12 minutes.`;
  }
}

/** What the tenant has against what it may have: the usage list. */
function usageList(view: BillingView): Html {
  const u = view.usage;
  const of = (n: number | null | undefined, limit: number) => (n === null || n === undefined ? `Up to ${limit}` : `${n} of ${limit}`);
  const over = (n: number | null | undefined, limit: number) => (typeof n === "number" && n > limit ? html` <span class="over">over</span>` : "");
  const rows: Html[] = [
    html`<li><span class="what"><strong>Monitors</strong></span><span class="value">${of(u?.monitors, view.limits.monitors)}${over(u?.monitors, view.limits.monitors)}</span></li>`,
  ];
  if (view.limits.fastMonitors > 0) {
    rows.push(
      html`<li><span class="what"><strong>Fast monitors</strong><span>Checked more often than every 12 minutes</span></span><span class="value">${of(u?.fastMonitors, view.limits.fastMonitors)}${over(u?.fastMonitors, view.limits.fastMonitors)}</span></li>`,
    );
  }
  rows.push(html`<li><span class="what"><strong>Status pages</strong></span><span class="value">${of(u?.statusPages, view.limits.statusPages)}</span></li>`);
  return html`<ul class="rows usage">${rows}</ul>`;
}

/**
 * The offer for one pack: what the customer has, and a button to add one
 * (and one to remove one, when they have any). `lead` puts it first, outlined,
 * as /billing/upgrade does for the limit that sent the customer there.
 */
function packOffer(kind: PackKind, view: BillingView, lead: boolean): Html {
  const pack = PACKS[kind];
  const fast = kind === "fast_monitors";
  // Removing goes from what Stripe bills (it may be past a cap, or not count at all); adding only while sold.
  const billed = view.billed ? view.billed[fast ? "fast_pack" : "monitor_pack"] : view.packs[kind];
  const have = Math.max(billed, view.packs[kind]);
  const sold = pack.plans.includes(view.plan);
  const price = fast ? PRICE_TEXT.fastPack : PRICE_TEXT.monitorPack;
  const unit = fast ? "fast monitors" : "monitors";
  const title = !sold ? "Fast monitor packs" : fast ? "More fast monitors" : "More monitors";
  const total = fast ? view.limits.fastMonitors : view.limits.monitors;
  const what = fast ? "fast monitor pack" : "monitor pack";
  const has =
    have > 0
      ? `You have ${count(have, what, `${what}s`)}, so ${total} ${fast ? "fast monitors" : "monitors"} in all.`
      : `Your plan has ${total} ${fast ? "fast monitors" : "monitors"}.`;
  const buttons: Html[] = [];
  if (sold && have < pack.max) {
    buttons.push(form("/billing/packs", `Add ${pack.adds} ${unit}: ${nb(price)}`, lead ? "primary" : "secondary", { kind, quantity: String(have + 1) }));
  }
  if (have > 0) buttons.push(form("/billing/packs", `Remove a ${what}`, "secondary", { kind, quantity: String(have - 1) }));
  const atMost =
    sold && have >= pack.max
      ? html`<p>That's the most a plan can have. Write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> for more.</p>`
      : "";
  return html`<div class="offer${lead ? " lead-offer" : ""}"><h3>${title}</h3>
<p>${sold ? has : `${count(have, what, `${what}s`)} billed.`}${sold && have < pack.max ? ` Add ${pack.adds} more for ${price} each, up to ${pack.max} packs.` : ""}</p>
${atMost}
${buttons.length ? html`<div class="stack">${buttons}</div>` : ""}</div>`;
}

/** The fast checks add-on's offer, on a plan without it. */
function fastOffer(lead: boolean): Html {
  return html`<div class="offer${lead ? " lead-offer" : ""}"><h3>${ONE_MINUTE} checks</h3>
<p>Check up to ${String(FAST)} monitors as often as once a minute, for ${PRICE_TEXT.fast} more; the rest stay at 12 minutes. You pay for the rest of this year now, then it renews with your plan.</p>
${form("/billing/add-fast", `Add for ${PRICE_TEXT.fast}`, lead ? "primary" : "secondary")}</div>`;
}

/** Which offer leads /billing/upgrade, from the limit the tenant's 402 named (`?need=`). */
type Lead = "fast" | "monitor_pack" | "fast_pack" | null;

function leadFor(need: LimitKind | null, view: BillingView): Lead {
  const fast = view.plan === "hosted_fast";
  if (need === "monitors") return "monitor_pack";
  if (need === "fast_monitors") return fast ? "fast_pack" : "fast";
  if (need === "interval") return fast ? null : "fast";
  return fast ? null : "fast";
}

/**
 * The billing section: what the customer has, what happens next, and the one
 * or two things they can do about it. `focus` "upgrade" leads with what lifts
 * the limit that sent them (`need`), or the next plan up.
 */
export function billingSection(
  view: BillingView,
  now: number,
  focus: "billing" | "upgrade" = "billing",
  level: 1 | 2 = 2,
  need: LimitKind | null = null,
): Html {
  const h = (text: string) => (level === 1 ? html`<h1>${text}</h1>` : html`<h2>${text}</h2>`);
  // The badge leads the billing page; the account page has the tenant's own just above.
  const badge = (label: string, tone?: string) =>
    level === 1 ? html`<p class="badge"${tone ? new Html(` style="--tone: var(${tone})"`) : ""}>${label}</p>` : "";
  if (!view.available) {
    return html`${h("Billing")}<p>Paid plans open soon: ${PRICE_TEXT.hosted}, and ${PRICE_TEXT.fast} more for ${ONE_MINUTE} checks. Your trial keeps running until then.</p>`;
  }
  if (!view.hasTenant) {
    return html`${h("Billing")}<p>Create your OpenPing first; its ${String(HOSTED_TRIAL_DAYS)}-day trial needs no card.</p>`;
  }
  const sub = view.subscription;
  const renews = sub?.renewsAt ? dateText(sub.renewsAt) : null;

  if (view.status === "trial") {
    return html`${badge(view.trialEndsAt ? `Trial, ${daysLeft(view.trialEndsAt, now)}` : "Trial")}
${h(focus === "upgrade" ? "Choose your plan" : "Billing")}
<p>${planLine("trial", view.limits)}${view.trialEndsAt && level === 1 ? ` It ends on ${dateText(view.trialEndsAt)}.` : ""}</p>
${level === 1 ? usageList(view) : ""}
<p>Subscribe for ${String(HOSTED_PLAN_LIMITS.monitors)} monitors, ${String(HOSTED_PLAN_LIMITS.statusPages)} status pages and every alert channel. Add ${ONE_MINUTE} checks on ${String(FAST)} monitors for ${PRICE_TEXT.fast} more.</p>
${subscribeButtons(focus === "upgrade" && need !== "monitors" && need !== "status_pages" && need !== "channel_kind" ? "hosted_fast" : "hosted")}`;
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
  // What Stripe will charge, from its own quantities.
  const total = year(view.billed ? billedTotal(view.billed) : yearlyTotal(view.plan, view.packs));
  const credit = view.creditCents > 0 ? dollars(view.creditCents) : null;
  const renewal = sub?.cancelAtPeriodEnd
    ? `${renews ? `Ends on ${renews}; it won't renew.` : "It won't renew."}${
        credit ? ` The credit of about ${credit} for removed packs isn't paid out when a plan ends without renewing.` : ""
      }`
    : renews
      ? `Renews on ${renews} for ${total}${credit ? `, less a credit of about ${credit} for removed packs` : ""}.`
      : "";
  // Billed but not counted (the add-on taken off in Stripe with fast packs left): say so, and offer to remove them.
  const idleFastPacks = view.billed && !fast ? view.billed.fast_pack : 0;
  if (idleFastPacks > 0) {
    lines.push(
      notice(
        `${count(idleFastPacks, "fast monitor pack is", "fast monitor packs are")} billed but count only with ${ONE_MINUTE} checks. Remove ${idleFastPacks === 1 ? "it" : "them"} below, or add ${ONE_MINUTE} checks.`,
        "error",
      ),
    );
  }
  if (sub?.pending) {
    const what = pendingText(sub.pending.items.length ? sub.pending.items : [{ kind: "fast", quantity: 1 }]);
    lines.push(
      html`<div class="offer lead-offer"><h3>${what.charAt(0).toUpperCase()}${what.slice(1)} are waiting on a payment</h3>
<p>The payment for them didn't go through, so they weren't added. Pay the invoice by ${dateText(sub.pending.until)} to add them; nothing changes until then.</p>
<div class="stack"><a class="button primary" href="${sub.pending.invoiceUrl}" rel="noreferrer">Pay the invoice</a></div></div>`,
    );
  }
  // Offers, only while nothing waits on a payment and the payments are up to date.
  const offers: Html[] = [];
  if (!pastDue && !sub?.pending && !sub?.cancelAtPeriodEnd) {
    const lead = focus === "upgrade" ? leadFor(need, view) : null;
    const all: { key: Exclude<Lead, null>; html: Html }[] = [];
    if (!fast) all.push({ key: "fast", html: fastOffer(lead === "fast") });
    all.push({ key: "monitor_pack", html: packOffer("monitors", view, lead === "monitor_pack") });
    if (fast || idleFastPacks > 0) all.push({ key: "fast_pack", html: packOffer("fast_monitors", view, lead === "fast_pack") });
    all.sort((a, b) => Number(b.key === lead) - Number(a.key === lead));
    offers.push(...all.map((o) => o.html));
  }
  const changes =
    offers.length > 0
      ? html`<p class="hint">Adding something charges the rest of this year now, and it starts once that payment goes through. Removing a pack takes it off at once; the unused part of the year comes off your next renewal, and isn't paid out if the plan ends without renewing. Nothing in your OpenPing is ever deleted: over a smaller limit, you can't add more until you remove some, and extra fast monitors are checked every 12 minutes.</p>`
      : "";
  return html`${pastDue ? badge("Payment due", "--degraded") : badge("Active", "--up")}
${h(focus === "upgrade" && !pastDue ? "Upgrade" : "Billing")}
${lines}
<p>${planLine(view.plan, view.limits)} ${renewal}</p>
${view.packs.monitors || view.packs.fast_monitors ? html`<p>Packs: ${packsText(view.packs)}.</p>` : ""}
${usageList(view)}
${offers}
${changes}
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
.usage { margin: 0 0 4px; }
.usage li { min-height: 48px; }
.usage .value { flex: none; font-variant-numeric: tabular-nums; color: var(--ink); font-weight: 600; text-align: right; }
.usage .over { color: var(--degraded); font-weight: 600; }
details.more { margin: 12px 0 0; border: 1px solid var(--line); border-radius: 0.5rem; }
details.more summary { cursor: pointer; min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 14px; font-size: 0.9375rem; font-weight: 600; color: var(--ink); list-style: none; }
details.more summary::-webkit-details-marker { display: none; }
details.more summary::after { content: ""; width: 8px; height: 8px; flex: none; border-right: 2px solid var(--ink-muted); border-bottom: 2px solid var(--ink-muted); transform: translateY(-2px) rotate(45deg); transition: transform 120ms cubic-bezier(0.25, 1, 0.5, 1); }
details.more[open] summary::after { transform: translateY(2px) rotate(-135deg); }
details.more summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 0.5rem; }
details.more .choose { padding: 4px 14px 14px; }
details.more select {
  display: block; width: 100%; min-height: 48px; padding: 10px 12px; font: inherit; font-size: 16px;
  color: var(--ink); background: var(--canvas); border: 1px solid var(--line); border-radius: 0.5rem;
}
details.more select:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
`;

export function billingPage(input: {
  view: BillingView;
  now: number;
  focus: "billing" | "upgrade";
  need?: LimitKind | null;
  flash?: { message: string; tone: "ok" | "error" } | null;
  status?: number;
}): Response {
  return renderPage({
    title: input.focus === "upgrade" ? "Upgrade" : "Billing",
    status: input.status,
    homeHref: "/account",
    style: BILLING_STYLE,
    main: html`${input.flash ? notice(input.flash.message, input.flash.tone) : ""}
${billingSection(input.view, input.now, input.focus, 1, input.need ?? null)}
<p class="switch"><a href="/account">Back to your account</a></p>`,
  });
}
