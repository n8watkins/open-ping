import { useState, type FormEvent, type ReactNode } from "react";
import { Loader2, Plus, Pencil, Trash2, X, Tags } from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { api, ApiError } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { Card, CardHeader, CardTitle } from "./ui/Card";
import { EmptyState } from "./ui/EmptyState";
import { cn } from "../lib/cn";
import type { Category } from "../lib/types";

/**
 * Inline manager for monitor categories (PRD §16). Self-contained: lists
 * categories from GET /api/categories and creates / renames / deletes them in
 * place via POST/PUT/DELETE /api/categories. Categories group monitors and back
 * the per-category selection on status pages; deleting one only un-assigns its
 * monitors (the backend nulls the FK), so the confirm says as much.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a URL-safe slug (lowercase-hyphen) from a free-text name. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const SLUG_PATTERN = /^[a-z0-9-]+$/;

/** Turn an API failure into a human message, mapping the 409 slug conflict. */
function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 409) return "That slug is already in use.";
    const d = e.data as { error?: string; issues?: unknown } | null;
    if (d && Array.isArray(d.issues) && d.issues.length > 0) {
      const first = d.issues[0] as { message?: string };
      if (first.message) return first.message;
    }
    if (d && typeof d.error === "string") return d.error;
  }
  return e instanceof Error ? e.message : fallback;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export function CategoriesManager() {
  const { csrf } = useBootstrap();
  const { data, loading, error, reload } =
    useFetch<{ categories: Category[] }>("/api/categories");
  const categories = data?.categories ?? [];

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<string | null>(null);

  async function remove(cat: Category) {
    if (
      !window.confirm(
        `Delete category "${cat.name}"? Monitors in this category will be ` +
          `un-assigned (the monitors themselves are not deleted).`,
      )
    )
      return;
    setRowBusy((m) => ({ ...m, [cat.id]: true }));
    setRowError(null);
    try {
      await api(`/api/categories/${cat.id}`, {
        method: "DELETE",
        csrf: csrf ?? undefined,
      });
      await reload();
    } catch (e) {
      setRowError(errMessage(e, "Could not delete the category."));
    } finally {
      setRowBusy((m) => ({ ...m, [cat.id]: false }));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Categories</CardTitle>
        {!adding && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setEditingId(null);
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover"
          >
            <Plus className="size-4" />
            New category
          </button>
        )}
      </CardHeader>

      <p className="-mt-1 mb-3 text-sm text-ink-muted">
        Group monitors into categories to build per-category status pages.
      </p>

      {adding && (
        <div className="mb-4">
          <CategoryForm
            existing={null}
            csrf={csrf ?? undefined}
            onSaved={() => {
              setAdding(false);
              void reload();
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {rowError && (
        <p className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          {rowError}
        </p>
      )}

      {loading && !data ? (
        <div className="grid place-items-center py-10">
          <Loader2 className="size-5 animate-spin text-ink-faint" />
        </div>
      ) : error ? (
        <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          Could not load categories: {error}
        </p>
      ) : categories.length === 0 && !adding ? (
        <EmptyState
          icon={<Tags className="size-6 text-accent" />}
          title="No categories yet"
          description="Create a category to organize monitors and drive focused status pages."
        />
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {categories.map((c) =>
            editingId === c.id ? (
              <div key={c.id} className="p-3">
                <CategoryForm
                  existing={c}
                  csrf={csrf ?? undefined}
                  onSaved={() => {
                    setEditingId(null);
                    void reload();
                  }}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            ) : (
              <CategoryRow
                key={c.id}
                category={c}
                busy={!!rowBusy[c.id]}
                onEdit={() => {
                  setEditingId(c.id);
                  setAdding(false);
                }}
                onDelete={() => void remove(c)}
              />
            ),
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function CategoryRow({
  category,
  busy,
  onEdit,
  onDelete,
}: {
  category: Category;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{category.name}</div>
        <div className="mt-0.5 font-mono text-xs text-ink-faint">
          {category.slug}
        </div>
        {category.description && (
          <p className="mt-1 max-w-prose text-xs text-ink-muted">
            {category.description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton title="Edit" onClick={onEdit} disabled={busy}>
          <Pencil className="size-4" />
        </IconButton>
        <IconButton title="Delete" onClick={onDelete} disabled={busy} danger>
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
        </IconButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit form
// ---------------------------------------------------------------------------

function CategoryForm({
  existing,
  csrf,
  onSaved,
  onCancel,
}: {
  existing: Category | null;
  csrf: string | undefined;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isEdit = existing != null;
  const [name, setName] = useState(existing?.name ?? "");
  const [slug, setSlug] = useState(existing?.slug ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  // Keep the slug in sync with the name until the user types a slug themselves.
  // On edit we start "touched" so an existing slug is never silently rewritten.
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onNameChange(v: string) {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (!SLUG_PATTERN.test(trimmedSlug)) {
      setError("Slug must be lowercase letters, numbers, and hyphens.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: trimmedName,
        slug: trimmedSlug,
        description: description.trim() || undefined,
      };
      if (isEdit && existing) {
        await api(`/api/categories/${existing.id}`, {
          method: "PUT",
          csrf,
          json: payload,
        });
      } else {
        await api("/api/categories", { method: "POST", csrf, json: payload });
      }
      onSaved();
    } catch (err) {
      setError(errMessage(err, "Could not save the category."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-line bg-surface-2/40 p-4"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">
          {isEdit ? "Edit category" : "New category"}
        </h4>
        <button
          type="button"
          onClick={onCancel}
          className="grid size-7 place-items-center rounded-lg text-ink-muted hover:bg-surface-2 hover:text-ink"
          aria-label="Cancel"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g. Core APIs"
            className="input"
            required
          />
        </Field>
        <Field label="Slug" hint="Lowercase letters, numbers, and hyphens.">
          <input
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            placeholder="core-apis"
            className="input font-mono"
            required
          />
        </Field>
      </div>

      <Field label="Description (optional)">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short note about this category."
          className="input"
        />
      </Field>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down"
        >
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          {isEdit ? "Save changes" : "Create category"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-2 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
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

function IconButton({
  children,
  title,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid size-8 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40",
        danger && "hover:text-down",
      )}
    >
      {children}
    </button>
  );
}
