import { useEffect, useState, type ReactNode } from "react";
import { Loader2, CheckCircle2, ExternalLink } from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { api, ApiError } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { Card, CardHeader, CardTitle } from "../components/ui/Card";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatusPageSettingsShape {
  status_page_enabled?: unknown;
  status_page_name?: unknown;
  status_page_description?: unknown;
  status_page_logo?: unknown;
  status_page_accent?: unknown;
  status_page_theme?: unknown;
  status_page_homepage?: unknown;
  status_page_footer?: unknown;
  status_page_attribution?: unknown;
  [key: string]: unknown;
}
interface SettingsResponse {
  settings: StatusPageSettingsShape;
}

type Theme = "light" | "dark" | "system";

const DEFAULT_ACCENT = "#6d8bff";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const d = e.data as { error?: string } | null;
    if (d && typeof d.error === "string") return d.error;
  }
  return e instanceof Error ? e.message : fallback;
}

/** Settings booleans are stored as the strings "true" / "false". */
function parseBool(v: unknown, fallback = false): boolean {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return fallback;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseTheme(v: unknown): Theme {
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function normalizeHex(v: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim() : DEFAULT_ACCENT;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function StatusPageSettings() {
  const { csrf } = useBootstrap();
  const { data, loading, error, reload } =
    useFetch<SettingsResponse>("/api/settings");

  const [enabled, setEnabled] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [logo, setLogo] = useState("");
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [theme, setTheme] = useState<Theme>("system");
  const [homepage, setHomepage] = useState("");
  const [footer, setFooter] = useState("");
  const [attribution, setAttribution] = useState(true);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const s = data?.settings;
    if (!s) return;
    setEnabled(parseBool(s.status_page_enabled));
    setName(str(s.status_page_name));
    setDescription(str(s.status_page_description));
    setLogo(str(s.status_page_logo));
    setAccent(str(s.status_page_accent) || DEFAULT_ACCENT);
    setTheme(parseTheme(s.status_page_theme));
    setHomepage(str(s.status_page_homepage));
    setFooter(str(s.status_page_footer));
    // Attribution defaults on when unset.
    setAttribution(parseBool(s.status_page_attribution, true));
  }, [data]);

  // Any change clears the "Saved" confirmation.
  function mark<T>(setter: (v: T) => void, value: T) {
    setter(value);
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await api("/api/settings", {
        method: "PUT",
        csrf: csrf ?? undefined,
        json: {
          settings: {
            status_page_enabled: enabled ? "true" : "false",
            status_page_name: name,
            status_page_description: description,
            status_page_logo: logo,
            status_page_accent: accent,
            status_page_theme: theme,
            status_page_homepage: homepage,
            status_page_footer: footer,
            status_page_attribution: attribution ? "true" : "false",
          },
        },
      });
      setSaved(true);
      void reload();
    } catch (e) {
      setSaveError(errMessage(e, "Could not save status page settings."));
    } finally {
      setSaving(false);
    }
  }

  const accentSwatch = normalizeHex(accent);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Status page</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Customize the public status page visitors see at{" "}
            <span className="font-mono text-ink-faint">/status</span>.
          </p>
        </div>
        <a
          href="/status"
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          View public page
          <ExternalLink className="size-4" />
        </a>
      </div>

      <section className="mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Customization</CardTitle>
          </CardHeader>

          {loading && !data ? (
            <div className="grid place-items-center py-10">
              <Loader2 className="size-5 animate-spin text-ink-faint" />
            </div>
          ) : error ? (
            <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
              Could not load settings: {error}
            </p>
          ) : (
            <div className="space-y-4">
              <label className="flex items-start gap-3 rounded-lg border border-line bg-surface-2/40 p-3">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => mark(setEnabled, e.target.checked)}
                  className="mt-0.5 size-4 accent-accent"
                />
                <span>
                  <span className="block text-sm font-medium text-ink">
                    Enable public status page
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-faint">
                    When off, the public page at /status is hidden.
                  </span>
                </span>
              </label>

              <Field
                label="Page name"
                hint="Shown as the heading and browser title."
              >
                <input
                  value={name}
                  onChange={(e) => mark(setName, e.target.value)}
                  placeholder="Acme Status"
                  className="input"
                />
              </Field>

              <Field
                label="Description"
                hint="A short tagline displayed under the page name."
              >
                <textarea
                  value={description}
                  onChange={(e) => mark(setDescription, e.target.value)}
                  placeholder="Live and historical status of Acme services."
                  rows={2}
                  className="input resize-y"
                />
              </Field>

              <Field label="Logo URL" hint="Optional. Displayed in the header.">
                <input
                  value={logo}
                  onChange={(e) => mark(setLogo, e.target.value)}
                  placeholder="https://example.com/logo.svg"
                  type="url"
                  className="input"
                />
              </Field>

              <Field
                label="Accent color"
                hint="Used for highlights and the operational status banner."
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={accentSwatch}
                    onChange={(e) => mark(setAccent, e.target.value)}
                    aria-label="Accent color picker"
                    className="size-9 shrink-0 cursor-pointer rounded-lg border border-line bg-surface-2"
                  />
                  <input
                    value={accent}
                    onChange={(e) => mark(setAccent, e.target.value)}
                    placeholder={DEFAULT_ACCENT}
                    className="input font-mono"
                  />
                </div>
              </Field>

              <Field label="Theme">
                <select
                  value={theme}
                  onChange={(e) => mark(setTheme, e.target.value as Theme)}
                  className="input"
                >
                  <option value="system">System (match visitor)</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </Field>

              <Field
                label="Homepage URL"
                hint="Where the logo and name link back to."
              >
                <input
                  value={homepage}
                  onChange={(e) => mark(setHomepage, e.target.value)}
                  placeholder="https://example.com"
                  type="url"
                  className="input"
                />
              </Field>

              <Field
                label="Footer text"
                hint="Optional note shown at the bottom of the page."
              >
                <textarea
                  value={footer}
                  onChange={(e) => mark(setFooter, e.target.value)}
                  placeholder="© Acme Inc. · Contact support@acme.com"
                  rows={2}
                  className="input resize-y"
                />
              </Field>

              <label className="flex items-start gap-3 rounded-lg border border-line bg-surface-2/40 p-3">
                <input
                  type="checkbox"
                  checked={attribution}
                  onChange={(e) => mark(setAttribution, e.target.checked)}
                  className="mt-0.5 size-4 accent-accent"
                />
                <span>
                  <span className="block text-sm font-medium text-ink">
                    Show "Powered by OpenPing"
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-faint">
                    Display a small attribution link in the footer.
                  </span>
                </span>
              </label>

              {saveError && (
                <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
                  {saveError}
                </p>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
                >
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  Save changes
                </button>
                {saved && !saving && (
                  <span className="inline-flex items-center gap-1.5 text-sm text-up">
                    <CheckCircle2 className="size-4" />
                    Saved
                  </span>
                )}
              </div>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared field wrapper
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}
