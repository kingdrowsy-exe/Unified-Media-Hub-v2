import { useEffect, useRef, useState } from "react";
import {
  fetchDetails,
  fetchMatch,
  fetchSeriesDetail,
  fetchSources,
  lookupTmdbId,
  PopularItem,
  MergedItem,
  LibrarySource,
  TmdbDetails,
  SourceVersion,
  XtreamEpisode,
  XtreamSeriesDetail,
  streamUrlFor,
} from "../api.js";
import SourcePicker from "./SourcePicker.js";
import Player from "./Player.js";
import Shelf from "./Shelf.js";
import Tile from "./Tile.js";

type Playable = MergedItem | PopularItem;

interface MovieDetailProps {
  item: Playable;
  onClose: () => void;
  onSelectSimilar: (tmdbId: number, type: "movie" | "show") => void;
}

function parseTmdbId(id: string): { type: "movie" | "show"; tmdbId: number } | null {
  const match = id.match(/^tmdb:(movie|show):(\d+)$/);
  if (!match) return null;
  return { type: match[1] as "movie" | "show", tmdbId: Number(match[2]) };
}

function formatRuntime(minutes?: number): string {
  if (!minutes) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function formatEpisodeDuration(seconds?: number): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function seriesIdFromSources(sources: { source: LibrarySource; id: string }[]): number | null {
  for (const source of sources) {
    if (source.source !== "xtream") continue;
    const match = /^series:(\d+)$/.exec(source.id);
    if (match) return Number(match[1]);
  }
  return null;
}

export default function MovieDetail({ item, onClose, onSelectSimilar }: MovieDetailProps) {
  const [details, setDetails] = useState<TmdbDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [sources, setSources] = useState<SourceVersion[] | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const [playing, setPlaying] = useState<{ src: string; hls: boolean; title?: string; duration?: number } | null>(null);
  const [seriesDetail, setSeriesDetail] = useState<XtreamSeriesDetail | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [overviewExpanded, setOverviewExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
    setDetails(null);
    setError(null);
    setSources(null);
    setShowSourcePicker(false);
    setPlaying(null);
    setSeriesDetail(null);
    setSeason(null);
    setOverviewExpanded(false);
  }, [item.id]);

  useEffect(() => {
    const parsed = parseTmdbId(item.id);
    setLoading(true);

    // Items from a Plex/Silo library search carry the provider's own id, not a TMDB one
    // (unlike Popular/Trakt items, which come from TMDB already) - look the title up on
    // TMDB first so the detail page can still show the full backdrop/cast/similar view.
    const resolveTmdbId = parsed
      ? Promise.resolve(parsed.tmdbId)
      : lookupTmdbId(item.title, item.year, item.type).then((res) => res.tmdbId);
    const type = parsed?.type ?? item.type;

    let cancelled = false;
    resolveTmdbId
      .then((tmdbId) => {
        if (cancelled) return;
        if (!tmdbId) {
          setLoading(false);
          return;
        }
        return fetchDetails(type, tmdbId).then((d) => {
          if (!cancelled) setDetails(d);
        });
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load details");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.title, item.type, item.year]);

  useEffect(() => {
    if (item.type !== "show" || seriesDetail) return;
    let cancelled = false;
    const title = details?.title || item.title;
    const year = item.year ?? (details?.releaseDate ? Number(details.releaseDate.slice(0, 4)) : undefined);
    const known = seriesIdFromSources(item.sources);
    const resolveId = known
      ? Promise.resolve(known)
      : title
        ? fetchMatch(title, year, "show").then((res) => seriesIdFromSources(res.sources))
        : Promise.resolve(null);

    resolveId
      .then((seriesId) => {
        if (cancelled || !seriesId) return;
        return fetchSeriesDetail(seriesId).then((detail) => {
          if (cancelled) return;
          setSeriesDetail(detail);
          setSeason(detail.seasons[0]?.number ?? detail.episodes[0]?.season ?? null);
        });
      })
      .catch(() => {
        // Episodes are optional; the title page still works from TMDB.
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.title, item.type, item.year, item.sources, details?.title, details?.releaseDate, seriesDetail]);

  function playEpisode(episode: XtreamEpisode, detailTitle?: string) {
    setError(null);
    setPlaying({
      src: streamUrlFor("xtream", episode.id),
      hls: episode.playback === "hls",
      title: detailTitle ? `${detailTitle} · ${episode.title}` : episode.title,
      duration: episode.durationSecs,
    });
  }

  function playVersion(version: SourceVersion) {
    setPlaying({
      src: streamUrlFor(version.source, version.id),
      hls: version.playback === "hls",
    });
  }

  async function handlePlay() {
    setLoadingSources(true);
    setSources(null);
    setError(null);
    try {
      const title = details?.title || item.title;
      const year = item.year ?? (details?.releaseDate ? Number(details.releaseDate.slice(0, 4)) : undefined);
      const result = await fetchSources(title, year, item.type);
      if (result.versions.length === 1) {
        playVersion(result.versions[0]);
        return;
      }
      if (result.versions.length > 1) {
        setSources(result.versions);
        setShowSourcePicker(true);
        return;
      }
      const episodes = seriesDetail?.episodes ?? [];
      const first = episodes.find((episode) => episode.season === season) ?? episodes[0];
      if (first) {
        playEpisode(first, seriesDetail?.title || item.title);
        return;
      }
      setError("This title isn't in your connected libraries.");
    } catch {
      setError("Couldn't check your libraries.");
    } finally {
      setLoadingSources(false);
    }
  }

  function handleSourceSelect(version: SourceVersion) {
    setShowSourcePicker(false);
    playVersion(version);
  }

  const backdrop = details?.backdrop ?? ("backdrop" in item ? (item as PopularItem).backdrop : undefined) ?? item.poster;
  const displayTitle = details?.title ?? item.title;
  const year = details?.releaseDate?.slice(0, 4) ?? (item.year ? String(item.year) : "");
  const runtime = formatRuntime(details?.runtime);
  const genreStr = details?.genres?.join(", ") ?? item.genre ?? "";
  const rating = details?.voteAverage ?? (item.ratingPercent ? item.ratingPercent / 10 : 0);
  const overview = details?.overview || seriesDetail?.plot || "";
  const visibleEpisodes = (seriesDetail?.episodes ?? []).filter((episode) => season === null || episode.season === season);

  const metaParts = [year, runtime, genreStr].filter(Boolean);

  return (
    <div className="detail-overlay">
      <div className="detail-scroll" ref={scrollRef}>
        <button className="detail-back" onClick={onClose} aria-label="Back">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {/* Backdrop */}
        <div className="detail-backdrop">
          {backdrop && <img src={backdrop} alt="" />}
          <div className="detail-backdrop-scrim" />
        </div>

        {/* Main info */}
        <div className="detail-body">
          <h1 className="detail-title">{displayTitle}</h1>

          {metaParts.length > 0 && (
            <div className="detail-meta">{metaParts.join(" · ")}</div>
          )}

          {(rating > 0 || details?.traktRating) && (
            <div className="detail-rating">
              {rating > 0 && (
                <span className="detail-rating-group">
                  <span className="detail-rating-badge">TMDB</span>
                  <span className="detail-rating-value">{rating.toFixed(1)}</span>
                </span>
              )}
              {details?.traktRating && (
                <span className="detail-rating-group">
                  <span className="detail-rating-badge detail-rating-badge-trakt">Trakt</span>
                  <span className="detail-rating-value">{(details.traktRating.rating).toFixed(1)}</span>
                  <span className="detail-rating-votes">({details.traktRating.votes.toLocaleString()})</span>
                </span>
              )}
            </div>
          )}

          {details?.tagline && (
            <div className="detail-tagline">{details.tagline}</div>
          )}

          {overview && (
            <div className="detail-overview">
              <p className={overviewExpanded ? "" : "detail-overview-clamped"}>
                {overview}
              </p>
              {overview.length > 200 && (
                <button
                  className="detail-more-btn"
                  onClick={() => setOverviewExpanded(!overviewExpanded)}
                >
                  {overviewExpanded ? "less" : "more"}
                </button>
              )}
            </div>
          )}

          {error && <div className="detail-error">{error}</div>}

          {/* Action buttons */}
          <div className="detail-actions">
            <button
              className="detail-play-btn"
              onClick={handlePlay}
              disabled={loadingSources}
            >
              {loadingSources ? "Checking…" : "▶ Play"}
            </button>
          </div>

          {seriesDetail && seriesDetail.episodes.length > 0 && (
            <div className="detail-section">
              <h2 className="detail-section-title">
                Episodes <span className="detail-section-source">from Xtream</span>
              </h2>
              {seriesDetail.seasons.length > 1 && (
                <div className="season-row">
                  {seriesDetail.seasons.map((entry) => (
                    <span
                      key={entry.number}
                      className={`chip ${season === entry.number ? "active" : ""}`}
                      onClick={() => setSeason(entry.number)}
                    >
                      {entry.name}
                    </span>
                  ))}
                </div>
              )}
              <div className="episode-list">
                {visibleEpisodes.map((episode) => (
                  <button
                    key={episode.id}
                    className="episode-row"
                    onClick={() => playEpisode(episode, displayTitle)}
                  >
                    <span className="episode-num">
                      {episode.episode > 0 ? episode.episode : "•"}
                    </span>
                    <span className="episode-copy">
                      <span className="episode-title">{episode.title}</span>
                      {episode.plot && <span className="episode-plot">{episode.plot}</span>}
                    </span>
                    {episode.durationSecs ? (
                      <span className="episode-duration">{formatEpisodeDuration(episode.durationSecs)}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Cast */}
          {details?.cast && details.cast.length > 0 && (
            <div className="detail-section">
              <h2 className="detail-section-title">Cast</h2>
              <div className="detail-cast-row">
                {details.cast.map((member, i) => (
                  <div key={i} className="detail-cast-card">
                    <div className="detail-cast-photo">
                      {member.profilePath ? (
                        <img src={member.profilePath} alt={member.name} loading="lazy" />
                      ) : (
                        <div className="detail-cast-photo-empty" />
                      )}
                    </div>
                    <div className="detail-cast-name">{member.name}</div>
                    <div className="detail-cast-character">{member.character}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reviews */}
          {details?.traktComments && details.traktComments.length > 0 && (
            <div className="detail-section">
              <h2 className="detail-section-title">Reviews <span className="detail-section-source">from Trakt</span></h2>
              <div className="detail-reviews">
                {details.traktComments.map((c) => (
                  <div key={c.id} className="review-card">
                    <div className="review-card-header">
                      <span className="review-avatar">{c.username.slice(0, 1).toUpperCase()}</span>
                      <div>
                        <div className="review-username">{c.username}</div>
                        <div className="review-meta">
                          Trakt · {new Date(c.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })}
                          {c.spoiler && <span className="review-spoiler-tag">Spoiler</span>}
                        </div>
                      </div>
                      {c.likes > 0 && <span className="review-likes">▲ {c.likes}</span>}
                    </div>
                    <p className={`review-text ${c.spoiler ? "review-text-spoiler" : ""}`}>{c.comment}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Similar */}
          {details?.similar && details.similar.length > 0 && (
            <Shelf title="Similar">
              {details.similar.map((s) => (
                <Tile
                  key={s.id}
                  image={s.poster}
                  title={s.title}
                  year={s.year}
                  genre={s.genre}
                  ratingPercent={s.ratingPercent}
                  owned
                  onClick={() => onSelectSimilar(s.id, s.type)}
                />
              ))}
            </Shelf>
          )}
        </div>
      </div>

      {/* Source picker sheet */}
      {showSourcePicker && sources && (
        <SourcePicker
          title={displayTitle}
          versions={sources}
          onSelect={handleSourceSelect}
          onClose={() => setShowSourcePicker(false)}
        />
      )}

      {/* Video player */}
      {playing && (
        <Player
          src={playing.src}
          title={playing.title ?? displayTitle}
          subtitle={metaParts.join(" · ") || undefined}
          isHls={playing.hls}
          durationHint={playing.duration ?? (details?.runtime ? details.runtime * 60 : undefined)}
          onClose={() => setPlaying(null)}
        />
      )}

      {loading && <div className="detail-loading">Loading…</div>}
    </div>
  );
}
