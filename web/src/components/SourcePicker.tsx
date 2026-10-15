import { useState } from "react";
import { SourceVersion } from "../api.js";

interface SourcePickerProps {
  title: string;
  versions: SourceVersion[];
  onSelect: (version: SourceVersion) => void;
  onClose: () => void;
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

type SourceFilter = "all" | "plex" | "silo" | "xtream";

function sourceLabel(source: string): string {
  if (source === "all") return "All";
  if (source === "plex") return "Plex";
  if (source === "silo") return "Silo";
  if (source === "xtream") return "Xtream";
  return source;
}

export default function SourcePicker({ title, versions, onSelect, onClose }: SourcePickerProps) {
  const [filter, setFilter] = useState<SourceFilter>("all");

  const availableFilters = new Set(versions.map((v) => v.source));
  const filtered = filter === "all" ? versions : versions.filter((v) => v.source === filter);

  const badgeClass = (badge: string) => {
    const lower = badge.toLowerCase();
    if (lower === "4k") return "source-badge source-badge-4k";
    if (lower === "1080p") return "source-badge source-badge-1080p";
    if (lower === "dv" || lower === "hdr" || lower === "hdr10") return "source-badge source-badge-hdr";
    if (lower === "remux") return "source-badge source-badge-remux";
    if (lower === "hevc" || lower === "h264" || lower === "av1") return "source-badge source-badge-codec";
    if (lower === "truehd" || lower === "dts-hd" || lower === "dts" || lower === "eac3" || lower === "aac" || lower === "flac")
      return "source-badge source-badge-audio";
    if (lower === "atmos") return "source-badge source-badge-atmos";
    return "source-badge";
  };

  return (
    <div className="source-picker-overlay" onClick={onClose}>
      <div className="source-picker" onClick={(e) => e.stopPropagation()}>
        <div className="source-picker-header">
          <button className="source-picker-close" onClick={onClose}>Close</button>
          <h2 className="source-picker-title">{title}</h2>
          <button className="source-picker-refresh" aria-label="Refresh">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M1 4v6h6M23 20v-6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>

        {availableFilters.size > 1 && (
          <div className="source-picker-filters">
            {(["all", ...Array.from(availableFilters)] as SourceFilter[]).map((f) => (
              <span
                key={f}
                className={`chip ${filter === f ? "active" : ""}`}
                onClick={() => setFilter(f)}
              >
                {sourceLabel(f)}
              </span>
            ))}
          </div>
        )}

        <div className="source-picker-count">{filtered.length} source{filtered.length !== 1 ? "s" : ""}</div>

        <div className="source-picker-list">
          {filtered.map((v, i) => (
            <div key={i} className="source-card" onClick={() => onSelect(v)}>
              <div className="source-card-header">
                <span className="source-card-server">{v.serverName}</span>
                {v.size ? <span className="source-card-size">{formatSize(v.size)}</span> : null}
              </div>
              {v.filename && (
                <div className="source-card-filename">
                  {v.serverName} &middot; {v.filename}
                </div>
              )}
              <div className="source-card-badges">
                <span className="source-badge source-badge-remote">Remote</span>
                {v.badges.map((b, j) => (
                  <span key={j} className={badgeClass(b)}>{b}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
