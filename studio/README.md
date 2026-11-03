# PeriBluGaming Sanity Studio

Content editor for the website's blog. Separate npm package on purpose: the Astro site does not depend on React or
the Studio, and the Studio is hosted by Sanity (free) instead of GitHub Pages.

```bash
cp .env.example .env     # SANITY_STUDIO_PROJECT_ID=<project id>
npm ci
npm run dev              # http://localhost:3333
npm run deploy           # https://<studioHost>.sanity.studio (see sanity.cli.ts) – only after approval
```

Setup, content model and security notes: [../docs/sanity-setup.md](../docs/sanity-setup.md).

- `schemaTypes/` – registered types (`post`, `blockContent`, `codeBlock`)
- `schemaTypes/future/` – prepared types (`project`, `game`), not registered yet
- Categories are shared with the website via `../src/config/blog.ts`

Security: [../docs/sanity-security.md](../docs/sanity-security.md). In short – the Studio uses your Sanity login,
never a token. Every `SANITY_STUDIO_*` variable is public; `sanity.cli.ts` refuses token-like names.
`package.json` → `overrides` pins patched versions of three CLI-only dependencies (see §8 of that document).
