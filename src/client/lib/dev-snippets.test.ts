import { describe, expect, it } from "vitest";
import {
  badgeHtml,
  badgeMarkdown,
  badgeUrl,
  claudeCodeCommand,
  claudeDesktopConfig,
  curlExample,
  exportTokenLine,
  feedUrls,
  opEnvFile,
  statusPageUrl,
  TOKEN_PLACEHOLDER,
  widgetSnippet,
  widgetUrl,
} from "./dev-snippets";

const ORIGIN = "https://status.example.com/";

describe("MCP and CLI snippets", () => {
  it("point Claude Code at the install's /mcp with the token from the environment", () => {
    expect(claudeCodeCommand(ORIGIN)).toBe(
      'claude mcp add --transport http openping https://status.example.com/mcp \\\n  --header "Authorization: Bearer $OPENPING_TOKEN"',
    );
    expect(claudeCodeCommand(ORIGIN, "user")).toContain("--transport http --scope user openping");
  });

  it("fill in a fresh token only where one is given", () => {
    expect(exportTokenLine(null)).toBe(`export OPENPING_TOKEN="${TOKEN_PLACEHOLDER}"`);
    expect(exportTokenLine("opk_abc")).toBe('export OPENPING_TOKEN="opk_abc"');
    expect(opEnvFile(ORIGIN, "opk_abc")).toBe("OPENPING_URL=https://status.example.com\nOPENPING_TOKEN=opk_abc");
  });

  it("build a Claude Desktop config that keeps the header in env", () => {
    const config = JSON.parse(claudeDesktopConfig(ORIGIN, null)) as {
      mcpServers: { openping: { args: string[]; env: Record<string, string> } };
    };
    expect(config.mcpServers.openping.args).toEqual([
      "-y",
      "mcp-remote",
      "https://status.example.com/mcp",
      "--header",
      "Authorization:${AUTH_HEADER}",
    ]);
    expect(config.mcpServers.openping.env.AUTH_HEADER).toBe(`Bearer ${TOKEN_PLACEHOLDER}`);
  });

  it("check a token with a REST call", () => {
    expect(curlExample(ORIGIN)).toBe('curl -H "Authorization: Bearer $OPENPING_TOKEN" https://status.example.com/api/overview');
  });
});

describe("embed snippets", () => {
  it("scope the widget to a page only when it isn't the default", () => {
    expect(widgetUrl(ORIGIN, { slug: null, theme: "dark" })).toBe("https://status.example.com/embed?theme=dark");
    expect(widgetUrl(ORIGIN, { slug: "api", theme: "light" })).toBe("https://status.example.com/embed?theme=light&slug=api");
    const html = widgetSnippet(ORIGIN, { slug: "api", theme: "dark", height: 320.4 }, 'A "quoted" title');
    expect(html).toContain('height="320"');
    expect(html).toContain('title="A &quot;quoted&quot; title"');
  });

  it("add only the badge options that change something", () => {
    expect(badgeUrl(ORIGIN, { slug: null, label: "status", labelColor: "" })).toBe(
      "https://status.example.com/api/public/badge.svg",
    );
    expect(badgeUrl(ORIGIN, { slug: "api", label: "API", labelColor: "#0f172a" })).toBe(
      "https://status.example.com/api/public/badge.svg?slug=api&label=API&labelColor=0f172a",
    );
    // Not a hex colour: left out, as the server would ignore it.
    expect(badgeUrl(ORIGIN, { slug: null, label: "", labelColor: "red" })).toBe(
      "https://status.example.com/api/public/badge.svg",
    );
  });

  it("link the badge to the page it reports on", () => {
    const page = statusPageUrl(ORIGIN, "api");
    expect(page).toBe("https://status.example.com/status/api");
    expect(badgeMarkdown(ORIGIN, { slug: "api", label: "API", labelColor: "" }, page)).toBe(
      "[![API](https://status.example.com/api/public/badge.svg?slug=api&label=API)](https://status.example.com/status/api)",
    );
    expect(badgeHtml(ORIGIN, { slug: null, label: "", labelColor: "" }, statusPageUrl(ORIGIN, null))).toBe(
      '<a href="https://status.example.com/status"><img src="https://status.example.com/api/public/badge.svg" alt="status" /></a>',
    );
  });

  it("give each page its RSS and Atom feeds", () => {
    expect(feedUrls(ORIGIN, null)).toEqual({
      rss: "https://status.example.com/status/feed.rss",
      atom: "https://status.example.com/status/feed.atom",
    });
    expect(feedUrls(ORIGIN, "api").atom).toBe("https://status.example.com/status/api/feed.atom");
  });
});
