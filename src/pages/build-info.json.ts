/**
 * /build-info.json – what this build was made from: commit and fingerprint of the Sanity content it rendered
 * (posts and projects). The scheduled deploy check compares it with the current state (docs/deployment.md).
 * Contains no secrets.
 */
import type { APIRoute } from 'astro';
import { getBlog } from '../lib/blog';
import { buildContentFingerprint } from '../lib/content-fingerprint';
import { createBuildInfo } from '../lib/deploy-check';
import { getProjects } from '../lib/projects';

export const GET: APIRoute = async () => {
  const [blog, projects] = await Promise.all([getBlog(), getProjects()]);
  const { content, reason } = buildContentFingerprint({ blog, projects });
  if (!content) console.warn(`[build-info] No content fingerprint: ${reason}. The deploy workflow will not deploy this build.`);
  const info = createBuildInfo(process.env.GITHUB_SHA, content);

  return new Response(`${JSON.stringify(info, null, 2)}\n`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
