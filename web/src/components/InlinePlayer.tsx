import { useEffect, useRef, useState } from "react";
import { useHlsVideo } from "../hooks/useHlsVideo.js";
import { qualityFromResolution } from "../utils/quality.js";

interface InlinePlayerProps {
  src?: string;
  icon?: string;
  title?: string;
  subtitle?: string;
}

const DEFAULT_VOLUME = 0.25;

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" className="icon-play">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}

function Replay10Icon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8zm-1.1 11h-.85v-3.26l-1.01.31v-.69l1.77-.63h.09V16zm4.28-1.76c0 .32-.03.6-.1.82s-.17.4-.29.55-.28.24-.45.31-.37.1-.58.1-.41-.03-.59-.1-.33-.17-.46-.31-.23-.33-.29-.55-.1-.5-.1-.82v-.74c0-.32.03-.6.1-.82s.17-.4.29-.54.28-.24.45-.31.37-.1.59-.1.41.03.59.1.33.17.46.31.23.33.29.54.1.5.1.82v.74zm-.85-.86c0-.19-.01-.35-.04-.48s-.07-.23-.12-.31-.11-.14-.19-.17-.16-.05-.25-.05-.18.02-.25.05-.14.09-.19.17-.09.18-.12.31-.04.29-.04.48v.97c0 .19.01.36.04.48s.07.24.12.32.11.14.19.17.16.05.25.05.18-.02.25-.05.14-.09.19-.17.09-.19.12-.32.04-.29.04-.48v-.97z" />
    </svg>
  );
}

function Forward10Icon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8zm-1.1 11h-.85v-3.26l-1.01.31v-.69l1.77-.63h.09V16zm4.28-1.76c0 .32-.03.6-.1.82s-.17.4-.29.55-.28.24-.45.31-.37.1-.58.1-.41-.03-.59-.1-.33-.17-.46-.31-.23-.33-.29-.55-.1-.5-.1-.82v-.74c0-.32.03-.6.1-.82s.17-.4.29-.54.28-.24.45-.31.37-.1.59-.1.41.03.59.1.33.17.46.31.23.33.29.54.1.5.1.82v.74zm-.85-.86c0-.19-.01-.35-.04-.48s-.07-.23-.12-.31-.11-.14-.19-.17-.16-.05-.25-.05-.18.02-.25.05-.14.09-.19.17-.09.18-.12.31-.04.29-.04.48v.97c0 .19.01.36.04.48s.07.24.12.32.11.14.19.17.16.05.25.05.18-.02.25-.05.14-.09.19-.17.09-.19.12-.32.04-.29.04-.48v-.97z" />
    </svg>
  );
}

function VolumeIcon({ muted }: { muted: boolean }) {
  if (muted) {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
    </svg>
  );
}

export default function InlinePlayer({ src, icon, title, subtitle }: InlinePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { error, playing: loaded } = useHlsVideo(videoRef, src, true, true);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(DEFAULT_VOLUME);
  const [quality, setQuality] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // The <video> element is reused across channel switches (React keeps the same
    // DOM node), so any earlier mute/volume state would otherwise silently carry
    // over to every subsequent channel. Force a clean, audible baseline each time.
    video.muted = false;
    video.volume = DEFAULT_VOLUME;
    setMuted(false);
    setVolume(DEFAULT_VOLUME);
    setQuality(null);

    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    // The real resolution is only known once the decoder has the first frame - reading
    // it here (instead of probing the manifest ahead of time) is effectively free since
    // we're already loading this one stream to play it.
    const onResize = () => {
      if (video.videoWidth && video.videoHeight) {
        setQuality(qualityFromResolution(video.videoWidth, video.videoHeight));
      }
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("resize", onResize);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("resize", onResize);
    };
  }, [src]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  function seek(deltaSeconds: number) {
    const video = videoRef.current;
    if (!video) return;
    let target = video.currentTime + deltaSeconds;
    const seekable = video.seekable;
    if (seekable.length > 0) {
      target = Math.min(Math.max(target, seekable.start(0)), seekable.end(seekable.length - 1));
    }
    video.currentTime = target;
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }

  function handleVolumeChange(v: number) {
    const video = videoRef.current;
    if (!video) return;
    video.volume = v;
    video.muted = v === 0;
    setVolume(v);
    setMuted(v === 0);
  }

  function toggleFullscreen() {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen();
    }
  }

  return (
    <div className="inline-player" ref={containerRef}>
      <div className="inline-player-video">
        {src ? (
          <video ref={videoRef} playsInline />
        ) : (
          <div className="inline-player-empty">Select a channel to start watching</div>
        )}
        {src && !error && !loaded && <div className="inline-player-status">Loading…</div>}
        {src && error && <div className="inline-player-status inline-player-status-error">{error}</div>}
      </div>

      {src && (
        <div className="player-bar">
          <div className="player-bar-info">
            {icon ? (
              <img className="player-bar-logo" src={icon} alt="" />
            ) : (
              <div className="player-bar-logo player-bar-logo-empty" />
            )}
            <div className="player-bar-text">
              <div className="player-bar-title">{title}</div>
              <div className="player-bar-subtitle">
                <span className="live-badge">
                  <span className="live-dot" /> LIVE
                </span>
                {quality && (
                  <span className={`quality-badge ${quality === "4K" ? "quality-badge-4k" : ""}`}>{quality}</span>
                )}
                {subtitle && <span className="player-bar-category">{subtitle}</span>}
              </div>
            </div>
          </div>

          <div className="player-transport">
            <button className="transport-btn" onClick={() => seek(-10)} title="Back 10 seconds">
              <Replay10Icon />
            </button>
            <button className="transport-btn transport-btn-primary" onClick={togglePlay}>
              {paused ? <PlayIcon /> : <PauseIcon />}
            </button>
            <button className="transport-btn" onClick={() => seek(10)} title="Forward 10 seconds">
              <Forward10Icon />
            </button>
          </div>

          <div className="player-bar-controls">
            <button className="transport-btn" onClick={toggleMute}>
              <VolumeIcon muted={muted || volume === 0} />
            </button>
            <input
              type="range"
              className="live-volume"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
            />
            <button className="transport-btn" onClick={toggleFullscreen}>
              <FullscreenIcon />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
