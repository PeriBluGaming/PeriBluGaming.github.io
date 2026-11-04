# Blog & Sanity CMS

The blog is managed in [Sanity](https://www.sanity.io) (headless CMS, **Free plan**) and rendered by Astro **at
build time**. The published site stays fully static: no Sanity request, token or API call ever happens in the
visitor's browser. Only images are loaded from Sanity's image CDN (`cdn.sanity.io`).

```text
studio/  (Sanity Studio, separate npm package)  ──publish──▶  Sanity Content Lake (dataset "production")
                                                                      │  GROQ, published documents only
src/lib/blog/  ◀── npm run build ─────────────────────────────────────┘
   │  validate + sanitise (normalize.ts)
   ▼
/blog/, /blog/<slug>/, /blog/category/<id>/   (static HTML on GitHub Pages)
```

Security model, access control, MFA and a setup checklist: **[sanity-security.md](sanity-security.md)** – read it
before creating the project.

## Modes

| Situation | Result |
| --- | --- |
| `SANITY_PROJECT_ID` not set | Blog **not configured**. No posts, no "Blog" menu item, `/blog/` shows an empty state with `noindex`. The live site looks exactly as before. |
| `SANITY_PROJECT_ID` set, posts published | Posts are built. The "Blog" menu item appears automatically. |
| `SANITY_PROJECT_ID` set, no posts yet | Same as not configured: menu item hidden, empty state. |
| `SANITY_PROJECT_ID` set, **Sanity unreachable / error** | **Build fails** with a clear `[blog]` message. GitHub Pages keeps serving the previous deployment, so posts never disappear silently. |
| … plus `SANITY_ALLOW_FAILURE=1` | Build continues **without** posts (menu item hidden, "temporarily unavailable" note) and logs a warning. Only for emergencies. |
| `BLOG_SAMPLE=1` | Local sample posts from `src/data/sample-posts.json`. For development only; refused when `CI`/`GITHUB_ACTIONS` is set. |
| A single post is invalid (e.g. bad slug) | That post is skipped with a warning; the others are published. |

## Local development without Sanity

```bash
BLOG_SAMPLE=1 npm run dev            # blog with sample posts at http://localhost:4321/blog/
BLOG_SAMPLE=1 GITHUB_OFFLINE=1 npm run build && npm run preview
```

With `SANITY_PROJECT_ID` in your local `.env`, every build needs network access to `<projectId>.api.sanity.io`
and **fails** if it is unreachable (by design). Offline or in a restricted network:
`SANITY_PROJECT_ID= npm run build` (blog disabled) or `BLOG_SAMPLE=1 …`.

## PeriBluGaming project

| | |
| --- | --- |
| Project ID | `hyyn359x` (public) |
| Dataset | `production` (public: published documents readable without a token, drafts not) |
| Studio URL | `https://periblugaming.sanity.studio` (deployed) |
| Studio app ID | `fsi8ker3lj7cei92xxfb5lfn` (public, `deployment.appId` in `studio/sanity.cli.ts`) |

`studio/.env.example` contains these values – `cp studio/.env.example studio/.env` is all the Studio needs.

## Environment variables (website, build time only)

| Variable | Required | Purpose |
| --- | --- | --- |
| `SANITY_PROJECT_ID` | for the blog | Sanity project ID (not secret – it is part of every image URL). |
| `SANITY_DATASET` | no | Default `production`. |
| `SANITY_API_VERSION` | no | Pinned API date, default `2025-02-19`. Bump deliberately after checking the changelog. |
| `SANITY_READ_TOKEN` | no | **Secret.** Only for a *private* dataset. Viewer (read-only) token. Never commit it. |
| `SANITY_ALLOW_FAILURE` | no | `1` = build without posts if Sanity fails. Leave unset in production. |
| `BLOG_SAMPLE` | no | `1` = sample posts (local only). |

None of them uses the `PUBLIC_` prefix, so Astro never bundles them into client code. To double-check after a
change, build with a dummy token and search the output: `grep -r "<dummy token>" dist` must find nothing.

Studio variables (`studio/.env`): `SANITY_STUDIO_PROJECT_ID`, `SANITY_STUDIO_DATASET`. These are bundled into the
Studio **by design** – never put a token there.

## One-time setup on the Free plan

> For PeriBluGaming the project and the hosted Studio already exist (see the table above); the steps stay here
> for reference and a possible re-setup. Each step creates or changes something in an external service – do it
> yourself, or approve it explicitly. No payment details are required at any step. If Sanity offers a trial of a
> paid plan, do not enter payment details; check **Manage → Plan** that the project is on **Free**.

1. **Account** – sign up at <https://www.sanity.io> with **GitHub** (or Google) – an account that has **2FA**
   enabled. Sanity relies on the provider for MFA; avoid the email/password login.
2. **Project** – in <https://www.sanity.io/manage> create a new project, e.g. "PeriBluGaming", with the dataset
   `production`. Note the **project ID** (8 characters).
3. **Dataset visibility** – `production` is *public* by default: published documents can be read without a token,
   drafts never. That is fine for public blog posts and means no secret is needed for builds. (Alternative: make it
   private and use `SANITY_READ_TOKEN`, see below.)
4. **Studio locally**
   ```bash
   cd studio
   cp .env.example .env        # set SANITY_STUDIO_PROJECT_ID=<project id>
   npm ci
   npx sanity login
   npm run dev                 # http://localhost:3333
   ```
   On first start Sanity asks to add `http://localhost:3333` as a CORS origin – confirm it (or add it under
   **Manage → API → CORS origins**, *with* credentials). Never add the website's domains or wildcards with
   credentials. Never put a token into `studio/.env` – every `SANITY_STUDIO_*` variable ends up in the public
   Studio bundle (`sanity.cli.ts` refuses token-like names).
5. **Studio online (browser & phone)** – hosted for free at `https://periblugaming.sanity.studio`.
   `deployment.appId` in `studio/sanity.cli.ts` identifies that deployment, so `npm run deploy` in `studio/`
   updates it (only after approval). For a new project without an app ID, the first `sanity deploy` asks for a
   hostname, creates the app and prints its **appId** – put it into `deployment.appId` (it replaces the deprecated
   `studioHost`). `deployment.autoUpdates` is `false`: the hosted Studio runs
   exactly the reviewed, lock-filed version. The page itself is public and shows a login screen; content can only be read (beyond published posts)
   or changed by project members. The Studio works in mobile browsers.
6. **Members** – only your own account, role **Administrator**. Don't invite anyone (Viewers can read drafts).
   No API tokens are needed. Go through the checklist in [sanity-security.md](sanity-security.md#7-setup-checklist-do-these-yourself).
7. **Website build locally**
   ```bash
   # .env in the repository root (git-ignored)
   SANITY_PROJECT_ID=<project id>
   npm run build
   ```
8. **Production build** – add `SANITY_PROJECT_ID` = `hyyn359x` and `SANITY_DATASET` = `production` as
   **repository variables** (Settings → Secrets and variables → Actions → *Variables*, not secrets).
   `.github/workflows/deploy.yml` passes them to the build and the scheduled content check; without them the
   workflow fails on purpose. Details: [deployment.md](deployment.md).

### Private dataset (optional)

Manage → API → Tokens → *Add API token* with **Viewer** permission. Store it only as the GitHub **secret**
`SANITY_READ_TOKEN` and in your local `.env`. Never in `studio/.env`, never in the repository.

## Writing a post

1. Studio → **Blog posts** → *Create*.
2. Title → *Generate* slug → short description → category → cover image (16:9, alt text required) → article.
3. **Publish**. Drafts never reach the website. *Hide on website* keeps a published post offline.
4. Done – the scheduled check deploys it within about 5–25 minutes. For an immediate update, run the deploy
   workflow manually ([deployment.md](deployment.md)).

Posts with a future publish date appear automatically with the first scheduled check after that date.

## Content model

`studio/schemaTypes/post.ts` – fields: title, slug, short description, category, publish date, cover image (+ alt),
article (`blockContent`), language (prepared, English only), hide flag, GitHub repository, GitHub release
(tag + URL, restricted to `github.com/PeriBluGaming/`), source (`manual` / `github-release`), SEO title,
meta description, noindex. Drafts are Sanity's built-in draft state.

Rich text (`studio/schemaTypes/blockContent.ts`): normal text, H2–H4, quote, bullet/numbered lists, bold, italic,
inline code, underline, strike-through, external/relative links, links to other posts, images (alt + caption) and
code blocks. The website accepts **only** this whitelist (`src/lib/blog/normalize.ts`): unknown types, unsafe link
targets (`javascript:`, `data:`, `//host` …) and HTML are dropped. Rich text is rendered by Astro components, never
with `set:html`.

Categories live in `src/config/blog.ts` and are shared with the Studio – add a category there once.

### Projects (`studio/schemaTypes/project.ts`)

Optional editorial overrides for GitHub repositories, matched by `repo` (case-insensitive, trimmed). GitHub stays the
source of truth for which repositories exist and for technical data (URL, language, stars, push date, fork/archived);
a repository needs **no** project document. The website reads published project documents at build time
(`src/lib/sanity-projects.ts`, same settings as the blog) and merges them in `src/lib/project-merge.ts`:

- **Per field:** explicit Sanity value → `src/config/projects.ts` → GitHub / default. Explicit `false`, `[]` and an
  empty description count as values; unset fields fall through. Invalid fields are ignored with a build warning.
- **Featured:** `featured: true` adds, `false` removes, unset keeps the configuration. Order: `featuredOrder`, else
  the position in `featuredProjects`; ties by that position, then by name. Featured projects bypass the fork/archive
  filters; hidden projects never appear. `listSettings.exclude` stays absolute.
- **Screenshot:** the first Sanity screenshot (with alt text) replaces the local one; its hotspot becomes the
  card's `object-position`. Missing or invalid → local screenshot → platform artwork.
- **Duplicates** (same repo): the most recently updated document wins, ties by document ID; a warning lists the
  ignored ones. Documents for repositories GitHub doesn't return are ignored – they never create cards.
- **Failures:** Sanity not configured, unreachable or returning garbage → the local configuration, as before (warning).
  An empty collection is fine.
- **Deploys:** published project changes are part of the deploy fingerprint and go live with the 15-minute check,
  like posts; drafts and release versions don't trigger builds ([deployment.md](deployment.md)).

#### Migrating the local configuration

**1. Dry run** (no token, nothing written)


`npm run migrate:projects:dry-run` (add `-- --json` for a machine-readable plan) shows how `src/config/projects.ts`
plus intended additions (currently SledStormPSXRecomp, featured as 4th entry; the entries after it move down) would
become project documents: deterministic IDs
(`project-<repo>`), CREATE / UPDATE / UNCHANGED / SKIP / BLOCKED per project, field-by-field conflicts with existing
documents (never overwritten), screenshot upload needs (local files are matched to Sanity assets by SHA-1) and the
effect on the website via the real merge. It is **read-only**: tokenless GET queries only, no Sanity client, no write
mode – nothing is created, uploaded or published.

**2. Authenticated preflight** (read-only, needs the read token only)

```bash
read -rs SANITY_MIGRATION_READ_TOKEN && export SANITY_MIGRATION_READ_TOKEN   # paste; not echoed, not in the shell history
npm run migrate:projects:preflight
```

Same planner as the dry run, but with an authenticated **raw** read: drafts (`drafts.*`), release versions
(`versions.*`), duplicate documents and documents of any type that occupy a proposed ID block the project. Existing
project documents are additionally read **exactly** (doc endpoint, not GROQ): a field stored as an explicit `null` is
a conflict (BLOCKED, never touched) because it is not reliably "missing" for `setIfMissing`; GROQ, and therefore the
tokenless dry run, cannot tell `null` from missing. The proposed documents are validated with the Studio schema;
GitHub must be live (not the fallback snapshot); unintended changes to the existing cards or their featured order
block execution. Exit code 1 if anything blocks. The output ends with the **plan fingerprint** – SHA-256 over the
target dataset, the GitHub repository names, every relevant Sanity document with its revision and the exact proposed
operations – and the command to execute exactly this plan. The preflight never reads the write token.

**3. Execution** (writes – only after reviewing the preflight)

```bash
read -rs SANITY_MIGRATION_WRITE_TOKEN && export SANITY_MIGRATION_WRITE_TOKEN   # in addition to the read token
npm run migrate:projects:execute -- --execute --confirm-dataset=production --plan=<fingerprint from step 2>
unset SANITY_MIGRATION_READ_TOKEN SANITY_MIGRATION_WRITE_TOKEN                 # then delete both tokens in Sanity
```

**Do not create or edit project documents in the Studio while the execution runs** (see "Race window" below).

Writes only if **all** gates pass: both tokens (different from each other) + `--execute` + `--confirm-dataset`
matching the configured dataset + `--plan`, no unknown or repeated arguments; a fresh authenticated preflight without
blockers; the same fingerprint as approved (otherwise "stale"); an identical fingerprint on a second read immediately
before writing. All writes go into **one atomic transaction** (`periblugaming-project-migration-<fingerprint>`)
containing only `create` (fails if the document exists – nothing is ever replaced) and, for existing documents,
`patch` with `ifRevisionID` + `setIfMissing` (fails on concurrent edits, only adds missing fields). A local check
rejects anything else before sending: no deletions, no `createOrReplace`, no `set`/`unset`, no screenshots/assets, no
document outside the approved plan. Afterwards a third read verifies that every migrated document is UNCHANGED.
Nothing is ever retried automatically. Screenshots are not migrated – the local ones keep working through the fallback.

| Result | Exit | Meaning | Next step |
| --- | --- | --- | --- |
| `committed_verified` | 0 | Sanity confirmed the transaction and the verification read shows every document as planned | run the preflight once more: every project UNCHANGED |
| `nothing-to-do` | 0 | everything already UNCHANGED | – |
| `refused` | 2 | arguments, tokens or a blocker – nothing sent | fix, then preflight again |
| `stale` | 1 | Sanity or GitHub changed since the preflight – nothing sent | preflight again, review, approve the new fingerprint |
| `not_committed` | 1 | Sanity refused the transaction (4xx, e.g. a concurrent edit) – atomic, **nothing written** | preflight again |
| `committed_unverified` | 3 | Sanity **confirmed** the transaction, but the verification read failed or found a difference/conflict. The output lists the transaction ID, the written document IDs and any conflicting document IDs. **The documents may already be live.** | do **not** re-run execute; run a fresh preflight, review the listed documents in the Studio |
| `unknown` | 3 | no or unreadable response (network error, **timeout**, 5xx, redirect, malformed 2xx). Atomic, so **all or nothing** of the listed documents was written – which one is not known. **The documents may already be live.** | do **not** re-run execute; run a fresh preflight: written documents show as UNCHANGED (new fingerprint), otherwise the same plan is still current |

Running it again after a successful migration is safe: everything is UNCHANGED and the old fingerprint is rejected.

**Race window (cannot be closed by the script).** Sanity's mutation API cannot make a transaction conditional on the
*absence* of other documents: `create` only fails if the published ID exists, `ifRevisionID` only guards the published
document. A draft (`drafts.<id>`) or release version created in the Studio between the last read (gate 4, a few hundred
milliseconds before the commit) and the commit is therefore not detected *before* writing. Consequences: for a CREATE
the published document is still created (the draft is not touched), and when the draft is published later it replaces
the migrated values with the draft's; for an UPDATE the draft does not contain the added fields, so publishing it
drops them. The verification read after the commit detects such a document (the project becomes BLOCKED), the result is
`committed_unverified` and names the conflicting document IDs. The script never deletes or changes that draft – review
it in the Studio and decide manually. Avoid the window altogether: nobody edits project documents while it runs.

**Tokens** – two dedicated API tokens, created just before the migration (Manage → API → Tokens) and **deleted right
after**:

| Variable | Used for | Minimum permission |
| --- | --- | --- |
| `SANITY_MIGRATION_READ_TOKEN` | preflight and every read during execution (drafts and release versions) | **Viewer** |
| `SANITY_MIGRATION_WRITE_TOKEN` | the single commit request of the execution – nothing else | **Editor** |

The preflight works without the write token and never reads it. The execution refuses (fail closed) unless both are
set and different – there is no fallback from one to the other, so reads never run with write permission. Both only
through the environment (never in `.env` files that get shared, never committed, never printed – error messages are
redacted, requests never follow redirects). The website
build never reads either token.

| Field | Behaviour |
| --- | --- |
| `repo` | Required. Name below `github.com/PeriBluGaming/` (letters, digits, `.`, `-`, `_`, no surrounding spaces). Unique across all project documents, compared case-insensitively, drafts included. If the uniqueness check can't run, validation fails with a message (publishing stays blocked). |
| `title`, `description` | Optional overrides. |
| `category` | Optional, same categories as `src/config/projects.ts`. |
| `tags` | Optional, max. 2, non-empty, unique. |
| `hidden` | Default `false`; only `true` hides a project. |
| `featured` | Optional, **no default**: unset = keep the website default, `true`/`false` = explicit override. |
| `featuredOrder` | Optional whole number ≥ 0, lower first; warning if set while not featured. |
| `accent` | Optional: `cyan`, `pink`, `violet` (same as the website). |
| `screenshots` | Optional images with hotspot; alt text required. The **first** one is meant for the featured card's left art area (cropped – set the hotspot). |

Security: published project documents (including screenshots) are publicly readable via the API, like posts.

### Prepared for later (not registered in the Studio)

- `studio/schemaTypes/future/game.ts` – game collection (title, platform, cover, purchase date, status, notes).
- Translations: every post has a `language` field (default `en`). For real translations add more entries to
  `blogLanguages`, consider `@sanity/document-internationalization`, and add `/<lang>/blog/` routes.

## Free plan notes

- Everything used here (Studio hosting on `*.sanity.studio`, public dataset, API reads during builds, image CDN)
  is available on the Free plan. Quotas (API requests, bandwidth, documents, seats) apply – see
  <https://www.sanity.io/pricing>. One build = one API request (`useCdn: false`), so quotas are not a concern.
- Images are served from `cdn.sanity.io` with responsive sizes (`srcset`) and automatic WebP/AVIF.
