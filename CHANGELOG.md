# Changelog

## 0.8.0 - 2026-10-28

Incident updates now reach your alert channels, and a review pass fixed passkey edge cases, big status pages and the monthly report.

### New

- Posting an incident update alerts the monitor's channels ([#36](https://github.com/n8watkins/open-ping/pull/36))

### Fixed

- Warnings about an address change are accurate, and recovery signs out other devices ([#37](https://github.com/n8watkins/open-ping/pull/37))
- Honest request budget, big status pages, feed links, monthly report catch-up ([#38](https://github.com/n8watkins/open-ping/pull/38))

## 0.7.0 - 2026-10-28

### New

- Sign in with a passkey; GitHub sign-in becomes optional ([#34](https://github.com/n8watkins/open-ping/pull/34))

### Fixed

- Ask before saving an Installation URL that would stop your passkeys working ([#35](https://github.com/n8watkins/open-ping/pull/35))

## 0.6.0 - 2026-10-28

### New

- Deploy your own OpenPing with one Deploy to Cloudflare button ([#33](https://github.com/n8watkins/open-ping/pull/33))

## 0.5.0 - 2026-10-28

Status pages now show a timeline of incident updates, can be followed by RSS or Atom, and say No data yet for monitors that have never been checked. A monthly uptime report is available as a table, CSV, MCP tool, CLI command and opt-in email. The offline page and Settings are tidier.

### New

- Send alerts to Slack, Microsoft Teams and Telegram ([#29](https://github.com/n8watkins/open-ping/pull/29))
- Failures are re-checked before alerting, and new monitors are checked at once ([#31](https://github.com/n8watkins/open-ping/pull/31))

## 0.4.0 - 2026-10-28

### New

- Change MASTER_KEY without losing data, and re-encrypt everything from Settings ([#25](https://github.com/n8watkins/open-ping/pull/25))
- Both ways to run OpenPing, owner-only sign-in, and each install's own home page ([#27](https://github.com/n8watkins/open-ping/pull/27))

### Fixed

- Real version in the app, and an unreadable push device no longer breaks alerts ([#26](https://github.com/n8watkins/open-ping/pull/26))

## 0.3.0 - 2026-10-28

### New

- Run your OpenPing from Claude Code or any MCP client, plus a full admin CLI ([#24](https://github.com/n8watkins/open-ping/pull/24))

### Fixed

- Lighthouse findings - real 404s and robots.txt, readable widget footer, wide-screen header ([#21](https://github.com/n8watkins/open-ping/pull/21))

## 0.2.1 - 2026-10-28

### Fixed

- The status page description wraps on phones instead of being cut off ([#18](https://github.com/n8watkins/open-ping/pull/18))

## 0.2.0 - 2026-10-27

Off-hours services now show as Scheduled off on the status page, widget, badge and feed instead of operational, and say since when. The widget can be embedded on n8builds.dev itself. Installs can keep their database id out of git with npm run deploy:prod.

### Safer

- One strict header policy for every page, widget on n8builds.dev, checks-only CI ([#16](https://github.com/n8watkins/open-ping/pull/16))

### Faster

- Scheduled runs that have nothing to check now finish in well under a second, and Settings > Diagnostics shows how many database calls each run made.

