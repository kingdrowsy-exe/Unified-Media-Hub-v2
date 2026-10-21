const SENSITIVE_QUERY = new Set([
  "u",
  "password",
  "token",
  "x-plex-token",
  "access_token",
  "refresh_token",
  "client_secret",
]);

// Xtream puts the password in the path: /live/<user>/<password>/<id>.m3u8
const CREDENTIAL_PATH = /(\/(?:live|movie|series|timeshift)\/)([^/]+)\/([^/]+)/gi;

function redactPath(path: string): string {
  return path.replace(CREDENTIAL_PATH, "$1$2/[redacted]");
}

/** Strip credentials from a URL before it is written to a log line. */
export function redactUrl(raw: string): string {
  const hashAt = raw.indexOf("#");
  const withoutHash = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const queryAt = withoutHash.indexOf("?");
  const path = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : withoutHash.slice(queryAt + 1);
  const safePath = redactPath(path);
  if (!query) return safePath;

  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY.has(key.toLowerCase())) params.set(key, "[redacted]");
  }
  return `${safePath}?${params.toString()}`;
}
