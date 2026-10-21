import type { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { resolvePlexStreamUrl } from "../clients/plex.js";
import { resolveSiloStreamUrl } from "../clients/silo.js";
import { liveStreamUrl } from "../clients/xtream.js";
import { isAllowedStreamUrl, rememberStreamUrl } from "../streamAllowlist.js";

function isPlaylist(contentType: string, url: string): boolean {
  return /mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(url);
}

// Xtream/IPTV CDNs vary in whether they send CORS headers, so hls.js (which fetches
// the manifest and every segment via XHR, unlike a plain <video src>) can be blocked
// mid-stream by a provider that doesn't. Proxying everything through this same-origin
// endpoint sidesteps that entirely, and also keeps the upstream credentials/URL out of
// the browser. Playlists are rewritten so every segment/key/nested-playlist reference
// routes back through this proxy too.
function rewritePlaylist(body: string, baseUrl: string): string {
  // The post-redirect URL is the base for relative segment paths, and it is often
  // a different host than the panel the user configured. Remember it, plus every
  // host this playlist points at, so the following segment requests are allowed.
  rememberStreamUrl(baseUrl);
  const proxied = (raw: string): string => {
    const absolute = new URL(raw, baseUrl).toString();
    rememberStreamUrl(absolute);
    return `/api/hls?u=${encodeURIComponent(absolute)}`;
  };

  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/i, (_m, uri) => `URI="${proxied(uri)}"`);
      }
      return proxied(trimmed);
    })
    .join("\n");
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

async function fetchAllowedStream(
  targetUrl: string,
  range?: string,
): Promise<{ upstream: Response; finalUrl: string } | { error: "forbidden" | "unreachable" }> {
  if (!isAllowedStreamUrl(targetUrl)) return { error: "forbidden" };

  let current = targetUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let upstream: Response;
    try {
      upstream = await fetch(current, {
        redirect: "manual",
        headers: range ? { range } : undefined,
      });
    } catch (err) {
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
  const fetched = await fetchAllowedStream(targetUrl, range);
  if ("error" in fetched) {
    if (fetched.error === "forbidden") {
      return reply.code(403).send({ error: "Stream host is not allowed" });
    }
    return reply.code(502).send({ error: "Failed to reach stream" });
  }

  const { upstream, finalUrl } = fetched;
  if (!upstream.ok && upstream.status !== 206) {
    return reply.code(502).send({ error: "Failed to reach stream" });
  }

  const contentType = upstream.headers.get("content-type") ?? "";

  // The request URL counts as well as the post-redirect URL: panels often 302 a
  // .m3u8 onto a CDN path that has no extension and a generic content-type.
  if (isPlaylist(contentType, targetUrl) || isPlaylist(contentType, finalUrl)) {
    // Xtream panels 302/301 the given URL on to the real CDN edge server, so relative
    // segment paths in the playlist must resolve against the post-redirect URL,
    // not the original targetUrl - the origin domain often doesn't serve segments at all.
    const rewritten = rewritePlaylist(await upstream.text(), finalUrl);
    reply.header("content-type", "application/vnd.apple.mpegurl");
    reply.header("cache-control", "no-store");
    return reply.send(rewritten);
  }

  reply.header("content-type", contentType || "video/mp2t");
  const length = upstream.headers.get("content-length");
  if (length) reply.header("content-length", length);
  if (upstream.status === 206) {
    reply.code(206);
    reply.header("accept-ranges", "bytes");
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) reply.header("content-range", contentRange);
  }
  if (!upstream.body) return reply.send();
  return reply.send(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]));
}

export async function streamRoutes(app: FastifyInstance) {
  app.get("/api/hls", async (request, reply) => {
    const { u } = request.query as { u?: string };
    if (!u) return reply.code(400).send({ error: "Missing url" });
    const range = request.headers.range;
    return proxyHlsResource(u, reply, typeof range === "string" ? range : undefined);
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
      reply.raw.on("close", () => controller.abort());

      const upstream = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      if (!upstream.ok || !upstream.body) {
        return reply.code(502).send({ error: "Failed to reach Silo stream" });
      }
      reply.header("content-type", upstream.headers.get("content-type") ?? "video/mp4");
      const length = upstream.headers.get("content-length");
      if (length) reply.header("content-length", length);
      return reply.send(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]));
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
