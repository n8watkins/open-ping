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

## Off-hours (scheduled off)

A monitor with an operating schedule is not checked outside its hours, and its public page says so.
Visitors see each off-hours service as **Scheduled off since Fri 4:48 PM**, the time it went off, shown in the visitor's own timezone.
Off-hours never count as an outage and never count against uptime.

- **Some services off, the rest up:** the banner stays **All systems operational**.
- **Every service off:** the banner reads **All services are scheduled off**, with the time of the last check instead of "Updated 2d ago".
- **An outage, an active maintenance window or a degraded service** still takes precedence over the off-hours banner.
- **A page with no public services** keeps its own banner, **No public services**.

The public feed (`GET /api/public/status`) reports such a service with `"state": "scheduled_off"` and a `since` timestamp (epoch milliseconds).
`since` is set only for `scheduled_off`, and is `null` for every other state.
A page whose services are all off has `"overall": "all_off"`; a page with no services has the same value and an empty `groups` list.

There is no setting to hide off-hours or to show them as operational.
The older `public.showScheduledOff` field is no longer used: OpenPing still accepts it from the API and from older backups, and ignores it.

---

## Services that haven't been checked yet

A new monitor shows **Unknown** until its first check, and its uptime reads **No data yet** instead of a figure it hasn't earned.
Services without a state (never checked, warming up or paused) never count toward the banner, so they can't make a page read "All systems operational".
A page where every service is still waiting says **Waiting for the first checks**.
In the public feed such a service has `"uptime90d": null`, and a page of them has `"overall": "awaiting_data"` (the badge reads "no data yet").

---

## Incident updates

An incident can carry a timeline of status updates, as Instatus and Better Stack status pages do.
Each update has a status (**Investigating**, **Identified**, **Monitoring** or **Resolved**) and a message, and is stamped with the time it was posted.

- Post, edit and delete updates in the incident's panel under **Incidents**, from the CLI (`op incidents update <id> --status identified --message "..."`), from an MCP client (`post_incident_update`), or over REST (`POST /api/incidents/:id/updates`, `PATCH` and `DELETE /api/incidents/:id/updates/:updateId`).
- The public page lists them under the incident, newest first, each with its relative and absolute time.
- Updates appear publicly only while the incident is marked **Show on public status page**, and only on pages that show its monitor.
- The incident's **Public summary** (the older single public message) stays as a one-line summary above the timeline, so incidents published before updates existed look the same.
  It isn't turned into an update, because it has no time of its own and is edited in place.
- An update describes the incident; it never opens or closes it.
  OpenPing resolves an incident when its monitor recovers, and you may want to post "Resolved" before or after that.
- An incident holds at most 100 updates of up to 2,000 characters each.

Posting an update does not send alerts to your notification channels yet.

---

## Feeds (RSS and Atom)

Every status page has an RSS 2.0 and an Atom 1.0 feed of its public incidents and their updates, so people can follow it in a feed reader without an account:

| Page | RSS | Atom |
| --- | --- | --- |
| Default page | `/status/feed.rss` | `/status/feed.atom` |
| Any page | `/status/<slug>/feed.rss` | `/status/<slug>/feed.atom` |

- Each public incident is one item, titled with its newest status, for example "Checkout incident (Identified)".
  Its body holds the summary, when it started and ended, and every update, newest first.
  A new update changes the item's updated time; its id stays the same.
- A feed lists the 50 most recent public incidents on that page, with the same rules as the page itself.
- An unknown slug or a page that is turned off answers 404.
- Feeds are cached for 60 seconds and answer a conditional request with `304 Not Modified`.
- The status page links both feeds with `<link rel="alternate">` and shows a **Subscribe (RSS)** link next to **Recent incidents**.

---

## Monthly uptime report

**Settings > Reports** shows, for any of the last 13 calendar months, each monitor's:

- **Uptime**: successful checks out of all checks, or "No data" when it wasn't checked;
- **Downtime** in minutes;
- **Monitored minutes**: the time its checks covered;
- **Incidents** that started in the month;
- **Average response time** of its successful checks.

Months are calendar months in the install's timezone (Settings > General), including daylight saving changes.
Off-hours are never counted: a monitor outside its schedule isn't checked, so that time is neither uptime nor downtime, and it isn't in the monitored minutes either.
The current month is reported so far.

Download it as CSV from the same card, or get it from `GET /api/reports/monthly?month=YYYY-MM&format=csv|json`, `op report --month YYYY-MM [--csv]` or the MCP tool `get_monthly_report`.
`month` defaults to last month.

Tick **Email me this report every month** to get it by email on the 1st, from 09:00 in the install's timezone, at the admin email (it needs `RESEND_API_KEY`).
A report that can't go out then (the email fails, or the Worker misses the day) is sent at the next chance later in the month, trying at most once an hour, and each month's report is sent only once.

The report comes from the hourly and daily rollups, never from raw samples, in one database round trip.
Hourly rollups are kept for 64 days by default, so last month is exact until this month ends.
For older months, or with a shorter custom retention, a UTC day that straddles the month's start or end counts in proportion to its overlap.
A monthly email costs the scheduler two D1 queries on the run that sends it, and it waits one run if the weekly summary went out on the same one.

---

## What a public page never exposes

Public pages (and their widget/badge) are built from a strictly redacted payload.
They never expose a monitor's URL, request body, auth/credentials, headers, its
heartbeat token, or any internal error text.
Service copy comes only from the public display name (falling back to the monitor
name), and incident/maintenance text comes only from the admin-authored public
message and the incident's posted updates.
An incident for a monitor that isn't on a given page can never appear on it.
The RSS and Atom feeds are built from the same redacted data and follow the same rules.
