import { settingsStore } from "./settingsStore.js";

/**
 * Hosts the HLS proxy is willing to fetch.
 *
 * Configured Plex / Silo / Xtream hosts are always allowed. Playlist fetches
 * and redirects that start from an allowed URL add the hosts they legitimately
 * point at (CDN edges, key servers, nested playlists), which is what live TV
 * needs — Xtream almost never serves segments from the panel host itself.
 *
 * Loopback and link-local addresses are keyed with their port and are not
 * learned from playlists, so a hostile playlist cannot turn the proxy into a
 * relay onto the machine running the app. A provider the user actually
 * configured on loopback is still allowed, on that port only.
 */
const learnedKeys = new Set<string>();

function bareHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

function ipv4Parts(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return null;
  return parts;
}

function isSensitiveIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** Loopback, link-local, and cloud-metadata addresses. */
export function isSensitiveHostname(hostname: string): boolean {
  const host = bareHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host === "::" || host === "0:0:0:0:0:0:0:0") return true;
  const v4 = ipv4Parts(host);
  if (v4) return isSensitiveIpv4(v4);
  // IPv6 link-local fe80::/10.
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mapped) {
    const hi = Number.parseInt(mapped[1], 16);
    const lo = Number.parseInt(mapped[2], 16);
    return isSensitiveIpv4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255]);
  }
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (mappedDotted) {
    const parts = ipv4Parts(mappedDotted[1]);
    return parts ? isSensitiveIpv4(parts) : true;
  }
  return false;
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function endpointKey(raw: string): string | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  const host = bareHostname(url.hostname);
  if (!host) return null;
  if (isSensitiveHostname(host)) {
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `sensitive|${host}|${port}`;
  }
  return `host|${host}`;
}

function configuredProviderKeys(): Set<string> {
  const keys = new Set<string>();
  for (const base of [
    settingsStore.getPlex()?.baseUrl,
    settingsStore.getSilo()?.baseUrl,
    settingsStore.getXtream()?.baseUrl,
  ]) {
    if (!base) continue;
    const key = endpointKey(base);
    if (key) keys.add(key);
  }
  return keys;
}

export function clearLearnedStreamHosts(): void {
  learnedKeys.clear();
}

export function isAllowedStreamUrl(raw: string): boolean {
  const key = endpointKey(raw);
  if (!key) return false;
  if (configuredProviderKeys().has(key)) return true;
  return learnedKeys.has(key);
}

/**
 * Remember a host referenced by an allowed playlist or redirect.
 * Returns false for non-http(s) URLs and for sensitive hosts the user did
 * not configure (those must not become a general relay).
 */
export function rememberStreamUrl(raw: string): boolean {
  const key = endpointKey(raw);
  if (!key) return false;
  if (key.startsWith("sensitive|") && !configuredProviderKeys().has(key)) return false;
  learnedKeys.add(key);
  return true;
}
