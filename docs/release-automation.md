# GitHub releases → "Releases" posts (design, NOT active)

Status: **documentation only.** The data model is prepared (`source: 'github-release'`, `relatedRepo`,
`relatedRelease` on `post`); no code fetches releases and nothing writes to Sanity.

## Goal

New releases of public PeriBluGaming repositories appear as posts in the category **Releases**, without duplicates,
clearly marked as automatic, and without unsafe HTML from release notes.

## Recommended architecture: GitHub Action → Sanity draft → review → publish

```text
schedule / manual run (GitHub Actions)
  1. list public repos of PeriBluGaming          GET /users/PeriBluGaming/repos?type=owner   (reuse src/lib/github.ts)
  2. per repo: list releases                     GET /repos/PeriBluGaming/<repo>/releases
  3. filter: draft == false; prerelease only if INCLUDE_PRERELEASES=1; skip forks/archived/excluded (projects.ts)
  4. map → post document (see below)
  5. Sanity mutation: createIfNotExists  _id = "drafts.release-<repo>-<tag>"   (write token = GitHub secret)
  6. owner reviews the draft in the Studio and presses Publish → normal publishing pipeline
```

Why drafts first: automatic text never goes live unreviewed, and the owner can add a cover image or a few words.
Once trusted, step 5 can write the published ID (`release-<repo>-<tag>`) directly – a one-line switch.

### Duplicate prevention

- **Deterministic document ID** `release-<repo>-<tag>` (lowercased, characters outside `[a-z0-9._-]` replaced by
  `-`). `createIfNotExists` makes re-runs idempotent – the same release can never create a second post, and a post
  edited by hand is never overwritten.
- Slug: `<repo>-<tag>` in kebab-case (e.g. `toystory2recomp-v1-2-0`). The website additionally skips duplicate
  slugs (implemented in `processPosts`).
- Deleted/unwanted release posts: set *Hide on website* instead of deleting – a deleted document would be
  recreated on the next run. (Alternative: keep an "ignored releases" list.)

### Field mapping

| Post field | From the GitHub release |
| --- | --- |
| `title` | `<project title from projects.ts> <tag>` or release `name` |
| `slug` | `<repo>-<tag>` |
| `category` | `releases` |
| `publishedAt` | `published_at` |
| `excerpt` | first non-empty line of the notes (plain text, ≤ 200 chars) or "New release <tag> of <project>." |
| `source` | `github-release` (read-only in the Studio) |
| `relatedRepo` | repository name |
| `relatedRelease` | `{ tag: tag_name, url: html_url }` (must start with `https://github.com/PeriBluGaming/`) |
| `body` | release notes converted to Portable Text (see below) |

### Release notes – no unsafe HTML

- Use the release `body` (**Markdown source**), never the rendered `body_html`.
- Convert Markdown → Portable Text with a small converter that only produces the supported whitelist
  (paragraphs, H2–H4, lists, bold/italic/code, links, code blocks). Raw HTML in the Markdown is dropped or kept as
  plain text. Images from release notes are not imported (would need asset upload; link to the release instead).
- The website's normalisation (`src/lib/blog/normalize.ts`) is the second line of defence: it drops unknown node
  types and unsafe link targets regardless of the source.
- Length cap (e.g. 20 000 characters) with a "Full release notes on GitHub" link.

### Pre-releases

`INCLUDE_PRERELEASES` (repository variable, default off). If on, add a "Pre-release" note to the excerpt.

### Manual vs. automatic posts

`source` distinguishes them. The website can show a small "Release" badge or filter on it later; manual posts
about a release simply use `relatedRelease` with `source: manual`.

### Credentials

- Reading releases: built-in `GITHUB_TOKEN` of the workflow (read-only).
- Writing to Sanity: an API token with **Editor** permission, stored only as the GitHub secret
  `SANITY_WRITE_TOKEN`. Never in the website build (which only reads), never in the repository.
- Workflow `permissions: { contents: read }`.

### Alternative considered: releases fetched at build time only

The website could fetch releases directly during the build (like the project list) and render them without the
CMS. Simpler, but releases could not be reviewed, annotated or hidden in the Studio, and two sources of posts would
have to be merged. Kept as a fallback idea.

## Rollout steps (each needs approval)

1. Implement `scripts/sync-releases.ts` + unit tests (filtering, ID/slug generation, Markdown → Portable Text).
2. Dry-run mode (`--dry-run` prints planned documents) in a manual workflow.
3. Create `SANITY_WRITE_TOKEN`, enable the manual workflow, review generated drafts.
4. Optionally add a schedule.
