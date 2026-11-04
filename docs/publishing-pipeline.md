# Publishing pipeline: Sanity → GitHub Pages (design, NOT active)

Status: **documentation only.** Nothing described here is enabled. `.github/workflows/deploy.yml` stays manual
(`workflow_dispatch`) until the owner approves one of the options below.

GitHub Pages serves static files, so a post published in the Studio only goes live after a new build. Goal: publish
in the Studio → site rebuilds automatically, without manual commits, without tokens in the browser, without secrets
in the repository and without paid infrastructure.

## Building blocks

- **Deploy job**: the existing `deploy.yml` (build + `actions/deploy-pages`). Automation only adds *triggers*;
  build and deploy steps stay the same. Its `concurrency: pages` group already serialises deployments.
- **Build-time safety** (already implemented): if Sanity fails, the build fails and the previous deployment stays
  online (see [sanity-setup.md](sanity-setup.md#modes)).
- **Sanity side**: [GROQ-powered webhooks](https://www.sanity.io/docs/webhooks) can send a request when a `post`
  is published, changed or deleted. Webhooks can be signed with a secret.
- **GitHub side**: a workflow can be started by `repository_dispatch` or `workflow_dispatch` (both need an
  authenticated API call) or by `schedule` (needs no external caller).

## Option A – scheduled check (recommended first step)

```text
GitHub Actions cron (e.g. every 30 min) → query Sanity: newest _updatedAt of published posts
   → compare with the value stored at the last deploy → changed? → build + deploy, else stop
```

- **No credentials leave GitHub.** Sanity does not need a GitHub token; no public endpoint exists that could be
  abused to trigger deployments.
- Reads use the public dataset (or the `SANITY_READ_TOKEN` secret for a private one).
- The "last deployed" marker can be kept as an Actions cache entry or as a repository variable (the latter needs a
  token with `variables: write`; a cache entry needs nothing extra).
- Cost: free for public repositories. Scheduled workflows in public repos are disabled automatically after 60 days
  without repository activity – GitHub sends a mail; re-enable with one click.
- Drawback: delay up to the cron interval; schedules may start a few minutes late.

Sketch (separate file, e.g. `.github/workflows/sanity-sync.yml`):

```yaml
on:
  schedule: [{ cron: '*/30 * * * *' }]
  workflow_dispatch:
permissions: { contents: read }
jobs:
  check:
    runs-on: ubuntu-latest
    outputs: { changed: ${{ steps.diff.outputs.changed }} }
    steps:
      - id: diff
        run: |
          # GROQ: max(_updatedAt) of published posts + count (detects deletions)
          # compare with cached marker, write "changed=true|false" to $GITHUB_OUTPUT
  deploy:
    needs: check
    if: needs.check.outputs.changed == 'true'
    uses: ./.github/workflows/deploy.yml   # requires adding `workflow_call` to deploy.yml
```

## Option B – Sanity webhook → GitHub `repository_dispatch`

```text
Studio "Publish" → Sanity webhook (POST https://api.github.com/repos/PeriBluGaming/PeriBluGaming.github.io/dispatches)
   Authorization: Bearer <fine-grained PAT>   body: {"event_type":"sanity-publish"}
→ workflow `on: repository_dispatch: types: [sanity-publish]` → build + deploy
```

- Fast (about 1–2 minutes to live).
- A **GitHub token is stored at Sanity** (in the webhook's HTTP headers). It must be a fine-grained PAT for this one
  repository with the minimum permission `repository_dispatch` requires (**Contents: read and write**). That
  permission could also push code, so a leaked token is serious. Expiry + rotation needed.
- GitHub cannot verify Sanity's webhook signature; anyone holding the token can trigger builds (not change
  content, though – content always comes from Sanity).

## Option C – webhook through a small verifying relay

```text
Sanity webhook (signed with secret S) → relay (e.g. Cloudflare Worker, free tier)
   verifies HMAC signature + timestamp, rate-limits, checks _type == "post"
   → calls GitHub workflow_dispatch with a token that only the relay knows
```

- Strongest separation: Sanity only holds the webhook secret, GitHub token lives in the relay's secret store;
  forged or replayed requests are rejected; a GitHub App or a PAT limited to **Actions: write** (enough for
  `workflow_dispatch`, cannot push code) can be used.
- Needs one more external account/service (free tier) – requires explicit approval.

## Comparison

| | A: schedule | B: direct webhook | C: relay |
| --- | --- | --- | --- |
| Delay | ≤ cron interval | ~1–2 min | ~1–2 min |
| GitHub token outside GitHub | none | at Sanity (Contents: write) | in relay (Actions: write) |
| Webhook authentication | n/a | token only | HMAC signature verified |
| Extra services | none | none | relay (free tier) |
| Effort | low | low | medium |

**Recommendation:** start with **A** (zero exposure, zero extra services). If the delay is annoying, move to **C**.
B only with a short-lived, single-repo token and the risk accepted consciously.

## Guardrails for any option

- Separate workflow file; `deploy.yml` steps unchanged (at most `workflow_call` / an extra trigger added).
- Only the default branch is deployed; `environment: github-pages` protection rules (Settings → Environments) can
  limit deployments to `main`.
- `concurrency: pages` prevents overlapping deployments; debounce bursts of edits (cron does this naturally; for
  webhooks use a GROQ filter like `_type == "post" && delta::changedAny(...)` and the "Publish" trigger only).
- Failed builds never deploy (build job fails → deploy job does not run).
- Secrets only in GitHub/Sanity/relay secret stores, never in the repository or `studio/.env`.
