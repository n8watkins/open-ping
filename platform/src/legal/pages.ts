/**
 * /terms and /privacy on app.<domain>: the documents of ./documents.ts in
 * the platform's shell, phone first, readable at a phone's width without
 * zooming, with the date they last changed and a link to the other one.
 */

import { Html, html, renderPage } from "../ui";
import { LEGAL_DOCUMENTS, type LegalSlug } from "./documents";

export const LEGAL_PATHS: Readonly<Record<LegalSlug, string>> = { terms: "/terms", privacy: "/privacy" };

const LEGAL_STYLE = `
.legal h1 { font-size: 1.625rem; margin-bottom: 4px; }
.legal .updated { font-size: 0.875rem; color: var(--ink-faint); margin: 0 0 20px; }
.legal h2 { font-size: 1.0625rem; margin: 28px 0 8px; padding-top: 4px; scroll-margin-top: 16px; }
.legal h3 { font-size: 1rem; margin: 20px 0 6px; }
.legal p, .legal li { color: var(--ink); font-size: 1rem; line-height: 1.6; }
.legal p { margin: 0 0 12px; }
.legal ul { margin: 0 0 12px; padding-left: 1.25rem; }
.legal li { margin: 0 0 8px; overflow-wrap: anywhere; }
.legal strong { font-weight: 650; }
.legal code { overflow-wrap: anywhere; }
.legal mark.fill { background: color-mix(in srgb, var(--degraded) 22%, transparent); color: var(--ink); border-radius: 4px; padding: 0 4px; }
.legal .toc { border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface-2); padding: 4px 16px; margin: 0 0 20px; }
.legal .toc summary { min-height: 44px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; font-weight: 600; color: var(--ink); list-style: none; }
.legal .toc summary::-webkit-details-marker { display: none; }
.legal .toc summary::after { content: ""; width: 8px; height: 8px; border-right: 2px solid var(--ink-muted); border-bottom: 2px solid var(--ink-muted); transform: translateY(-2px) rotate(45deg); transition: transform 120ms cubic-bezier(0.25, 1, 0.5, 1); }
.legal .toc[open] summary::after { transform: translateY(2px) rotate(-135deg); }
@media (prefers-reduced-motion: reduce) { .legal .toc summary::after { transition: none; } }
.legal .toc ol { margin: 0 0 12px; padding-left: 0; list-style: none; }
.legal .toc li { margin: 0; }
.legal .toc a { display: flex; align-items: center; min-height: 44px; padding: 8px 0; line-height: 1.35; text-decoration: none; }
.legal .toc a:hover { text-decoration: underline; }
.legal .other { border-top: 1px solid var(--line); margin-top: 28px; padding-top: 16px; }
@media (min-width: 640px) { .legal .toc a { min-height: 36px; padding: 6px 0; } }
`;

function dateText(isoDay: string): string {
  return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export function legalPage(slug: LegalSlug): Response {
  const doc = LEGAL_DOCUMENTS[slug];
  const other = LEGAL_DOCUMENTS[slug === "terms" ? "privacy" : "terms"];
  return renderPage({
    title: doc.title,
    wide: true,
    style: LEGAL_STYLE,
    headers: { "cache-control": "public, max-age=300" },
    main: html`<article class="legal">
<h1>${doc.title}</h1>
<p class="updated">Last updated <time datetime="${doc.updated}">${dateText(doc.updated)}</time></p>
<details class="toc"><summary>Contents</summary><ol>${doc.sections.map(
      (s) => html`<li><a href="#${s.id}">${s.text}</a></li>`,
    )}</ol></details>
${new Html(doc.html)}
<p class="other">See also our <a href="${LEGAL_PATHS[other.slug]}">${other.title}</a>.</p>
</article>`,
  });
}
