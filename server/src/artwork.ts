import { isConfiguredHostname, isSensitiveHostname } from "./streamAllowlist.js";

/** Provider images are loaded by the renderer. Keep ordinary http(s) URLs; drop scripts and LAN targets. */
export function sanitizeArtworkUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  const sensitive =
    isSensitiveHostname(url.hostname) ||
    url.hostname.toLowerCase() === "localhost" ||
    url.hostname.toLowerCase().endsWith(".localhost") ||
    url.hostname.toLowerCase().endsWith(".local") ||
    url.hostname.toLowerCase().endsWith(".internal");
  if (sensitive && !isConfiguredHostname(url.hostname)) return undefined;
  return url.toString();
}
