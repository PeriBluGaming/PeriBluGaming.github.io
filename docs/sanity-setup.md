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
   `.github/workflows/deploy.yml` passes them to the build step only:
   ```yaml
   env:
     GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
     SANITY_PROJECT_ID: ${{ vars.SANITY_PROJECT_ID }}
     SANITY_DATASET: ${{ vars.SANITY_DATASET }}
   ```
   Then run the workflow manually. Without the variables the build still succeeds, with the blog hidden.

### Private dataset (optional)

Manage → API → Tokens → *Add API token* with **Viewer** permission. Store it only as the GitHub **secret**
`SANITY_READ_TOKEN` and in your local `.env`. Never in `studio/.env`, never in the repository.

## Writing a post

1. Studio → **Blog posts** → *Create*.
2. Title → *Generate* slug → short description → category → cover image (16:9, alt text required) → article.
3. **Publish**. Drafts never reach the website. *Hide on website* keeps a published post offline.
4. Run the deploy workflow (manual for now; automation: [publishing-pipeline.md](publishing-pipeline.md)).

Posts with a future publish date are skipped until a build runs after that date.

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

### Prepared for later (not registered in the Studio)

- `studio/schemaTypes/future/project.ts` – CMS overrides for GitHub projects (title, description, screenshots,
  featured, visibility, accent, order). The GitHub API stays the source of the repository list;
  `src/config/projects.ts` remains the fallback.
- `studio/schemaTypes/future/game.ts` – game collection (title, platform, cover, purchase date, status, notes).
- Translations: every post has a `language` field (default `en`). For real translations add more entries to
  `blogLanguages`, consider `@sanity/document-internationalization`, and add `/<lang>/blog/` routes.

## Free plan notes

- Everything used here (Studio hosting on `*.sanity.studio`, public dataset, API reads during builds, image CDN)
  is available on the Free plan. Quotas (API requests, bandwidth, documents, seats) apply – see
  <https://www.sanity.io/pricing>. One build = one API request (`useCdn: false`), so quotas are not a concern.
- Images are served from `cdn.sanity.io` with responsive sizes (`srcset`) and automatic WebP/AVIF.
