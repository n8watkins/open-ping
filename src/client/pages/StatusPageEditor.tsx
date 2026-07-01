import {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { useFetch } from "../lib/useFetch";
import { Card } from "../components/ui/Card";
import { cn } from "../lib/cn";
import type { Category, StatusPage } from "../lib/types";

/**
 * Create / edit a status page (PRD §16). Mirrors `statusPageSchema`: slug,
 * branding (name, description, theme, accent, logo, homepage, footer,
 * attribution), a kill switch, and a monitor selection (all / by category /
 * specific monitors). The form holds flat local state and POSTs on new / PUTs on
 * edit; the worker re-validates with zod and returns `{ issues }` on 400 (409 on
 * a slug clash), which we surface inline.
 */

type Theme = "dark" | "light" | "system";
type IncludeMode = "all" | "categories" | "monitors";

const DEFAULT_ACCENT = "#6d8bff";

/** Hex color pattern the server accepts (see shared/schemas.ts): #rgb or #rrggbb. */
const ACCENT_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SLUG_PATTERN = /^[a-z0-9-]+$/;

function isValidAccent(v: string): boolean {
  return ACCENT_PATTERN.test(v.trim());
}

/**
 * A `#rrggbb` value for the native color input, which only accepts 6-digit hex:
 * expand a valid `#rgb`, pass `#rrggbb` through, else fall back to the default.
 */
function accentSwatchValue(v: string): string {
  const t = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t;
  if (/^#[0-9a-fA-F]{3}$/.test(t)) {
    const [, r, g, b] = t;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return DEFAULT_ACCENT;
}

interface FormState {
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  theme: Theme;
  accent: string;
  logo: string;
  homepage: string;
  footer: string;
  attribution: boolean;
  includeMode: IncludeMode;
  categoryIds: string[];
  monitorIds: string[];
}

interface MonitorOption {
  id: string;
  name: string;
}

function initialForm(): FormState {
  return {
    slug: "",
    name: "",
    description: "",
    enabled: true,
    theme: "dark",
    accent: DEFAULT_ACCENT,
    logo: "",
    homepage: "",
    footer: "",
    attribution: true,
    includeMode: "all",
    categoryIds: [],
    monitorIds: [],
  };
}

function prefill(p: StatusPage): FormState {
  return {
    slug: p.slug,
    name: p.name,
    description: p.description ?? "",
    enabled: p.enabled,
    theme: p.theme,
    accent: p.accent || DEFAULT_ACCENT,
    logo: p.logo ?? "",
    homepage: p.homepage ?? "",
    footer: p.footer ?? "",
    attribution: p.attribution,
    includeMode: p.includeMode,
    categoryIds: p.categoryIds ?? [],
    monitorIds: p.monitorIds ?? [],
  };
}

function toggle<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

/** Pull human-readable messages out of a worker error (400 issues / 409 slug). */
function errorMessages(err: unknown): string[] {
  if (err instanceof ApiError) {
    if (err.status === 409)
      return ["That slug is already in use by another status page."];
    if (
      err.status === 400 &&
      err.data &&
      typeof err.data === "object" &&
      "issues" in err.data
    ) {
      const issues = (err.data as { issues?: unknown }).issues;
      if (Array.isArray(issues) && issues.length > 0) {
        return issues.map((raw) => {
          const i = raw as { path?: unknown[]; message?: string };
          const path = Array.isArray(i.path) ? i.path.join(".") : "";
          const msg = i.message ?? "Invalid value";
          return path ? `${path}: ${msg}` : msg;
        });
      }
    }
  }
  if (err instanceof Error) return [err.message];
  return ["Could not save the status page."];
}

export default function StatusPageEditor() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { csrf } = useBootstrap();

  const [form, setForm] = useState<FormState>(initialForm);
  const [isDefault, setIsDefault] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Selection sources (cheap lists; fetched regardless of the current mode so
  // switching modes is instant).
  const { data: catData } = useFetch<{ categories: Category[] }>(
    "/api/categories",
  );
  const { data: monData } = useFetch<{ monitors: MonitorOption[] }>(
    "/api/monitors",
  );
  const categories = catData?.categories ?? [];
  const monitors = monData?.monitors ?? [];

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { statusPage } = await api<{ statusPage: StatusPage }>(
          `/api/status-pages/${id}`,
        );
        if (cancelled) return;
        setForm(prefill(statusPage));
        setIsDefault(statusPage.isDefault);
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof Error ? e.message : "Could not load this status page.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }) as FormState);
  }

  function buildPayload(): Record<string, unknown> {
    return {
      slug: form.slug.trim(),
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      enabled: form.enabled,
      includeMode: form.includeMode,
      categoryIds: form.includeMode === "categories" ? form.categoryIds : [],
      monitorIds: form.includeMode === "monitors" ? form.monitorIds : [],
      theme: form.theme,
      accent: form.accent.trim(),
      // optionalUrl accepts "" or a valid URL; send trimmed values as-is.
      logo: form.logo.trim(),
      homepage: form.homepage.trim(),
      footer: form.footer.trim() || undefined,
      attribution: form.attribution,
    };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    // Client-side guards for the two constraints worth catching before a round
    // trip: the slug pattern and the accent hex (mirrors the server regexes).
    const localErrors: string[] = [];
    if (!form.name.trim()) localErrors.push("Name is required.");
    if (!SLUG_PATTERN.test(form.slug.trim()))
      localErrors.push(
        "Slug must be lowercase letters, numbers, and hyphens.",
      );
    if (!isValidAccent(form.accent))
      localErrors.push("Accent must be a 3- or 6-digit hex color, e.g. #6d8bff.");
    if (localErrors.length > 0) {
      setErrors(localErrors);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    setSaving(true);
    setErrors([]);
    try {
      await api<{ statusPage: { id: string } }>(
        isEdit ? `/api/status-pages/${id}` : "/api/status-pages",
        {
          method: isEdit ? "PUT" : "POST",
          json: buildPayload(),
          csrf: csrf ?? undefined,
        },
      );
      navigate("/status-page");
    } catch (err) {
      setErrors(errorMessages(err));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSaving(false);
    }
  }

  const accentValid = isValidAccent(form.accent);
  const accentSwatch = accentSwatchValue(form.accent);

  if (loading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          {loadError}
        </div>
        <Link
          to="/status-page"
          className="mt-4 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="size-4" /> Back to status pages
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <Link
          to="/status-page"
          className="inline-flex items-center gap-1.5 text-xs text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="size-3.5" />
          Back to status pages
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">
          {isEdit ? "Edit status page" : "New status page"}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Configure a public status page — its branding and which monitors it
          shows.
        </p>
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down"
        >
          <p className="font-medium">Please fix the following:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {errors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* 1. Basics */}
        <FormCard title="Basics">
          <Field label="Name" required>
            <input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Acme Status"
              required
              className="input"
            />
          </Field>

          <Field
            label="Slug"
            required
            hint={
              isDefault
                ? "The default page is served at /status; its slug can't be changed."
                : "Public URL path: /status/<slug>. Lowercase letters, numbers, and hyphens."
            }
          >
            <input
              value={form.slug}
              onChange={(e) => set("slug", e.target.value)}
              placeholder="acme"
              disabled={isDefault}
              required
              className="input font-mono disabled:opacity-60"
            />
          </Field>

          <Field
            label="Description"
            hint="A short tagline displayed under the page name."
          >
            <textarea
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Live and historical status of Acme services."
              rows={2}
              className="input resize-y"
            />
          </Field>

          <Checkbox
            label="Enabled"
            checked={form.enabled}
            onChange={(v) => set("enabled", v)}
          />
          <p className="-mt-2 text-xs text-ink-faint">
            When off, this public page is hidden.
          </p>
        </FormCard>

        {/* 2. Branding */}
        <FormCard
          title="Branding"
          description="How this page looks to visitors."
        >
          <Field label="Theme">
            <select
              value={form.theme}
              onChange={(e) => set("theme", e.target.value as Theme)}
              className="input"
            >
              <option value="system">System (match visitor)</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </Field>

          <Field
            label="Accent color"
            hint="Used for highlights and the operational status banner."
          >
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={accentSwatch}
                onChange={(e) => set("accent", e.target.value)}
                aria-label="Accent color picker"
                className="size-9 shrink-0 cursor-pointer rounded-lg border border-line bg-surface-2"
              />
              <input
                value={form.accent}
                onChange={(e) => set("accent", e.target.value)}
                placeholder={DEFAULT_ACCENT}
                aria-invalid={!accentValid}
                className={cn("input font-mono", !accentValid && "border-down")}
              />
            </div>
            {!accentValid && (
              <p role="alert" className="mt-1.5 text-xs text-down">
                Use a 3- or 6-digit hex color, e.g. #6d8bff.
              </p>
            )}
          </Field>

          <Field label="Logo URL" hint="Optional. Displayed in the header.">
            <input
              value={form.logo}
              onChange={(e) => set("logo", e.target.value)}
              placeholder="https://example.com/logo.svg"
              type="url"
              className="input"
            />
          </Field>

          <Field
            label="Homepage URL"
            hint="Optional. Where the logo and name link back to."
          >
            <input
              value={form.homepage}
              onChange={(e) => set("homepage", e.target.value)}
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
              value={form.footer}
              onChange={(e) => set("footer", e.target.value)}
              placeholder="© Acme Inc. · Contact support@acme.com"
              rows={2}
              className="input resize-y"
            />
          </Field>

          <Checkbox
            label={'Show "Powered by OpenPing"'}
            checked={form.attribution}
            onChange={(v) => set("attribution", v)}
          />
        </FormCard>

        {/* 3. Monitor selection */}
        <FormCard
          title="Monitors"
          description="Choose which monitors appear on this page."
        >
          <div className="space-y-2">
            <ModeRadio
              value="all"
              current={form.includeMode}
              onChange={(v) => set("includeMode", v)}
              label="All visible monitors"
              hint="Every monitor marked public."
            />
            <ModeRadio
              value="categories"
              current={form.includeMode}
              onChange={(v) => set("includeMode", v)}
              label="By category"
              hint="Public monitors in the selected categories."
            />
            <ModeRadio
              value="monitors"
              current={form.includeMode}
              onChange={(v) => set("includeMode", v)}
              label="Specific monitors"
              hint="Only the monitors you pick below."
            />
          </div>

          {form.includeMode === "categories" && (
            <Field label="Categories">
              {categories.length === 0 ? (
                <p className="text-xs text-ink-faint">
                  No categories yet. Create categories on the status pages
                  screen first.
                </p>
              ) : (
                <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-line bg-surface p-2.5">
                  {categories.map((c) => (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-2 text-sm text-ink"
                    >
                      <input
                        type="checkbox"
                        checked={form.categoryIds.includes(c.id)}
                        onChange={() =>
                          set("categoryIds", toggle(form.categoryIds, c.id))
                        }
                        className="size-4 accent-accent"
                      />
                      <span className="truncate">{c.name}</span>
                      <span className="truncate font-mono text-xs text-ink-faint">
                        {c.slug}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </Field>
          )}

          {form.includeMode === "monitors" && (
            <Field label="Monitors">
              {monitors.length === 0 ? (
                <p className="text-xs text-ink-faint">No monitors available.</p>
              ) : (
                <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-line bg-surface p-2.5">
                  {monitors.map((m) => (
                    <label
                      key={m.id}
                      className="flex cursor-pointer items-center gap-2 text-sm text-ink"
                    >
                      <input
                        type="checkbox"
                        checked={form.monitorIds.includes(m.id)}
                        onChange={() =>
                          set("monitorIds", toggle(form.monitorIds, m.id))
                        }
                        className="size-4 accent-accent"
                      />
                      <span className="truncate">{m.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </Field>
          )}
        </FormCard>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-1">
          <Link
            to="/status-page"
            className="inline-flex items-center rounded-lg px-3 py-2 text-sm text-ink-muted transition-colors hover:text-ink"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {isEdit ? "Save changes" : "Create status page"}
          </button>
        </div>
      </form>
    </div>
  );
}

// --- Small presentational helpers ---

function FormCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
        )}
      </div>
      {children}
    </Card>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-muted">
        {label}
        {required && (
          <span className="text-down" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-accent"
      />
      {label}
    </label>
  );
}

function ModeRadio({
  value,
  current,
  onChange,
  label,
  hint,
}: {
  value: IncludeMode;
  current: IncludeMode;
  onChange: (v: IncludeMode) => void;
  label: string;
  hint: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
        current === value
          ? "border-accent bg-accent-soft"
          : "border-line bg-surface-2/40 hover:bg-surface-2",
      )}
    >
      <input
        type="radio"
        name="includeMode"
        checked={current === value}
        onChange={() => onChange(value)}
        className="mt-0.5 size-4 accent-accent"
      />
      <span>
        <span className="block text-sm font-medium text-ink">{label}</span>
        <span className="mt-0.5 block text-xs text-ink-faint">{hint}</span>
      </span>
    </label>
  );
}
