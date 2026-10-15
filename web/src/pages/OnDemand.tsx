import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PopularItem, fetchPopular, fetchTraktRecommendations, fetchTraktWatchlist } from "../api.js";
import MovieDetail from "../components/MovieDetail.js";
import Hero, { HeroItem } from "../components/Hero.js";
import LibraryBrowser from "../components/LibraryBrowser.js";
import Shelf from "../components/Shelf.js";
import Tile from "../components/Tile.js";

const HERO_SLIDE_COUNT = 8;

// Alternate movie/show/movie/show... so the rotation isn't just "all movies then all shows".
function interleave<T>(a: T[], b: T[]): T[] {
  const result: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) result.push(a[i]);
    if (b[i]) result.push(b[i]);
  }
  return result;
}

export default function OnDemand() {
  const [popularMovies, setPopularMovies] = useState<PopularItem[]>([]);
  const [popularShows, setPopularShows] = useState<PopularItem[]>([]);
  const [tmdbConfigured, setTmdbConfigured] = useState<boolean | null>(null);
  const [watchlist, setWatchlist] = useState<PopularItem[]>([]);
  const [recommendations, setRecommendations] = useState<PopularItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<PopularItem | null>(null);

  useEffect(() => {
    fetchPopular()
      .then((res) => {
        setPopularMovies(res.movies);
        setPopularShows(res.shows);
        setTmdbConfigured(res.configured);
      })
      .catch(() => setTmdbConfigured(false));
    fetchTraktWatchlist()
      .then((res) => setWatchlist(res.items))
      .catch(() => setWatchlist([]));
    fetchTraktRecommendations()
      .then((res) => setRecommendations(res.items))
      .catch(() => setRecommendations([]));
  }, []);

  function handleSelectSimilar(tmdbId: number, type: "movie" | "show") {
    setSelectedItem({ id: `tmdb:${type}:${tmdbId}`, title: "", type, sources: [] });
  }

  const heroItems: HeroItem[] = useMemo(
    () =>
      interleave(popularMovies, popularShows)
        .slice(0, HERO_SLIDE_COUNT)
        .map((item) => ({
          image: item.backdrop ?? item.poster,
          title: item.title,
          subtitle: [item.year, item.genre].filter(Boolean).join(" · "),
          owned: item.sources.length > 0,
          onPlay: () => setSelectedItem(item),
        })),
    [popularMovies, popularShows],
  );

  function renderTile(item: PopularItem) {
    const isOwned = item.sources.length > 0;
    return (
      <Tile
        key={item.id}
        image={item.poster}
        title={item.title}
        genre={item.genre}
        ratingPercent={item.ratingPercent}
        year={item.year}
        owned={isOwned}
        badges={isOwned ? item.sources.map((s) => s.source) : undefined}
        onClick={() => setSelectedItem(item)}
      />
    );
  }

  return (
    <div className="page">
      {heroItems.length > 0 && <Hero items={heroItems} />}

      <LibraryBrowser onSelect={setSelectedItem} />

      {tmdbConfigured === false && (
        <div className="notice">
          TMDB isn't connected yet, so Popular Movies/Shows aren't available.{" "}
          <Link to="/settings">Connect TMDB</Link>
        </div>
      )}

      {watchlist.length > 0 && <Shelf title="Your Trakt Watchlist">{watchlist.map(renderTile)}</Shelf>}
      {recommendations.length > 0 && <Shelf title="Recommended for You">{recommendations.map(renderTile)}</Shelf>}
      {popularMovies.length > 0 && <Shelf title="Popular Movies">{popularMovies.map(renderTile)}</Shelf>}
      {popularShows.length > 0 && <Shelf title="Popular Shows">{popularShows.map(renderTile)}</Shelf>}

      {selectedItem && (
        <MovieDetail
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          onSelectSimilar={handleSelectSimilar}
        />
      )}
    </div>
  );
}
