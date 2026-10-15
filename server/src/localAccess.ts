import { config } from "./config.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Vite defaults to 5173 and walks forward when that port is already taken.
// The dev UI is served by Vite and proxies /api here, forwarding the browser's
// Origin, so those ports have to stay allowed or `npm run dev` cannot save
// settings or load the library.
const VITE_DEV_PORTS = new Set(["5173", "5174", "5175", "5176", "5177", "5178", "5179", "5180"]);

function bareHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(bareHostname(hostname));
}

/** True when the Host header is a loopback name. Rejects DNS-rebinding names. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  let hostname: string;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return false;
    hostname = host.slice(1, end);
  } else {
    hostname = host.replace(/:\d+$/, "");
  }
  return isLoopbackHostname(hostname);
}

/**
 * Origins the desktop window and the Vite dev server actually use.
 * Any other origin (a website open in the browser, a LAN page) is refused.
 */
export function isAppOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!isLoopbackHostname(url.hostname)) return false;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port === String(config.port)) return true;
  return VITE_DEV_PORTS.has(port);
}
