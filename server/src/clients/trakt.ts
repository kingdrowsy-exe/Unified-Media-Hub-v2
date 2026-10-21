import { NotConfiguredError, settingsStore } from "../settingsStore.js";
import { fetchProvider, readJsonLimited } from "../upstream.js";

const API_BASE = "https://api.trakt.tv";

function requireTrakt() {
  const trakt = settingsStore.getTrakt();
  if (!trakt) {
    throw new NotConfiguredError("trakt");
  }
  return trakt;
}

function requireTraktAuth() {
  const trakt = requireTrakt();
  if (!trakt.accessToken) {
    throw new NotConfiguredError("trakt");
  }
  return trakt;
}

function baseHeaders(clientId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
  };
}

// Public endpoints (ratings, comments, id lookups) only need the client id, never a user
// token - safe to call any time Trakt is connected, whether or not the account is linked.
async function traktFetch<T>(path: string): Promise<T> {
  const trakt = requireTrakt();
  const res = await fetchProvider(`${API_BASE}${path}`, { headers: baseHeaders(trakt.clientId) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Trakt request failed: ${res.status} ${path}`);
  }
  return readJsonLimited<T>(res);
}

async function refreshAccessToken(): Promise<void> {
  const trakt = requireTraktAuth();
  if (!trakt.refreshToken) {
    throw new Error("Trakt session expired - reconnect your account");
  }
  const res = await fetchProvider(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refresh_token: trakt.refreshToken,
      client_id: trakt.clientId,
      client_secret: trakt.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("Trakt session expired - reconnect your account");
  }
  const data = await readJsonLimited<{ access_token: string; refresh_token: string; expires_in: number }>(res);
  settingsStore.updateTrakt({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
}

// User-scoped endpoints (watchlist, recommendations) require the OAuth device-flow token.
// Refreshes once and retries on a 401 rather than failing the whole request.
async function traktAuthFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let trakt = requireTraktAuth();
  const doFetch = () =>
    fetchProvider(`${API_BASE}${path}`, {
      ...init,
      headers: { ...baseHeaders(trakt.clientId), Authorization: `Bearer ${trakt.accessToken}`, ...init.headers },
    });

  let res = await doFetch();
  if (res.status === 401) {
    await res.body?.cancel().catch(() => undefined);
    await refreshAccessToken();
    trakt = requireTraktAuth();
    res = await doFetch();
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Trakt request failed: ${res.status} ${path}`);
  }
  if (res.status === 204) {
    await res.body?.cancel().catch(() => undefined);
    return undefined as T;
  }
  return readJsonLimited<T>(res);
}

export interface TraktDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export async function createDeviceCode(clientId: string): Promise<TraktDeviceCode> {
  const res = await fetchProvider(`${API_BASE}/oauth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("Couldn't start Trakt device authorization. Check your Client ID.");
  }
  const data = await readJsonLimited<{
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
  }>(res);
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_url,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

// Returns null while the user hasn't approved yet (Trakt's pending state) rather than
// throwing, so callers can keep polling without treating "not yet" as an error.
export async function pollDeviceToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> {
  const res = await fetchProvider(`${API_BASE}/oauth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: deviceCode, client_id: clientId, client_secret: clientSecret }),
  });
  if (res.status === 400) {
    await res.body?.cancel().catch(() => undefined);
    return null; // authorization pending
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Trakt authorization failed (${res.status}). Start over.`);
  }
  const data = await readJsonLimited<{ access_token: string; refresh_token: string; expires_in: number }>(res);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function verifyAccountLink(): Promise<void> {
  await traktAuthFetch<unknown>("/users/settings");
}

export async function validateClientId(clientId: string): Promise<void> {
  const res = await fetchProvider(`${API_BASE}/movies/trending?limit=1`, { headers: baseHeaders(clientId) });
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) {
    throw new Error("Trakt login failed. Check your Client ID.");
  }
}

interface TraktIds {
  trakt: number;
  slug: string;
  tmdb?: number;
  imdb?: string;
}

interface TraktMovieOrShow {
  title: string;
  year?: number;
  ids: TraktIds;
}

export interface TraktRatingInfo {
  rating: number;
  votes: number;
}

export interface TraktComment {
  id: number;
  comment: string;
  spoiler: boolean;
  review: boolean;
  createdAt: string;
  likes: number;
  username: string;
}

async function lookupTraktId(tmdbId: number, type: "movie" | "show"): Promise<number | null> {
  const results = await traktFetch<{ movie?: TraktMovieOrShow; show?: TraktMovieOrShow }[]>(
    `/search/tmdb/${tmdbId}?type=${type}`,
  );
  const match = results[0]?.[type];
  return match?.ids.trakt ?? null;
}

export async function getRatingAndComments(
  tmdbId: number,
  type: "movie" | "show",
): Promise<{ rating: TraktRatingInfo | null; comments: TraktComment[] }> {
  const traktId = await lookupTraktId(tmdbId, type);
  if (!traktId) return { rating: null, comments: [] };

  const kind = type === "movie" ? "movies" : "shows";
  const [ratingData, commentsData] = await Promise.all([
    traktFetch<{ rating: number; votes: number }>(`/${kind}/${traktId}/ratings`),
    traktFetch<
      { id: number; comment: string; spoiler: boolean; review: boolean; created_at: string; likes: number; user: { username: string } }[]
    >(`/${kind}/${traktId}/comments/likes?limit=6`),
  ]);

  return {
    rating: { rating: ratingData.rating, votes: ratingData.votes },
    comments: commentsData.slice(0, 5).map((c) => ({
      id: c.id,
      comment: c.comment,
      spoiler: c.spoiler,
      review: c.review,
      createdAt: c.created_at,
      likes: c.likes,
      username: c.user.username,
    })),
  };
}

export interface TraktListItem {
  tmdbId: number;
  title: string;
  year?: number;
  type: "movie" | "show";
}

function toListItem(entry: TraktMovieOrShow, type: "movie" | "show"): TraktListItem | null {
  if (!entry.ids.tmdb) return null;
  return { tmdbId: entry.ids.tmdb, title: entry.title, year: entry.year, type };
}

export async function getWatchlist(): Promise<TraktListItem[]> {
  const [movies, shows] = await Promise.all([
    traktAuthFetch<{ movie: TraktMovieOrShow }[]>("/sync/watchlist/movies"),
    traktAuthFetch<{ show: TraktMovieOrShow }[]>("/sync/watchlist/shows"),
  ]);
  const items = [
    ...movies.map((m) => toListItem(m.movie, "movie")),
    ...shows.map((s) => toListItem(s.show, "show")),
  ];
  return items.filter((i): i is TraktListItem => i !== null);
}

export async function getRecommendations(): Promise<TraktListItem[]> {
  const [movies, shows] = await Promise.all([
    traktAuthFetch<TraktMovieOrShow[]>("/recommendations/movies?limit=15"),
    traktAuthFetch<TraktMovieOrShow[]>("/recommendations/shows?limit=15"),
  ]);
  const items = [
    ...movies.map((m) => toListItem(m, "movie")),
    ...shows.map((s) => toListItem(s, "show")),
  ];
  return items.filter((i): i is TraktListItem => i !== null);
}
