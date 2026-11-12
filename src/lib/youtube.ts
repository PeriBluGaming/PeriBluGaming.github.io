/**
 * YouTube URL handling for project videos. Shared by the website and the Sanity Studio; pure, no imports.
 * Only the 11-character video ID is ever taken from editor input – every URL the site renders is rebuilt from it.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const EMBED_HOSTS = new Set([...WATCH_HOSTS, 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

/** Video ID from a YouTube URL (watch, youtu.be, embed, shorts, live), or null if it is not a YouTube video URL. */
export function parseYouTubeId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  let id: string | null | undefined;
  if (host === 'youtu.be') id = segments.length === 1 ? segments[0] : null;
  else if (WATCH_HOSTS.has(host) && segments.length === 1 && segments[0] === 'watch') id = url.searchParams.get('v');
  else if (EMBED_HOSTS.has(host) && segments.length === 2 && ['embed', 'shorts', 'live', 'v'].includes(segments[0])) id = segments[1];

  return id && VIDEO_ID.test(id) ? id : null;
}

/** Privacy-enhanced player URL. Only loaded after the visitor clicks play, so autoplay starts the chosen video. */
export const youTubeEmbedUrl = (id: string): string => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;

export const youTubeWatchUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;
