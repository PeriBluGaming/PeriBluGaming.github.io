/**
 * Sanity project migration – DRY RUN. Read-only, there is no write mode.
 *
 *   npm run migrate:projects:dry-run              # Markdown report
 *   npm run migrate:projects:dry-run -- --json    # machine-readable plan (dryRun: true, executable: false)
 *
 * Needs SANITY_PROJECT_ID (from .env). Never sends a token; GitHub is read without a token as well.
 * Exit code 0 = plan produced (it may contain BLOCKED items), 1 = could not read the inputs, 2 = usage.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { categories, defaultCategory, featuredProjects, listSettings, projectOverrides } from '../src/config/projects.ts';
import { site } from '../src/config/site.ts';
import type { RepoData } from '../src/lib/github.ts';
import { validateProjectImage } from '../src/lib/project-image.ts';
import { planMigration, proposedDocuments, renderReport } from '../src/lib/project-migration.ts';
import { MigrationAbort, collectInputs, validateWithStudioSchema } from '../src/lib/project-migration-io.ts';

const args = process.argv.slice(2);
if (args.some((a) => a !== '--json')) {
  console.error('Usage: node scripts/sanity-project-migration-dry-run.ts [--json]   (dry run only – there is no write mode)');
  process.exit(2);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const config = { categories, defaultCategory, projectOverrides, featuredProjects, listSettings };
const fallback = JSON.parse(readFileSync(join(root, 'src/data/fallback-repos.json'), 'utf8')) as { fetchedAt: string; repos: RepoData[] };
const resolveLocalImage = (image: Parameters<typeof validateProjectImage>[0], repo: string) => validateProjectImage(image, repo, join(root, 'public'));

try {
  const inputs = await collectInputs({ env: process.env, root, config, githubUser: site.githubUser, fallback });
  const base = { ...inputs, config, resolveLocalImage };
  // First pass for the document set, then validate it with the Studio schema and plan again.
  const draft = planMigration(base);
  const schemaErrors = await validateWithStudioSchema(root, proposedDocuments(draft), inputs.existing);
  const plan = planMigration({ ...base, schemaErrors, schemaValidation: schemaErrors ? 'Studio schema (Sanity validation engine, offline)' : undefined });
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(plan, null, 2)}\n` : renderReport(plan));
} catch (err) {
  console.error(err instanceof MigrationAbort ? err.message : `[migration] ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
