const SENSITIVE_QUERY = /([?&#](?:u|password|token|x-plex-token|access_token|refresh_token|client_secret)=)[^&#\s]*/gi;

// Xtream puts the password in the path: /live/<user>/<password>/<id>.m3u8
const CREDENTIAL_PATH = /(\/(?:live|movie|series|timeshift)\/)([^/]+)\/([^/]+)/gi;
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;

function redactPath(path: string): string {
  return path.replace(CREDENTIAL_PATH, "$1$2/[redacted]");
}

/** Strip credentials from a URL before it is written to a log line. */
export function redactUrl(raw: string): string {
  const withoutUserinfo = raw.replace(USERINFO, "$1$2:[redacted]@");
  const hashAt = withoutUserinfo.indexOf("#");
  const withoutHash = hashAt === -1 ? withoutUserinfo : withoutUserinfo.slice(0, hashAt);
  const queryAt = withoutHash.indexOf("?");
  const path = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : withoutHash.slice(queryAt + 1);
  const safePath = redactPath(path);
  if (!query) return safePath;

  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) {
    if (/^(u|password|token|x-plex-token|access_token|refresh_token|client_secret)$/i.test(key)) {
      params.set(key, "[redacted]");
    }
  }
  return `${safePath}?${params.toString()}`;
}

/** Redact credentials inside a stack trace or other free text. */
export function redactText(value: string): string {
  return value.replace(USERINFO, "$1$2:[redacted]@").replace(CREDENTIAL_PATH, "$1$2/[redacted]").replace(SENSITIVE_QUERY, "$1[redacted]");
}
