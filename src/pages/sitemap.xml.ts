/**
 * /sitemap.xml – every indexable page of the static site: home, project detail pages and (once the blog is visible)
 * the blog index, its category pages and posts that are not marked noindex. Built from the same data as the pages,
 * so it can't list a page that doesn't exist. Referenced from /robots.txt.
 */
import type { APIRoute } from 'astro';
import { site } from '../config/site';
import { getBlog, isBlogVisible } from '../lib/blog';
import { getProjects } from '../lib/projects';

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export const GET: APIRoute = async () => {
  const [blog, projects] = await Promise.all([getBlog(), getProjects()]);
  const entries: { path: string; lastmod?: string }[] = [{ path: '/' }];

  for (const page of projects.pages) entries.push({ path: page.path, lastmod: page.project.pushedAt });

  if (isBlogVisible(blog)) {
    entries.push({ path: '/blog/' });
    for (const category of blog.categories) entries.push({ path: `/blog/category/${category.id}/` });
    for (const post of blog.posts) if (!post.seo.noindex) entries.push({ path: `/blog/${post.slug}/`, lastmod: post.publishedAt });
  }

  const urls = entries
    .map(({ path, lastmod }) => {
      const loc = escapeXml(new URL(path, site.url).href);
      const date = lastmod && !Number.isNaN(Date.parse(lastmod)) ? `<lastmod>${new Date(lastmod).toISOString().slice(0, 10)}</lastmod>` : '';
      return `  <url><loc>${loc}</loc>${date}</url>`;
    })
    .join('\n');

  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
