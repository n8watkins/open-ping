/**
 * RSS 2.0 and Atom 1.0 builders for status page feeds (routes/feeds.ts).
 * Pure string work, so the escaping is unit-tested without a Worker.
 *
 * Every piece of text that reaches the XML goes through {@link escapeXml},
 * which also drops the characters XML 1.0 cannot carry at all (most control
 * characters, lone surrogates), so an admin's message can never make a feed
 * unparseable. Item bodies are HTML built from escaped text and then escaped
 * again as XML text, which is how both formats carry HTML (RSS description,
 * Atom content type="html"); no CDATA, so "]]>" in a message is harmless.
 */

import {
  INCIDENT_UPDATE_LABELS,
  type IncidentUpdateStatus,
} from "../db/incident-updates";

/** Characters XML 1.0 forbids anywhere, even escaped. */
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escape text for an XML element body or a double- or single-quoted attribute. */
export function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Escape text for HTML, keeping its line breaks as <br>. */
function htmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r\n?|\n/g, "<br>");
}

export interface FeedItem {
  /** Stable, globally unique id (a URL with a fragment). */
  id: string;
  title: string;
  link: string;
  published: number;
  updated: number;
  /** The body as HTML (already escaped where it holds text). */
  html: string;
}

export interface Feed {
  title: string;
  description: string;
  /** The status page the feed belongs to. */
  pageUrl: string;
  /** The feed's own URL. */
  selfUrl: string;
  /** When anything in the feed last changed (epoch ms). */
  updated: number;
  items: FeedItem[];
}

/** RFC 822 date, as RSS 2.0 wants: "Wed, 28 Oct 2026 15:04:00 GMT". */
export function rfc822(ms: number): string {
  return new Date(ms).toUTCString();
}

/** RFC 3339 date, as Atom wants, to the second: "2026-10-28T15:04:00Z". */
export function rfc3339(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** "2026-10-28 15:04 UTC": readable in any feed reader, whatever its timezone. */
function utcText(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function buildRss(feed: Feed): string {
  const items = feed.items
    .map(
      (item) => `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="false">${escapeXml(item.id)}</guid>
      <pubDate>${rfc822(item.published)}</pubDate>
      <description>${escapeXml(item.html)}</description>
    </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(feed.title)}</title>
    <link>${escapeXml(feed.pageUrl)}</link>
    <description>${escapeXml(feed.description)}</description>
    <atom:link href="${escapeXml(feed.selfUrl)}" rel="self" type="application/rss+xml"/>
    <language>en</language>
    <lastBuildDate>${rfc822(feed.updated)}</lastBuildDate>
    <generator>OpenPing</generator>
${items}
  </channel>
</rss>
`;
}

export function buildAtom(feed: Feed): string {
  const entries = feed.items
    .map(
      (item) => `  <entry>
    <title>${escapeXml(item.title)}</title>
    <id>${escapeXml(item.id)}</id>
    <link rel="alternate" type="text/html" href="${escapeXml(item.link)}"/>
    <published>${rfc3339(item.published)}</published>
    <updated>${rfc3339(item.updated)}</updated>
    <content type="html">${escapeXml(item.html)}</content>
  </entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(feed.title)}</title>
  <subtitle>${escapeXml(feed.description)}</subtitle>
  <id>${escapeXml(feed.pageUrl)}</id>
  <link rel="alternate" type="text/html" href="${escapeXml(feed.pageUrl)}"/>
  <link rel="self" type="application/atom+xml" href="${escapeXml(feed.selfUrl)}"/>
  <updated>${rfc3339(feed.updated)}</updated>
  <author><name>${escapeXml(feed.title)}</name></author>
  <generator>OpenPing</generator>
${entries}
</feed>
`;
}

// ---------------------------------------------------------------------------
// Incidents as feed items
// ---------------------------------------------------------------------------

/** The public incident fields a feed item is built from (routes/public.ts). */
export interface FeedIncident {
  id: string;
  title: string;
  message: string;
  startedAt: number;
  resolvedAt: number | null;
  updates: { status: IncidentUpdateStatus; message: string; at: number }[];
}

/** The incident's current status for its title: the newest update, else open/resolved. */
export function incidentStatusLabel(incident: FeedIncident): string {
  const latest = incident.updates[0];
  if (latest) return INCIDENT_UPDATE_LABELS[latest.status];
  return incident.resolvedAt != null ? "Resolved" : "Ongoing";
}

/** When an incident last changed: its newest update, resolution or start. */
export function incidentUpdatedAt(incident: FeedIncident): number {
  return Math.max(incident.startedAt, incident.resolvedAt ?? 0, ...incident.updates.map((u) => u.at));
}

/**
 * One feed item per public incident: its summary, when it started and ended,
 * then its updates newest first. A new update changes the item's `updated`
 * time (and Atom readers show it again); the id stays the same.
 */
export function incidentFeedItem(incident: FeedIncident, pageUrl: string): FeedItem {
  const link = `${pageUrl}#incident-${encodeURIComponent(incident.id)}`;
  const parts: string[] = [];
  if (incident.message) parts.push(`<p>${htmlText(incident.message)}</p>`);
  parts.push(
    `<p>Started ${utcText(incident.startedAt)}` +
      (incident.resolvedAt != null ? `, resolved ${utcText(incident.resolvedAt)}` : ", ongoing") +
      ".</p>",
  );
  for (const u of incident.updates) {
    parts.push(
      `<p><strong>${INCIDENT_UPDATE_LABELS[u.status]}</strong> (${utcText(u.at)})<br>${htmlText(u.message)}</p>`,
    );
  }
  return {
    id: link,
    title: `${incident.title} (${incidentStatusLabel(incident)})`,
    link,
    published: incident.startedAt,
    updated: incidentUpdatedAt(incident),
    html: parts.join("\n"),
  };
}
