# PeriBluGaming.github.io

Official portfolio website of **PeriBluGaming** – retro gaming, native recompilation, homebrew and tools.
Built with [Astro](https://astro.build), TypeScript and Tailwind CSS. Repository data is fetched from the
GitHub REST API **at build time only**; the published site is fully static.

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

## Project data

- `src/config/projects.ts` – featured projects (order + accent), categories, per-repo title/description/tags,
  optional `image`, exclusions, fork/archive filters.
- `src/config/site.ts` – site metadata and social links (empty URL = hidden).
- `src/data/fallback-repos.json` – real API snapshot used when GitHub is unreachable or rate-limited.

### Environment variables (optional, build time only)

| Variable         | Purpose                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `GITHUB_TOKEN`   | Raises the API rate limit (60 → 5000 req/h). Never commit a token. |
| `GITHUB_OFFLINE` | `1` = skip the API and build from the fallback snapshot.           |

## Deployment

`.github/workflows/deploy.yml` deploys to GitHub Pages and is **manual only** (`workflow_dispatch`).
Enable Pages with source "GitHub Actions" before the first run.

## Design references

`design-references/` holds the local design originals and is excluded from Git. Optimised derivatives used by the
site live in `public/images/` and can be regenerated with `scripts/assets/build_assets.py`
(see [scripts/assets/README.md](scripts/assets/README.md)).
