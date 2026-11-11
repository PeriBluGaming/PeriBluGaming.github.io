# Project detail pages

Every featured project gets a static page at `/projects/<slug>/` (e.g. `/projects/toystory2recomp/`). Featured cards
on the home page open it; the separate **Repository** link still goes to GitHub.

## Which projects get a page

A project that is shown on the site (not hidden, not excluded) gets a page if **any** of these is true
(`src/lib/project-pages.ts`):

| Rule | Where it is recorded |
| --- | --- |
| It is featured now (also newly featured projects) | – automatic |
| It was featured before in Sanity | `detailPageEnabled: true` on its Sanity document |
| It was featured before through code | `detailPages` in `src/config/projects.ts` |

Projects that were never featured get no page. **Hide on website** removes the page as well.

### How activation becomes permanent

- **Sanity:** the Studio's *Publish* button for projects is wrapped (`studio/actions/detailPagePublish.ts`). When a
  project is published while it is featured – or was featured in the currently published version, or is featured in
  `src/config/projects.ts` – the Studio sets `detailPageEnabled: true` and stores a slug if none exists, as part of
  that publish. It uses the editor's own session; there are no build-time writes, tokens or bulk changes. The field is
  read-only once on.
- **Code:** keep the entry in `detailPages` when you remove a project from `featuredProjects`. A test fails if a
  featured repository is missing there.

Existing documents need **no migration**: currently featured projects get pages anyway; the flag is recorded the
next time each document is published. Until then, a featured project that is un-featured *outside* the Studio
(API/CLI) would lose its page – the build logs `has no stored slug yet` for such projects.

## Slugs

Order: `detailPages` (code) → Sanity `slug` → generated from the **repository name** (never the title), lowercase
letters, digits and hyphens. Stored slugs never change when the title changes; the Studio locks the slug once the page
is live and rejects duplicates (other documents and `detailPages`). If two projects still end up with the same slug
the build does not fail: stored slugs win, the later one gets `-2`, `-3`, … and a warning.

## Content (Sanity, group "Detail page")

All optional; empty sections are not rendered.

| Section | Source |
| --- | --- |
| Hero | the existing card image (first screenshot or local featured image), title, description, tags, language |
| About the Project | `longDescription` (same rich text as blog posts); falls back to the short description |
| Key Features | `features[]`: title, description, optional image (with alt) or icon; drag to reorder |
| Screenshots | all `screenshots` (alt text, optional `caption`) – no second upload needed |
| Gameplay & Videos | `videos[]`: YouTube URL + optional title; the first one is large |
| Latest Release | GitHub `releases/latest` (version, date, link) – hidden without a published release |

Videos: nothing is loaded from YouTube/Google until a visitor clicks play; then the player is loaded from
`youtube-nocookie.com`. Releases are fetched once per page at build time; any GitHub error or `GITHUB_OFFLINE=1`
only hides the section. Releases are refreshed by the daily build (03:17 UTC) or a manual deploy – publishing a GitHub
release alone does not trigger a deploy.

SEO: unique title, description, canonical URL, Open Graph image (hero image), JSON-LD, and `/sitemap.xml`
(referenced from `/robots.txt`).
