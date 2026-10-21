import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, Channel, EpgListing, fetchChannels, fetchEpg, streamUrlFor } from "../api.js";
import InlinePlayer from "../components/InlinePlayer.js";
import { useInView } from "../hooks/useInView.js";
import { qualityFromName, stripQualityFromName } from "../utils/quality.js";
import { groupCategories } from "../utils/categoryGroups.js";
import { createLimiter } from "../utils/concurrencyLimiter.js";

type Filter = { kind: "all" } | { kind: "group"; group: string } | { kind: "category"; category: string };

function filterKey(f: Filter): string {
  return f.kind === "all" ? "all" : f.kind === "group" ? `group:${f.group}` : `category:${f.category}`;
}

function formatTime(iso: string): string {
  const date = new Date(Number(iso) * 1000 || iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Fetching EPG for every channel at once would fire hundreds of requests in a burst.
// Cache results so scrolling a row out of and back into view doesn't re-fetch, and only
// fetch once a row is actually visible.
const epgCache = new Map<number, EpgListing[]>();
const epgLimiter = createLimiter(4);

function GuideRow({
  channel,
  active,
  onClick,
}: {
  channel: Channel;
  active: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const inView = useInView(ref);
  const [epg, setEpg] = useState<EpgListing[]>(() => epgCache.get(channel.id) ?? []);

  useEffect(() => {
    if (!inView || epgCache.has(channel.id)) return;
    let cancelled = false;
    epgLimiter(() => fetchEpg(channel.id))
      .then((res) => {
        const listings = res.listings.slice(0, 1);
        epgCache.set(channel.id, listings);
        if (!cancelled) setEpg(listings);
      })
      .catch(() => {
        // don't cache failures - allow a retry next time the row comes into view
      });
    return () => {
      cancelled = true;
    };
  }, [inView, channel.id]);

  const now = epg[0];
  const quality = qualityFromName(channel.name);

  return (
    <button type="button" ref={ref} className={`guide-row ${active ? "active" : ""}`} onClick={onClick}>
      <div className="guide-row-logo">
        {channel.icon ? <img src={channel.icon} alt="" loading="lazy" /> : <div className="guide-row-logo-empty" />}
      </div>
      <div className="guide-row-info">
        <div className="guide-row-name">
          <span>{quality ? stripQualityFromName(channel.name) : channel.name}</span>
          {quality && (
            <span className={`quality-badge ${quality === "4K" ? "quality-badge-4k" : ""}`}>{quality}</span>
          )}
        </div>
        <div className="guide-row-now">
          {now ? (
            <>
              <span className="guide-row-time">
                {formatTime(now.start)}–{formatTime(now.end)}
              </span>
              {now.title}
            </>
          ) : (
            channel.category
          )}
        </div>
      </div>
    </button>
  );
}

export default function Live() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [playing, setPlaying] = useState<Channel | null>(null);

  useEffect(() => {
    fetchChannels()
      .then((res) => {
        setChannels(res.channels);
        setCategories(res.categories);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 409) {
          setNotConfigured(true);
        } else {
          setError(err.message);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of channels) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
    return counts;
  }, [channels]);

  const groups = useMemo(() => groupCategories(categories), [categories]);

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of groups) {
      const total = g.categories.reduce((sum, c) => sum + (categoryCounts.get(c.name) ?? 0), 0);
      counts.set(g.group, total);
    }
    return counts;
  }, [groups, categoryCounts]);

  const groupMembership = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) {
      for (const c of g.categories) map.set(c.name, g.group);
    }
    return map;
  }, [groups]);

  function toggleGroupExpanded(group: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const visible = useMemo(() => {
    let list = channels;
    if (filter.kind === "category") {
      list = list.filter((c) => c.category === filter.category);
    } else if (filter.kind === "group") {
      list = list.filter((c) => groupMembership.get(c.category) === filter.group);
    }
    if (search.trim()) {
      const needle = search.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(needle));
    }
    return list;
  }, [channels, filter, groupMembership, search]);

  if (!loading && notConfigured) {
    return (
      <div className="page">
        <div className="status">
          Xtream Codes isn't connected yet.
          <br />
          <Link to="/settings">Go to Settings</Link> to log in.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page">
        <div className="status">Loading channels…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="status">Failed to load channels: {error}</div>
      </div>
    );
  }

  return (
    <div className="live-layout">
      <aside className="live-categories-col">
        <div className="live-sidebar-header">
          Categories
          <span className="live-sidebar-count">{channels.length}</span>
        </div>
        <button
          type="button"
          className={`live-category ${filter.kind === "all" ? "active" : ""}`}
          onClick={() => setFilter({ kind: "all" })}
        >
          <span>All</span>
          <span className="live-category-count">{channels.length}</span>
        </button>

        {groups.map((g) => {
          if (g.categories.length === 1) {
            const only = g.categories[0];
            const key: Filter = { kind: "category", category: only.name };
            return (
              <button
                type="button"
                key={g.group}
                className={`live-category ${filterKey(filter) === filterKey(key) ? "active" : ""}`}
                onClick={() => setFilter(key)}
              >
                <span>{only.name}</span>
                <span className="live-category-count">{categoryCounts.get(only.name) ?? 0}</span>
              </button>
            );
          }

          const expanded = expandedGroups.has(g.group);
          const groupKey: Filter = { kind: "group", group: g.group };
          return (
            <div key={g.group} className="live-category-group">
              <button
                type="button"
                className={`live-category live-category-folder ${
                  filterKey(filter) === filterKey(groupKey) ? "active" : ""
                }`}
                onClick={() => {
                  setFilter(groupKey);
                  if (!expanded) toggleGroupExpanded(g.group);
                }}
              >
                <span className="live-category-label">
                  <span
                    className={`live-category-chevron ${expanded ? "expanded" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleGroupExpanded(g.group);
                    }}
                  >
                    ›
                  </span>
                  <span>{g.group}</span>
                </span>
                <span className="live-category-count">{groupCounts.get(g.group) ?? 0}</span>
              </button>
              {expanded && (
                <div className="live-category-children">
                  {g.categories.map((c) => {
                    const key: Filter = { kind: "category", category: c.name };
                    return (
                      <button
                        type="button"
                        key={c.name}
                        className={`live-category sub ${filterKey(filter) === filterKey(key) ? "active" : ""}`}
                        onClick={() => setFilter(key)}
                      >
                        <span>{c.label}</span>
                        <span className="live-category-count">{categoryCounts.get(c.name) ?? 0}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </aside>

      <main className="live-player-col">
        <InlinePlayer
          src={playing ? streamUrlFor("live", playing.id) : undefined}
          icon={playing?.icon}
          title={playing?.name}
          subtitle={playing?.category}
        />
      </main>

      <aside className="live-guide-col">
        <input
          type="text"
          className="live-search"
          placeholder="Search channels…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {visible.length === 0 ? (
          <div className="status">No channels found.</div>
        ) : (
          <div className="guide-list">
            {visible.map((channel) => (
              <GuideRow
                key={channel.id}
                channel={channel}
                active={playing?.id === channel.id}
                onClick={() => setPlaying(channel)}
              />
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
