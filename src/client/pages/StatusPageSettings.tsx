import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  ExternalLink,
  Star,
  LayoutTemplate,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { api, ApiError } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { CategoriesManager } from "../components/CategoriesManager";
import type { StatusPage } from "../lib/types";

/**
 * Status-page management screen (PRD §16). Lists the published public pages from
 * GET /api/status-pages — each with its slug, enabled state, default badge, a
 * link to its public view, and edit/delete actions — plus an inline categories
 * manager. Per-page branding and monitor selection are edited on the dedicated
 * editor at /status-page/new and /status-page/:id. The default page is served at
 * /status and cannot be deleted, so its delete action is hidden.
 */

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const d = e.data as { error?: string; message?: string } | null;
    if (e.status === 400 && d?.error === "default_not_deletable")
      return "The default status page cannot be deleted.";
    if (d && typeof d.message === "string") return d.message;
    if (d && typeof d.error === "string") return d.error;
  }
  return e instanceof Error ? e.message : fallback;
}

/** Public URL for a page: the default page lives at /status, others at /status/<slug>. */
function publicHref(page: StatusPage): string {
  return page.isDefault ? "/status" : `/status/${page.slug}`;
}

export default function StatusPageSettings() {
  const { csrf } = useBootstrap();
  const { data, loading, error, reload } =
    useFetch<{ statusPages: StatusPage[] }>("/api/status-pages");
  const pages = data?.statusPages ?? [];

  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<string | null>(null);

  async function remove(page: StatusPage) {
    if (
      !window.confirm(
        `Delete status page "${page.name}"? This cannot be undone.`,
      )
    )
      return;
    setRowBusy((m) => ({ ...m, [page.id]: true }));
    setRowError(null);
    try {
      await api(`/api/status-pages/${page.id}`, {
        method: "DELETE",
        csrf: csrf ?? undefined,
      });
      await reload();
    } catch (e) {
      setRowError(errMessage(e, "Could not delete the status page."));
    } finally {
      setRowBusy((m) => ({ ...m, [page.id]: false }));
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Status pages</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Publish one or more public status pages, each with its own branding
            and monitor selection.
          </p>
        </div>
        <Link
          to="/status-page/new"
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover"
        >
          <Plus className="size-4" />
          New status page
        </Link>
      </div>

      {rowError && (
        <p className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          {rowError}
        </p>
      )}

      {loading && !data ? (
        <div className="mt-6 grid place-items-center py-10">
          <Loader2 className="size-5 animate-spin text-ink-faint" />
        </div>
      ) : error ? (
        <p className="mt-6 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          Could not load status pages: {error}
        </p>
      ) : pages.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<LayoutTemplate className="size-6 text-accent" />}
            title="No status pages yet"
            description="Create a public status page to share live and historical uptime with your users."
            action={
              <Link
                to="/status-page/new"
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover"
              >
                <Plus className="size-4" />
                New status page
              </Link>
            }
          />
        </div>
      ) : (
        <Card className="mt-6 divide-y divide-line p-0">
          {pages.map((p) => (
            <StatusPageRow
              key={p.id}
              page={p}
              busy={!!rowBusy[p.id]}
              onDelete={() => void remove(p)}
            />
          ))}
        </Card>
      )}

      <section className="mt-8">
        <CategoriesManager />
      </section>
    </div>
  );
}

function StatusPageRow({
  page,
  busy,
  onDelete,
}: {
  page: StatusPage;
  busy: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{page.name}</span>
          {page.isDefault && (
            <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">
              <Star className="size-3" />
              Default
            </span>
          )}
          <EnabledPill enabled={page.enabled} />
        </div>
        <div className="mt-0.5 font-mono text-xs text-ink-faint">
          {page.isDefault ? "/status" : `/status/${page.slug}`}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <a
          href={publicHref(page)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          View public page
          <ExternalLink className="size-3.5" />
        </a>
        <Link
          to={`/status-page/${page.id}`}
          title="Edit"
          aria-label="Edit"
          className="grid size-8 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Pencil className="size-4" />
        </Link>
        {!page.isDefault && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            title="Delete"
            aria-label="Delete"
            className="grid size-8 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-down disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function EnabledPill({ enabled }: { enabled: boolean }) {
  if (enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-up/40 bg-up/10 px-2.5 py-0.5 text-[11px] font-medium text-up">
        <span className="size-1.5 rounded-full bg-up" />
        Enabled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium text-ink-faint">
      <span className="size-1.5 rounded-full bg-paused" />
      Disabled
    </span>
  );
}
