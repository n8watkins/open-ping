import { Hono, type Context } from "hono";
import { etag } from "hono/etag";
import type { AppEnv } from "../types";
import { loadPublicFeed } from "./public";
import { buildAtom, buildRss, incidentFeedItem, incidentUpdatedAt, type Feed } from "../lib/feed";

/**
 * RSS 2.0 and Atom feeds of a status page's public incidents and their
 * updates, mounted at /status in index.ts (before the catch-all, which would
 * otherwise hand these extension paths to the assets binding and 404):
 *
 *   /status/feed.rss, /status/feed.atom              the default page
 *   /status/:slug/feed.rss, /status/:slug/feed.atom  any page, by slug
 *
 * UNAUTHENTICATED: the data comes from routes/public.ts loadPublicFeed, which
 * applies the status page's own boundary (enabled page, public monitors on
 * this page, incidents the admin made public). An unknown slug or a page that
 * is turned off is a 404. The Worker's security headers apply as everywhere.
 */
export const feeds = new Hono<AppEnv>();

/** Feed readers poll; a minute of staleness is fine and lets the CDN absorb them. */
export const FEED_CACHE_SECONDS = 60;

const CONTENT_TYPES = {
  rss: "application/rss+xml; charset=utf-8",
  atom: "application/atom+xml; charset=utf-8",
} as const;

type Format = keyof typeof CONTENT_TYPES;


async function serveFeed(c: Context<AppEnv>, format: Format, slug: string | undefined) {
  const data = await loadPublicFeed(c.env, slug);
  if (data === "not_found") {
    c.header("Cache-Control", `public, max-age=${FEED_CACHE_SECONDS}`);
    return c.text("Not found", 404);
  }
  const origin = new URL(c.req.url).origin;
  const pagePath = slug == null ? "/status" : `/status/${encodeURIComponent(slug)}`;
  const pageUrl = `${origin}${pagePath}`;
  const items = data.incidents.map((i) => incidentFeedItem(i, pageUrl));
  const feed: Feed = {
    title: /\bstatus\b/i.test(data.page.name) ? data.page.name : `${data.page.name} status`,
    description: data.page.description || `Incidents and updates from the ${data.page.name} status page.`,
    pageUrl,
    selfUrl: `${pageUrl}/feed.${format}`,
    // The newest change, so the body (and its ETag) only changes when the
    // incidents do; a feed with nothing in it yet is dated now.
    updated: data.incidents.length ? Math.max(...data.incidents.map(incidentUpdatedAt)) : Date.now(),
    items,
  };
  c.header("Content-Type", CONTENT_TYPES[format]);
  c.header("Cache-Control", `public, max-age=${FEED_CACHE_SECONDS}`);
  return c.body(format === "rss" ? buildRss(feed) : buildAtom(feed));
}

// A conditional GET from a reader that already has this version gets a 304.
// Only on the feed routes: a `use("*")` here would also wrap /status itself,
// whose app shell comes from the assets binding.
const conditional = etag();

feeds.get("/feed.rss", conditional, (c) => serveFeed(c, "rss", undefined));
feeds.get("/feed.atom", conditional, (c) => serveFeed(c, "atom", undefined));
feeds.get("/:slug/feed.rss", conditional, (c) => serveFeed(c, "rss", c.req.param("slug")));
feeds.get("/:slug/feed.atom", conditional, (c) => serveFeed(c, "atom", c.req.param("slug")));
