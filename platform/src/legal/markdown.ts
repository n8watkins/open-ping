/**
 * The small Markdown subset the legal pages are written in (docs/legal/),
 * rendered to HTML for /terms and /privacy, so the Markdown in the
 * repository stays the one copy of the text.
 *
 * Supported: `#`, `##` and `###` headings; paragraphs (one sentence per
 * line, joined with spaces); `- ` lists whose items may continue on lines
 * indented by two spaces; and, inline, `**bold**`, `` `code` ``,
 * `[text](href)` links to this site, https or mailto, bare email addresses,
 * and `[TO FILL: ...]` placeholders, which are highlighted so the owner
 * can't miss one. Anything else (tables, quotes, numbered or nested lists,
 * code blocks, raw HTML) throws, so a document can't silently render wrong.
 */

import { escapeHtml } from "../ui";

export class MarkdownError extends Error {}

/** A heading's anchor: lowercase words joined by dashes, e.g. "4. How long" -> "4-how-long". */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function safeHref(href: string): string {
  if (/^(\/(?!\/)|#|https:\/\/|mailto:)/.test(href)) return href;
  throw new MarkdownError(`link to an unsupported address: ${href}`);
}

/** Plain text with bare email addresses as mailto links. */
function textWithEmails(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(EMAIL)) {
    const address = match[0].replace(/\.$/, "");
    const at = match.index ?? 0;
    out += escapeHtml(text.slice(last, at)) + `<a href="mailto:${escapeHtml(address)}">${escapeHtml(address)}</a>`;
    last = at + address.length;
  }
  return out + escapeHtml(text.slice(last));
}

/** One line (or joined lines) of inline Markdown. */
export function renderInline(source: string): string {
  if (/<[a-z!/]/i.test(source.replace(/`[^`]*`/g, ""))) throw new MarkdownError(`raw HTML isn't supported: ${source}`);
  const token = /`([^`]+)`|\*\*(.+?)\*\*|\[TO FILL: ([^\]]+)\]|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let out = "";
  let last = 0;
  for (const match of source.matchAll(token)) {
    const at = match.index ?? 0;
    out += textWithEmails(source.slice(last, at));
    const [, code, bold, fill, linkText, href] = match;
    if (code !== undefined) out += `<code>${escapeHtml(code)}</code>`;
    else if (bold !== undefined) out += `<strong>${renderInline(bold)}</strong>`;
    else if (fill !== undefined) out += `<mark class="fill">[To fill: ${escapeHtml(fill)}]</mark>`;
    else out += `<a href="${escapeHtml(safeHref(href!))}">${renderInline(linkText!)}</a>`;
    last = at + match[0].length;
  }
  const rest = source.slice(last);
  if (/\*\*|`|\]\(/.test(rest)) throw new MarkdownError(`unbalanced inline markup: ${source}`);
  return out + textWithEmails(rest);
}

export interface RenderedMarkdown {
  /** The text of the `#` heading. */
  title: string;
  /** Everything after the title, as HTML. */
  html: string;
  /** The `##` headings, for a table of contents. */
  sections: { id: string; text: string }[];
}

/** Renders a whole document: its first line must be the `#` title. */
export function renderMarkdown(source: string): RenderedMarkdown {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let title: string | null = null;
  const out: string[] = [];
  const sections: { id: string; text: string }[] = [];
  let paragraph: string[] = [];
  let list: string[][] | null = null;

  const flush = () => {
    if (paragraph.length) out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
    if (list) out.push(`<ul>${list.map((item) => `<li>${renderInline(item.join(" "))}</li>`).join("")}</ul>`);
    list = null;
  };

  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    const where = `line ${index + 1}`;
    if (line === "") return flush();
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      if (level === 1) {
        if (title !== null || out.length) throw new MarkdownError(`${where}: only the first line may be a # title`);
        title = text;
        return;
      }
      if (level > 3) throw new MarkdownError(`${where}: headings go down to ### only`);
      const id = headingId(text);
      if (level === 2) sections.push({ id, text });
      out.push(`<h${level} id="${escapeHtml(id)}">${renderInline(text)}</h${level}>`);
      return;
    }
    if (/^- /.test(line)) {
      if (paragraph.length) {
        out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
        paragraph = [];
      }
      (list ??= []).push([line.slice(2).trim()]);
      return;
    }
    if (/^ {2}\S/.test(line) && list) {
      if (/^ {2}(- |\d+\. )/.test(line)) throw new MarkdownError(`${where}: nested lists aren't supported`);
      list[list.length - 1]!.push(line.trim());
      return;
    }
    if (/^(\s|>|\||```|\d+\. |\* |\+ |<)/.test(line)) throw new MarkdownError(`${where}: unsupported Markdown: ${line}`);
    if (list) flush();
    paragraph.push(line);
  });
  flush();
  if (title === null) throw new MarkdownError("the document needs a # title on its first line");
  return { title, html: out.join("\n"), sections };
}
