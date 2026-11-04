# Deployment: GitHub Pages with automatic content updates

`.github/workflows/deploy.yml` builds the Astro site and deploys it to GitHub Pages.

| Trigger | When | Builds |
| --- | --- | --- |
| `schedule` – content check | every 15 minutes (`7,22,37,52 * * * *`) | only if something changed (below) |
| `schedule` – daily refresh | 03:17 UTC (`17 3 * * *`) | **always** – refreshes the GitHub project cards |
| `workflow_dispatch` | **Actions → Deploy to GitHub Pages → Run workflow** on `main` | **always** |

Scheduled runs only exist on the default branch. Which cron started a run is read from `github.event.schedule`;
the decision is made in `forceReason()` (`src/lib/deploy-check.ts`), the cron expressions are kept in sync with the
workflow by a test.

No secrets are involved. Sanity is read without a token (public dataset); the only credential is the built-in
`GITHUB_TOKEN`. Design and alternatives: [publishing-pipeline.md](publishing-pipeline.md).

## How a change goes live

```text
check   (contents: read)          current Sanity fingerprint + main commit  vs.  https://…/build-info.json
  │ changed?  no → stop (≈ 15 s, nothing deployed)
build   (contents: read)          npm ci → npm run build → dist/build-info.json (fingerprint of what was rendered)
deploy  (pages + id-token write)  gate: main head == built commit AND Sanity fingerprint == built fingerprint
                                  → actions/deploy-pages, otherwise skip (the next check builds the newer state)
```

A rebuild happens when **any** of these differ from the live `/build-info.json`:

- the commit on `main` (code was merged) – so merges go live within ~15 minutes without a separate trigger;
- the **content fingerprint** – SHA-256 over type, ID and revision (`_rev`) of every *visible* Sanity document;
- the live file is missing (first publication), unreadable or in an older format.

Typical delay from "Publish" in the Studio to live: **≈ 5–25 minutes** (interval + scheduling delay + 2–3 minutes
build and deploy). Need it now? Start the workflow manually.

### What counts as "visible" (`src/lib/blog/visibility.ts`)

The same GROQ filter is used by the blog query *and* the fingerprint, so they can't drift apart: published
documents only (no `drafts.*`, no `versions.*`), with a slug, not hidden, `publishedAt <= now()`.

| Action in the Studio | Fingerprint | Deploy |
| --- | --- | --- |
| Edit a draft, save, discard | unchanged | no |
| Publish a new post | new document | yes |
| Edit + publish a post | new `_rev` | yes |
| Unpublish / delete a post | document gone | yes |
| Toggle *Hide on website* + publish | document leaves / enters the set | yes |
| Post with a future publish date | enters the set once the date has passed | yes, at the first check after that date |
| Publish without visible changes | new `_rev` | yes (harmless extra build) |

Scheduled posts: the visibility filter uses Sanity's server time, the build skips posts that are still in the
future by the runner's clock. A post whose publish time falls between the two clocks is left out of the build's
fingerprint as well, so the next check sees it and rebuilds – it can't get "stuck" as already live.

### Failure handling and messages

Every decision is written to the run's **summary** (`Deploy check: …`, `Build: …`, `Deploy gate: …`). Errors appear
as annotations (`::error::`) on the run page; failed runs trigger GitHub's notification mail.

| Situation | Result | Message |
| --- | --- | --- |
| Repository variables missing | check **fails** | `SANITY_PROJECT_ID is not set – define the repository variables …` |
| Sanity unreachable / wrong project (3 attempts) | check **fails** – never "no changes" | `Sanity query failed after 3 attempts: HTTP …` |
| Live `build-info.json` missing (404) | rebuild | `no build-info.json on the live site yet (first publication)` |
| Live `build-info.json` unreadable | rebuild, restores it | `live build-info.json unreadable (…)` |
| Build without content fingerprint | build **fails** (no 15-minute rebuild loop) | `The build has no content fingerprint – …` |
| Content or `main` changed during the build | deploy skipped, next check builds | notice `Deploy skipped – superseded …` |
| Build or `deploy-pages` fails | previous deployment stays online | Astro / action error in the log |

### Older runs can't overwrite newer deployments

- Runs are serialised (`concurrency: pages`); at most one waits, newer ones replace it. Mostly check runs of
  ~15 s, so waiting is rare; the daily run (minute 17) never coincides with a content check (minutes 7/22/37/52).
- The deploy job checks right before deploying that the build is still current (head of `main` and Sanity
  fingerprint). This also covers **re-running** an old run or only its deploy job.
- Only `main` deploys: every job requires `github.ref == refs/heads/main`, and the `github-pages` environment only
  accepts `main` (Settings → Environments).

## Required GitHub settings (manual, once)

| Where | Setting |
| --- | --- |
| Settings → Secrets and variables → Actions → **Variables** | `SANITY_PROJECT_ID` = `hyyn359x`, `SANITY_DATASET` = `production` (variables, **not** secrets – both are public) |
| Settings → Pages | Source: **GitHub Actions** |
| Settings → Environments → `github-pages` | Deployment branches: **`main`** only; **no** required reviewers (would block every automatic deploy) |
| Settings → Actions → General | Workflow permissions: **Read repository contents** (default token read-only) |

Not needed: `SANITY_READ_TOKEN`, any personal access token, any webhook.

## Limits and known gaps

- **GitHub data (projects, stars, "updated" dates) is not part of the fingerprint.** It is refreshed by the daily
  build at 03:17 UTC (or any other build), so it is at most about a day old.
- **Scheduled runs can start late or be skipped** under load. The next run catches up.
- **Public repositories: GitHub disables scheduled workflows after 60 days without repository activity** (no
  commits etc. – Sanity changes don't count). GitHub sends a mail; re-enable under Actions → the workflow →
  *Enable workflow*. Check this after longer breaks.
- A manual or daily run that is still *waiting* (only if a long build is running at that moment) can be replaced by
  a newer content check, which builds only if something changed. Start it again if needed; the daily refresh
  otherwise happens the next day.
- If the deploy gate skips (something changed during the build), the site goes live with the next check.

## GitHub data refresh

The project cards use the GitHub REST API at build time; that data has no fingerprint. The daily run at 03:17 UTC
therefore always builds (and deploys, if nothing newer exists). A more precise alternative – a second fingerprint
over exactly the GitHub fields the site shows – would avoid the daily build but needs more code; not needed so far.

## Merge order (PR 1 → PR 2)

1. **PR 1 `feature/sanity-cms-integration` → `main`**: `deploy.yml` is unchanged by this PR (still manual only, no
   Sanity variables). Nothing runs automatically. A manual run in between builds the site with the blog **hidden**
   (not configured) – harmless, but unnecessary.
2. **Set the repository variables** (see *Required GitHub settings*) before PR 2.
3. **PR 2 `feature/sanity-auto-deploy` → `main`**: activates the schedules. The first content check finds no
   `build-info.json` on the live site and **deploys automatically** within ~15 minutes (blog included). Without the
   variables every check fails (red runs, mails) until they are set.

## Extending to more Sanity types (e.g. projects)

1. Define the type's visibility filter (like `POST_VISIBLE_FILTER`) and add it to `contentSources` in
   `src/lib/content-fingerprint.ts`.
2. Let the type's loader return `_type`, `_id`, `_rev` of the fetched documents and add them to the fingerprint in
   `src/pages/build-info.json.ts`.
3. Bump `FINGERPRINT_VERSION` → the next check rebuilds once.

## Local testing

```bash
set -a && source .env && set +a
GITHUB_SHA=$(git rev-parse HEAD) npm run build && node scripts/deploy-check.ts built
npm run preview &                                     # serves dist/ on :4321
GITHUB_SHA=$(git rev-parse HEAD) SITE_URL=http://localhost:4321 node scripts/deploy-check.ts check   # → changed=false
```
