import { escapeHtml } from "../notifications/email-layout";

/**
 * A small server-rendered page styled like the app (the dark navy look), with
 * no script: for the few answers the Worker gives as HTML before the app can
 * load, such as a refused Hosted hand-off or the "Open the app" step of an app
 * sign-in. Every value is escaped here.
 */
export interface PlainPage {
  /** The tab title, before " | OpenPing". */
  title: string;
  heading: string;
  /** Paragraphs of plain text; `{ code }` is a line of monospace text, such as a header value to copy. */
  body: (string | { code: string })[];
  /**
   * "article" widens the card and aligns its text to the start, for a page
   * that explains something in several paragraphs (/bot). Default "card".
   */
  layout?: "card" | "article";
  /** The main button. */
  action?: { href: string; label: string };
  /**
   * A button that POSTs (instead of a link): for a step a link scanner or a
   * prefetch must not take by itself. `fields` become hidden inputs.
   */
  form?: { action: string; label: string; fields?: Record<string, string> };
  /** A quieter link under the button. */
  secondary?: { href: string; label: string };
  /** A short line under the card. */
  fine?: string;
}

export function renderPlainPage(page: PlainPage): string {
  const paragraphs = page.body
    .map((item) =>
      typeof item === "string" ? `<p>${escapeHtml(item)}</p>` : `<p class="code"><code>${escapeHtml(item.code)}</code></p>`,
    )
    .join("\n        ");
  const action = page.action
    ? `<a class="button" href="${escapeHtml(page.action.href)}">${escapeHtml(page.action.label)}</a>`
    : "";
  const form = page.form
    ? `<form method="post" action="${escapeHtml(page.form.action)}">${Object.entries(page.form.fields ?? {})
        .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
        .join("")}<button class="button" type="submit">${escapeHtml(page.form.label)}</button></form>`
    : "";
  const secondary = page.secondary
    ? `<a class="secondary" href="${escapeHtml(page.secondary.href)}">${escapeHtml(page.secondary.label)}</a>`
    : "";
  const fine = page.fine ? `<p class="fine">${escapeHtml(page.fine)}</p>` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0b1220" media="(prefers-color-scheme: dark)" />
    <meta name="theme-color" content="#f6f8fb" media="(prefers-color-scheme: light)" />
    <meta name="color-scheme" content="dark light" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(page.title)} | OpenPing</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <style>
      :root {
        --canvas: #0b1220;
        --surface: #111b2e;
        --line: #1f2c44;
        --ink: #e6edf6;
        --ink-muted: #9fb0c5;
        --ink-faint: #8595ad;
        --accent: #6d8bff;
      }
      /* The app's light palette (client/index.css), for visitors whose system is light. */
      @media (prefers-color-scheme: light) {
        :root {
          --canvas: #f6f8fb;
          --surface: #ffffff;
          --line: #d8e0ea;
          --ink: #16233a;
          --ink-muted: #475569;
          --ink-faint: #5f6f87;
          --accent: #4f5fd6;
        }
      }
      * { box-sizing: border-box; }
      html, body { min-height: 100%; margin: 0; }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 1.5rem 1rem;
        background-color: var(--canvas);
        color: var(--ink);
        -webkit-font-smoothing: antialiased;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      main { width: 100%; max-width: 24rem; }
      .brand {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        margin: 0 0 2rem;
        font-size: 1.125rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--ink);
      }
      .brand svg { width: 28px; height: 28px; }
      .brand .ping { color: var(--accent); }
      .card {
        padding: 1.5rem;
        border: 1px solid var(--line);
        border-radius: 0.875rem;
        background-color: var(--surface);
        text-align: center;
      }
      h1 { margin: 0; font-size: 1.125rem; font-weight: 600; letter-spacing: -0.01em; }
      .card p { margin: 0.75rem 0 0; font-size: 0.875rem; line-height: 1.6; color: var(--ink-muted); overflow-wrap: anywhere; }
      .button {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 2.75rem;
        margin-top: 1.5rem;
        border-radius: 0.5rem;
        background-color: var(--ink);
        color: var(--canvas);
        font-size: 0.875rem;
        font-weight: 600;
        text-decoration: none;
      }
      button.button { width: 100%; border: 0; font-family: inherit; cursor: pointer; }
      form { margin: 0; }
      .button:hover { opacity: 0.9; }
      .secondary {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 2.75rem;
        margin-top: 0.5rem;
        color: var(--ink-muted);
        font-size: 0.875rem;
        text-decoration: underline;
        text-underline-offset: 4px;
      }
      .secondary:hover { color: var(--ink); }
      .button:focus-visible, .secondary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .article main { max-width: 38rem; }
      .article .card { padding: 1.75rem; text-align: left; }
      .article .card p { font-size: 0.9375rem; }
      .card p.code {
        padding: 0.625rem 0.75rem;
        border: 1px solid var(--line);
        border-radius: 0.5rem;
        background-color: var(--canvas);
        color: var(--ink);
        text-align: left;
      }
      .card p.code code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8125rem; }
      .fine { margin: 1.5rem 0 0; font-size: 0.75rem; line-height: 1.5; color: var(--ink-faint); text-align: center; }
    </style>
  </head>
  <body${page.layout === "article" ? ' class="article"' : ""}>
    <main>
      <p class="brand" aria-label="OpenPing">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="#111b2e" />
          <circle cx="16" cy="16" r="4" fill="#6d8bff" />
          <circle cx="16" cy="16" r="9" fill="none" stroke="#6d8bff" stroke-width="1.5" opacity="0.5" />
          <circle cx="16" cy="16" r="13" fill="none" stroke="#6d8bff" stroke-width="1.5" opacity="0.2" />
        </svg>
        <span>Open<span class="ping">Ping</span></span>
      </p>
      <div class="card">
        <h1>${escapeHtml(page.heading)}</h1>
        ${paragraphs}
        ${action}
        ${form}
        ${secondary}
      </div>
      ${fine}
    </main>
  </body>
</html>
`;
}
