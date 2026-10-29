import { describe, expect, it } from "vitest";

import { LEGAL_DOCUMENTS, TERMS_VERSION, parseLegalDocument } from "./documents";
import { MarkdownError, headingId, renderInline, renderMarkdown } from "./markdown";

describe("renderInline", () => {
  it("escapes text and renders the supported marks", () => {
    expect(renderInline("a < b & **bold** and `x <y>`")).toBe("a &lt; b &amp; <strong>bold</strong> and <code>x &lt;y&gt;</code>");
  });

  it("links local, https and mailto addresses, and bare emails", () => {
    expect(renderInline("See [the policy](/privacy) or [docs](https://example.com/a).")).toBe(
      'See <a href="/privacy">the policy</a> or <a href="https://example.com/a">docs</a>.',
    );
    expect(renderInline("Write to support@n8builds.dev.")).toBe('Write to <a href="mailto:support@n8builds.dev">support@n8builds.dev</a>.');
  });

  it("highlights placeholders", () => {
    expect(renderInline("Run by [TO FILL: legal name].")).toBe('Run by <mark class="fill">[To fill: legal name]</mark>.');
  });

  it("refuses raw HTML, unsafe links and unbalanced marks", () => {
    expect(() => renderInline("<script>x</script>")).toThrow(MarkdownError);
    expect(() => renderInline("[x](javascript:alert(1))")).toThrow(MarkdownError);
    expect(() => renderInline("[x](//evil.example)")).toThrow(MarkdownError);
    expect(() => renderInline("**open")).toThrow(MarkdownError);
  });
});

describe("renderMarkdown", () => {
  it("joins one-sentence lines into paragraphs and renders lists with continued items", () => {
    const out = renderMarkdown("# Title\n\nOne.\nTwo.\n\n## 1. Part\n\n- First.\n  More.\n- Second.\nAfter.\n");
    expect(out.title).toBe("Title");
    expect(out.sections).toEqual([{ id: "1-part", text: "1. Part" }]);
    expect(out.html).toBe('<p>One. Two.</p>\n<h2 id="1-part">1. Part</h2>\n<ul><li>First. More.</li><li>Second.</li></ul>\n<p>After.</p>');
  });

  it("refuses what it can't render", () => {
    for (const body of ["| a | b |", "> quote", "1. one", "```", "#### deep", "- a\n  - nested", "<div>"]) {
      expect(() => renderMarkdown(`# T\n\n${body}\n`), body).toThrow(MarkdownError);
    }
    expect(() => renderMarkdown("No title")).toThrow(MarkdownError);
    expect(() => renderMarkdown("# A\n\n# B")).toThrow(MarkdownError);
  });

  it("makes heading ids", () => {
    expect(headingId("13. The OpenPing website (openping.n8builds.dev)")).toBe("13-the-openping-website-openpingn8buildsdev");
  });
});

describe("the legal documents", () => {
  it("render from docs/legal with a title, a date and sections", () => {
    for (const doc of Object.values(LEGAL_DOCUMENTS)) {
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(doc.sections.length).toBeGreaterThan(5);
      expect(doc.html).not.toContain("Last updated");
      expect(doc.html).not.toContain("—");
    }
    expect(LEGAL_DOCUMENTS.terms.title).toBe("Terms of Service");
    expect(LEGAL_DOCUMENTS.privacy.title).toBe("Privacy Policy");
    expect(TERMS_VERSION).toBe(LEGAL_DOCUMENTS.terms.updated);
  });

  it("needs a valid Last updated line", () => {
    expect(() => parseLegalDocument("terms", "# T\n\nText.")).toThrow(/Last updated/);
    expect(() => parseLegalDocument("terms", "# T\n\nLast updated: 2026-13-45\n")).toThrow(/Last updated/);
  });
});
