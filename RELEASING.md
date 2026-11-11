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
- `revert`: takes back an earlier change users saw (`revert: dark mode`); it is listed in the notes under Reverted.
- `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`: everything else; these stay out of the release notes.
- Add `!` after the type (`feat!: ...`) or a `BREAKING CHANGE:` line in the body for a breaking change.
- The scope is optional: `fix(popup): ...`.
- Write the subject as a change, lowercase, no trailing period: `feat: add dark mode`, not `Added dark mode.`.

The `commit-msg` hook checks this locally, and the Commit messages workflow checks every pushed commit.

### Pull requests

A squash merge turns the pull request into one commit whose message is the pull request's title, so the Commit messages workflow checks the title too, and checks it again when it is edited.
Write the title like a commit subject: `feat: add dark mode`.
GitHub adds ` (#12)` to it when it squashes, so the check counts that against the 100-character header limit.
Put any `Release-note:` or `BREAKING CHANGE:` line in the description, and set the repo to use the title and description for squash commits (Settings, General, "Default commit message": "Pull request title and description"), or with the gh CLI:

```sh
gh api -X PATCH repos/{owner}/{repo} -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
```

GitHub's own default uses the commit message instead of the title when a pull request has one commit, and the commit list as the description, where a stray `Release-note:` line from one commit could reword the whole change.

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
- Below 1.0 (a `0.y.z` version) a breaking change is a minor bump instead: 0.13.0 goes to 0.14.0.
- Force one with `npm run release -- minor` (or `patch`, `major`, or an exact `1.4.0`).
- Going from `0.y.z` to 1.0.0 is a decision, never a side effect: `npm run release -- --stable` cuts 1.0.0, and `major` or a `1.x` version is refused without `--stable`.
  `"stable": true` in `.release.json` does the same for every release, the train's included, so a breaking change then bumps major.
- It bumps `package.json`, `package-lock.json` and any file listed in `.release.json` `versionFiles` (a path, or `{ "path": "...", "pattern": "..." }` with one capture group for the version), adds a section to `CHANGELOG.md` and an entry to `releases.json` (the same notes as data; `"releases": { "feed": true }` adds an Atom feed, `releases.xml`), commits `chore(release): vX.Y.Z` and tags it.
- With `--push` it first makes sure `main` isn't behind `origin/main` and runs `npm run release:check` (skip that with `--no-check`), so a tag is only pushed for a commit that passes. If the push is rejected, the release commit and tag are undone.
  On a branch that takes changes only through pull requests, it releases through one instead (see [Protecting the branch and the tags](#protecting-the-branch-and-the-tags)).
- Releases are cut from `main` or `master`; a repo that ships from another long-lived branch lists it in `.release.json` `branches` (for example `["master", "release/1.x"]`).
  The Commit messages workflow checks pushes to those branches as well as `main` and `master`: rerun apply after changing the list (`npx release-kit apply .` in a package-mode repo, where `npm run release:check` warns until you do).
  The release train still runs on `main` or `master` only.
- The changelog date is today in `.release.json` `timeZone` (for example `"America/Los_Angeles"`), or in the machine's time zone; set it when the release train cuts releases, because CI runs in UTC.
- Edit the new `CHANGELOG.md` section before pushing if a line needs rewording (`git commit --amend`, then move the tag with `git tag -f -a --cleanup=verbatim vX.Y.Z` and paste the new section as its message).
  Never move a tag after it is pushed: the next release would start from the wrong place, and the kit stops when it finds one moved.

Pushing the tag runs `.github/workflows/release.yml`:

1. The tag must be a plain `vX.Y.Z` and match every version file.
2. The repo's checks, `npm run release:check`, must pass.
3. `npm run release:artifacts`, if defined, writes shippable files into `release-artifacts/`; they get SHA-256 checksums.
4. The GitHub Release is created with the generated notes and the files (`releases.json`, and `releases.xml` with the feed on, among them), and the uploaded files are re-downloaded and checked.

If a Release run fails after the tag is pushed (a flaky check, an outage), fix the cause and retry; the workflow is safe to run again:

- **Re-run failed jobs** on the failed run is the usual retry.
  It keeps the run's build, and a release that a failed run already created is finished (notes refreshed, missing files uploaded), not duplicated.
- **Run workflow** from `main` with the tag in the "tag" box is for when the fix is in the workflow itself, or the run is older than its 14-day build artifacts.
- If the release already has files that differ from the new build, the run stops instead of replacing files people may have downloaded; delete those files (or the release) first.

Don't delete and re-push the tag.

## The release train

If this repo has `.github/workflows/release-train.yml` (added by `apply.mjs --train`), releases also happen on a schedule.
Its schedule is in `.release.json` (`train.schedule`, a cron line in UTC).

- On each run it looks at the commits on `main` since the last tag.
- When at least one is user-facing (`feat`, `fix`, `perf`, `security`, a `revert:` commit or a breaking change), it runs `npm run release:check` on that commit, then makes the release commit and tag with the bump the commits call for, exactly like `npm run release`.
- If `.release.json` lists `train.checks` (workflow files, such as the ones whose checks branch protection requires on `main`), it pushes the release commit to a temporary `release-train/vX.Y.Z` branch, runs each of them there and waits for them to pass, then deletes the branch. Each of those workflows needs `workflow_dispatch:` in its `on:`.
- Then it pushes `main` and the tag in one atomic push and makes sure the Release workflow runs on the tag.
- When there are only docs, chores, tests or refactors, it releases nothing.
- "Run workflow" on the Release train runs it now; pick a bump to force one (it then releases any commits, user-facing or not), or tick "dry run" to see the plan and the notes without cutting anything.
- The release commit is made by `github-actions[bot]`, and its pushes made with the workflow's own token start no other workflow; that is why the train starts `train.checks` and the Release workflow explicitly.
- The train runs only on its schedule or from "Run workflow", so nothing it pushes can trigger it again.

### A protected main

GitHub doesn't count checks from runs started with `workflow_dispatch`, the only runs the train's token can start.
So on a `main` protected by required checks, the train's push is rejected even though `train.checks` passed on that exact commit.
The fix is a deploy key that the branch's rules let through, stored as the `RELEASE_TRAIN_KEY` secret; the train's checkout pushes with it when it exists.
The train still runs `train.checks` first and pushes only when they pass, so the key never lets an unchecked commit onto `main`.
A tag pushed with the key starts the Release workflow by itself, and pushing `main` with it runs CI there as usual.
`npx release-kit protect` (see [Protecting the branch and the tags](#protecting-the-branch-and-the-tags)) makes the key, once, in a repo with a train.

- If `main` moves while it runs, or a check fails, nothing is released and the release commit is thrown away; run it again, or let the next scheduled run pick it up.
- It stops instead of guessing when there is no release tag yet (run `npm run release -- --baseline` first), when the last tag isn't on `main`, or when `package.json` doesn't match the last tag.

Preview what it would do with `npm run release -- --plan`.
Releasing by hand still works at any time; the train just finds less to do.

## Protecting the branch and the tags

Set it up once, as an admin, with the gh CLI signed in:

```sh
npx release-kit protect --dry-run   # what it will do
npx release-kit protect
```

It writes two GitHub rulesets:

- **`release-kit: branches`**, on the default branch and any other branch in `.release.json` `branches`: no deletion, no force push, changes only through a pull request (no approvals needed), and the repo's CI checks must pass.
- **`release-kit: release tags`**, on `refs/tags/v*`: anyone who can push may create a release tag, nobody may delete or move one.

The required checks are, in order: `--checks "CI result,check / check"`, `"protect": { "checks": [...] }` in `.release.json`, the ones the ruleset already requires (a rerun keeps them), or else the GitHub Actions checks that passed on the latest merged pull request.
That last way leaves out workflows that run on only some pull requests (a `paths` filter, like the security scan's, or auto-merge), and in a workflow with a `CI result` job (see CI lanes) only that job is required, since it stands for the others.

When it requires checks, protect also allows auto-merge on the repo, so `.github/workflows/auto-merge.yml` can merge release-kit updates and Dependabot patch and minor updates once those checks pass; a major update waits for a person, and so does a minor update of a dependency below 1.0.0 (labeled `needs-review: 0.x minor`), since SemVer lets a 0.x minor break.
The required checks should cover all of CI: GitHub's auto-merge waits for nothing else.

Nobody bypasses the branch rules, admins included, so a coding agent signed in as an admin can't push to `main` either.
Releases still work:

- `npm run release -- --push` tries its usual push; when the rules reject it, it pushes the release commit to a `release/vX.Y.Z` branch, opens a pull request, merges it once its checks pass (up to `--pr-timeout`, default 30 minutes), and tags the merged commit.
  It waits for and judges only what gates the merge: the branch's required checks (from its rulesets and branch protection), or, when it requires none, every GitHub Actions check.
  Commit statuses and other apps' checks (a Vercel deploy, GitGuardian) that the rules don't require are printed and ignored, so a rate-limited preview deploy doesn't stop a release.
  If a gating check fails, or a required check never reports before `--pr-timeout`, it closes the pull request and undoes the release commit, so nothing is tagged.
  `--via-pr` goes straight to the pull request, and `npm run release -- --dry-run --push` says which path it will take.
- With a release train, the train's deploy key may bypass the branch rules (see [A protected main](#a-protected-main)); `--rotate-key` replaces the key.
- `--admin-bypass` lets repository admins push straight to the branch again, for a repo that wants that trade-off.

`npm run release:check` warns when the rulesets drift from what protect would set (a rule removed by hand, a different bypass list, other required checks than `.release.json` names), whenever gh can read them.
Rulesets need a public repo, or GitHub Pro for a private one.

### A private repo on GitHub Free

There protect sets up the free safeguards instead, and says what GitHub still lets through (see release-kit's [docs/PRIVATE_REPOS.md](https://github.com/n8watkins/release-kit/blob/main/docs/PRIVATE_REPOS.md)):

- **The pre-push guard** (`.githooks/pre-push`) refuses, before anything is sent, a push straight to `main` or a release branch, a force push or deletion of one, and a moved or deleted `v*` tag.
  Push a branch and open a pull request instead.
  `npm run release -- --push` still works: the guard recognizes its one release commit, and when the release would carry unpushed work along it goes through a release pull request.
  In an emergency, `RELEASE_KIT_ALLOW_DIRECT_PUSH=1 git push ...` lets a push through and logs it to `.git/release-kit/direct-push.log`.
- **The Direct push alarm** (`.github/workflows/direct-push.yml`) checks every push to those branches on GitHub; a commit that came from no merged pull request, a force push or a moved tag fails the run and opens an issue labeled `release-kit: direct push`.
- **Merge when green** (`.github/workflows/auto-merge.yml`) merges update pull requests once every check has passed.

## Baselines and backfills

- `npm run release -- --baseline` tags the version this repo is already at, without a GitHub Release, so the first real release lists only new work.
- `npm run release -- --baseline <commit> --publish` tags a past milestone with the version its `package.json` had, and publishes it.
- `npx release-kit backfill` adds release tags from before the kit wrote `releases.json` to it, from their commits: a dry run that prints the plan, `--write` to write the file, `--edit-releases` to fill in GitHub Release notes that are empty or only GitHub's generated list.
  Commits that aren't Conventional Commits are counted as `unattributed`, never guessed at, and baseline tags are skipped.

## When to release

- Release when something worth telling a user about has landed: a feature, a fix they would notice, or a batch of either.
- With the release train on, that happens on its schedule without anyone remembering to; release by hand when something shouldn't wait.
- Before 1.0, minor versions carry features and breaking changes, and patch versions carry fixes.
- Version 1.0.0 means "ready for people who aren't me": cut it with `npm run release -- --stable`.
