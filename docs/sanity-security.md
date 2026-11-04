# Sanity – security model & hardening checklist

Scope: Sanity project for the PeriBluGaming blog on the **Free plan**, Studio in `studio/`, website build in
`src/lib/blog/`. Goal: only the owner's account can create, edit, delete or publish content; visitors can read
published posts only; nothing unpublished leaks.

> Facts about Sanity's plans and features below were checked against Sanity's documentation in November 2026.
> Plans change – verify the marked items (⚠︎) in **sanity.io/manage** during setup.

## 1. Who can do what

| Actor | Studio UI | Read published | Read drafts / versions | Write / publish / delete | Project settings |
| --- | --- | --- | --- | --- | --- |
| Anyone on the internet | loads the **login screen** only | **yes** (public dataset, via API) | no | no | no |
| Logged-in Sanity user, **not** a member | login works, but no project access | yes (same as anyone) | no | no | no |
| Member with role **Viewer** | yes | yes | **yes** | no | no |
| Member with role **Administrator** (you) | yes | yes | yes | **yes** | **yes** |
| API token | – | per token role | per token role | per token role | – |

### The Studio URL is not a security boundary

`https://periblugaming.sanity.studio` serves a static JavaScript app **without authentication**. Anyone can load
it and will see Sanity's login screen. The bundle contains only public information: project ID, dataset name and
the content schema. Every data read beyond published documents and every write is checked **server-side** by
Sanity's API against the logged-in user's project membership and role. The same applies to `localhost:3333`.
So: the *interface* is public, *data and editing* are protected.

### Roles on the Free plan

- Available: **Administrator** and **Viewer** only (⚠︎). Editor/Contributor and custom roles need paid plans –
  nothing here depends on them.
- Administrator = full read/write on all datasets + members, tokens, CORS, webhooks.
- Viewer = read **everything including drafts**, no writes. Viewers don't use a seat, but they *do* see
  unpublished content – **don't invite viewers** unless intended.
- Result: publishing rights = Administrator = only you.

### No public registration, no self-service access

Anyone can create a *Sanity account*, but an account has **no access** to your project until an Administrator
invites it (Manage → Members). Nothing in this repository creates members, invitations or tokens. If Sanity shows
you **access requests** from other accounts (⚠︎ newer Studio/Manage versions can offer a "request access" flow),
they only take effect when an Administrator approves them – **decline** anything you don't recognise.

### What anonymous visitors can read

With a **public** dataset (default), the special "everyone" identity can read all documents at the **root path**
through the API – i.e. exactly the published posts the website shows, *including fields the website does not
display*. Documents with a dot in their ID (`drafts.*`, `versions.*`) are **not** readable anonymously.
Writes always require authentication.

⇒ **Never put private information into published documents** (e.g. later: personal notes or purchase prices in
the game collection). For such content use a **private dataset** (supported on Free ⚠︎) and a read token, or
keep the data out of Sanity.

## 2. Drafts can't reach the website

| Layer | Protection |
| --- | --- |
| Sanity | drafts/versions live under `drafts.*` / `versions.*` – not readable without auth |
| Website build | no token by default → anonymous read → drafts impossible |
| Client config | `perspective: 'published'`, `useCdn: false`, `withCredentials: false`, `stega: false` (`src/lib/blog/sanity.ts`) |
| Query | `_id in path("*")` (root documents only), `publishedAt <= now()`, `hidden != true` |
| Normalisation | links to posts that are not in the build become plain text (no hints at unpublished slugs) |
| Tests | `tests/blog-sanity.test.ts`, `tests/blog-load.test.ts` |

With an optional `SANITY_READ_TOKEN` (private dataset) the token *could* read drafts – the perspective and the
query still never request them.

## 3. Account security & MFA

- Login providers: **Google**, **GitHub**, **email + password** (⚠︎). Your Sanity account is bound to the provider
  you signed up with – the same e-mail via another provider is a *different* account.
- Sanity has **no separate MFA setting** for Google/GitHub logins – MFA is enforced by the provider (⚠︎ for
  email/password accounts no Sanity-side 2FA is documented).
- **Recommendation:** sign up with **GitHub** (or Google) and make sure that account has **2FA** (passkey or
  authenticator app; GitHub already requires 2FA for many accounts). Don't use the email/password login.
- SSO/SAML and custom login are paid/Enterprise features – not needed.
- Restricting the login buttons in the Studio (`auth.providers`) only changes the UI, not who can log in – not
  used, not a security measure.
- `npx sanity login` stores a CLI session token in your user config folder. Use `npx sanity logout` on shared
  machines.

## 4. Tokens & secrets

| Credential | Needed? | Where it may live | Never |
| --- | --- | --- | --- |
| Website read token `SANITY_READ_TOKEN` | **no** (public dataset) | only if dataset is private: GitHub *secret* + local `.env`, role **Viewer** | repository, `studio/.env`, any `PUBLIC_*`/`SANITY_STUDIO_*` variable |
| Write/Editor/Admin token | **no** (Studio uses your login) | later only for release automation: GitHub secret `SANITY_WRITE_TOKEN` | website build, repository, Studio |
| Deploy token | no (deploy from your logged-in CLI) | – | – |
| Webhook secrets | no (no webhooks yet) | – | – |

Guards in this repository:

- Website: variables have no `PUBLIC_` prefix → never in client code; build output was searched for canary
  tokens: not found.
- Studio: **every `SANITY_STUDIO_*` variable is bundled into the public Studio JavaScript, even unused ones**
  (verified). `studio/sanity.cli.ts` therefore aborts `sanity dev/build/deploy` if a `SANITY_STUDIO_*` variable
  name contains TOKEN/SECRET/KEY/PASSWORD/PRIVATE/AUTH (verified for shell variables and `studio/.env`).
- `.env`, `.env.*` and `studio/.env` are git-ignored; only `.env.example` files are tracked.

## 5. CORS

The website needs **no CORS origin** – it talks to Sanity only during the build (server side, not a browser).

| Origin | Credentials | When |
| --- | --- | --- |
| `http://localhost:3333` | allow | added by Sanity for local Studio development. Remove it if you stop developing locally. |
| `https://periblugaming.sanity.studio` | allow | added automatically on `sanity deploy` |
| `https://periblugaming.github.io`, `https://periblugaming.de` | – | **don't add** (not needed) |
| any wildcard (`*`, `https://*.example`) with credentials | – | **never** – would let those sites act as you while you're logged in |

## 6. Studio deployment (`npm run deploy`, later, after approval)

- Free hosting on `periblugaming.sanity.studio`; requires your logged-in CLI session with Administrator rights.
- `deployment.appId` (`studio/sanity.cli.ts`) selects the existing deployment; it replaces the deprecated
  `studioHost`. App ID and URL are public and not secret – the login and project membership protect the data.
- Deploying publishes the **Studio app and schema**, not content. Take it down again with `npx sanity undeploy`.
- Only deploy from a clean checkout of reviewed code (the deployed bundle runs with your session in the browser).
- `deployment.autoUpdates: false` – no Sanity code is pulled from Sanity's CDN at runtime; updates go through
  `package.json`, review, `npm audit` and a new deploy.
- The deployed Studio's hostname is added to the project's CORS origins (with credentials) automatically. Check
  afterwards in Manage → API that no other origins were added.

## 7. Setup checklist (do these yourself)

- [ ] Sign up with **GitHub** (or Google) whose account has **2FA** enabled.
- [ ] Create the project → plan is **Free**, no payment method entered.
- [ ] Dataset `production`, visibility **public** (or private + Viewer token, see §1).
- [ ] Manage → **Members**: only you, role **Administrator**; no pending invitations; decline unknown access requests.
- [ ] Manage → **API → Tokens**: **empty** (or only one *Viewer* token if the dataset is private).
- [ ] Manage → **API → CORS origins**: only the entries in §5.
- [ ] Manage → **API → Webhooks**: none.
- [ ] `studio/.env` contains only `SANITY_STUDIO_PROJECT_ID` / `SANITY_STUDIO_DATASET`.
- [ ] After `sanity deploy`: open the Studio in a private window → only the login screen is shown; log in with
      another account (if you have one) → "no access" to the project.
- [ ] Test: create a **draft** post, run `npm run build` locally → it does not appear; publish → it appears.
- [ ] Review members/tokens/CORS occasionally (e.g. every few months).

## 8. Dependencies (Studio)

`npm audit` on `studio/` initially: 3 high, 16 moderate – all transitive dependencies of the **Sanity CLI /
build tooling** (`@sanity/cli` → `@vercel/frameworks`, `@module-federation/dts-plugin`, `jsdom`, `@oclif/core`).

| Package | Issue | Where it runs | Action |
| --- | --- | --- | --- |
| `undici` 7.29.1 (pinned by `@module-federation/dts-plugin`) | high: TLS/redirect/DoS issues | Node only (CLI build, jsdom) – not in the Studio bundle | override → **7.30.1** (patch, same major) |
| `js-yaml` 3.13.1 (pinned by `@vercel/frameworks`) | high: prototype pollution / CPU DoS in merge keys | Node only (CLI framework detection) | override → **3.15.2** (same major) |
| `smol-toml` 1.5.2 (pinned by `@vercel/frameworks`) | high/moderate: DoS on malformed TOML | Node only (CLI) | override → **1.9.1** (same major) |
| `minimatch` 10.2.6 (via `@oclif/core`) | moderate: ReDoS-style glob amplification | Node only (CLI argument/plugin globbing on local input) | **open**: fix only in 11.x (major) – would break oclif; accept |

Overrides are scoped to the pinning parent in `studio/package.json` → `overrides`. After the change:
**0 high, 13 moderate** (all the same `minimatch` advisory propagated through CLI packages), `tsc`, `sanity build`
and `sanity dev` work. None of the affected packages is part of the browser bundle (checked). Remaining risk:
low – exploitation would need attacker-controlled glob patterns fed to the local CLI.

**Accepted risk (2026-11-03): 13 moderate findings, all `minimatch` < 11.0.1 via `@oclif/core` (Sanity CLI).**
Re-check after every Sanity update:

```bash
cd studio && npm update sanity && npm audit && npm ls undici js-yaml smol-toml minimatch
```

Remove the overrides once `sanity`/`@sanity/cli` ships patched versions, and drop this note once `minimatch` is
fixed upstream.
The website itself (`package.json` in the root): `npm audit` → **0** vulnerabilities.
