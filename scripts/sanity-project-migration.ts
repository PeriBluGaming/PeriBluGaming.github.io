/**
 * Controlled Sanity project migration (docs/sanity-setup.md → "Migrating the local configuration").
 *
 *   npm run migrate:projects:preflight
 *       Authenticated, read-only. Needs SANITY_MIGRATION_READ_TOKEN (Viewer) only – the write token is never read.
 *       Prints the plan, its blockers and the plan fingerprint. Exit 1 if anything blocks.
 *
 *   npm run migrate:projects:execute -- --execute --confirm-dataset=<dataset> --plan=<fingerprint>
 *       Needs SANITY_MIGRATION_READ_TOKEN (reads) AND SANITY_MIGRATION_WRITE_TOKEN (the commit only).
 *       Writes ONLY if every gate passes (see src/lib/project-migration-execute.ts). Never retries.
 *
 * Tokens come from the environment only (never printed, never written to a file).
 * Exit codes: 0 = committed and verified / nothing to do (preflight: no blockers)
 *             1 = blocked, stale or not committed – nothing was written
 *             2 = refused (arguments / tokens) – nothing was read or written
 *             3 = committed but unverified, or outcome unknown – documents MAY be live, run a fresh preflight
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { categories, defaultCategory, featuredProjects, listSettings, projectOverrides } from '../src/config/projects.ts';
import { site } from '../src/config/site.ts';
import type { RepoData } from '../src/lib/github.ts';
import { validateProjectImage } from '../src/lib/project-image.ts';
import { renderReport } from '../src/lib/project-migration.ts';
import {
  MIGRATION_READ_TOKEN_ENV,
  MIGRATION_WRITE_TOKEN_ENV,
  authenticatedPreflight,
  executeMigration,
  migrationTarget,
  parseExecuteArgs,
  authorizationErrors,
  type ExecutionStatus,
  type PreflightContext,
} from '../src/lib/project-migration-execute.ts';
import { createHttpAdapter } from '../src/lib/sanity-migration-adapter.ts';

const [command, ...rest] = process.argv.slice(2);
const usage = 'Usage: sanity-project-migration.ts preflight | execute --execute --confirm-dataset=<dataset> --plan=<fingerprint>';
const fail = (code: number, lines: string[]): never => {
  for (const l of lines) console.error(l);
  process.exit(code);
};

if (command !== 'preflight' && command !== 'execute') fail(2, [usage]);
if (command === 'preflight' && rest.length) fail(2, ['preflight takes no arguments.', usage]);

const readToken = process.env[MIGRATION_READ_TOKEN_ENV]?.trim();
// The preflight never touches the write token, even if it is set.
const writeToken = command === 'execute' ? process.env[MIGRATION_WRITE_TOKEN_ENV]?.trim() : undefined;
const redact = (text: string) => [readToken, writeToken].filter((t): t is string => Boolean(t)).reduce((t, s) => t.split(s).join('***'), text);

let target: ReturnType<typeof migrationTarget>;
try {
  target = migrationTarget(process.env);
} catch (err) {
  fail(2, [err instanceof Error ? err.message : String(err)]);
}

if (command === 'preflight') {
  if (!readToken) fail(2, [`${MIGRATION_READ_TOKEN_ENV} is not set. The preflight needs an authenticated read (drafts and release versions) – a Viewer token is enough.`]);
} else {
  // All operator gates before any network access (executeMigration checks them again).
  const errors = authorizationErrors(parseExecuteArgs(rest), process.env, target!);
  if (errors.length) fail(2, errors);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const ctx: PreflightContext = {
  env: process.env,
  root,
  config: { categories, defaultCategory, projectOverrides, featuredProjects, listSettings },
  githubUser: site.githubUser,
  fallback: JSON.parse(readFileSync(join(root, 'src/data/fallback-repos.json'), 'utf8')) as { fetchedAt: string; repos: RepoData[] },
  adapter: createHttpAdapter({ ...target!, readToken: readToken!, ...(writeToken && { writeToken }) }),
  resolveLocalImage: (image, repo) => validateProjectImage(image, repo, join(root, 'public')),
};

const EXIT: Record<ExecutionStatus, number> = {
  'committed_verified': 0,
  'nothing-to-do': 0,
  'refused': 2,
  'stale': 1,
  'not_committed': 1,
  'committed_unverified': 3,
  'unknown': 3,
};

try {
  if (command === 'preflight') {
    const pre = await authenticatedPreflight(ctx);
    const out = [renderReport(pre.plan).replace('# Sanity project migration – DRY RUN (read-only, not executable)', '# Sanity project migration – AUTHENTICATED PREFLIGHT (read-only)')];
    out.push('## Plan fingerprint', '', `\`${pre.fingerprint}\``, '');
    if (pre.blockers.length) {
      out.push('## Blockers – execution is not possible', '', ...pre.blockers.map((b) => `- ${b}`), '');
    } else if (pre.plan.summary.operations.CREATE + pre.plan.summary.operations.UPDATE === 0) {
      out.push('## Nothing to do', '', 'Every project is UNCHANGED.', '');
    } else {
      out.push(
        '## To execute this exact plan', '',
        `Needs ${MIGRATION_READ_TOKEN_ENV} and ${MIGRATION_WRITE_TOKEN_ENV}. Do not edit project documents in the Studio until it has finished.`, '',
        '```bash', `npm run migrate:projects:execute -- --execute --confirm-dataset=${pre.target.dataset} --plan=${pre.fingerprint}`, '```', '',
      );
    }
    process.stdout.write(`${out.join('\n')}\n`);
    process.exit(pre.blockers.length ? 1 : 0);
  }

  const result = await executeMigration(rest, ctx, (line) => console.error(line));
  console.log(`Status: ${result.status}`);
  for (const m of result.messages) console.log(m);
  if (result.transactionId) console.log(`Transaction: ${result.transactionId}`);
  if (result.documentIds?.length) console.log(`Documents confirmed by Sanity: ${result.documentIds.join(', ')}`);
  else if (result.plannedDocumentIds?.length) console.log(`Documents in the transaction: ${result.plannedDocumentIds.join(', ')}`);
  if (result.conflicts?.length) console.log(`Conflicting documents: ${result.conflicts.join(', ')}`);
  process.exit(EXIT[result.status]);
} catch (err) {
  // Only reachable before a commit was attempted (executeMigration classifies everything from the commit on).
  fail(1, [`[migration] ${redact(err instanceof Error ? err.message : String(err))}`, 'Nothing was written.']);
}
