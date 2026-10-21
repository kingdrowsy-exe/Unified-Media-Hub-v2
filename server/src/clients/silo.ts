import { sanitizeArtworkUrl } from "../artwork.js";
import { NotConfiguredError, settingsStore } from "../settingsStore.js";
import { fetchProvider, readJsonLimited } from "../upstream.js";

// Silo's real native API (confirmed against a live instance) - not Jellyfin/Emby
// despite also offering a separate Jellyfin-compat layer on port 8096 (not exposed
// publicly on this deployment). Movies only for now: TV series need per-episode
// content_id lookups that haven't been mapped yet (a "watch" call on a series content_id
// returns 400 "Content is not directly playable").

export interface SiloItem {
  Id: string;
  Name: string;
  ProductionYear?: number;
  Type: string;
  posterUrl?: string;
  genre?: string;
  ratingPercent?: number;
}

interface SiloAuthResult {
  access_token: string;
  expires_in: number;
}

interface SiloProfile {
  id: string;
  is_primary: boolean;
}

interface SiloCatalogItem {
  content_id: string;
  type: string;
  title: string;
  year?: number;
  genres?: string[];
  rating_imdb?: number;
  rating_tmdb?: number;
  poster_url?: string;
}

interface SiloWatchVersion {
  file_id: number;
  file_name?: string;
  file_size?: number;
  resolution?: string;
  video_codec?: string;
  audio_codec?: string;
  audio_channels?: number;
  hdr?: string;
  dynamic_range?: string;
}

export interface SiloMediaVersion {
  contentId: string;
  fileId: number;
  filename?: string;
  size?: number;
  resolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  hdr?: string;
}

let session: { accessToken: string; expiresAt: number } | null = null;
let profileId: string | null = null;

function requireSilo() {
  const silo = settingsStore.getSilo();
  if (!silo) {
    throw new NotConfiguredError("silo");
  }
  return silo;
}

export function resetSiloSession() {
  session = null;
  profileId = null;
}

async function authenticate(): Promise<{ accessToken: string; expiresAt: number }> {
  const silo = requireSilo();
  const res = await fetchProvider(`${silo.baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: silo.username, password: silo.password }),
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.includes("application/json")) {
    throw new Error(`Silo authentication failed: ${res.status}`);
  }
  const data = await readJsonLimited<SiloAuthResult>(res);
  session = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return session;
}

async function getSession() {
  if (!session || session.expiresAt < Date.now()) {
    return authenticate();
  }
  return session;
}

async function getProfileId(): Promise<string> {
  if (profileId) return profileId;
  const silo = requireSilo();
  const s = await getSession();
  const res = await fetchProvider(`${silo.baseUrl}/api/v1/profiles`, {
    headers: { Authorization: `Bearer ${s.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Silo profile lookup failed: ${res.status}`);
  }
  const data = await readJsonLimited<{ profiles: SiloProfile[] }>(res);
  const profile = data.profiles.find((p) => p.is_primary) ?? data.profiles[0];
  if (!profile) {
    throw new Error("Silo account has no profiles");
  }
  profileId = profile.id;
  return profileId;
}

function toSiloItem(item: SiloCatalogItem): SiloItem {
  return {
    Id: item.content_id,
    Name: item.title,
    ProductionYear: item.year,
    Type: "Movie",
    posterUrl: sanitizeArtworkUrl(item.poster_url),
    genre: item.genres?.[0],
    ratingPercent:
      item.rating_tmdb !== undefined
        ? Math.round(item.rating_tmdb * 10)
        : item.rating_imdb !== undefined
          ? Math.round(item.rating_imdb * 10)
          : undefined,
  };
}

async function fetchCatalog(query?: string): Promise<SiloItem[]> {
  const silo = requireSilo();
  const s = await getSession();
  const url = new URL(`${silo.baseUrl}/api/v1/catalog`);
  if (query) url.searchParams.set("q", query);
  const res = await fetchProvider(url, { headers: { Authorization: `Bearer ${s.accessToken}` } });
  if (!res.ok) {
    throw new Error(`Silo catalog request failed: ${res.status}`);
  }
  const data = await readJsonLimited<{ items: SiloCatalogItem[] }>(res);
  return data.items.filter((item) => item.type === "movie").map(toSiloItem);
}

export async function listSiloItems(): Promise<SiloItem[]> {
  // Silo's catalog has no confirmed offset/limit pagination and can be enormous
  // (six-figure item counts) - like Plex's "popular" page, we only take the single
  // bounded page the API hands back rather than paging through everything.
  return fetchCatalog();
}

// Confirmed working: /api/v1/catalog?q=<query> returns a real filtered result set, not
// the full unfiltered catalog - a proper search, safe to use live per user-initiated query.
export async function searchSiloItems(query: string): Promise<SiloItem[]> {
  return fetchCatalog(query);
}

export function siloPosterUrl(_itemId: string, item?: { posterUrl?: string }): string | undefined {
  return item?.posterUrl;
}

export async function getSiloMediaVersions(contentId: string): Promise<SiloMediaVersion[]> {
  const silo = requireSilo();
  const s = await getSession();
  const res = await fetchProvider(`${silo.baseUrl}/api/v1/watch/${contentId}`, {
    headers: { Authorization: `Bearer ${s.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Silo item isn't directly playable (${res.status})`);
  }
  const data = await readJsonLimited<{ versions?: SiloWatchVersion[] }>(res);
  return (data.versions ?? []).map((v) => ({
    contentId,
    fileId: v.file_id,
    filename: v.file_name,
    size: v.file_size,
    resolution: v.resolution,
    videoCodec: v.video_codec,
    audioCodec: v.audio_codec,
    audioChannels: v.audio_channels,
    hdr: v.hdr ?? v.dynamic_range,
  }));
}

const CLIENT_CAPABILITIES = {
  video_evidence: "declared",
  audio_evidence: "declared",
  codecs_video: ["h264", "hevc", "av1", "vp9"],
  codecs_video_hardware: ["h264", "hevc", "av1", "vp9"],
  codecs_audio: ["aac", "mp3", "opus", "vorbis", "flac"],
  containers: ["mp4", "webm", "mkv", "mp3", "flac", "ogg"],
  max_resolution: "2160p",
  hdr: false,
};

function deliveryCapability(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    supported_on_device: true,
    containers: ["mp4", "webm", "mkv", "mp3", "flac", "ogg"],
    video_codecs: ["h264", "hevc", "av1", "vp9"],
    audio_decode_codecs: ["aac", "mp3", "opus", "vorbis", "flac"],
    audio_passthrough_codecs: [],
    hdr_details: { hdr10: false, hdr10_plus: false, hlg: false, dolby_vision_profiles: [], dolby_vision_profile_levels: [] },
    subtitles: {
      embedded_text: true,
      sidecar_text: true,
      ass_styling: true,
      embedded_bitmap: false,
      sidecar_bitmap: false,
      font_attachments: true,
    },
    features: [],
    auth_header_refresh: false,
    validated_claims: [],
    transformations: [],
    ...overrides,
  };
}

export async function resolveSiloStreamUrl(contentId: string): Promise<{ url: string; accessToken: string }> {
  const silo = requireSilo();
  const s = await getSession();
  const headers = { Authorization: `Bearer ${s.accessToken}` };

  const watchRes = await fetchProvider(`${silo.baseUrl}/api/v1/watch/${contentId}`, { headers });
  if (!watchRes.ok) {
    throw new Error(`Silo item isn't directly playable (${watchRes.status})`);
  }
  const watch = await readJsonLimited<{ versions?: SiloWatchVersion[] }>(watchRes);
  const fileId = watch.versions?.[0]?.file_id;
  if (fileId === undefined) {
    throw new Error("No playable file found for this Silo title");
  }

  const profile = await getProfileId();
  const body = {
    protocol_version: 3,
    client_features: ["playback_plan_v3", "plan_invalidated_v1"],
    file_id: fileId,
    profile_id: profile,
    playback_attempt_id: crypto.randomUUID(),
    quality_preference: "auto",
    subtitle_fidelity_preference: "preserve",
    metered: false,
    client_capabilities: {
      ...CLIENT_CAPABILITIES,
      hdr_details: {
        hdr10: true,
        hdr10_plus: false,
        hlg: false,
        dolby_vision_profiles: [],
        dolby_vision_profile_levels: [],
        hdr10_max_width: 3840,
        hdr10_max_height: 2160,
        hdr10_max_frame_rate: 24,
        hdr10_max_bitrate_kbps: 80000,
      },
    },
    client_playback_context: {
      protocol_version: 3,
      form_factor: "desktop",
      app_version: "web",
      device: { platform: "web", platform_details: { user_agent: "UnifiedMediaHub/0.1.0", device_pixel_ratio: "1" } },
      deliveries: {
        original_http: deliveryCapability(),
        progressive: deliveryCapability({ audio_decode_codecs: ["aac", "opus", "flac"] }),
        hls: deliveryCapability({ containers: ["hls"] }),
      },
    },
  };

  const startRes = await fetchProvider(`${silo.baseUrl}/api/v1/playback/start`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "X-Profile-Id": profile },
    body: JSON.stringify(body),
  });
  if (!startRes.ok) {
    throw new Error(`Silo playback couldn't start (${startRes.status})`);
  }
  const plan = await readJsonLimited<{ playback_plan?: { stream?: { url?: string } } }>(startRes);
  const streamPath = plan.playback_plan?.stream?.url;
  if (!streamPath) {
    throw new Error("Silo didn't return a playable stream for this title");
  }

  const base = new URL(silo.baseUrl);
  const joined = `${base.origin}/api/v1${streamPath.startsWith("/") ? streamPath : `/${streamPath}`}`;
  const target = new URL(joined);
  if (target.origin !== base.origin || target.username || target.password) {
    throw new Error("Silo returned a stream outside the configured server");
  }
  return { url: target.toString(), accessToken: s.accessToken };
}
