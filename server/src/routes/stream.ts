import type { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { resolvePlexStreamUrl } from "../clients/plex.js";
import { resolveSiloStreamUrl } from "../clients/silo.js";
import { liveStreamUrl, parseXtreamPlaybackId, xtreamPlaybackTarget } from "../clients/xtream.js";

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
  const proxied = (raw: string): string => {
    const absolute = new URL(raw, baseUrl).toString();
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

async function proxyHlsResource(targetUrl: string, reply: FastifyReply, range?: string) {
  const upstream = await fetch(targetUrl, range ? { headers: { range } } : undefined);
  if (!upstream.ok && upstream.status !== 206) {
    return reply.code(502).send({ error: "Failed to reach stream" });
  }

  const contentType = upstream.headers.get("content-type") ?? "";

  if (isPlaylist(contentType, targetUrl)) {
    // Xtream panels 302/301 the given URL on to the real CDN edge server, so relative
    // segment paths in the playlist must resolve against upstream.url (post-redirect),
    // not the original targetUrl - the origin domain often doesn't serve segments at all.
    // upstream.url is the post-redirect URL when the runtime records one. Fall back to
    // the URL we requested so a relative segment still resolves on the provider host.
    const rewritten = rewritePlaylist(await upstream.text(), upstream.url || targetUrl);
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

function fileContentType(extension: string | undefined, upstream: string): string {
  if (upstream && !/octet-stream|binary|text\/plain/i.test(upstream)) return upstream;
  if (extension === "mp4" || extension === "m4v") return "video/mp4";
  if (extension === "webm") return "video/webm";
  if (extension === "mov") return "video/quicktime";
  return upstream || "application/octet-stream";
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Progressive VOD (mp4/webm) is proxied the same way Silo is: credentials stay on the
// server, and Range is forwarded so the browser can seek. The URL itself is always on
// the configured Xtream host, which is what a provider-host HLS allowlist accepts.
async function proxyFileResource(targetUrl: string, reply: FastifyReply, range: string | undefined, extension?: string) {
  const upstream = await fetch(targetUrl, range ? { headers: { range } } : undefined);
  if (!upstream.ok && upstream.status !== 206) {
    return reply.code(502).send({ error: "Failed to reach stream" });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (isPlaylist(contentType, targetUrl) || isPlaylist(contentType, upstream.url)) {
    const rewritten = rewritePlaylist(await upstream.text(), upstream.url || targetUrl);
    reply.header("content-type", "application/vnd.apple.mpegurl");
    reply.header("cache-control", "no-store");
    return reply.send(rewritten);
  }

  reply.header("content-type", fileContentType(extension, contentType));
  reply.header("accept-ranges", "bytes");
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
    return proxyHlsResource(u, reply, request.headers.range as string | undefined);
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
      return proxyHlsResource(liveStreamUrl(Number(id)), reply, request.headers.range as string | undefined);
    }

    if (source === "xtream") {
      const parsed = parseXtreamPlaybackId(id);
      if (!parsed) return reply.code(400).send({ error: "Invalid Xtream stream id" });
      const target = xtreamPlaybackTarget(parsed.kind, parsed.id, parsed.extension);
      const range = singleHeader(request.headers.range);
      // m3u8 (and mkv/avi requested as m3u8) goes through the same playlist rewriter as
      // live TV, so segment URLs stay on the provider host or a host the playlist names.
      if (target.hls) return proxyHlsResource(target.url, reply, range);
      return proxyFileResource(target.url, reply, range, parsed.extension);
    }

    if (source === "plex") {
      const url = await resolvePlexStreamUrl(id);
      return reply.code(302).redirect(url);
    }

    return reply.code(400).send({ error: `Unknown source: ${source}` });
  });
}
