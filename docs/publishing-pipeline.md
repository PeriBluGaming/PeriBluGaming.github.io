# Publishing pipeline: Sanity → GitHub Pages (design and options)

Status: **Option A is implemented** in `.github/workflows/deploy.yml` – operation, settings and limits:
[deployment.md](deployment.md). It becomes active once the workflow is on `main` and the repository variables are
set. Options B and C remain possible later additions for faster publishing.

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

## Option A – scheduled check (implemented)

```text
GitHub Actions cron (every 15 min) → fingerprint of the visible Sanity content + commit on main
   → compare with /build-info.json of the live site → changed? → build + deploy, else stop
```

- **No credentials leave GitHub.** Sanity does not need a GitHub token; no public endpoint exists that could be
  abused to trigger deployments. Reads use the public dataset without a token.
- Compared with the first sketch (newest `_updatedAt` + count, marker in an Actions cache) the implementation uses
  - a **fingerprint over type, ID and `_rev` of every visible document**, computed with the same GROQ filter as the
    blog query – it also catches scheduled posts becoming visible and hide/unhide;
  - the **live site's `/build-info.json`** as the "last deployed" marker – no cache that can expire, no variable
    that needs a write token, always compared with what is really online;
  - the **commit on `main`** as part of the comparison, so merged code goes live without a separate trigger;
  - a **deploy gate** that refuses outdated builds (re-runs, content changed during the build).
- Cost: free for public repositories. Scheduled workflows in public repos are disabled automatically after 60 days
  without repository activity – GitHub sends a mail; re-enable with one click.
- Drawback: delay up to the cron interval; schedules may start late.

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
- Better variant: call **`workflow_dispatch`** instead (`POST …/actions/workflows/deploy.yml/dispatches`, body
  `{"ref":"main"}`). It needs only **Actions: write** (cannot change code). The deploy gate and the `main`-only
  conditions in `deploy.yml` already guard against dispatches on other refs and re-runs of old runs. Keep the
  schedule as safety net – webhooks are retried only twice and don't fire for scheduled posts.
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
