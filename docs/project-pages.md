# Project detail pages

Every featured project gets a static page at `/projects/<slug>/` (e.g. `/projects/toystory2recomp/`). Featured cards
on the home page open it; the separate **Repository** link still goes to GitHub. **Once a page is published it stays
online** – the deploy workflow refuses any build that would remove it or change its URL.

## Which projects get a page

A project that is shown on the site (not hidden, not excluded) gets a page if **any** of these is true
(`src/lib/project-pages.ts`):

| Rule | Where it is recorded |
| --- | --- |
| It is featured now (also newly featured projects) | – automatic |
| The live site already has a page for it | live page manifest `/projects/pages.json` |
| It was featured before in Sanity | `detailPageEnabled: true` on its Sanity document |
| It was featured before through code | `detailPages` in `src/config/projects.ts` |

Projects that were never featured get no page.

## The page manifest and the page guard

Every build publishes **`/projects/pages.json`**: each page's repository, slug and the latest release it shows
(`src/lib/page-manifest.ts`). `/build-info.json` declares `"manifest": 1` so the deploy check knows the site uses it.

**Builds read the live manifest first** (once, at build time): published pages are kept even if the project lost its
featured flag in any way (Studio, API, CLI, Releases, a Studio that was not redeployed), published slugs are claimed
before any other slug, and published releases are reused when GitHub fails.

**The page guard** (`guardPages`, run by `deploy-check built` in the build job and again by `deploy-check verify` in
the deploy job) compares the new build's manifest with the live one and **refuses to deploy** when:

1. a published page disappears (e.g. the GitHub listing fell back to an old snapshot, the project was hidden or its
   Sanity document deleted, the repository was renamed or made private);
2. a published repository changes its slug;
3. a published slug is given to another repository (also a retired slug);
4. the new manifest is malformed or inconsistent (invalid repository/slug, duplicates, untrusted release URL);
5. the live manifest can't be read reliably on a site that uses manifests (network error, timeout, 403, 5xx, invalid
   JSON or content, or a 404 although `/build-info.json` declares a manifest);
6. a release the live site shows would disappear because GitHub was unavailable during the build.

There is **no override switch**. The only permitted removal is an explicit entry in `retiredDetailPages`
(`src/config/projects.ts`) with the page's repository **and** slug – a reviewed code change. Its slug stays reserved.

### First publication (bootstrap)

Deterministic, no manual flag: a missing live manifest (HTTP **404** only) is accepted when

- the live `/build-info.json` is readable and has **no** `manifest` field (site built before manifests), or
- the site has never been published (no `/build-info.json` and no manifest).

Anything else – including any error reading either file – is refused. After the first manifest deploy, the live
build info carries `"manifest": 1` and a missing manifest always blocks.

## Slugs

Order: **published slug** (live manifest) → `detailPages` (code) → Sanity `slug` → generated from the **repository
name** (never the title). Published and stored slugs are claimed first, retired ones stay reserved, so on a collision
only the **new** project gets `-2`, `-3`, … (with a build warning). A changed Sanity or config slug for a published page
is ignored with a warning – the URL stays. The Studio locks the slug once the page is live and rejects duplicates.

## Releases

Per page, at build time (`src/lib/github-releases.ts`, `GET /repos/…/releases/latest` – the release GitHub marks
"Latest"; prereleases and drafts are never shown):

| GitHub answer | Page shows | Manifest `releaseStatus` |
| --- | --- | --- |
| a release | that release | `fetched` |
| 404 – no published release | no release section | `none` |
| network error, timeout, 403, 429, 5xx, invalid data, or `GITHUB_OFFLINE=1` | the release from the live manifest (re-validated) | `previous` |
| … and the live manifest has none | no release section | `unavailable` (blocked by the guard if the live page showed one) |

Release URLs must be `https://github.com/PeriBluGaming/<repo>/releases/…` – anything else is rejected, never cached.

### Every 15 minutes: new releases trigger a deploy

When code and Sanity content are unchanged, the scheduled check reads the live manifest and asks GitHub for each page's
latest release – with the same function the build uses – and compares **release IDs** (a replaced release counts even
with the same tag; a removed release counts too). A difference triggers the normal build and deploy. Manual runs, the
daily build and code/Sanity changes build without these requests.

**Failure policy:** if a release lookup fails twice, or the live manifest can't be read, the check **fails** (red run,
`::error::`) instead of reporting "no changes" – the same policy as an unreachable Sanity. The next check retries; the
daily build always builds. If GitHub is still failing during the build, the previous releases are reused and the
next check triggers again until GitHub answers.

## Content (Sanity, group "Detail page")

All optional; empty sections are not rendered.

| Section | Source |
| --- | --- |
| Hero | the existing card image (first screenshot or local featured image), title, description, tags, language |
| About the Project | `longDescription` (same rich text as blog posts); falls back to the short description |
| Key Features | `features[]`: title, description, optional image (with alt) or icon; drag to reorder |
| Screenshots | all `screenshots` (alt text, optional `caption`) – no second upload needed |
| Gameplay & Videos | `videos[]`: YouTube URL + optional title; the first one is large |
| Latest Release | see *Releases* |

Videos: nothing is loaded from YouTube/Google until a visitor clicks play; then the player is loaded from
`youtube-nocookie.com`. SEO: unique title, description, canonical URL, Open Graph image, JSON-LD, `/sitemap.xml`.

## Website and Sanity Studio

The website (this repository, deployed by `.github/workflows/deploy.yml`) and the Studio (`studio/`, hosted by Sanity)
are **deployed separately**. The workflow never deploys the Studio.

The Studio's custom **Publish** action (`studio/actions/detailPagePublish.ts`) records `detailPageEnabled` and a slug
on a project document when it is published while featured (or was featured in the published version, or is featured
in `src/config/projects.ts`). It is a second, CMS-side record next to the live manifest: it keeps the information if
the site ever has to be rebuilt from scratch, and lets the Studio show and lock the URL. It only takes effect once the
updated Studio is deployed – until then the live manifest alone protects published pages.

### Safe production rollout

1. Merge to `main`. The next check (≤ 15 min) or a manual run builds; the first deploy is the bootstrap (summary:
   `Page guard: first page manifest …`).
2. Verify the first manifest:
   - `https://periblugaming.github.io/build-info.json` contains `"manifest": 1`;
   - `https://periblugaming.github.io/projects/pages.json` lists every featured project with the expected slug, and
     `releaseStatus` is `fetched` or `none` (not `unavailable`) for each;
   - every `/projects/<slug>/` URL opens.
3. Deploy the Studio: `cd studio && npm ci && npx sanity deploy` (needs a Sanity login with deploy rights).
4. In the Studio, open each featured project and publish it once (no changes needed): `Detail page live` turns on and
   `Page URL` is filled and locked. Each publish triggers a normal content deploy.
5. Verify un-featuring keeps the page: switch **Featured** off on a test project, publish, wait for the deploy, and
   confirm its `/projects/<slug>/` still opens and is still in `pages.json`. Switch it back on afterwards if wanted.
6. Optional: run the workflow manually and confirm the summary shows `releases unchanged (…)` on the next scheduled
   check.

### When the page guard blocks a deployment

The live site stays as it is; nothing is lost. The run log lists each problem as `Page guard: …`.

| Problem | Typical cause | Recovery |
| --- | --- | --- |
| `would disappear` | GitHub listing fell back to the snapshot; repository private/deleted; project hidden; Sanity document deleted | Temporary GitHub problem: wait for the next run. Otherwise restore the cause (unhide, restore the document, make the repository public, refresh the snapshot with `npm run snapshot`). To remove the page **on purpose**: add the repository and its published slug to `retiredDetailPages` and merge. |
| `would move from … to …` | slug edited outside the Studio (API) and no live manifest at build time | Restore the slug in Sanity / `detailPages`; re-run. |
| `would be reassigned` | repository renamed on GitHub, or a new project claims a published slug | Rename: see limitations below. New project: give it another slug. |
| `release … would disappear` | GitHub and the live manifest were both unavailable during the build | Re-run once GitHub is reachable. |
| `live … unreadable` / `returned 404` | GitHub Pages or network problem | Re-run later. Never delete `/projects/pages.json` from the live site. |

## Known limitations

- **Repository renames** change the project's identity (the repository name). The guard blocks the deploy
  (`would disappear` + `would be reassigned`) instead of silently moving or dropping the page. There is no automatic
  rename mapping: the options are renaming the repository back, or a reviewed change that retires the old entry
  (its slug then stays reserved, so the renamed project gets a new URL). A rename alias would be a separate change.
- "Hide on website" on a project with a published page blocks deploys until it is unhidden or retired – on purpose,
  hiding is not treated as permanent removal.
- No redirects are generated; an intentionally retired URL returns 404.
- A build that could not read the live manifest falls back to the local/Sanity records; the guard then blocks it if
  anything would change.
