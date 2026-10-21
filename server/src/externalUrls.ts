const TRUSTED_HOSTS = new Set(["plex.tv", "www.plex.tv", "app.plex.tv", "trakt.tv", "www.trakt.tv"]);

export function isAppNavigation(raw: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "127.0.0.1" && host !== "localhost") return false;
  return Number(url.port) === port;
}

/** https pages the desktop window may hand to the OS browser. */
export function isTrustedExternal(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return TRUSTED_HOSTS.has(url.hostname.toLowerCase().replace(/\.$/, ""));
}

export function safeExternalUrl(raw: string | undefined, fallback: string): string {
  if (raw && isTrustedExternal(raw)) return raw;
  return fallback;
}
