import { NotConfiguredError, settingsStore } from "../settingsStore.js";
import { fetchProvider, readJsonLimited } from "../upstream.js";

const API_BASE = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w500";
const BACKDROP_BASE = "https://image.tmdb.org/t/p/original";
const PROFILE_BASE = "https://image.tmdb.org/t/p/w185";

export interface TmdbItem {
  id: number;
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  genre?: string;
  ratingPercent?: number;
  type: "movie" | "show";
}

interface RawTmdbResult {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string;
  backdrop_path?: string;
  vote_average?: number;
  genre_ids?: number[];
}

interface RawGenre {
  id: number;
  name: string;
}

function requireTmdb() {
  const tmdb = settingsStore.getTmdb();
  if (!tmdb) {
    throw new NotConfiguredError("tmdb");
  }
  return tmdb;
}

async function tmdbFetch<T>(path: string): Promise<T> {
  const tmdb = requireTmdb();
  const res = await fetchProvider(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${tmdb.accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`TMDB request failed: ${res.status} ${path}`);
  }
  return readJsonLimited<T>(res);
}

// Genre id -> name lists rarely change, so cache them in-memory for the process lifetime
// instead of fetching on every popular-list request.
let movieGenres: Map<number, string> | null = null;
let showGenres: Map<number, string> | null = null;

async function getMovieGenres(): Promise<Map<number, string>> {
  if (movieGenres) return movieGenres;
  const data = await tmdbFetch<{ genres: RawGenre[] }>("/genre/movie/list");
  movieGenres = new Map(data.genres.map((g) => [g.id, g.name]));
  return movieGenres;
}

async function getShowGenres(): Promise<Map<number, string>> {
  if (showGenres) return showGenres;
  const data = await tmdbFetch<{ genres: RawGenre[] }>("/genre/tv/list");
  showGenres = new Map(data.genres.map((g) => [g.id, g.name]));
  return showGenres;
}

function toItem(raw: RawTmdbResult, type: "movie" | "show", genres: Map<number, string>): TmdbItem {
  const dateStr = raw.release_date || raw.first_air_date;
  return {
    id: raw.id,
    title: (raw.title ?? raw.name ?? "").trim(),
    year: dateStr ? Number(dateStr.slice(0, 4)) : undefined,
    poster: raw.poster_path ? `${POSTER_BASE}${raw.poster_path}` : undefined,
    backdrop: raw.backdrop_path ? `${BACKDROP_BASE}${raw.backdrop_path}` : undefined,
    genre: raw.genre_ids?.length ? genres.get(raw.genre_ids[0]) : undefined,
    ratingPercent: raw.vote_average ? Math.round(raw.vote_average * 10) : undefined,
    type,
  };
}

// TMDB returns 20 results per page, so getting 25 needs two page fetches. These happen
// at most once per CACHE_TTL_SECONDS (the caller wraps this in the shared cache), and are
// fetched sequentially rather than in parallel - simple, deliberate throttling to stay
// far under TMDB's rate limit (40 req/s) regardless of how many things call this at once.
const POPULAR_COUNT = 25;
const PAGE_SIZE = 20;

async function fetchPopularPages(path: string): Promise<RawTmdbResult[]> {
  const results: RawTmdbResult[] = [];
  for (let page = 1; results.length < POPULAR_COUNT; page++) {
    const data = await tmdbFetch<{ results: RawTmdbResult[]; total_pages: number }>(
      `${path}?page=${page}`,
    );
    results.push(...data.results);
    if (page >= data.total_pages || data.results.length < PAGE_SIZE) break;
  }
  return results.slice(0, POPULAR_COUNT);
}

export async function getPopularMovies(): Promise<TmdbItem[]> {
  const genres = await getMovieGenres();
  const results = await fetchPopularPages("/movie/popular");
  return results.map((r) => toItem(r, "movie", genres));
}

export async function getPopularShows(): Promise<TmdbItem[]> {
  const genres = await getShowGenres();
  const results = await fetchPopularPages("/tv/popular");
  return results.map((r) => toItem(r, "show", genres));
}

interface RawTmdbSingle {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string;
  backdrop_path?: string;
  vote_average?: number;
  genres?: { id: number; name: string }[];
}

// A single, light fetch (no credits/similar) for building a tile from a bare tmdb id -
// used for Trakt watchlist/recommendations, which hand back ids rather than full metadata.
export async function getBasicItem(tmdbId: number, type: "movie" | "show"): Promise<TmdbItem | null> {
  try {
    const path = type === "movie" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
    const raw = await tmdbFetch<RawTmdbSingle>(path);
    const dateStr = raw.release_date || raw.first_air_date;
    return {
      id: raw.id,
      title: (raw.title ?? raw.name ?? "").trim(),
      year: dateStr ? Number(dateStr.slice(0, 4)) : undefined,
      poster: raw.poster_path ? `${POSTER_BASE}${raw.poster_path}` : undefined,
      backdrop: raw.backdrop_path ? `${BACKDROP_BASE}${raw.backdrop_path}` : undefined,
      genre: raw.genres?.[0]?.name,
      ratingPercent: raw.vote_average ? Math.round(raw.vote_average * 10) : undefined,
      type,
    };
  } catch {
    return null;
  }
}

// Search results from Plex/Silo carry the provider's own id (e.g. Silo's "movie-tmdb-584"),
// not a bare TMDB id, so they can't go straight into getMovieDetails/getTvDetails the way
// Popular/Trakt items (which originate from TMDB) can. This resolves title+year to a TMDB
// id so the detail page can still show the full backdrop/cast/similar/ratings view for a
// title someone found by searching their own library instead of browsing Popular.
export async function searchTmdbId(
  title: string,
  year: number | undefined,
  type: "movie" | "show",
): Promise<number | null> {
  const path = type === "movie" ? "/search/movie" : "/search/tv";
  const params = new URLSearchParams({ query: title });
  if (year) params.set(type === "movie" ? "year" : "first_air_date_year", String(year));
  const data = await tmdbFetch<{ results: RawTmdbResult[] }>(`${path}?${params}`);
  return data.results[0]?.id ?? null;
}

export interface TmdbCastMember {
  name: string;
  character: string;
  profilePath?: string;
}

export interface TmdbDetails {
  id: number;
  title: string;
  overview: string;
  releaseDate?: string;
  runtime?: number;
  genres: string[];
  voteAverage: number;
  backdrop?: string;
  poster?: string;
  status?: string;
  tagline?: string;
  cast: TmdbCastMember[];
  similar: TmdbItem[];
  type: "movie" | "show";
}

interface RawCastMember {
  name: string;
  character?: string;
  profile_path?: string;
  order?: number;
}

export async function getMovieDetails(tmdbId: number): Promise<TmdbDetails> {
  const [detail, credits, similar] = await Promise.all([
    tmdbFetch<Record<string, unknown>>(`/movie/${tmdbId}`),
    tmdbFetch<{ cast?: RawCastMember[] }>(`/movie/${tmdbId}/credits`),
    tmdbFetch<{ results: RawTmdbResult[] }>(`/movie/${tmdbId}/similar?page=1`),
  ]);

  const genres = await getMovieGenres();

  return {
    id: tmdbId,
    title: (detail.title as string) ?? "",
    overview: (detail.overview as string) ?? "",
    releaseDate: (detail.release_date as string) ?? undefined,
    runtime: (detail.runtime as number) ?? undefined,
    genres: ((detail.genres as { id: number; name: string }[]) ?? []).map((g) => g.name),
    voteAverage: (detail.vote_average as number) ?? 0,
    backdrop: detail.backdrop_path ? `${BACKDROP_BASE}${detail.backdrop_path}` : undefined,
    poster: detail.poster_path ? `${POSTER_BASE}${detail.poster_path}` : undefined,
    status: (detail.status as string) ?? undefined,
    tagline: (detail.tagline as string) ?? undefined,
    cast: (credits.cast ?? []).slice(0, 12).map((c) => ({
      name: c.name,
      character: c.character ?? "",
      profilePath: c.profile_path ? `${PROFILE_BASE}${c.profile_path}` : undefined,
    })),
    similar: similar.results.slice(0, 12).map((r) => toItem(r, "movie", genres)),
    type: "movie",
  };
}

export async function getTvDetails(tmdbId: number): Promise<TmdbDetails> {
  const [detail, credits, similar] = await Promise.all([
    tmdbFetch<Record<string, unknown>>(`/tv/${tmdbId}`),
    tmdbFetch<{ cast?: RawCastMember[] }>(`/tv/${tmdbId}/credits`),
    tmdbFetch<{ results: RawTmdbResult[] }>(`/tv/${tmdbId}/similar?page=1`),
  ]);

  const genres = await getShowGenres();

  return {
    id: tmdbId,
    title: (detail.name as string) ?? "",
    overview: (detail.overview as string) ?? "",
    releaseDate: (detail.first_air_date as string) ?? undefined,
    runtime: ((detail.episode_run_time as number[]) ?? [])[0] ?? undefined,
    genres: ((detail.genres as { id: number; name: string }[]) ?? []).map((g) => g.name),
    voteAverage: (detail.vote_average as number) ?? 0,
    backdrop: detail.backdrop_path ? `${BACKDROP_BASE}${detail.backdrop_path}` : undefined,
    poster: detail.poster_path ? `${POSTER_BASE}${detail.poster_path}` : undefined,
    status: (detail.status as string) ?? undefined,
    tagline: (detail.tagline as string) ?? undefined,
    cast: (credits.cast ?? []).slice(0, 12).map((c) => ({
      name: c.name,
      character: c.character ?? "",
      profilePath: c.profile_path ? `${PROFILE_BASE}${c.profile_path}` : undefined,
    })),
    similar: similar.results.slice(0, 12).map((r) => toItem(r, "show", genres)),
    type: "show",
  };
}
