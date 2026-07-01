# Categories & status pages

OpenPing can publish **more than one** public status page, each showing a
different slice of your monitors.
The mechanism has two parts: **categories** (a way to group monitors) and
**status pages** (published public views that select monitors to show).

At a glance:

- A monitor can belong to one **category** and be flagged to show on public pages.
- A **status page** picks which monitors it shows (all public monitors, the public monitors in chosen categories, or a hand-picked list).
- The single **default page** is served at `/status`; every other page gets its own slug at `/status/:slug`.
- Each page (default or not) can be embedded as a [widget or SVG badge](./WIDGET.md) scoped with `?slug=`.

---

## 1. Categorize a monitor (and make it public)

Categories and public visibility are set per monitor, in the **monitor editor**
(`/monitors/new` or `/monitors/:id/edit`), under the "Visibility" section:

- **Category** - an optional dropdown.
Assigning a category lets category-based status pages include the monitor, and groups it on those pages.
A monitor with no category simply isn't matched by "by category" pages.
- **Show on public status pages** - a checkbox.
This is the master switch: a monitor is only ever eligible for *any* public page when this is on.
When it's off, the monitor never appears publicly, regardless of category or page selection.

Deleting a category does not delete its monitors; their `category_id` is cleared
(the foreign key is `ON DELETE SET NULL`), so they fall back to "uncategorized".

---

## 2. Manage categories and pages

Everything is managed from the **Status pages** screen at `/status-page`:

- The screen lists your published pages, each with its slug, enabled/disabled
  state, a **Default** badge on the default page, a link to its public view, and
  edit/delete actions.
The default page cannot be deleted, so it has no delete action.
- An inline **categories manager** at the bottom lets you create, rename, and
  delete categories (each has a name and a URL-safe slug).

Create a new page at `/status-page/new` and edit an existing one at
`/status-page/:id`.
The editor has three groups of settings.

### Basics

- **Name** (required) and **Slug** (required; lowercase letters, numbers, and
  hyphens).
The slug is the public URL path: the page is served at `/status/<slug>`.
The default page is always served at `/status`, so its slug is locked and cannot be changed.
- **Description** - an optional tagline shown under the page name.
- **Enabled** - a kill switch.
When off, the public page returns nothing but its name (and its badge renders a neutral "unknown").

### Branding

Theme (system / light / dark), accent color (a 3- or 6-digit hex), an optional
logo URL, an optional homepage URL the logo/name link back to, optional footer
text, and a "Powered by OpenPing" attribution toggle.

### Monitors (include mode)

This is what makes each page show a different set of services.
Pick one of three modes:

| Mode | Shows |
| --- | --- |
| **All visible monitors** | every monitor with "Show on public status pages" on |
| **By category** | the public monitors whose category is in the categories you select |
| **Specific monitors** | only the public monitors you tick in the list |

In every mode the "Show on public status pages" flag is still required - it is
the outer boundary, and the include mode narrows within it.
The default page ships in "all visible" mode, matching the original
single-page behavior.

---

## 3. Public URLs and embedding

- **Default page:** `https://<your-domain>/status`
- **Per-category / additional page:** `https://<your-domain>/status/<slug>`

A slug that matches no page is a hard **404** (it never silently falls back to the
default page - that would leak the wrong page's monitors).

Every page can also be embedded elsewhere, scoped with the same slug:

- **Widget** (iframe): `/embed?slug=<slug>` (omit `slug` for the default page).
- **Badge** (SVG): `/api/public/badge.svg?slug=<slug>`.

See [`WIDGET.md`](./WIDGET.md) for the full embedding guide.

---

## What a public page never exposes

Public pages (and their widget/badge) are built from a strictly redacted payload.
They never expose a monitor's URL, request body, auth/credentials, headers, its
heartbeat token, or any internal error text.
Service copy comes only from the public display name (falling back to the monitor
name), and incident/maintenance text comes only from the admin-authored public
message.
An incident for a monitor that isn't on a given page can never appear on it.
