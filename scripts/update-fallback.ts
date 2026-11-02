/**
 * Refreshes src/data/fallback-repos.json from the live GitHub API.
 * The snapshot is used when the API is unreachable or rate-limited during a build.
 *
 *   npm run snapshot
 */
import { writeFile } from 'node:fs/promises';
import { fetchPublicRepos } from '../src/lib/github.ts';

const USER = 'PeriBluGaming';
const target = new URL('../src/data/fallback-repos.json', import.meta.url);

const repos = await fetchPublicRepos(USER, { token: process.env.GITHUB_TOKEN || undefined });
const snapshot = { user: USER, fetchedAt: new Date().toISOString(), repos };

await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Saved ${repos.length} repositories to ${target.pathname}`);
