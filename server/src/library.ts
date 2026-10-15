import { config } from "./config.js";
import { cached } from "./cache.js";
import { listPopularLibraryItems, PlexItem, searchLibraryItems as searchPlexItems } from "./clients/plex.js";
import { listSiloItems, searchSiloItems, SiloItem } from "./clients/silo.js";
import {
  listSeriesLibraryItems,
  listVodLibraryItems,
  XtreamLibraryItem,
} from "./clients/xtream.js";
import { mergeLibraries, pickBestMatch, titleContains, MergedItem } from "./merge.js";
import { NotConfiguredError, settingsStore } from "./settingsStore.js";

const XTREAM_BROWSE_MOVIES = 36;
const XTREAM_BROWSE_SERIES = 24;

async function safeList<T>(fn: () => Promise<T[]>): Promise<{ items: T[]; configured: boolean }> {
  try {
    return { items: await fn(), configured: true };
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      return { items: [], configured: false };
    }
    throw err;
  }
}

export interface OwnedLibrary {
  merged: MergedItem[];
  sources: { plex: boolean; silo: boolean; xtream: boolean };
}

export function configuredLibrarySources(): { plex: boolean; silo: boolean; xtream: boolean } {
  return {
    plex: Boolean(settingsStore.getPlex()),
    silo: Boolean(settingsStore.getSilo()),
    xtream: Boolean(settingsStore.getXtream()),
  };
}

// Xtream panels have no title-search action — the catalog is the search index. A failure
// here must not blank Plex/Silo results (or the Popular ownership pass) for the cache window.
async function safeXtream(fn: () => Promise<XtreamLibraryItem[]>): Promise<{ items: XtreamLibraryItem[]; configured: boolean }> {
  try {
    return { items: await fn(), configured: true };
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      return { items: [], configured: false };
    }
    console.error("Xtream library lookup failed:", err);
    return { items: [], configured: true };
  }
}

async function listXtreamBrowseSample(): Promise<XtreamLibraryItem[]> {
  const [movies, series] = await Promise.all([listVodLibraryItems(), listSeriesLibraryItems()]);
  const recent = (items: XtreamLibraryItem[], limit: number) =>
    [...items]
      .sort((a, b) => (b.added ?? 0) - (a.added ?? 0) || a.title.localeCompare(b.title))
      .slice(0, limit);
  return [...recent(movies, XTREAM_BROWSE_MOVIES), ...recent(series, XTREAM_BROWSE_SERIES)];
}

export async function searchXtreamLibrary(query: string): Promise<XtreamLibraryItem[]> {
  const [movies, series] = await Promise.all([listVodLibraryItems(), listSeriesLibraryItems()]);
  return [...movies, ...series].filter((item) => titleContains(item.title, query));
}

// Shared by /api/ondemand and /api/popular so both read the same cached, bounded
// "popular" page instead of each independently querying Plex/Silo. Xtream has no
// equivalent ranked page, so this adds a short recently-added sample from its catalog.
export function getOwnedPopularLibrary(): Promise<OwnedLibrary> {
  return cached("ondemand:popular", config.cacheTtlSeconds, async () => {
    const [plex, silo, xtream] = await Promise.all([
      safeList<PlexItem>(listPopularLibraryItems),
      safeList<SiloItem>(listSiloItems),
      safeXtream(listXtreamBrowseSample),
    ]);
    return {
      merged: mergeLibraries(plex.items, silo.items, xtream.items),
      sources: { plex: plex.configured, silo: silo.configured, xtream: xtream.configured },
    };
  });
}

// Plex and Silo are targeted, indexed lookups. Xtream has no search action, so a query
// filters the cached VOD/series catalog instead of scanning it again per keystroke.
export async function searchOwnedLibrary(query: string): Promise<OwnedLibrary> {
  const [plex, silo, xtream] = await Promise.all([
    safeList<PlexItem>(() => searchPlexItems(query)),
    safeList<SiloItem>(() => searchSiloItems(query)),
    safeXtream(() => searchXtreamLibrary(query)),
  ]);
  return {
    merged: mergeLibraries(plex.items, silo.items, xtream.items),
    sources: { plex: plex.configured, silo: silo.configured, xtream: xtream.configured },
  };
}

interface OwnableItem {
  title: string;
  year?: number;
  type?: "movie" | "show";
  sources: { source: "plex" | "silo" | "xtream"; id: string }[];
}

// Shared by /api/popular and /api/trakt/* (watchlist, recommendations): each title's
// ownership check is a live, targeted Plex/Silo search (the same one GET /api/match uses),
// never a full-library scan. Callers wrap this in their own cache so a given batch of
// titles only actually runs once per cache window. A small concurrency cap just keeps
// that one-time batch from bursting every lookup at Plex/Silo simultaneously.
const MATCH_CONCURRENCY = 4;

export async function attachOwnership<T extends OwnableItem>(items: T[]): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      try {
        const { merged } = await searchOwnedLibrary(item.title);
        const match = pickBestMatch(merged, item.title, item.year, item.type);
        if (match) item.sources = match.sources;
      } catch {
        // Leave unmatched on any lookup failure - the tile just shows as not-in-library.
      }
    }
  }
  await Promise.all(Array.from({ length: MATCH_CONCURRENCY }, worker));
}
