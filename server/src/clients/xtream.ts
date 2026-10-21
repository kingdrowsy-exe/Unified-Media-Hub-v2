import { NotConfiguredError, settingsStore } from "../settingsStore.js";
import { fetchProvider, readJsonLimited } from "../upstream.js";

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
  const res = await fetchProvider(apiUrl(action, extra));
  if (!res.ok) {
    throw new Error(`Xtream request failed: ${res.status} action=${action}`);
  }
  return readJsonLimited<T>(res);
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
