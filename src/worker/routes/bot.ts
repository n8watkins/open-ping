import { Hono } from "hono";
import type { AppEnv } from "../types";
import { renderPlainPage } from "../lib/plain-page";
import { checkerUserAgent } from "../lib/user-agent";

/**
 * GET /bot: what the OpenPing checker is, for a site owner who found its
 * User-Agent (lib/user-agent.ts) in their logs or firewall events. Every
 * install serves it; the default User-Agent links to the project's own copy.
 * A plain page with no script, public, and served before the app loads.
 */
export const bot = new Hono<AppEnv>();

bot.get("/", (c) => {
  c.header("Cache-Control", "public, max-age=3600");
  return c.html(
    renderPlainPage({
      title: "The OpenPing checker",
      heading: "The OpenPing checker",
      layout: "article",
      body: [
        "Requests whose User-Agent starts with OpenPing/ come from OpenPing, an open-source uptime monitor. Someone who runs an OpenPing install added a page of your site as a monitor, most often the site's own owner, to be told when it goes down.",
        "This install's checker identifies itself as:",
        { code: checkerUserAgent(c.env) },
        "What it does: it requests the one address it was given on a fixed schedule, usually every few minutes, and reads the status code and, for a keyword check, the page's text. Before it reports a failure it asks once more, sometimes from another region. About once a week it also fetches the site's icon. It never follows links, crawls, submits forms or runs scripts.",
        "Where it comes from: OpenPing runs on Cloudflare Workers, so its requests come from Cloudflare's IP addresses, which change. To let it through a firewall, WAF or bot rule, allow requests whose User-Agent starts with OpenPing/ rather than an IP range.",
        "Each install runs in its owner's own Cloudflare account and the OpenPing project can't see or change another install's checks. To stop a check you didn't ask for, block that User-Agent: the install's owner then sees the monitor failing.",
      ],
      action: { href: "https://github.com/n8watkins/open-ping", label: "OpenPing on GitHub" },
    }),
  );
});
