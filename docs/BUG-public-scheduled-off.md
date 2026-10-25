# Bug: the public status feed reports "operational" during scheduled off-hours

Reported 2026-10-25, from the developer portfolio (portfolio.n8builds.dev), which reads this feed.

## Summary

Outside a monitor's operating schedule, OpenPing stops checking it and sets its state to `scheduled_off`, as designed.
The public status feed (`GET /api/public/status`), the public status page and the embeddable widget still report that monitor as `operational`.
A visitor is told the app is up while it is asleep: for a Render free-tier app, the first visit then waits about a minute for a cold start.

## Seen on

- https://openping.n8builds.dev, on Sunday 2026-10-25 (the n8 Render apps are scheduled for weekdays only).
- The feed's `updatedAt` was `2026-10-23T23:48:57Z`, the last check on Friday.
- Echo, GeminiGPT and Scout all had `"state": "operational"`, while their bars for 2026-10-24 and 2026-10-25 were `"state": "none"` (no checks).
- The status page showed "All systems operational", "Updated 2d ago".

## Reproduce

1. Give an HTTP monitor an operating schedule that excludes the current time (for example weekdays only, on a weekend).
2. Leave its public setting `showScheduledOff` at its default, `false`.
3. Wait for the next scheduled run: `monitor_state.state` becomes `scheduled_off` (`src/worker/checks/state.ts`, around line 284).
4. `curl https://<install>/api/public/status`: the service's `state` is `operational`.

Expected: `scheduled_off`, which the status page, the widget and the feed's consumers already know how to show ("Scheduled off").

## Cause

`mapPublicState` in `src/worker/routes/public.ts` (around line 136) maps the internal state to the public one:

```ts
case "scheduled_off":
  // Hidden from the page (and from the outage calc) unless the operator
  // opts in; treat as operational when hidden.
  return showScheduledOff ? "scheduled_off" : "operational";
```

`showScheduledOff` defaults to `false` (`src/shared/schemas.ts` line 174, `src/worker/db/monitors.ts` line 94).
So by default an off-hours monitor is reported as up.

Two things make it worse:

- **The option can't be turned on in the app.** The monitor editor (`src/client/pages/MonitorEditor.tsx`) only round-trips `showScheduledOff` (line 566); there is no control for it. It can be set only through the API, the CLI or an import.
- **The product promises the opposite.** The landing page (`src/client/pages/Landing.tsx` line 607) says off-hours show as "Scheduled off" and never count against uptime.

The intent of hiding was to keep off-hours from looking like an outage.
That part is already handled separately: `computeOverall` never counts `scheduled_off` toward an outage (see the comment around line 112), and uptime excludes off-hours.
Reporting `operational` instead is not needed for that, and it is wrong.

## Suggested fix

1. Report the truth by default: map `scheduled_off` to `scheduled_off` in the public projection.
   Decide what `showScheduledOff: false` should mean afterwards. Two reasonable options:
   - drop the option (simplest; the overall banner already ignores off-hours), or
   - keep it as "hide this service from the public page while it is off", never "show it as operational".
2. If the option stays, add a toggle for it to the monitor editor.
3. Check the overall banner when every service is off: `OverallStatus` already has `all_off`; make sure the page, the widget and the feed use it, so a fully off-hours page doesn't read "All systems operational".
4. Consider showing the time of the last check next to "Scheduled off" (for example "Scheduled off since Fri 4:48 PM"), so "Updated 2d ago" doesn't look like a dead monitor.
5. Tests: `src/worker/routes/public.test.ts` should cover an off-hours monitor in the feed, the overall banner with some and with all services off, and the widget's rendering of `scheduled_off`.
6. Update `docs/STATUS_PAGES.md` and `docs/WIDGET.md` to say what visitors see off-hours.

## Who depends on it

- **portfolio.n8builds.dev** (`n8watkins/dev-portfolio`) shows a status pill on Echo, Scout and GeminiGPT from this feed.
  It works around the bug today: a feed whose `updatedAt` is more than 30 minutes old is read as "Asleep" (`lib/status.ts`, `STALE_AFTER_MS`).
  Once the feed reports `scheduled_off` itself, that workaround still behaves correctly (it maps `scheduled_off` to "Asleep" too) and can stay as a safety net.

## Related, separate issues found at the same time

- **The widget can't be embedded on n8builds.dev itself.**
  `ALLOWED_FRAME_ANCESTORS` in `src/worker/index.ts` (line 33) is `https://*.n8builds.dev`, which matches subdomains but not the bare domain.
  Add `https://n8builds.dev` if the widget should ever appear there.
- **Adopt release-kit** (https://github.com/n8watkins/release-kit) for commit checks and releases, when the owner rolls it out across the build repos.
