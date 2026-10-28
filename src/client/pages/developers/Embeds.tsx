import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Rss } from "lucide-react";
import { useFetch } from "../../lib/useFetch";
import { cn } from "../../lib/cn";
import type { StatusPage } from "../../lib/types";
import {
  badgeHtml,
  badgeMarkdown,
  badgeUrl,
  feedUrls,
  statusPageUrl,
  widgetSnippet,
  widgetUrl,
} from "../../lib/dev-snippets";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { CodeBlock } from "../../components/ui/CodeBlock";
import { CopyButton } from "../../components/ui/CopyButton";
import { ErrorBanner, Field, SectionSkeleton } from "../settings/shared";
import { useDevelopers } from "../Developers";

const DOCS = "https://github.com/n8watkins/open-ping/blob/main/docs/WIDGET.md";

/** A value that settles `ms` after its last change, so the preview isn't refetched per keystroke. */
function useSettled<T>(value: T, ms = 350): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** The slug embeds use for a page: none for the default page. */
function embedSlug(p: StatusPage): string | null {
  return p.isDefault ? null : p.slug;
}

/** Developers > Embeds & feeds: a badge and widget builder with live preview, and each page's feeds. */
export default function EmbedsPage() {
  const { data, loading, error } = useFetch<{ statusPages: StatusPage[] }>("/api/status-pages");
  const pages = useMemo(
    () => [...(data?.statusPages ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)),
    [data],
  );

  return (
    <div className="stagger space-y-6 [&>*]:animate-enter">
      {loading && !data ? (
        <Card className="p-5">
          <SectionSkeleton rows={4} />
        </Card>
      ) : error && !data ? (
        <ErrorBanner>Could not load status pages: {error}</ErrorBanner>
      ) : (
        <>
          <EmbedBuilder pages={pages} />
          <FeedsCard pages={pages} />
        </>
      )}
    </div>
  );
}

function EmbedBuilder({ pages }: { pages: StatusPage[] }) {
  const { origin } = useDevelopers();
  // The preview loads from this browser's origin, so it works on any address
  // you opened the app at; the snippets use the install's public address.
  const here = window.location.origin;
  const [pageId, setPageId] = useState<string>(pages[0]?.id ?? "");
  const page = pages.find((p) => p.id === pageId) ?? pages[0] ?? null;
  const slug = page ? embedSlug(page) : null;
  const [kind, setKind] = useState<"badge" | "widget">("badge");
  const [label, setLabel] = useState("status");
  const [labelColor, setLabelColor] = useState("#555555");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [height, setHeight] = useState(280);

  const badge = { slug, label, labelColor: labelColor.toLowerCase() === "#555555" ? "" : labelColor };
  const settledBadge = useSettled(badge);
  const pageUrl = statusPageUrl(origin, slug);

  return (
    <Card className="p-5">
      <CardHeader>
        <CardTitle>Badge and widget</CardTitle>
        <a
          href={DOCS}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
        >
          Embedding guide
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </CardHeader>
      <p className="-mt-1 mb-5 text-sm text-ink-muted">
        Show a status page&apos;s live state anywhere: a badge for a README, or a widget that lists each service. Both show
        only what the public page shows.
      </p>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div role="group" aria-label="Embed type" className="inline-flex rounded-lg border border-line bg-surface-2/50 p-0.5">
            {(["badge", "widget"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  "rounded-md px-3.5 py-1.5 text-sm font-medium capitalize transition-colors duration-150",
                  kind === k ? "bg-accent-soft text-ink shadow-sm" : "text-ink-muted hover:text-ink",
                )}
              >
                {k}
              </button>
            ))}
          </div>

          <Field label="Status page">
            <select className="input" value={page?.id ?? ""} onChange={(e) => setPageId(e.target.value)} name="embed-page">
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.isDefault ? " (default)" : ""}
                  {p.enabled ? "" : " (off)"}
                </option>
              ))}
            </select>
          </Field>
          {page && !page.enabled && (
            <p className="text-xs text-degraded">This page is off, so its badge reads &ldquo;unknown&rdquo; and the widget says so.</p>
          )}

          {kind === "badge" ? (
            <>
              <Field label="Label">
                <input
                  className="input"
                  name="badge-label"
                  value={label}
                  maxLength={40}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="status"
                />
              </Field>
              <Field label="Label colour">
                <span className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Pick the label colour"
                    value={/^#[0-9a-f]{6}$/i.test(labelColor) ? labelColor : "#555555"}
                    onChange={(e) => setLabelColor(e.target.value)}
                    className="h-9 w-11 shrink-0 cursor-pointer rounded-lg border border-line bg-surface-2 p-1"
                  />
                  <input
                    className="input font-mono"
                    name="badge-label-color"
                    value={labelColor}
                    onChange={(e) => setLabelColor(e.target.value)}
                    spellCheck={false}
                  />
                </span>
              </Field>
            </>
          ) : (
            <>
              <Field label="Theme">
                <select className="input" value={theme} onChange={(e) => setTheme(e.target.value as "dark" | "light")} name="widget-theme">
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </Field>
              <Field label={`Height: ${height}px`} hint="About 120px for the banner and 40px for each service.">
                <input
                  type="range"
                  min={160}
                  max={640}
                  step={10}
                  value={height}
                  onChange={(e) => setHeight(Number(e.target.value))}
                  className="w-full accent-accent"
                  name="widget-height"
                />
              </Field>
            </>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <div className="mb-1.5 text-xs font-medium text-ink-muted">Preview</div>
            <div
              className={cn(
                "grid min-h-24 place-items-center overflow-hidden rounded-lg border border-line p-4",
                kind === "widget" && theme === "light" ? "bg-[#f6f8fb]" : "bg-canvas/60",
              )}
            >
              {kind === "badge" ? (
                <img
                  key={badgeUrl(here, settledBadge)}
                  src={badgeUrl(here, settledBadge)}
                  alt={`${settledBadge.label || "status"} badge preview`}
                  className="h-5 animate-fade"
                />
              ) : (
                <iframe
                  key={`${slug}-${theme}`}
                  src={widgetUrl(here, { slug, theme })}
                  title="Widget preview"
                  width="100%"
                  height={height}
                  loading="lazy"
                  className="w-full max-w-[480px] animate-fade border-0 transition-[height] duration-200"
                  style={{ colorScheme: "normal" }}
                />
              )}
            </div>
          </div>
          {kind === "badge" ? (
            <>
              <CodeBlock wrap label="Markdown" code={badgeMarkdown(origin, badge, pageUrl)} />
              <CodeBlock wrap label="HTML" code={badgeHtml(origin, badge, pageUrl)} />
            </>
          ) : (
            <>
              <CodeBlock label="HTML" code={widgetSnippet(origin, { slug, theme, height }, page ? `${page.name} status` : undefined)} />
              <p className="text-xs leading-relaxed text-ink-faint">
                The widget can be framed only by sites its frame policy allows: this install, and the domains listed in{" "}
                <code className="font-mono">WIDGET_FRAME_ANCESTORS</code> (the embedding guide shows how to add yours).
              </p>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function FeedsCard({ pages }: { pages: StatusPage[] }) {
  const { origin } = useDevelopers();
  return (
    <Card className="p-5">
      <CardHeader>
        <CardTitle>RSS and Atom feeds</CardTitle>
      </CardHeader>
      <p className="-mt-1 mb-4 text-sm text-ink-muted">
        Each status page publishes its public incidents and their updates, for feed readers, Slack&apos;s RSS app or your
        own scripts.
      </p>
      {pages.length === 0 ? (
        <p className="text-sm text-ink-faint">No status pages yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {pages.map((p) => {
            const feeds = feedUrls(origin, embedSlug(p));
            return (
              <li key={p.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Rss className="size-4 shrink-0 text-ink-faint" aria-hidden />
                  <span className="truncate text-sm font-medium text-ink">{p.name}</span>
                  {!p.enabled && <span className="shrink-0 text-xs text-ink-faint">Off: feeds return 404</span>}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-6.5 sm:pl-0">
                  {(["rss", "atom"] as const).map((f) => (
                    <span key={f} className="inline-flex items-center overflow-hidden rounded-md border border-line">
                      <a
                        href={feeds[f]}
                        target="_blank"
                        rel="noreferrer"
                        className="px-2 py-1 text-xs font-medium text-ink-muted uppercase transition-colors hover:bg-surface-2 hover:text-ink"
                      >
                        {f}
                      </a>
                      <CopyButton
                        text={feeds[f]}
                        compact
                        variant="ghost"
                        ariaLabel={`Copy the ${f.toUpperCase()} feed URL for ${p.name}`}
                        className="rounded-none border-l border-line"
                      />
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
