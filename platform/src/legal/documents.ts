/**
 * The Terms of Service and the Privacy Policy, served at /terms and
 * /privacy. The text is docs/legal/TERMS.md and docs/legal/PRIVACY.md,
 * bundled as plain text (a Text module rule in wrangler.jsonc, and the same
 * in platform/vitest.config.ts), so there is one copy of each to edit.
 *
 * Each document carries a "Last updated: YYYY-MM-DD" line under its title.
 * That date is the version: an account records the Terms' version it
 * accepted at sign-up (migration 0011), so a later change can be told apart.
 */

import privacySource from "../../../docs/legal/PRIVACY.md";
import termsSource from "../../../docs/legal/TERMS.md";
import { MarkdownError, renderMarkdown } from "./markdown";

export type LegalSlug = "terms" | "privacy";

export interface LegalDocument {
  slug: LegalSlug;
  title: string;
  /** "YYYY-MM-DD", from the document's "Last updated" line. */
  updated: string;
  html: string;
  sections: { id: string; text: string }[];
}

const UPDATED_LINE = /^Last updated: (\d{4}-\d{2}-\d{2})$/m;

export function parseLegalDocument(slug: LegalSlug, source: string): LegalDocument {
  const updated = UPDATED_LINE.exec(source)?.[1];
  if (!updated || Number.isNaN(Date.parse(`${updated}T00:00:00Z`))) {
    throw new MarkdownError(`${slug}: needs a "Last updated: YYYY-MM-DD" line`);
  }
  const rendered = renderMarkdown(source.replace(UPDATED_LINE, ""));
  return { slug, updated, ...rendered };
}

export const LEGAL_DOCUMENTS: Readonly<Record<LegalSlug, LegalDocument>> = {
  terms: parseLegalDocument("terms", termsSource),
  privacy: parseLegalDocument("privacy", privacySource),
};

/** The Terms' version a new account accepts: its "Last updated" date. */
export const TERMS_VERSION = LEGAL_DOCUMENTS.terms.updated;
