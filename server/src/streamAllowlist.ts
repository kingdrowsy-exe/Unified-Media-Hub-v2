import { settingsStore } from "./settingsStore.js";

/**
 * Hosts the HLS proxy is willing to fetch.
 *
 * Configured Plex / Silo / Xtream hosts are always allowed, on the port the
 * user saved (80 and 443 count as the same site). Playlist URLs and redirects
 * may add other public hosts, on the port the playlist actually used.
 *
 * Loopback, link-local, private, and metadata targets are not learned from a
 * playlist. A provider the user typed in is still allowed, including a LAN
 * address, but that does not open the rest of the network.
 */
const learnedKeys = new Set<string>();
const MAX_LEARNED = 2048;
const clearListeners = new Set<() => void>();

function bareHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  return host;
}

function ipv4Parts(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return null;
  return parts;
}

type AddressKind = "public" | "private" | "loopback" | "linklocal" | "blocked" | "name";

function ipv4Kind(parts: number[]): AddressKind {
  const [a, b] = parts;
  const value = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  if (a === 0 || a === 127) return a === 127 ? "loopback" : "blocked";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "linklocal";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 192 && b === 0 && parts[2] === 0) return "blocked";
  if (a === 192 && b === 0 && parts[2] === 2) return "blocked";
  if (a === 198 && (b === 18 || b === 19)) return "blocked";
  if (a === 198 && b === 51 && parts[2] === 100) return "blocked";
  if (a === 203 && b === 0 && parts[2] === 113) return "blocked";
  if (value >= 0xe0000000) return "blocked";
  return "public";
}

function ipv4FromMapped(host: string): number[] | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (dotted) return ipv4Parts(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

export function addressKind(hostname: string): AddressKind {
  const host = bareHostname(hostname);
  if (!host) return "blocked";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "name";
  }
  if (host === "metadata.google.internal") return "name";
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return "loopback";
  if (host === "::" || host === "0:0:0:0:0:0:0:0") return "blocked";
  const v4 = ipv4Parts(host);
  if (v4) return ipv4Kind(v4);
  const mapped = ipv4FromMapped(host);
  if (mapped) return ipv4Kind(mapped);
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return "linklocal";
  if (/^fe[cdef][0-9a-f]:/i.test(host)) return "blocked";
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return "private";
  if (/^ff[0-9a-f]{2}:/i.test(host)) return "blocked";
  if (/^2001:0?db8:/i.test(host)) return "blocked";
  if (host.includes(":")) return "public";
  return "name";
}

/** Loopback, private, link-local, documentation, and internal names. */
export function isSensitiveHostname(hostname: string): boolean {
  return addressKind(hostname) !== "public" && addressKind(hostname) !== "name";
}

function isBlockedName(hostname: string): boolean {
  const host = bareHostname(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  );
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

function portOf(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function endpointKey(raw: string): string | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  const host = bareHostname(url.hostname);
  if (!host) return null;
  const kind = isSensitiveHostname(host) || isBlockedName(host) ? "sensitive" : "host";
  return `${kind}|${host}|${portOf(url)}`;
}

function keyMatches(key: string, keys: Set<string>): boolean {
  if (keys.has(key)) return true;
  const [kind, host, port] = key.split("|");
  if (kind !== "host" || !host || !port) return false;
  if (port !== "80" && port !== "443") return false;
  const other = port === "80" ? "443" : "80";
  return keys.has(`host|${host}|${other}`);
}

function configuredBases(): string[] {
  return [
    settingsStore.getPlex()?.baseUrl,
    settingsStore.getSilo()?.baseUrl,
    settingsStore.getXtream()?.baseUrl,
  ].filter((base): base is string => Boolean(base));
}

function configuredProviderKeys(): Set<string> {
  const keys = new Set<string>();
  for (const base of configuredBases()) {
    const key = endpointKey(base);
    if (key) keys.add(key);
  }
  return keys;
}

export function isConfiguredHostname(hostname: string): boolean {
  const host = bareHostname(hostname);
  return configuredBases().some((base) => {
    const url = parseHttpUrl(base);
    return url !== null && bareHostname(url.hostname) === host;
  });
}

/**
 * A resolved address is usable for a stream fetch when it is publicly routable,
 * or when it is the network the user actually configured and it is not
 * link-local metadata space. A learned CDN name that resolves at a LAN or
 * loopback address is a rebinding attack and is refused.
 */
export function resolvedAddressAllowed(hostname: string, address: string): boolean {
  const kind = addressKind(address);
  if (kind === "public") return true;
  if (!isConfiguredHostname(hostname)) return false;
  if (kind === "linklocal" || kind === "blocked") return bareHostname(hostname) === bareHostname(address);
  if (kind === "loopback") {
    const configured = bareHostname(hostname);
    return configured === "localhost" || configured.endsWith(".localhost") || addressKind(configured) === "loopback";
  }
  return kind === "private";
}

export function onLearnedHostsCleared(listener: () => void): void {
  clearListeners.add(listener);
}

export function clearLearnedStreamHosts(): void {
  learnedKeys.clear();
  for (const listener of clearListeners) listener();
}

export function isAllowedStreamUrl(raw: string): boolean {
  const key = endpointKey(raw);
  if (!key) return false;
  if (keyMatches(key, configuredProviderKeys())) return true;
  return keyMatches(key, learnedKeys);
}

/**
 * Remember a host referenced by an allowed playlist or redirect.
 * Returns false for non-http(s) URLs and for sensitive hosts the user did
 * not configure (those must not become a general relay).
 */
export function rememberStreamUrl(raw: string): boolean {
  const key = endpointKey(raw);
  if (!key) return false;
  if (key.startsWith("sensitive|") && !keyMatches(key, configuredProviderKeys())) return false;
  if (learnedKeys.has(key) || keyMatches(key, configuredProviderKeys())) return true;
  if (learnedKeys.size >= MAX_LEARNED) return false;
  learnedKeys.add(key);
  return true;
}

/** Plex's resource list is allowed to point at the user's LAN server, not at link-local metadata. */
export function isSafePlexProbe(raw: string): boolean {
  const url = parseHttpUrl(raw);
  if (!url || url.username || url.password) return false;
  const host = bareHostname(url.hostname);
  if (host === "metadata.google.internal" || host.endsWith(".google.internal") || host.endsWith(".internal")) {
    return false;
  }
  const kind = addressKind(host);
  return kind !== "linklocal" && kind !== "blocked";
}
