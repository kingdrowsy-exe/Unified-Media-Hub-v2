import { NotConfiguredError, settingsStore } from "../settingsStore.js";
import { fetchProvider, readJsonLimited } from "../upstream.js";

export interface PlexItem {
  ratingKey: string;
  title: string;
  year?: number;
  type: string;
  thumb?: string;
  Genre?: { tag: string }[];
  audienceRating?: number;
  rating?: number;
}

interface PlexDirectory {
  key: string;
  title: string;
  type: string;
}

function requirePlex() {
  const plex = settingsStore.getPlex();
  if (!plex) {
    throw new NotConfiguredError("plex");
  }
  return plex;
}

function plexUrl(path: string): URL {
  const plex = requirePlex();
  const base = new URL(plex.baseUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin || url.username || url.password) {
    throw new Error("Plex request left the configured server");
  }
  url.searchParams.set("X-Plex-Token", plex.token);
  return url;
}

async function plexFetch<T>(path: string): Promise<T> {
  const res = await fetchProvider(plexUrl(path), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Plex request failed: ${res.status}`);
  }
  return readJsonLimited<T>(res);
}

/** Part keys from a Plex server stay on that server. A key of "@evil" or "//evil" must not carry the token away. */
export function buildPlexPartUrl(baseUrl: string, token: string, partKey: string): string {
  const base = new URL(baseUrl);
  const target = new URL(partKey, base);
  if (target.origin !== base.origin || target.username || target.password) {
    throw new Error("Plex returned a stream outside the configured server");
  }
  target.searchParams.set("X-Plex-Token", token);
  return target.toString();
}

export async function listSections(): Promise<PlexDirectory[]> {
  const data = await plexFetch<{ MediaContainer: { Directory: PlexDirectory[] } }>("/library/sections");
  return data.MediaContainer.Directory ?? [];
}

async function moviesAndShowSections(): Promise<PlexDirectory[]> {
  const sections = await listSections();
  return sections.filter((s) => s.type === "movie" || s.type === "show");
}

// Pulling an entire library section can mean thousands of items against a slow/remote
// Plex server - and worse, the Plex server we're talking to is hosted by someone else,
// who flagged repeated full-library scans from this app. For the browse grid we only
// ever request a bounded "popular" page per section (sorted by rating, not a full/title
// scan); full per-item detail is fetched separately and lazily, only when the user
// actually clicks something, via resolvePlexStreamUrl. Search filters this same cached
// page client-side rather than issuing a fresh query per keystroke - see routes/ondemand.ts.
const POPULAR_PAGE_SIZE = 24;

export async function listPopularLibraryItems(): Promise<PlexItem[]> {
  const sections = await moviesAndShowSections();
  const results = await Promise.all(
    sections.map(async (section) => {
      const data = await plexFetch<{ MediaContainer: { Metadata?: PlexItem[] } }>(
        `/library/sections/${section.key}/all?sort=rating:desc&X-Plex-Container-Start=0&X-Plex-Container-Size=${POPULAR_PAGE_SIZE}`,
      );
      return data.MediaContainer.Metadata ?? [];
    }),
  );
  return results.flat();
}

// A title filter is a targeted, indexed lookup (Plex's SQLite metadata DB), not a full
// section scan the way sorting by rating across everything is - this is the same kind of
// query every real Plex client does for search-as-you-type, and is fine to run live,
// debounced, per user-initiated search rather than only checking the cached popular page.
export async function searchLibraryItems(query: string): Promise<PlexItem[]> {
  const sections = await moviesAndShowSections();
  const results = await Promise.all(
    sections.map(async (section) => {
      const data = await plexFetch<{ MediaContainer: { Metadata?: PlexItem[] } }>(
        `/library/sections/${section.key}/all?title=${encodeURIComponent(query)}`,
      );
      return data.MediaContainer.Metadata ?? [];
    }),
  );
  return results.flat();
}

export function plexPosterUrl(thumb?: string): string | undefined {
  if (!thumb) return undefined;
  const plex = settingsStore.getPlex();
  if (!plex) return undefined;
  let target: URL;
  try {
    const base = new URL(plex.baseUrl);
    target = new URL(thumb, base);
    if (target.origin !== base.origin || target.username || target.password) return undefined;
  } catch {
    return undefined;
  }
  target.searchParams.delete("X-Plex-Token");
  const path = `${target.pathname}${target.search}`;
  return `/api/image/plex?path=${encodeURIComponent(path)}`;
}

export function plexImageUrl(imagePath: string): string {
  return plexUrl(imagePath).toString();
}

export interface PlexMediaVersion {
  ratingKey: string;
  videoResolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  container?: string;
  bitrate?: number;
  filename?: string;
  size?: number;
}

export async function getPlexMediaVersions(ratingKey: string): Promise<PlexMediaVersion[]> {
  const data = await plexFetch<{
    MediaContainer: {
      Metadata?: {
        Media?: {
          videoResolution?: string;
          videoCodec?: string;
          audioCodec?: string;
          audioChannels?: number;
          container?: string;
          bitrate?: number;
          Part?: { file?: string; size?: number; key?: string }[];
        }[];
      }[];
    };
  }>(`/library/metadata/${ratingKey}`);

  const media = data.MediaContainer.Metadata?.[0]?.Media ?? [];
  return media.map((m) => ({
    ratingKey,
    videoResolution: m.videoResolution,
    videoCodec: m.videoCodec,
    audioCodec: m.audioCodec,
    audioChannels: m.audioChannels,
    container: m.container,
    bitrate: m.bitrate,
    filename: m.Part?.[0]?.file?.split(/[/\\]/).pop(),
    size: m.Part?.[0]?.size,
  }));
}

export async function resolvePlexStreamUrl(ratingKey: string): Promise<string> {
  const plex = requirePlex();
  const data = await plexFetch<{
    MediaContainer: { Metadata?: { Media?: { Part?: { key: string }[] }[] }[] };
  }>(`/library/metadata/${ratingKey}`);
  const part = data.MediaContainer.Metadata?.[0]?.Media?.[0]?.Part?.[0];
  if (!part) {
    throw new Error(`No playable part found for Plex item ${ratingKey}`);
  }
  return buildPlexPartUrl(plex.baseUrl, plex.token, part.key);
}
