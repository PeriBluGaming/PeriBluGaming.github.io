# PeriBluGaming.github.io

Official portfolio website of **PeriBluGaming** – retro gaming, native recompilation, homebrew and tools.
Built with [Astro](https://astro.build), TypeScript and Tailwind CSS. Repository data is fetched from the
GitHub REST API and blog posts from [Sanity](https://www.sanity.io) **at build time only**; the published site is
fully static.

## Requirements

- Node.js ≥ 22.23.4 (the project pins Node 24 via `.nvmrc`)
- npm

```bash
nvm use        # switches this shell to the version in .nvmrc
npm install
```

## Commands

| Command            | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `npm run dev`      | Dev server at http://localhost:4321                              |
| `npm run build`    | Type check (`astro check`) + production build into `dist/`       |
| `npm run preview`  | Serve the production build locally                               |
| `npm run snapshot` | Refresh `src/data/fallback-repos.json` from the live GitHub API  |
| `npm test`         | Unit tests (Node's built-in test runner)                         |

## Project data

- `src/config/projects.ts` – featured projects (order, accent, optional screenshot), categories,
  per-repo title/description/tags, exclusions, fork/archive filters.
  Adding screenshots: [docs/project-screenshots.md](docs/project-screenshots.md).
- `src/config/site.ts` – site metadata and social links (`enabled: false` = hidden).
- `src/data/fallback-repos.json` – real API snapshot used when GitHub is unreachable or rate-limited.
- Project detail pages (`/projects/<slug>/`), their Sanity fields and how activation persists:
  [docs/project-pages.md](docs/project-pages.md).

## Blog (Sanity CMS)

Posts are written in the Sanity Studio (`studio/`, separate package) and built into `/blog/`. Without
`SANITY_PROJECT_ID` the blog is simply hidden (no menu item). Setup, modes and content model:
[docs/sanity-setup.md](docs/sanity-setup.md), security model and checklist:
[docs/sanity-security.md](docs/sanity-security.md).

```bash
BLOG_SAMPLE=1 npm run dev   # blog with local sample posts, no Sanity account needed
```

- `src/config/blog.ts` – categories (shared with the Studio).
- `src/lib/blog/` – config, loading, validation/sanitising, Sanity client.
- Published posts go live automatically (scheduled check, see *Deployment*). Release posts are designed but not
  active: [docs/release-automation.md](docs/release-automation.md).

### Environment variables (optional, build time only)

| Variable         | Purpose                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `GITHUB_TOKEN`   | Raises the API rate limit (60 → 5000 req/h). Never commit a token. |
| `GITHUB_OFFLINE` | `1` = skip the API and build from the fallback snapshot.           |

Blog variables (`SANITY_PROJECT_ID`, `SANITY_DATASET`, `SANITY_API_VERSION`, `SANITY_READ_TOKEN`,
`SANITY_ALLOW_FAILURE`, `BLOG_SAMPLE`): see `.env.example` and [docs/sanity-setup.md](docs/sanity-setup.md).

## Deployment

`.github/workflows/deploy.yml` deploys `main` to GitHub Pages: manually (`workflow_dispatch`, always builds) and
every 15 minutes when the code on `main` or the published Sanity content changed – drafts never trigger a deploy.
A daily build at 03:17 UTC refreshes the GitHub project cards.
No secrets; requires the repository variables `SANITY_PROJECT_ID` and `SANITY_DATASET`.
How it works, required settings and limits: [docs/deployment.md](docs/deployment.md).

## Design references

`design-references/` holds the local design originals and is excluded from Git. Optimised derivatives used by the
site live in `public/images/` and can be regenerated with `scripts/assets/build_assets.py`
(see [scripts/assets/README.md](scripts/assets/README.md)).
