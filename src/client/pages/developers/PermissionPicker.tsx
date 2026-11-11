import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Lock, Search } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  ACTION_LABEL,
  ACTIONS,
  PERMISSION_CATEGORIES,
  PERMISSION_TEMPLATES,
  PERMISSIONS,
  RESOURCES,
  grantedResources,
  implies,
  permission,
  type Action,
  type Permission,
  type Resource,
} from "../../../shared/scopes";

export interface PermissionSelection {
  /** Ticked permissions; implied reads are always in here too. */
  granted: ReadonlySet<Permission>;
  /** Full access (admin): everything, the list is ignored. */
  full: boolean;
}

export const EMPTY_SELECTION: PermissionSelection = {
  granted: new Set(),
  full: false,
};

/** Add what ticked actions imply (Edit ticks Read), so what is ticked is what the token gets. */
function withImplied(perms: Iterable<Permission>): Set<Permission> {
  const out = new Set(perms);
  for (const p of [...out]) for (const q of implies(p)) out.add(q);
  return out;
}

/** The ticked action of the same resource that needs `action`, so its box stays ticked; null when none does. */
function lockedBy(granted: ReadonlySet<Permission>, resource: Resource, action: Action): Action | null {
  const p = `${resource.id}:${action}` as Permission;
  return (
    resource.actions.find(
      (a) =>
        a !== action &&
        granted.has(`${resource.id}:${a}` as Permission) &&
        implies(`${resource.id}:${a}` as Permission).includes(p),
    ) ?? null
  );
}

const CATEGORIES = PERMISSION_CATEGORIES.map((c) => ({
  id: c.id,
  label: c.label,
  resources: RESOURCES.filter((r) => r.categoryId === c.id),
}));

/**
 * Developers > API tokens: pick a token's permissions like a cloud console. Categories collapse to a row with a
 * granted / total counter; each resource row has a checkbox per action it supports. Nothing is ticked to start.
 */
export function PermissionPicker({
  value,
  onChange,
}: {
  value: PermissionSelection;
  onChange: (next: PermissionSelection) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const { granted, full } = value;
  const q = query.trim().toLowerCase();

  const visible = useMemo(
    () =>
      CATEGORIES.map((c) => ({
        ...c,
        resources:
          q === ""
            ? c.resources
            : c.resources.filter((r) =>
                [c.label, r.label, r.description, r.id, ...Object.values(r.grants)].some((t) => t.toLowerCase().includes(q)),
              ),
      })).filter((c) => c.resources.length > 0),
    [q],
  );

  function set(perms: Iterable<Permission>) {
    onChange({ granted: withImplied(perms), full });
  }

  function toggle(resource: Resource, action: Action, on: boolean) {
    const p = permission(resource.id, action);
    if (!p) return;
    const next = new Set(granted);
    if (on) next.add(p);
    else next.delete(p);
    set(next);
  }

  function toggleOpen(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search permissions</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search permissions..."
            disabled={full}
            className="input pl-9"
          />
        </label>
        <BulkSelect disabled={full} onPick={set} />
      </div>

      <fieldset disabled={full} className={cn("min-w-0", full && "opacity-50")}>
        <legend className="sr-only">Permissions</legend>
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {visible.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-ink-muted">No permission matches &ldquo;{query}&rdquo;.</li>
          )}
          {visible.map((c) => {
            // The counter always covers the whole category, even while a search narrows its rows.
            const all = CATEGORIES.find((x) => x.id === c.id)!.resources;
            const total = all.reduce((n, r) => n + r.actions.length, 0);
            const count = full
              ? total
              : all.reduce((n, r) => n + r.actions.filter((a) => granted.has(`${r.id}:${a}` as Permission)).length, 0);
            const expanded = q !== "" || open.has(c.id);
            const panelId = `perm-cat-${c.id}`;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={expanded ? panelId : undefined}
                  aria-describedby={`${panelId}-count`}
                  onClick={() => toggleOpen(c.id)}
                  className="flex w-full items-center gap-2.5 bg-surface px-3.5 py-3 text-left transition-colors hover:bg-surface-2/50"
                >
                  <ChevronRight
                    aria-hidden
                    className={cn("size-4 shrink-0 text-ink-faint transition-transform duration-150", expanded && "rotate-90")}
                  />
                  <span className="min-w-0 flex-1 text-sm font-semibold text-ink">{c.label}</span>
                  <span
                    aria-hidden
                    className={cn(
                      "rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums",
                      count > 0 ? "bg-accent-soft text-accent" : "text-ink-faint",
                    )}
                  >
                    {count}/{total}
                  </span>
                </button>
                <span id={`${panelId}-count`} hidden>
                  {`${count} of ${total} granted`}
                </span>
                {expanded && (
                  <ul id={panelId} className="divide-y divide-line/70 border-t border-line/70 bg-surface-2/20">
                    {c.resources.map((r) => (
                      <ResourceRow key={r.id} resource={r} granted={granted} full={full} onToggle={toggle} />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>

      <FullAccess checked={full} onChange={(on) => onChange({ granted, full: on })} />
    </div>
  );
}

function ResourceRow({
  resource: r,
  granted,
  full,
  onToggle,
}: {
  resource: Resource;
  granted: ReadonlySet<Permission>;
  full: boolean;
  onToggle: (r: Resource, a: Action, on: boolean) => void;
}) {
  return (
    <li className="flex flex-col gap-2.5 py-3 pr-3.5 pl-[2.375rem] sm:flex-row sm:pl-10 sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{r.label}</p>
        <p className="text-xs text-ink-muted">{r.description}</p>
      </div>
      <div
        role="group"
        aria-label={`${r.label} actions`}
        className="flex shrink-0 flex-wrap gap-1 sm:grid sm:grid-cols-2"
      >
        {ACTIONS.map((a) => {
          if (!r.actions.includes(a)) return <span key={a} aria-hidden className="hidden w-[4.75rem] sm:block" />;
          const p = `${r.id}:${a}` as Permission;
          const locked = lockedBy(granted, r, a);
          const checked = full || granted.has(p);
          return (
            <label
              key={a}
              title={locked ? `Included with ${ACTION_LABEL[locked]}` : r.grants[a]}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 min-w-[4.75rem] rounded-md border px-2 py-1.5 text-xs font-medium transition-colors select-none",
                checked
                  ? "border-accent/50 bg-accent-soft/50 text-ink"
                  : "border-line bg-surface text-ink-muted hover:border-ink-faint/60",
                locked && "cursor-default",
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={!!locked}
                onChange={(e) => onToggle(r, a, e.target.checked)}
                aria-label={`${r.label}: ${ACTION_LABEL[a]}${locked ? ` (included with ${ACTION_LABEL[locked]})` : ""}`}
                className="size-3.5 shrink-0 accent-accent"
              />
              {ACTION_LABEL[a]}
            </label>
          );
        })}
      </div>
    </li>
  );
}

function FullAccess({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors",
        checked ? "border-degraded/60 bg-degraded/10" : "border-dashed border-line hover:border-ink-faint/60",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--color-degraded)]"
      />
      <span className="min-w-0 text-sm">
        <span className="font-semibold text-ink">Full access</span>
        <span className="text-ink-muted">: everything, including settings, security, backups and anything added later</span>
        <span className="mt-1.5 flex items-start gap-1.5 text-xs text-degraded">
          <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
          Anyone holding it can delete monitors, change alert channels and export all your data. Only for your own CLI; give an
          agent or a script just the permissions above.
        </span>
      </span>
    </label>
  );
}

/** "Bulk select": quick ways to tick boxes. They only tick boxes; the list shows what they did. */
function BulkSelect({ disabled, onPick }: { disabled: boolean; onPick: (perms: Iterable<Permission>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  function pick(perms: Iterable<Permission>) {
    onPick(perms);
    setOpen(false);
  }

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  }

  const item =
    "flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-ink outline-none hover:bg-surface-2 focus-visible:bg-surface-2";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-full w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50 sm:w-auto"
      >
        Bulk select
        <ChevronDown aria-hidden className={cn("size-4 text-ink-faint transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Bulk select"
          onKeyDown={onMenuKey}
          className="absolute right-0 z-20 mt-1.5 w-full min-w-64 animate-enter rounded-lg border border-line bg-surface p-1 shadow-lg sm:w-72"
        >
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => pick(PERMISSIONS.filter((p) => p.endsWith(":read")))}
          >
            All read
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => pick(PERMISSIONS.filter((p) => p.endsWith(":read") || p.endsWith(":edit")))}
          >
            All read and edit
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => pick([])}>
            Clear all
          </button>
          <div role="separator" className="my-1 border-t border-line" />
          <p className="px-2.5 pt-1 pb-0.5 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Start from</p>
          {PERMISSION_TEMPLATES.map((t) => (
            <button key={t.id} type="button" role="menuitem" className={item} onClick={() => pick(t.scopes)}>
              <span className="min-w-0">
                <span className="block">{t.label}</span>
                <span className="block text-xs text-ink-muted">{t.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Below the list: exactly what the token will be able to do, in plain words, updated as boxes are ticked. */
export function PermissionSummary({ value }: { value: PermissionSelection }) {
  const groups = grantedResources([...value.granted]);
  return (
    <section
      aria-live="polite"
      aria-label="What this token can do"
      className="rounded-lg border border-line bg-surface-2/30 p-3.5"
    >
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">What this token can do</h3>
      {value.full ? (
        <p className="flex items-start gap-2 text-sm text-ink">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-degraded" />
          Everything: every permission above, settings, security, backups and anything added later. It still can&apos;t create or
          revoke tokens; only you, signed in here, can.
        </p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing yet. Tick at least one permission above.</p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {groups.flatMap(({ resource, actions }) =>
              actions.map((a) => (
                <li key={`${resource.id}:${a}`} className="flex items-start gap-2 text-sm text-ink">
                  <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-up" />
                  <span>
                    {resource.grants[a]}
                    <span className="ml-1.5 font-mono text-[11px] text-ink-faint">
                      {resource.id}:{a}
                    </span>
                  </span>
                </li>
              )),
            )}
          </ul>
          <p className="mt-2.5 flex items-start gap-2 border-t border-line/70 pt-2.5 text-xs text-ink-muted">
            <Lock aria-hidden className="mt-px size-3.5 shrink-0" />
            Everything else is refused. No token can create or revoke tokens.
          </p>
        </>
      )}
    </section>
  );
}
