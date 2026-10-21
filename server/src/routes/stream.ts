import type { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { plexImageUrl, resolvePlexStreamUrl } from "../clients/plex.js";
import { resolveSiloStreamUrl } from "../clients/silo.js";
import { liveStreamUrl } from "../clients/xtream.js";
import { rememberStreamUrl } from "../streamAllowlist.js";
import { issueStreamTicket, resolveStreamTicket } from "../streamTickets.js";
import {
  fetchProvider,
  fetchStream,
  isBlockedFetchError,
  maxPlaylistBytes,
  readTextLimited,
  sameHostRedirect,
} from "../upstream.js";
import { NotConfiguredError } from "../settingsStore.js";

function isPlaylist(contentType: string, url: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  // A live MPEG-TS is often served from the .m3u8 URL, or after a 302 to another
  // host. The playlist cap must not cut that body. A generic type still uses the
  // URL, because panels return real playlists as application/octet-stream.
  if (type.startsWith("video/") || type.startsWith("audio/")) return false;
  return type.includes("mpegurl") || /\.m3u8(\?|$)/i.test(url);
}

const SAFE_MEDIA_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/octet-stream",
  "video/mp2t",
  "video/mp4",
  "video/webm",
  "audio/mp4",
  "audio/aac",
  "audio/mpeg",
]);

function safeMediaType(contentType: string, playlist: boolean): string {
  if (playlist) return "application/vnd.apple.mpegurl";
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return SAFE_MEDIA_TYPES.has(base) ? base : "application/octet-stream";
}

function setDocumentHeaders(reply: FastifyReply, contentType: string): void {
  reply.header("content-type", contentType);
  reply.header("x-content-type-options", "nosniff");
  reply.header("content-security-policy", "default-src 'none'");
  reply.header("referrer-policy", "no-referrer");
  reply.header("cache-control", "no-store");
}

// Xtream/IPTV CDNs vary in whether they send CORS headers, so hls.js (which fetches
// the manifest and every segment via XHR, unlike a plain <video src>) can be blocked
// mid-stream by a provider that doesn't. Proxying everything through this same-origin
// endpoint sidesteps that entirely, and also keeps the upstream credentials/URL out of
// the browser. Playlists are rewritten so every segment/key/nested-playlist reference
// routes back through this proxy too. The browser receives an opaque ticket, not the
// upstream URL, so a password or Plex token in that URL never reaches the renderer.
function rewritePlaylist(body: string, baseUrl: string): string {
  rememberStreamUrl(baseUrl);
  const proxied = (raw: string): string | null => {
    let absolute: URL;
    try {
      absolute = new URL(raw, baseUrl);
    } catch {
      return null;
    }
    if (!rememberStreamUrl(absolute.toString())) return null;
    const ticket = issueStreamTicket(absolute.toString());
    if (!ticket) return null;
    return `/api/hls?t=${ticket}`;
  };

  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]*)"/gi, (_match, uri: string) => {
          const next = proxied(uri);
          return next ? `URI="${next}"` : `URI=""`;
        });
      }
      return proxied(trimmed) ?? `# blocked`;
    })
    .join("\n");
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

async function fetchAllowedStream(
  targetUrl: string,
  signal: AbortSignal,
  range?: string,
): Promise<{ upstream: Response; finalUrl: string } | { error: "forbidden" | "unreachable" }> {
  let current = targetUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let upstream: Response;
    try {
      upstream = await fetchStream(current, {
        signal,
        headers: range ? { range } : undefined,
      });
    } catch (err) {
      if (signal.aborted) return { error: "unreachable" };
      if (isBlockedFetchError(err)) return { error: "forbidden" };
      if (err instanceof TypeError) return { error: "unreachable" };
      throw err;
    }

    if (REDIRECT_STATUSES.has(upstream.status)) {
      const location = upstream.headers.get("location");
      await upstream.body?.cancel().catch(() => undefined);
      if (!location || hop === MAX_REDIRECTS) return { error: "unreachable" };
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { error: "unreachable" };
      }
      if (!rememberStreamUrl(next.toString())) return { error: "forbidden" };
      current = next.toString();
      continue;
    }

    return { upstream, finalUrl: current };
  }

  return { error: "unreachable" };
}

async function proxyHlsResource(targetUrl: string, reply: FastifyReply, range?: string) {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  reply.raw.on("close", onClose);

  try {
    const fetched = await fetchAllowedStream(targetUrl, controller.signal, range);
    if ("error" in fetched) {
      if (reply.sent || controller.signal.aborted) return;
      if (fetched.error === "forbidden") {
        return reply.code(403).send({ error: "Stream host is not allowed" });
      }
      return reply.code(502).send({ error: "Failed to reach stream" });
    }

    const { upstream, finalUrl } = fetched;
    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => undefined);
      if (reply.sent || controller.signal.aborted) return;
      return reply.code(502).send({ error: "Failed to reach stream" });
    }

    const contentType = upstream.headers.get("content-type") ?? "";

    // The request URL counts as well as the post-redirect URL: panels often 302 a
    // .m3u8 onto a CDN path that has no extension and a generic content-type.
    if (isPlaylist(contentType, targetUrl) || isPlaylist(contentType, finalUrl)) {
      // Xtream panels 302/301 the given URL on to the real CDN edge server, so relative
      // segment paths in the playlist must resolve against the post-redirect URL,
      // not the original targetUrl - the origin domain often doesn't serve segments at all.
      const rewritten = rewritePlaylist(await readTextLimited(upstream, maxPlaylistBytes()), finalUrl);
      if (reply.sent || controller.signal.aborted) return;
      setDocumentHeaders(reply, "application/vnd.apple.mpegurl");
      return reply.send(rewritten);
    }

    setDocumentHeaders(reply, safeMediaType(contentType, false));
    const length = upstream.headers.get("content-length");
    if (length && /^\d+$/.test(length)) reply.header("content-length", length);
    if (upstream.status === 206) {
      reply.code(206);
      reply.header("accept-ranges", "bytes");
      const contentRange = upstream.headers.get("content-range");
      if (contentRange && /^bytes \d+-\d+\/(\d+|\*)$/i.test(contentRange)) {
        reply.header("content-range", contentRange);
      }
    }
    if (!upstream.body) return reply.send();
    const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on("error", () => {
      upstream.body?.cancel().catch(() => undefined);
    });
    return reply.send(nodeStream);
  } catch (err) {
    if (controller.signal.aborted || reply.sent) return;
    if (err instanceof Error && err.message === "response too large") {
      return reply.code(502).send({ error: "Failed to reach stream" });
    }
    if (isBlockedFetchError(err)) {
      return reply.code(403).send({ error: "Stream host is not allowed" });
    }
    throw err;
  }
}

export async function streamRoutes(app: FastifyInstance) {
  app.get("/api/hls", async (request, reply) => {
    const { t } = request.query as { t?: string };
    if (!t) return reply.code(400).send({ error: "Missing url" });
    const target = resolveStreamTicket(t);
    if (!target) return reply.code(403).send({ error: "Stream host is not allowed" });
    const range = request.headers.range;
    return proxyHlsResource(target, reply, typeof range === "string" ? range : undefined);
  });

  app.get("/api/image/plex", async (request, reply) => {
    const { path: imagePath } = request.query as { path?: string };
    if (!imagePath || !imagePath.startsWith("/") || imagePath.startsWith("//") || imagePath.includes("\\")) {
      return reply.code(400).send({ error: "bad path" });
    }
    let target: string;
    try {
      target = plexImageUrl(imagePath);
    } catch (err) {
      if (err instanceof NotConfiguredError) throw err;
      return reply.code(403).send({ error: "Stream host is not allowed" });
    }
    const upstream = await fetchProvider(target, { headers: { Accept: "image/*,*/*" } });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel().catch(() => undefined);
      return reply.code(502).send({ error: "Failed to reach Plex" });
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    setDocumentHeaders(reply, base.startsWith("image/") ? base : "application/octet-stream");
    const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on("error", () => {
      upstream.body?.cancel().catch(() => undefined);
    });
    return reply.send(nodeStream);
  });

  app.get("/api/stream/:source/:id", async (request, reply) => {
    const { source, id } = request.params as { source: string; id: string };

    if (source === "silo") {
      // Unlike Plex/Xtream, Silo's stream endpoint requires an Authorization header
      // (not just a token embedded in the URL), which a 302 redirect can't hand off to
      // the browser - so we proxy the video through this server instead of redirecting.
      //
      // Every call to resolveSiloStreamUrl opens a brand new playback session with Silo
      // (a fresh playback_attempt_id) - and we never tell Silo when one is abandoned. The
      // browser's native seeking on a plain <video src> fires a new request here on every
      // seek, so without the two things below, rapid seeking piles up concurrent sessions
      // against whatever limit Silo enforces, which then rejects further attempts until
      // the old ones time out server-side (the "wait a bit and it works again" pattern).
      //
      // 1. accept-ranges: none tells the browser up front that this resource can't be
      //    range-requested, so it stops trying and just clamps seeking to what's already
      //    buffered (see Player.tsx's clampToSeekable) instead of firing a new request.
      // 2. Aborting the upstream Silo fetch when the client disconnects (seeks again,
      //    closes the player) stops us from holding a session open that nothing wants.
      reply.header("accept-ranges", "none");

      const { url, accessToken } = await resolveSiloStreamUrl(id);
      const controller = new AbortController();
      const onClose = () => controller.abort();
      reply.raw.on("close", onClose);

      try {
        let current = url;
        let upstream: Response | null = null;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          upstream = await fetchStream(current, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: controller.signal,
          });
          if (!REDIRECT_STATUSES.has(upstream.status)) break;
          const location = upstream.headers.get("location");
          await upstream.body?.cancel().catch(() => undefined);
          const next = location ? sameHostRedirect(current, location) : null;
          if (!next || hop === MAX_REDIRECTS) {
            return reply.code(502).send({ error: "Failed to reach Silo stream" });
          }
          current = next;
          upstream = null;
        }
        if (!upstream || !upstream.ok || !upstream.body) {
          await upstream?.body?.cancel().catch(() => undefined);
          if (reply.sent || controller.signal.aborted) return;
          return reply.code(502).send({ error: "Failed to reach Silo stream" });
        }
        setDocumentHeaders(reply, safeMediaType(upstream.headers.get("content-type") ?? "", false));
        const length = upstream.headers.get("content-length");
        if (length && /^\d+$/.test(length)) reply.header("content-length", length);
        const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
        nodeStream.on("error", () => {
          upstream?.body?.cancel().catch(() => undefined);
        });
        return reply.send(nodeStream);
      } catch (err) {
        if (controller.signal.aborted || reply.sent) return;
        if (isBlockedFetchError(err)) return reply.code(403).send({ error: "Stream host is not allowed" });
        throw err;
      }
    }

    if (source === "live") {
      // See the comment on proxyHlsResource: live TV is HLS, played via hls.js, which
      // needs CORS on every request - so it's proxied rather than redirected.
      const range = request.headers.range;
      return proxyHlsResource(liveStreamUrl(Number(id)), reply, typeof range === "string" ? range : undefined);
    }

    if (source === "plex") {
      // Proxy instead of redirecting. A 302 would hand the renderer (and anyone
      // who can call this API) a URL that contains X-Plex-Token.
      const range = request.headers.range;
      return proxyHlsResource(
        await resolvePlexStreamUrl(id),
        reply,
        typeof range === "string" ? range : undefined,
      );
    }

    return reply.code(400).send({ error: `Unknown source: ${source}` });
  });
}
