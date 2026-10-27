# Releasing

This repo follows the n8 release standard (release-kit).
Commits use Conventional Commits, versions follow SemVer, and a pushed `vX.Y.Z` tag publishes a GitHub Release.

## Commit messages

```
type(scope): subject
```

- `feat`: something a user can see or do that they couldn't before.
- `fix`: a bug fix a user would notice.
- `perf`: faster or lighter, same behavior.
- `security`: hardening a user would want to know about (a checksum, a tighter policy).
- `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`: everything else; these stay out of the release notes.
- Add `!` after the type (`feat!: ...`) or a `BREAKING CHANGE:` line in the body for a breaking change.
- The scope is optional: `fix(popup): ...`.
- Write the subject as a change, lowercase, no trailing period: `feat: add dark mode`, not `Added dark mode.`.

The `commit-msg` hook checks this locally, and the Commit messages workflow checks every pushed commit.

## Writing for the release notes

`feat`, `fix`, `perf` and `security` subjects become the release notes, the changelog and the public build log.
Write them as patch notes: what a user can now do, or what works better, in plain words.

| Instead of | Write |
|---|---|
| `fix(marquee): debounce ResizeObserver` | `fix: the logo strip no longer stutters when you resize the window` |
| `feat: owner round 10` | `feat: a dino game in the AI kit, and a rebuilt Loadout` |
| `perf: lazy Sentry and LazyMotion` | `perf: pages load about a second faster on phones` |

- Say what changed for the user, not which file, library or test changed.
- A change no user would notice (a flaky test, a CI fix) isn't a `fix`: use `test`, `ci` or `chore`.
- When the subject has to stay technical, add a `Release-note:` line to the body; the notes use it instead:

  ```
  fix(marquee): debounce ResizeObserver

  Release-note: the logo strip no longer stutters when you resize the window
  ```

- `Release-note: skip` keeps a `feat` or `fix` out of the notes (a breaking change is always listed).
- `npm run release -- --summary "Dark mode, and a faster homepage."` puts a line in your words at the top of the release.

### How the notes look

Set `notes` in `.release.json`:

- The default style: headings New, Fixed, Faster and Safer, and no scope labels.
- `"style": "classic"`: the commit-type headings Features, Fixes, Performance and Security, with scope labels.
- `"headings": { "Features": "What's new" }`: rename any heading.
- `"scopes": "hide"`, or `{ "a11y": "Accessibility", "ci": false }` to rename some scopes and drop others.

Pull request numbers like `(#12)` link to the pull request.
The GitHub Release shows exactly the section the release wrote to `CHANGELOG.md`, summary and all.

## Cutting a release

```bash
npm run release -- --dry-run   # preview the version and the notes
npm run release -- --push      # check, bump, changelog, commit, tag, push
```

- With no bump given it picks one: major for a breaking change, minor for a feature, otherwise patch.
- Force one with `npm run release -- minor` (or `patch`, `major`, or an exact `1.4.0`).
- It bumps `package.json`, `package-lock.json` and any file listed in `.release.json` `versionFiles`, adds a section to `CHANGELOG.md`, commits `chore(release): vX.Y.Z` and tags it.
- With `--push` it first makes sure `main` isn't behind `origin/main` and runs `npm run release:check` (skip that with `--no-check`), so a tag is only pushed for a commit that passes. If the push is rejected, the release commit and tag are undone.
- The changelog date is today in `.release.json` `timeZone` (for example `"America/Los_Angeles"`), or in the machine's time zone; set it when the release train cuts releases, because CI runs in UTC.
- Edit the new `CHANGELOG.md` section before pushing if a line needs rewording (`git commit --amend`, then move the tag with `git tag -f -a --cleanup=verbatim vX.Y.Z` and paste the new section as its message).
  Never move a tag after it is pushed: the next release would start from the wrong place, and the kit stops when it finds one moved.

Pushing the tag runs `.github/workflows/release.yml`:

1. The tag must be a plain `vX.Y.Z` and match every version file.
2. The repo's checks, `npm run release:check`, must pass.
3. `npm run release:artifacts`, if defined, writes shippable files into `release-artifacts/`; they get SHA-256 checksums.
4. The GitHub Release is created with the generated notes and the files, and the uploaded files are re-downloaded and checked.

If a Release run fails after the tag is pushed (a flaky check, an outage), fix the cause and run the Release workflow again on the tag: Actions, Release, "Run workflow", and pick the tag under "Use workflow from".
Don't delete and re-push the tag.

## The release train

If this repo has `.github/workflows/release-train.yml` (added by `apply.mjs --train`), releases also happen on a schedule.
Its schedule is in `.release.json` (`train.schedule`, a cron line in UTC).

- On each run it looks at the commits on `main` since the last tag.
- When at least one is user-facing (`feat`, `fix`, `perf`, `security`, a revert or a breaking change), it runs `npm run release:check` on that commit, then makes the release commit and tag with the bump the commits call for, exactly like `npm run release`.
- If `.release.json` lists `train.checks` (workflow files, such as the ones whose checks branch protection requires on `main`), it pushes the release commit to a temporary `release-train/vX.Y.Z` branch, runs each of them there and waits for them to pass, then deletes the branch. Each of those workflows needs `workflow_dispatch:` in its `on:`.
- Then it pushes `main` and the tag in one atomic push and makes sure the Release workflow runs on the tag.
- When there are only docs, chores, tests or refactors, it releases nothing.
- "Run workflow" on the Release train runs it now; pick a bump to force one (it then releases any commits, user-facing or not), or tick "dry run" to see the plan and the notes without cutting anything.
- The release commit is made by `github-actions[bot]`, and its pushes made with the workflow's own token start no other workflow; that is why the train starts `train.checks` and the Release workflow explicitly.
- The train runs only on its schedule or from "Run workflow", so nothing it pushes can trigger it again.

### A protected main

GitHub doesn't count checks from runs started with `workflow_dispatch`, the only runs the train's token can start.
So on a `main` protected by required checks, the train's push is rejected even though `train.checks` passed on that exact commit.
The fix is a deploy key that the branch's protection lets through, stored as the `RELEASE_TRAIN_KEY` secret; the train's checkout pushes with it when it exists.
The train still runs `train.checks` first and pushes only when they pass, so the key never lets an unchecked commit onto `main`.
A tag pushed with the key starts the Release workflow by itself, and pushing `main` with it runs CI there as usual.

Set it up once, as an admin, with the gh CLI signed in:

```sh
npx release-kit protect --dry-run   # what it will do
npx release-kit protect
```

It creates the ruleset `release-kit: protect main` (no deletion, no force push, the required checks that classic protection had, or `--checks "CI result,check"`), lets the deploy key and repository admins bypass it (`--no-admin-bypass` to drop admins), adds a new write deploy key `release-kit train` with its private half only in the secret, and then removes classic branch protection, which a deploy key can't bypass.
Run it again to rotate the key.
- If `main` moves while it runs, or a check fails, nothing is released and the release commit is thrown away; run it again, or let the next scheduled run pick it up.
- It stops instead of guessing when there is no release tag yet (run `npm run release -- --baseline` first), when the last tag isn't on `main`, or when `package.json` doesn't match the last tag.

Preview what it would do with `npm run release -- --plan`.
Releasing by hand still works at any time; the train just finds less to do.

## Baselines and backfills

- `npm run release -- --baseline` tags the version this repo is already at, without a GitHub Release, so the first real release lists only new work.
- `npm run release -- --baseline <commit> --publish` tags a past milestone with the version its `package.json` had, and publishes it.

## When to release

- Release when something worth telling a user about has landed: a feature, a fix they would notice, or a batch of either.
- With the release train on, that happens on its schedule without anyone remembering to; release by hand when something shouldn't wait.
- Before 1.0, minor versions carry features and patch versions carry fixes.
- Version 1.0.0 means "ready for people who aren't me".
