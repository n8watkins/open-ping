import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { hitRateLimit } from "../db/rate-limit";
import { confirmSignup, leaveWaitlist, type ConfirmResult } from "../db/waitlist";
import { renderPlainPage, type PlainPage } from "../lib/plain-page";
import { waitlistEnabled } from "./waitlist";

/**
 * The pages behind the links in the waitlist email (routes/waitlist.ts), served
 * as small HTML pages in the app's look, light and dark, with no script:
 *
 * - /waitlist/confirm?t=...  GET shows a button, POST confirms. Opening the link
 *   does nothing by itself, so a mail scanner that fetches every link can't
 *   confirm an address for its owner.
 * - /waitlist/leave?t=...    GET and POST both leave at once: one click, no
 *   login. The POST is what a mail app's own unsubscribe button sends
 *   (List-Unsubscribe-Post, RFC 8058). Leaving deletes the row.
 *
 * Tokens are unguessable (24 random bytes, stored hashed), so a page answers the
 * same for a wrong link as for a used one, except to say a confirm link expired.
 */
export const waitlistPages = new Hono<AppEnv>();

/** Per-client-IP cap on link pages a minute. */
export const WAITLIST_LINK_PER_IP_LIMIT = 30;

const HOME = { href: "/", label: "Back to OpenPing" };

function respond(c: Context<AppEnv>, page: PlainPage, status: 200 | 400 | 404 | 429 = 200) {
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  return c.html(renderPlainPage(page), status);
}

const brokenLink: PlainPage = {
  title: "Link not found",
  heading: "This link doesn't work",
  body: ["It may have been used already, or copied only in part. Open the link from the latest email, or sign up again."],
  secondary: HOME,
};

async function token(c: Context<AppEnv>): Promise<string> {
  const fromQuery = c.req.query("t");
  if (fromQuery) return fromQuery;
  // A form post carries it as a hidden field; a mail app's one-click POST only has the URL.
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  return typeof body.t === "string" ? body.t : "";
}

async function guard(c: Context<AppEnv>) {
  if (!waitlistEnabled(c.env)) return respond(c, { title: "Not found", heading: "Not found", body: ["There is nothing here."], secondary: HOME }, 404);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const hit = await hitRateLimit(c.env, `wl:link:${ip}`, WAITLIST_LINK_PER_IP_LIMIT);
  if (!hit.allowed) {
    c.header("Retry-After", String(hit.retryAfterSeconds));
    return respond(c, { title: "Slow down", heading: "Too many tries", body: ["Give it a minute and try again."], secondary: HOME }, 429);
  }
  return null;
}

const CONFIRM_PAGES: Record<ConfirmResult, PlainPage> = {
  confirmed: {
    title: "You're on the list",
    heading: "You're on the list",
    body: ["Thanks for confirming. I'll email you once, when OpenPing Hosted opens, with early pricing. Nothing else."],
    action: { href: "/install", label: "Run OpenPing yourself meanwhile" },
    secondary: HOME,
  },
  already: {
    title: "Already confirmed",
    heading: "You're already confirmed",
    body: ["This address is on the list. There is nothing more to do."],
    secondary: HOME,
  },
  expired: {
    title: "Link expired",
    heading: "This link has expired",
    body: ["Confirm links work for seven days, and an unconfirmed request is deleted after that. Sign up again on the home page to get a new one."],
    action: { href: "/#hosted-card", label: "Sign up again" },
  },
  unknown: brokenLink,
};

waitlistPages.get("/confirm", async (c) => {
  const blocked = await guard(c);
  if (blocked) return blocked;
  const t = await token(c);
  if (!t) return respond(c, brokenLink, 400);
  return respond(c, {
    title: "Confirm your spot",
    heading: "Confirm your spot",
    body: ["One click and you're on the OpenPing Hosted waitlist. I'll email you once, when it opens."],
    form: { action: "/waitlist/confirm", label: "Confirm my spot", fields: { t } },
  });
});

waitlistPages.post("/confirm", async (c) => {
  const blocked = await guard(c);
  if (blocked) return blocked;
  const t = await token(c);
  if (!t) return respond(c, brokenLink, 400);
  return respond(c, CONFIRM_PAGES[await confirmSignup(c.env, t, Date.now())]);
});

async function leave(c: Context<AppEnv>) {
  const blocked = await guard(c);
  if (blocked) return blocked;
  const t = await token(c);
  if (!t) return respond(c, brokenLink, 400);
  const removed = await leaveWaitlist(c.env, t);
  return respond(
    c,
    removed
      ? {
          title: "You've left the waitlist",
          heading: "You've left the waitlist",
          body: ["Your address is deleted, and I won't email you again."],
          secondary: HOME,
        }
      : {
          title: "Already removed",
          heading: "You're not on the waitlist",
          body: ["This address was already removed, so there is nothing more to do."],
          secondary: HOME,
        },
  );
}

waitlistPages.get("/leave", leave);
waitlistPages.post("/leave", leave);
