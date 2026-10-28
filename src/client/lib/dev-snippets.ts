/**
 * Copy-paste snippets for the Developers page, built from the install's own
 * address, so what the owner copies works as is. Pure, so they're tested.
 */

/** What stands in for a token the page can't show (it is shown once, at creation). */
export const TOKEN_PLACEHOLDER = "<your API token>";

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/** `export OPENPING_TOKEN="..."`, the line every other snippet reads the token from. */
export function exportTokenLine(token: string | null): string {
  return `export OPENPING_TOKEN="${token ?? TOKEN_PLACEHOLDER}"`;
}

export type McpScope = "local" | "user" | "project";

/** `claude mcp add ...` for Claude Code (docs/MCP.md). */
export function claudeCodeCommand(origin: string, scope: McpScope = "local"): string {
  const scopeFlag = scope === "local" ? "" : ` --scope ${scope}`;
  return [
    `claude mcp add --transport http${scopeFlag} openping ${trimOrigin(origin)}/mcp \\`,
    `  --header "Authorization: Bearer $OPENPING_TOKEN"`,
  ].join("\n");
}

/** Claude Desktop's config entry, through the mcp-remote bridge (docs/MCP.md). */
export function claudeDesktopConfig(origin: string, token: string | null): string {
  return JSON.stringify(
    {
      mcpServers: {
        openping: {
          command: "npx",
          args: ["-y", "mcp-remote", `${trimOrigin(origin)}/mcp`, "--header", "Authorization:${AUTH_HEADER}"],
          env: { AUTH_HEADER: `Bearer ${token ?? TOKEN_PLACEHOLDER}` },
        },
      },
    },
    null,
    2,
  );
}

/** The CLI's .op.env file (docs/CLI.md). */
export function opEnvFile(origin: string, token: string | null): string {
  return [`OPENPING_URL=${trimOrigin(origin)}`, `OPENPING_TOKEN=${token ?? TOKEN_PLACEHOLDER}`].join("\n");
}

/** A first REST call, to check a token works. */
export function curlExample(origin: string): string {
  return `curl -H "Authorization: Bearer $OPENPING_TOKEN" ${trimOrigin(origin)}/api/overview`;
}

// ---------------------------------------------------------------------------
// Embeds (docs/WIDGET.md) and feeds (routes/feeds.ts)
// ---------------------------------------------------------------------------

export interface WidgetOptions {
  /** A status page's slug; null for the default page. */
  slug: string | null;
  theme: "dark" | "light";
  height: number;
}

export function widgetUrl(origin: string, o: Pick<WidgetOptions, "slug" | "theme">): string {
  const q = new URLSearchParams({ theme: o.theme });
  if (o.slug) q.set("slug", o.slug);
  return `${trimOrigin(origin)}/embed?${q.toString()}`;
}

export function widgetSnippet(origin: string, o: WidgetOptions, title = "Service status"): string {
  return [
    "<iframe",
    `  src="${widgetUrl(origin, o)}"`,
    `  title="${title.replace(/"/g, "&quot;")}"`,
    `  width="100%"`,
    `  height="${Math.round(o.height)}"`,
    `  style="border:0;max-width:480px;color-scheme:normal"`,
    `  loading="lazy"`,
    "></iframe>",
  ].join("\n");
}

export interface BadgeOptions {
  slug: string | null;
  /** The left-hand text; "status" when blank. */
  label: string;
  /** A hex colour for the left-hand side, without or with "#"; default grey when blank. */
  labelColor: string;
}

export function badgeUrl(origin: string, o: BadgeOptions): string {
  const q = new URLSearchParams();
  if (o.slug) q.set("slug", o.slug);
  const label = o.label.trim();
  if (label && label !== "status") q.set("label", label);
  const color = o.labelColor.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) q.set("labelColor", color);
  const qs = q.toString();
  return `${trimOrigin(origin)}/api/public/badge.svg${qs ? `?${qs}` : ""}`;
}

export function badgeMarkdown(origin: string, o: BadgeOptions, statusPageUrl: string): string {
  return `[![${o.label.trim() || "status"}](${badgeUrl(origin, o)})](${statusPageUrl})`;
}

export function badgeHtml(origin: string, o: BadgeOptions, statusPageUrl: string): string {
  const alt = (o.label.trim() || "status").replace(/"/g, "&quot;");
  return `<a href="${statusPageUrl}"><img src="${badgeUrl(origin, o)}" alt="${alt}" /></a>`;
}

/** A status page's public address: /status for the default page, /status/<slug> otherwise. */
export function statusPageUrl(origin: string, slug: string | null): string {
  return `${trimOrigin(origin)}/status${slug ? `/${slug}` : ""}`;
}

export function feedUrls(origin: string, slug: string | null): { rss: string; atom: string } {
  const base = statusPageUrl(origin, slug);
  return { rss: `${base}/feed.rss`, atom: `${base}/feed.atom` };
}
