import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  MergedItem,
  OnDemandCategory,
  fetchOnDemand,
  fetchOnDemandCategories,
} from "../api.js";
import Shelf from "./Shelf.js";
import Tile from "./Tile.js";

type SourceFilter = "all" | "plex" | "silo" | "xtream";
type TypeFilter = "all" | "movie" | "show";

interface LibraryBrowserProps {
  onSelect: (item: MergedItem) => void;
}

function sourceLabel(source: SourceFilter): string {
  if (source === "all") return "All";
  if (source === "plex") return "Plex";
  if (source === "silo") return "Silo";
  return "Xtream";
}

export default function LibraryBrowser({ onSelect }: LibraryBrowserProps) {
  const [items, setItems] = useState<MergedItem[]>([]);
  const [sources, setSources] = useState<{ plex: boolean; silo: boolean; xtream: boolean } | null>(null);
  const [vodCategories, setVodCategories] = useState<OnDemandCategory[]>([]);
  const [seriesCategories, setSeriesCategories] = useState<OnDemandCategory[]>([]);
  const [source, setSource] = useState<SourceFilter>("all");
  const [type, setType] = useState<TypeFilter>("all");
  const [category, setCategory] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    fetchOnDemandCategories()
      .then((res) => {
        setVodCategories(res.vod);
        setSeriesCategories(res.series);
      })
      .catch(() => {
        setVodCategories([]);
        setSeriesCategories([]);
      });
  }, []);

  useEffect(() => {
    const categoryKind = category.startsWith("movie:") ? "movie" : category.startsWith("show:") ? "show" : undefined;
    const categoryId = categoryKind ? category.slice(categoryKind.length + 1) : undefined;
    setLoading(true);
    setError(null);
    fetchOnDemand({
      source: source === "all" ? undefined : source,
      type: categoryKind ?? (type === "all" ? undefined : type),
      category: categoryId,
    })
      .then((res) => {
        setItems(res.items);
        setSources(res.sources);
        setTruncated(Boolean(res.truncated));
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [source, type, category]);

  const categories = useMemo(() => {
    if (type === "movie") return vodCategories.map((entry) => ({ ...entry, kind: "movie" as const }));
    if (type === "show") return seriesCategories.map((entry) => ({ ...entry, kind: "show" as const }));
    return [
      ...vodCategories.map((entry) => ({ ...entry, kind: "movie" as const })),
      ...seriesCategories.map((entry) => ({ ...entry, kind: "show" as const })),
    ];
  }, [type, vodCategories, seriesCategories]);

  const showCategories = (source === "all" || source === "xtream") && categories.length > 0;
  const browsing = source !== "all" || type !== "all" || category !== "";
  const movies = items.filter((item) => item.type === "movie");
  const shows = items.filter((item) => item.type === "show");
  const anyConnected = sources && (sources.plex || sources.silo || sources.xtream);

  function renderTile(item: MergedItem) {
    return (
      <Tile
        key={item.id}
        image={item.poster}
        title={item.title}
        genre={item.genre}
        ratingPercent={item.ratingPercent}
        year={item.year}
        owned
        badges={item.sources.map((entry) => entry.source)}
        onClick={() => onSelect(item)}
      />
    );
  }

  function selectSource(next: SourceFilter) {
    setSource(next);
    if (next !== "all" && next !== "xtream") setCategory("");
  }

  function selectType(next: TypeFilter) {
    setType(next);
    setCategory("");
  }

  return (
    <section className="library-block">
      <h2 className="shelf-title">
        Your library
        <span className="shelf-chevron">›</span>
      </h2>

      <div className="library-filters">
        {(["all", "movie", "show"] as const).map((entry) => (
          <span
            key={entry}
            className={`chip ${type === entry ? "active" : ""}`}
            onClick={() => selectType(entry)}
          >
            {entry === "all" ? "All" : entry === "movie" ? "Movies" : "Series"}
          </span>
        ))}
        <span className="library-filter-gap" />
        {(["all", "plex", "silo", "xtream"] as const).map((entry) => (
          <span
            key={entry}
            className={`chip ${source === entry ? "active" : ""}`}
            onClick={() => selectSource(entry)}
          >
            {sourceLabel(entry)}
          </span>
        ))}
        {showCategories && (
          <select
            className="library-select"
            value={category}
            aria-label="Xtream category"
            onChange={(event) => {
              const value = event.target.value;
              setCategory(value);
              if (value.startsWith("movie:")) setType("movie");
              if (value.startsWith("show:")) setType("show");
            }}
          >
            <option value="">All Xtream categories</option>
            {type === "all" ? (
              <>
                {vodCategories.length > 0 && (
                  <optgroup label="Movies">
                    {vodCategories.map((entry) => (
                      <option key={`movie:${entry.id}`} value={`movie:${entry.id}`}>
                        {entry.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {seriesCategories.length > 0 && (
                  <optgroup label="Series">
                    {seriesCategories.map((entry) => (
                      <option key={`show:${entry.id}`} value={`show:${entry.id}`}>
                        {entry.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </>
            ) : (
              categories.map((entry) => (
                <option key={`${entry.kind}:${entry.id}`} value={`${entry.kind}:${entry.id}`}>
                  {entry.name}
                </option>
              ))
            )}
          </select>
        )}
      </div>

      {loading && <div className="library-status">Loading your library…</div>}
      {!loading && error && <div className="library-status">Couldn't load your library: {error}</div>}

      {!loading && !error && sources && !anyConnected && (
        <div className="library-status">
          Connect Plex, Silo, or Xtream to browse movies and series here. <Link to="/settings">Settings</Link>
        </div>
      )}

      {!loading && !error && anyConnected && items.length === 0 && (
        <div className="library-status">Nothing in this view yet. Try another category, or search by title.</div>
      )}

      {!loading && !error && truncated && (
        <div className="library-status">Showing the first {items.length}. Search to narrow it down.</div>
      )}

      {!loading && !error && !browsing && movies.length > 0 && (
        <Shelf title="Movies in your libraries">{movies.map(renderTile)}</Shelf>
      )}
      {!loading && !error && !browsing && shows.length > 0 && (
        <Shelf title="Series in your libraries">{shows.map(renderTile)}</Shelf>
      )}

      {!loading && !error && browsing && items.length > 0 && <div className="search-grid">{items.map(renderTile)}</div>}
    </section>
  );
}
