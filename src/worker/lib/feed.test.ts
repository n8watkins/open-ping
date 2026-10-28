import { describe, expect, it } from "vitest";
import {
  buildAtom,
  buildRss,
  escapeXml,
  incidentFeedItem,
  incidentStatusLabel,
  rfc3339,
  rfc822,
  type Feed,
  type FeedIncident,
} from "./feed";

/**
 * A small XML well-formedness check for the feeds we build: every tag closes
 * in order, attributes are quoted, and no raw `<` or bare `&` sits in text.
 * Enough to catch an escaping mistake; the E2E pass also runs a real parser.
 */
function assertWellFormed(xml: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, "");
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[6]) throw new Error(`stray < at ${m.index}`);
    if (m[5] !== undefined) {
      if (/&(?!(amp|lt|gt|quot|apos);)/.test(m[5])) throw new Error(`bare & in text: ${m[5].slice(0, 40)}`);
      continue;
    }
    const [, closing, name, , selfClosing] = m;
    if (closing) {
      const open = stack.pop();
      if (open !== name) throw new Error(`</${name}> closes <${open}>`);
    } else if (!selfClosing) stack.push(name!);
  }
  if (stack.length) throw new Error(`unclosed: ${stack.join(", ")}`);
}

const NASTY = `Tom & Jerry's <script>alert("x")</script> ]]> \u0001\u0008 bell\uD800 done`;

const incident = (over: Partial<FeedIncident> = {}): FeedIncident => ({
  id: "inc_1",
  title: "API incident",
  message: "Errors on checkout",
  startedAt: Date.UTC(2026, 9, 28, 14, 0),
  resolvedAt: null,
  updates: [],
  ...over,
});

function feedOf(items: FeedIncident[]): Feed {
  const pageUrl = "https://status.example.com/status";
  return {
    title: "Example status",
    description: "Incidents & updates",
    pageUrl,
    selfUrl: `${pageUrl}/feed.rss`,
    updated: Date.UTC(2026, 9, 28, 16, 0),
    items: items.map((i) => incidentFeedItem(i, pageUrl)),
  };
}

describe("escapeXml", () => {
  it("escapes the five XML specials", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });

  it("drops characters XML 1.0 cannot carry, keeps tabs, newlines and real emoji", () => {
    expect(escapeXml("a\u0000b\u0001c\u000bd\u001fe￾f")).toBe("abcdef");
    expect(escapeXml("tab\tnl\ncr\r")).toBe("tab\tnl\ncr\r");
    // A lone surrogate is invalid; a proper pair (an emoji) is fine.
    expect(escapeXml("x\uD800y\uDC00z")).toBe("xyz");
    expect(escapeXml("ok \u{1F680}")).toBe("ok \u{1F680}");
  });
});

describe("dates", () => {
  it("formats RFC 822 for RSS and RFC 3339 for Atom", () => {
    const t = Date.UTC(2026, 9, 28, 15, 4, 5, 678);
    expect(rfc822(t)).toBe("Wed, 28 Oct 2026 15:04:05 GMT");
    expect(rfc3339(t)).toBe("2026-10-28T15:04:05Z");
  });
});

describe("incident feed items", () => {
  it("titles by the newest update's status, else ongoing or resolved", () => {
    expect(incidentStatusLabel(incident())).toBe("Ongoing");
    expect(incidentStatusLabel(incident({ resolvedAt: Date.UTC(2026, 9, 28, 15) }))).toBe("Resolved");
    expect(
      incidentStatusLabel(
        incident({
          updates: [
            { status: "monitoring", message: "b", at: 3 },
            { status: "identified", message: "a", at: 2 },
          ],
        }),
      ),
    ).toBe("Monitoring");
  });

  it("puts the summary and every update, newest first, in the body, and dates it by the newest change", () => {
    const item = incidentFeedItem(
      incident({
        updates: [
          { status: "monitoring", message: "Fix deployed\nwatching", at: Date.UTC(2026, 9, 28, 15, 30) },
          { status: "identified", message: "Bad deploy", at: Date.UTC(2026, 9, 28, 14, 30) },
        ],
      }),
      "https://s.example/status",
    );
    expect(item.title).toBe("API incident (Monitoring)");
    expect(item.id).toBe("https://s.example/status#incident-inc_1");
    expect(item.updated).toBe(Date.UTC(2026, 9, 28, 15, 30));
    expect(item.html.indexOf("Monitoring")).toBeLessThan(item.html.indexOf("Identified"));
    expect(item.html).toContain("Fix deployed<br>watching");
    expect(item.html).toContain("Started 2026-10-28 14:00 UTC, ongoing.");
  });
});

describe("RSS and Atom", () => {
  const items = [
    incident({ title: NASTY, message: NASTY, updates: [{ status: "investigating", message: NASTY, at: Date.UTC(2026, 9, 28, 14, 5) }] }),
    incident({ id: "inc_2", resolvedAt: Date.UTC(2026, 9, 27, 3, 0), startedAt: Date.UTC(2026, 9, 27, 2, 0) }),
  ];

  it("builds well-formed RSS 2.0 with escaped text and HTML", () => {
    const xml = buildRss(feedOf(items));
    assertWellFormed(xml);
    expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('<atom:link href="https://status.example.com/status/feed.rss" rel="self" type="application/rss+xml"/>');
    expect(xml).toContain("<guid isPermaLink=\"false\">https://status.example.com/status#incident-inc_1</guid>");
    expect(xml).toContain("<pubDate>Wed, 28 Oct 2026 14:00:00 GMT</pubDate>");
    expect(xml).toContain("<description>Incidents &amp; updates</description>");
    // The message's markup is text twice over: HTML-escaped, then XML-escaped.
    expect(xml).toContain("&amp;lt;script&amp;gt;");
    expect(xml).not.toContain("<script>");
    // eslint-disable-next-line no-control-regex -- asserting control characters are gone
    expect(xml).not.toMatch(/[\u0000-\u0008]/);
    expect(xml.match(/<item>/g)).toHaveLength(2);
  });

  it("builds well-formed Atom 1.0 with ids, updated times and HTML content", () => {
    const xml = buildAtom(feedOf(items));
    assertWellFormed(xml);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("<updated>2026-10-28T16:00:00Z</updated>");
    expect(xml).toContain('<link rel="self" type="application/atom+xml" href="https://status.example.com/status/feed.rss"/>');
    expect(xml).toContain("<updated>2026-10-28T14:05:00Z</updated>");
    expect(xml).toContain('<content type="html">');
    expect(xml).not.toContain("<script>");
    expect(xml.match(/<entry>/g)).toHaveLength(2);
  });

  it("is still well-formed with no incidents", () => {
    assertWellFormed(buildRss(feedOf([])));
    assertWellFormed(buildAtom(feedOf([])));
  });
});
