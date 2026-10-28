# Changelog

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

