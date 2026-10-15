import { PlexItem, plexPosterUrl } from "./clients/plex.js";
import { SiloItem, siloPosterUrl } from "./clients/silo.js";
import { XtreamLibraryItem } from "./clients/xtream.js";

export type LibrarySource = "plex" | "silo" | "xtream";

export interface MergedItem {
  id: string;
  source: LibrarySource;
  title: string;
  year?: number;
  type: "movie" | "show";
  poster?: string;
  genre?: string;
  ratingPercent?: number;
  sources: { source: LibrarySource; id: string }[];
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function matchKey(title: string, year?: number): string {
  return `${normalizeTitle(title)}::${year ?? ""}`;
}

export function titleContains(title: string, query: string): boolean {
  const needle = normalizeTitle(query);
  if (!needle) return false;
  return normalizeTitle(title).includes(needle);
}

// Exact title, and year when both sides have one. A copy with no year still matches
// (Xtream names often omit it) but a different year does not, so remakes stay apart.
export function matchingTitles<T extends { title: string; year?: number; type?: "movie" | "show" }>(
  items: T[],
  title: string,
  year?: number,
  type?: "movie" | "show",
): T[] {
  const needle = normalizeTitle(title);
  return items.filter((item) => {
    if (normalizeTitle(item.title) !== needle) return false;
    if (type && item.type && item.type !== type) return false;
    if (year !== undefined && item.year !== undefined && item.year !== year) return false;
    return true;
  });
}

export function pickBestMatch<T extends { title: string; year?: number; type?: "movie" | "show" }>(
  items: T[],
  title: string,
  year?: number,
  type?: "movie" | "show",
): T | undefined {
  const matches = matchingTitles(items, title, year, type);
  if (year !== undefined) {
    return matches.find((item) => item.year === year) ?? matches.find((item) => item.year === undefined);
  }
  return matches[0];
}

function plexTypeToCommon(type: string): "movie" | "show" {
  return type === "show" ? "show" : "movie";
}

function siloTypeToCommon(type: string): "movie" | "show" {
  return type === "Series" ? "show" : "movie";
}

function attachKey(
  byKey: Map<string, MergedItem>,
  item: { title: string; year?: number; type: "movie" | "show" },
): string {
  const exact = matchKey(item.title, item.year);
  const exactHit = byKey.get(exact);
  if (exactHit?.type === item.type) return exact;

  const needle = normalizeTitle(item.title);
  const same = [...byKey.entries()].filter(
    ([, existing]) => normalizeTitle(existing.title) === needle && existing.type === item.type,
  );
  // A copy with no year (common on Xtream) joins the only other copy of that title.
  // Two different years stay apart so a remake is not glued to the original.
  if (item.year === undefined && same.length === 1) return same[0][0];
  if (item.year !== undefined) {
    const undated = same.filter(([, existing]) => existing.year === undefined);
    const otherYears = same.filter(([, existing]) => existing.year !== undefined && existing.year !== item.year);
    if (undated.length === 1 && otherYears.length === 0) return undated[0][0];
  }

  if (exactHit && exactHit.type !== item.type) return `${exact}::${item.type}`;
  return exact;
}

function upsert(byKey: Map<string, MergedItem>, key: string, entry: MergedItem) {
  const existing = byKey.get(key);
  if (!existing) {
    byKey.set(key, entry);
    return;
  }
  for (const source of entry.sources) {
    if (!existing.sources.some((current) => current.source === source.source && current.id === source.id)) {
      existing.sources.push(source);
    }
  }
  existing.poster = existing.poster ?? entry.poster;
  existing.genre = existing.genre ?? entry.genre;
  existing.ratingPercent = existing.ratingPercent ?? entry.ratingPercent;
  existing.year = existing.year ?? entry.year;
}

export function mergeLibraries(
  plexItems: PlexItem[],
  siloItems: SiloItem[],
  xtreamItems: XtreamLibraryItem[] = [],
): MergedItem[] {
  const byKey = new Map<string, MergedItem>();

  for (const item of plexItems) {
    const key = matchKey(item.title, item.year);
    const score = item.audienceRating ?? item.rating;
    const entry: MergedItem = {
      id: `plex:${item.ratingKey}`,
      source: "plex",
      title: item.title,
      year: item.year,
      type: plexTypeToCommon(item.type),
      poster: plexPosterUrl(item.thumb),
      genre: item.Genre?.[0]?.tag,
      ratingPercent: score !== undefined ? Math.round(score * 10) : undefined,
      sources: [{ source: "plex", id: item.ratingKey }],
    };
    byKey.set(key, entry);
  }

  for (const item of siloItems) {
    const key = matchKey(item.Name, item.ProductionYear);
    const entry: MergedItem = {
      id: `silo:${item.Id}`,
      source: "silo",
      title: item.Name,
      year: item.ProductionYear,
      type: siloTypeToCommon(item.Type),
      poster: siloPosterUrl(item.Id, item),
      genre: item.genre,
      ratingPercent: item.ratingPercent,
      sources: [{ source: "silo", id: item.Id }],
    };
    const existing = byKey.get(key);
    if (existing && existing.type !== entry.type) {
      upsert(byKey, `${key}::${entry.type}`, entry);
    } else {
      upsert(byKey, key, entry);
    }
  }

  for (const item of xtreamItems) {
    const entry: MergedItem = {
      id: `xtream:${item.id}`,
      source: "xtream",
      title: item.title,
      year: item.year,
      type: item.type,
      poster: item.poster,
      genre: item.genre,
      ratingPercent: item.ratingPercent,
      sources: [{ source: "xtream", id: item.id }],
    };
    upsert(byKey, attachKey(byKey, item), entry);
  }

  return [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title));
}
