/**
 * /build-info.json – what this build was made from: commit and fingerprint of the visible Sanity content.
 * The scheduled deploy check compares it with the current state (docs/deployment.md). Contains no secrets.
 */
import type { APIRoute } from 'astro';
import { getBlog } from '../lib/blog';
import { computeFingerprint } from '../lib/content-fingerprint';
import { createBuildInfo } from '../lib/deploy-check';

export const GET: APIRoute = async () => {
  const blog = await getBlog();
  // Every rendered Sanity type contributes its documents here (currently only posts).
  const content = blog.status === 'sanity' ? computeFingerprint(blog.contentItems ?? []) : null;
  const info = createBuildInfo(process.env.GITHUB_SHA, content);

  return new Response(`${JSON.stringify(info, null, 2)}\n`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
