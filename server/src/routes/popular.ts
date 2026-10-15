import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { cached } from "../cache.js";
import { getPopularMovies, getPopularShows, TmdbItem } from "../clients/tmdb.js";
import { attachOwnership, searchOwnedLibrary } from "../library.js";
import { pickBestMatch } from "../merge.js";
import { NotConfiguredError } from "../settingsStore.js";

export interface PopularItem {
  id: string;
  title: string;
  year?: number;
  type: "movie" | "show";
  poster?: string;
  backdrop?: string;
  genre?: string;
  ratingPercent?: number;
  sources: { source: "plex" | "silo" | "xtream"; id: string }[];
}

function toPopularItem(t: TmdbItem): PopularItem {
  return {
    id: `tmdb:${t.type}:${t.id}`,
    title: t.title,
    year: t.year,
    type: t.type,
    poster: t.poster,
    backdrop: t.backdrop,
    genre: t.genre,
    ratingPercent: t.ratingPercent,
    sources: [],
  };
}

export async function popularRoutes(app: FastifyInstance) {
  app.get("/api/popular", async () => {
    try {
      return await cached("popular:full", config.cacheTtlSeconds, async () => {
        // Sequential, not Promise.all - keeps requests to TMDB spaced out one at a time
        // rather than bursting, even though this only ever runs once per cache window.
        const movies = (await getPopularMovies()).map(toPopularItem);
        const shows = (await getPopularShows()).map(toPopularItem);
        await Promise.all([attachOwnership(movies), attachOwnership(shows)]);
        return { movies, shows, configured: true };
      });
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        return { movies: [], shows: [], configured: false };
      }
      throw err;
    }
  });

  app.get("/api/match", async (request) => {
    const { title, year, type } = request.query as { title?: string; year?: string; type?: string };
    if (!title) {
      return { sources: [] };
    }
    const { merged } = await searchOwnedLibrary(title);
    const kind = type === "movie" || type === "show" ? type : undefined;
    const match = pickBestMatch(merged, title, year ? Number(year) : undefined, kind);
    return { sources: match?.sources ?? [] };
  });
}
