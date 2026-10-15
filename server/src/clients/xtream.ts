import { config } from "../config.js";
import { cached } from "../cache.js";
import { NotConfiguredError, settingsStore } from "../settingsStore.js";

export interface XtreamCategory {
  category_id: string;
  category_name: string;
}

export interface XtreamLiveStream {
  stream_id: number;
  name: string;
  stream_icon?: string;
  category_id: string;
}

export interface XtreamEpgEntry {
  id: string;
  title: string;
  start: string;
  end: string;
  description?: string;
}

interface RawEpgEntry {
  id: string;
  title: string;
  start: string;
  end: string;
  description?: string;
}

export interface XtreamLibraryItem {
  id: string;
  title: string;
  year?: number;
  type: "movie" | "show";
  poster?: string;
  genre?: string;
  ratingPercent?: number;
  categoryId?: string;
  added?: number;
  containerExtension?: string;
}

export interface XtreamCategoryRef {
  id: string;
  name: string;
}

export interface XtreamSeason {
  number: number;
  name: string;
  cover?: string;
  episodeCount: number;
}

export interface XtreamEpisode {
  /** Playback id understood by /api/stream/xtream/:id (`episode:<id>:<ext>`). */
  id: string;
  season: number;
  episode: number;
  title: string;
  plot?: string;
  durationSecs?: number;
  poster?: string;
  playback: "hls" | "file";
}

export interface XtreamSeriesDetail {
  seriesId: number;
  title: string;
  poster?: string;
  plot?: string;
  year?: number;
  genre?: string;
  seasons: XtreamSeason[];
  episodes: XtreamEpisode[];
}

export interface XtreamVodInfo {
  name?: string;
  plot?: string;
  containerExtension?: string;
  durationSecs?: number;
  resolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  genre?: string;
  year?: number;
}

const XTREAM_TIMEOUT_MS = 60_000;
const NATIVE_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm"]);

const RELEASE_JUNK =
  /\b(2160p|1080p|720p|480p|576p|4k|uhd|hdr10\+?|hdr|hevc|x265|x264|h\.?264|h\.?265|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdtv|dvdrip|hdrip|remux|10bit|8bit|aac|dts|atmos|truehd)\b/gi;

function requireXtream() {
  const xtream = settingsStore.getXtream();
  if (!xtream) {
    throw new NotConfiguredError("xtream");
  }
  return xtream;
}

function apiUrl(action: string, extra: Record<string, string> = {}) {
  const xtream = requireXtream();
  const url = new URL(`${xtream.baseUrl}/player_api.php`);
  url.searchParams.set("username", xtream.username);
  url.searchParams.set("password", xtream.password);
  url.searchParams.set("action", action);
  for (const [key, value] of Object.entries(extra)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function xtreamFetch<T>(action: string, extra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(apiUrl(action, extra), { signal: AbortSignal.timeout(XTREAM_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Xtream request failed: ${res.status} action=${action}`);
  }
  return (await res.json()) as T;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function posterUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw || /^(null|n\/a|none|undefined)$/i.test(raw)) return undefined;
  return raw;
}

function containerExtension(value: unknown): string {
  const raw = asString(value)?.toLowerCase().replace(/^\./, "") ?? "";
  return /^[a-z0-9]{1,10}$/.test(raw) ? raw : "mkv";
}

function ratingPercent(rating: unknown, rating5: unknown): number | undefined {
  const five = asNumber(rating5);
  if (five !== undefined && five > 0) {
    return Math.max(0, Math.min(100, Math.round(five * 20)));
  }
  const value = asNumber(rating);
  if (value === undefined || value <= 0) return undefined;
  const percent = value <= 5 ? value * 20 : value <= 10 ? value * 10 : value;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function yearFromText(value: unknown): number | undefined {
  const match = asString(value)?.match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : undefined;
}

function firstGenre(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const part = raw.split(/[/|,]/)[0]?.trim();
  return part || undefined;
}

function durationSeconds(value: unknown): number | undefined {
  const numeric = asNumber(value);
  if (numeric !== undefined && numeric > 0) return Math.round(numeric);
  if (typeof value !== "string") return undefined;
  const parts = value.split(":").map((part) => Number(part));
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
}

// Release names ("Dune (2021) 1080p", "The.Matrix.1999.1080p.BluRay") need the year and
// quality tags pulled off so dedup can line them up with a Plex/Silo/TMDB title. A clean
// title that merely ends in a number ("Blade Runner 2049") keeps that number.
export function cleanXtreamTitle(raw: string): { title: string; year?: number } {
  const original = raw.trim();
  if (!original) return { title: "" };

  const parenYear = original.match(/\((19\d{2}|20\d{2})\)/);
  let year = parenYear ? Number(parenYear[1]) : undefined;
  RELEASE_JUNK.lastIndex = 0;
  const hadReleaseJunk = RELEASE_JUNK.test(original) || /\.(?:19|20)\d{2}\./.test(original);
  RELEASE_JUNK.lastIndex = 0;

  let name = original.replace(/\[[^\]]*\]/g, " ");
  name = name.replace(/\((?:19|20)\d{2}\)/g, " ");
  name = name.replace(/\([^)]*(?:1080p|720p|2160p|4k|uhd|hdr|hevc|x26[45]|bluray|webrip|web-dl)[^)]*\)/gi, " ");
  name = name.replace(/[._]+/g, " ");
  name = name.replace(RELEASE_JUNK, " ");
  name = name.replace(/\s{2,}/g, " ").trim();
  name = name.replace(/^[\s\-–:|]+|[\s\-–:|]+$/g, "").trim();

  if (year === undefined && hadReleaseJunk) {
    const trailing = name.match(/^(.*\S)\s+((?:19|20)\d{2})$/);
    if (trailing) {
      name = trailing[1].trim();
      year = Number(trailing[2]);
    }
  }

  return { title: name || original, year };
}

export function resolutionFromHeight(height?: number): string | undefined {
  if (!height || height <= 0) return undefined;
  if (height >= 2000) return "4K";
  if (height >= 1000) return "1080p";
  if (height >= 700) return "720p";
  if (height >= 400) return "480p";
  return undefined;
}

export function playbackModeForExtension(extension: string): "hls" | "file" {
  return NATIVE_EXTENSIONS.has(extension.toLowerCase()) ? "file" : "hls";
}

export function parseXtreamPlaybackId(
  id: string,
): { kind: "vod" | "episode"; id: number; extension: string } | null {
  const match = /^(vod|episode):(\d+):([a-z0-9]{1,10})$/i.exec(id);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() === "episode" ? "episode" : "vod",
    id: Number(match[2]),
    extension: match[3].toLowerCase(),
  };
}

export function parseXtreamSeriesId(id: string): number | null {
  const match = /^series:(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

function categoryNameMap(categories: XtreamCategory[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const category of categories) {
    const id = asString(category.category_id);
    const name = asString(category.category_name);
    if (id && name) names.set(id, name);
  }
  return names;
}

function toCategoryRefs(categories: XtreamCategory[]): XtreamCategoryRef[] {
  const refs: XtreamCategoryRef[] = [];
  for (const category of categories) {
    const id = asString(category.category_id);
    const name = asString(category.category_name);
    if (!id || !name) continue;
    refs.push({ id, name });
  }
  return refs;
}

export function mapVodStreams(streams: unknown, categories: XtreamCategory[] = []): XtreamLibraryItem[] {
  const names = categoryNameMap(categories);
  const items: XtreamLibraryItem[] = [];
  for (const raw of asArray<Record<string, unknown>>(streams)) {
    const streamId = asNumber(raw.stream_id);
    const rawName = asString(raw.name);
    if (streamId === undefined || !rawName) continue;
    const cleaned = cleanXtreamTitle(rawName);
    if (!cleaned.title) continue;
    const extension = containerExtension(raw.container_extension);
    const categoryId = asString(raw.category_id);
    items.push({
      id: `vod:${streamId}:${extension}`,
      title: cleaned.title,
      year: cleaned.year,
      type: "movie",
      poster: posterUrl(raw.stream_icon) ?? posterUrl(raw.cover),
      genre: firstGenre(raw.genre) ?? (categoryId ? names.get(categoryId) : undefined),
      ratingPercent: ratingPercent(raw.rating, raw.rating_5based),
      categoryId,
      added: asNumber(raw.added),
      containerExtension: extension,
    });
  }
  return items;
}

export function mapSeriesList(series: unknown, categories: XtreamCategory[] = []): XtreamLibraryItem[] {
  const names = categoryNameMap(categories);
  const items: XtreamLibraryItem[] = [];
  for (const raw of asArray<Record<string, unknown>>(series)) {
    const seriesId = asNumber(raw.series_id);
    const rawName = asString(raw.name) ?? asString(raw.title);
    if (seriesId === undefined || !rawName) continue;
    const cleaned = cleanXtreamTitle(rawName);
    if (!cleaned.title) continue;
    const categoryId = asString(raw.category_id);
    const year = yearFromText(raw.releaseDate) ?? yearFromText(raw.release_date) ?? cleaned.year;
    items.push({
      id: `series:${seriesId}`,
      title: cleaned.title,
      year,
      type: "show",
      poster: posterUrl(raw.cover) ?? posterUrl(raw.stream_icon),
      genre: firstGenre(raw.genre) ?? (categoryId ? names.get(categoryId) : undefined),
      ratingPercent: ratingPercent(raw.rating, raw.rating_5based),
      categoryId,
      added: asNumber(raw.last_modified) ?? asNumber(raw.added),
    });
  }
  return items;
}

function videoMeta(info: Record<string, unknown>): { height?: number; videoCodec?: string; audioCodec?: string } {
  const videoRaw = Array.isArray(info.video) ? info.video[0] : info.video;
  const audioRaw = Array.isArray(info.audio) ? info.audio[0] : info.audio;
  const video = asRecord(videoRaw);
  const audio = asRecord(audioRaw);
  return {
    height: asNumber(video?.height),
    videoCodec: asString(video?.codec_name),
    audioCodec: asString(audio?.codec_name),
  };
}

export function mapVodInfo(payload: unknown): XtreamVodInfo {
  const root = asRecord(payload) ?? {};
  const info = asRecord(root.info) ?? {};
  const movie = asRecord(root.movie_data) ?? {};
  const media = videoMeta(info);
  const extension = asString(movie.container_extension);
  return {
    name: asString(movie.name) ?? asString(info.name),
    plot: asString(info.plot) ?? asString(info.description),
    containerExtension: extension ? containerExtension(extension) : undefined,
    durationSecs: durationSeconds(info.duration_secs) ?? durationSeconds(info.duration),
    resolution: resolutionFromHeight(media.height),
    videoCodec: media.videoCodec,
    audioCodec: media.audioCodec,
    genre: firstGenre(info.genre),
    year: yearFromText(info.releasedate) ?? yearFromText(info.release_date),
  };
}

function episodeList(episodes: unknown): Record<string, unknown>[] {
  if (Array.isArray(episodes)) return episodes.filter((entry) => asRecord(entry)).map((entry) => entry as Record<string, unknown>);
  const record = asRecord(episodes);
  if (!record) return [];
  const list: Record<string, unknown>[] = [];
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const row = asRecord(entry);
        if (row) list.push(row);
      }
    } else {
      const row = asRecord(value);
      if (row) list.push(row);
    }
  }
  return list;
}

export function mapSeriesPayload(seriesId: number, payload: unknown): XtreamSeriesDetail {
  const root = asRecord(payload) ?? {};
  const info = asRecord(root.info) ?? {};
  const cleaned = cleanXtreamTitle(asString(info.name) ?? asString(info.title) ?? `Series ${seriesId}`);
  const year = yearFromText(info.releaseDate) ?? yearFromText(info.release_date) ?? cleaned.year;

  const seasonMeta = new Map<number, { name?: string; cover?: string }>();
  for (const raw of asArray<unknown>(root.seasons)) {
    const season = asRecord(raw);
    if (!season) continue;
    const number = asNumber(season.season_number) ?? asNumber(season.season);
    if (number === undefined) continue;
    seasonMeta.set(number, {
      name: asString(season.name),
      cover: posterUrl(season.cover) ?? posterUrl(season.cover_big),
    });
  }

  const episodes: XtreamEpisode[] = [];
  for (const raw of episodeList(root.episodes)) {
    const episodeInfo = asRecord(raw.info) ?? {};
    const episodeId = asNumber(raw.id) ?? asNumber(raw.stream_id);
    if (episodeId === undefined) continue;
    const season = asNumber(raw.season) ?? asNumber(episodeInfo.season) ?? 1;
    const episode = asNumber(raw.episode_num) ?? asNumber(raw.episode) ?? 0;
    const extension = containerExtension(raw.container_extension);
    const title = asString(raw.title) ?? asString(episodeInfo.title) ?? `Episode ${episode || episodes.length + 1}`;
    episodes.push({
      id: `episode:${episodeId}:${extension}`,
      season,
      episode,
      title,
      plot: asString(episodeInfo.plot) ?? asString(raw.plot),
      durationSecs: durationSeconds(episodeInfo.duration_secs) ?? durationSeconds(episodeInfo.duration),
      poster: posterUrl(episodeInfo.movie_image) ?? posterUrl(raw.stream_icon),
      playback: playbackModeForExtension(extension),
    });
    if (!seasonMeta.has(season)) seasonMeta.set(season, {});
  }

  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode || a.title.localeCompare(b.title));

  const counts = new Map<number, number>();
  for (const episode of episodes) counts.set(episode.season, (counts.get(episode.season) ?? 0) + 1);

  const seasons: XtreamSeason[] = [...seasonMeta.entries()]
    .map(([number, meta]) => ({
      number,
      name: meta.name && !/^season\s+\d+$/i.test(meta.name) ? meta.name : `Season ${number}`,
      cover: meta.cover,
      episodeCount: counts.get(number) ?? 0,
    }))
    .filter((season) => season.episodeCount > 0)
    .sort((a, b) => a.number - b.number);

  return {
    seriesId,
    title: cleaned.title || `Series ${seriesId}`,
    poster: posterUrl(info.cover) ?? posterUrl(info.movie_image),
    plot: asString(info.plot),
    year,
    genre: firstGenre(info.genre),
    seasons,
    episodes,
  };
}

async function loadCategories(action: "get_vod_categories" | "get_series_categories", cacheKey: string) {
  return cached(cacheKey, config.cacheTtlSeconds, async () => asArray<XtreamCategory>(await xtreamFetch(action)));
}

export function listVodLibraryItems(): Promise<XtreamLibraryItem[]> {
  return cached("xtream:vod-items", config.cacheTtlSeconds, async () => {
    const [streams, categories] = await Promise.all([
      xtreamFetch<unknown>("get_vod_streams"),
      loadCategories("get_vod_categories", "xtream:vod-categories").catch(() => [] as XtreamCategory[]),
    ]);
    return mapVodStreams(streams, categories);
  });
}

export function listSeriesLibraryItems(): Promise<XtreamLibraryItem[]> {
  return cached("xtream:series-items", config.cacheTtlSeconds, async () => {
    const [series, categories] = await Promise.all([
      xtreamFetch<unknown>("get_series"),
      loadCategories("get_series_categories", "xtream:series-categories").catch(() => [] as XtreamCategory[]),
    ]);
    return mapSeriesList(series, categories);
  });
}

export async function listXtreamCategoryRefs(): Promise<{ vod: XtreamCategoryRef[]; series: XtreamCategoryRef[] }> {
  try {
    const [vod, series] = await Promise.all([
      loadCategories("get_vod_categories", "xtream:vod-categories").catch((err) => {
        if (err instanceof NotConfiguredError) throw err;
        return [] as XtreamCategory[];
      }),
      loadCategories("get_series_categories", "xtream:series-categories").catch((err) => {
        if (err instanceof NotConfiguredError) throw err;
        return [] as XtreamCategory[];
      }),
    ]);
    return { vod: toCategoryRefs(vod), series: toCategoryRefs(series) };
  } catch (err) {
    if (err instanceof NotConfiguredError) return { vod: [], series: [] };
    throw err;
  }
}

export async function listXtreamByCategory(type: "movie" | "show", categoryId: string): Promise<XtreamLibraryItem[]> {
  const items = type === "movie" ? await listVodLibraryItems() : await listSeriesLibraryItems();
  return items.filter((item) => item.categoryId === categoryId);
}

export function getSeriesDetail(seriesId: number): Promise<XtreamSeriesDetail> {
  return cached(`xtream:series-detail:${seriesId}`, config.cacheTtlSeconds, async () => {
    const payload = await xtreamFetch<unknown>("get_series_info", { series_id: String(seriesId) });
    return mapSeriesPayload(seriesId, payload);
  });
}

export async function getVodInfo(vodId: number): Promise<XtreamVodInfo> {
  const payload = await xtreamFetch<unknown>("get_vod_info", { vod_id: String(vodId) });
  return mapVodInfo(payload);
}

export async function listLiveCategories(): Promise<XtreamCategory[]> {
  return xtreamFetch<XtreamCategory[]>("get_live_categories");
}

export async function listLiveStreams(): Promise<XtreamLiveStream[]> {
  return xtreamFetch<XtreamLiveStream[]>("get_live_streams");
}

function decodeBase64Maybe(value: string): string {
  try {
    return Buffer.from(value, "base64").toString("utf-8");
  } catch {
    return value;
  }
}

export async function getShortEpg(streamId: number): Promise<XtreamEpgEntry[]> {
  const data = await xtreamFetch<{ epg_listings?: RawEpgEntry[] }>("get_short_epg", {
    stream_id: String(streamId),
  });
  const listings = data.epg_listings ?? [];
  return listings.map((entry) => ({
    id: entry.id,
    title: decodeBase64Maybe(entry.title),
    start: entry.start,
    end: entry.end,
    description: entry.description ? decodeBase64Maybe(entry.description) : undefined,
  }));
}

export function liveStreamUrl(streamId: number, extension = "m3u8"): string {
  const xtream = requireXtream();
  return `${xtream.baseUrl}/live/${xtream.username}/${xtream.password}/${streamId}.${extension}`;
}

export function vodStreamUrl(streamId: number, extension = "m3u8"): string {
  const xtream = requireXtream();
  const ext = extension.replace(/^\./, "") || "m3u8";
  return `${xtream.baseUrl}/movie/${xtream.username}/${xtream.password}/${streamId}.${ext}`;
}

export function seriesEpisodeStreamUrl(episodeId: number, extension = "m3u8"): string {
  const xtream = requireXtream();
  const ext = extension.replace(/^\./, "") || "m3u8";
  return `${xtream.baseUrl}/series/${xtream.username}/${xtream.password}/${episodeId}.${ext}`;
}

/**
 * Playback URL on the configured Xtream host.
 * mp4/webm are requested as that file. Everything else (mkv, avi, …) is requested as
 * `.m3u8` on the same host — panels that can remux will, and the HLS proxy allowlist
 * only has to allow the provider host (CDN edges are learned from the playlist).
 */
export function xtreamPlaybackTarget(kind: "vod" | "episode", id: number, extension: string): { url: string; hls: boolean } {
  const hls = playbackModeForExtension(extension) === "hls";
  const requestExtension = hls ? "m3u8" : extension;
  const url = kind === "vod" ? vodStreamUrl(id, requestExtension) : seriesEpisodeStreamUrl(id, requestExtension);
  return { url, hls };
}
