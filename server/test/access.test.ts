import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "umh-access-"));
const port = await freePort();
process.env.DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.LOG_LEVEL = "silent";

const { startServer } = await import("../src/index.js");
const { settingsStore } = await import("../src/settingsStore.js");
const { clearLearnedStreamHosts, isAllowedStreamUrl, rememberStreamUrl } = await import(
  "../src/streamAllowlist.js"
);
const { isAppOrigin, isLoopbackHostHeader } = await import("../src/localAccess.js");

function lanIps(): string[] {
  const ips: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      ips.push(entry.address);
    }
  }
  return ips;
}

function expectRefused(ip: string, targetPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: ip, port: targetPort });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${ip}:${targetPort} (socket may be open on all interfaces)`));
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`connected to ${ip}:${targetPort}`));
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ECONNREFUSED") resolve();
      else reject(err);
    });
  });
}

function proxiedUrls(playlist: string): string[] {
  return [...playlist.matchAll(/\/api\/hls\?u=([^"\s]+)/g)].map((match) => decodeURIComponent(match[1]));
}

function listen(host: string, handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

test("api is local to the app", async (t) => {
  let app: FastifyInstance;
  let providerBase = "";
  let cdnBase = "";
  let secretHits = 0;
  let secretPort = 0;
  const closers: Array<() => void | Promise<void>> = [];

  t.before(async () => {
    const secret = await listen("127.0.0.1", (_req, res) => {
      secretHits += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("secret-body");
    });
    secretPort = secret.port;
    closers.push(() => secret.server.close());

    const lan = lanIps()[0];
    if (lan) {
      const cdn = await listen(lan, (req, res) => {
        if ((req.url ?? "").startsWith("/seg.ts")) {
          res.writeHead(200, { "content-type": "video/mp2t" });
          res.end("cdn-segment");
          return;
        }
        res.writeHead(404);
        res.end();
      });
      cdnBase = `http://${lan}:${cdn.port}`;
      closers.push(() => cdn.server.close());
    }

    const provider = await listen("127.0.0.2", (req, res) => {
      const pathname = req.url?.split("?")[0] ?? "/";
      if (pathname.startsWith("/live/") && pathname.endsWith(".m3u8")) {
        const location = pathname.includes("/2.m3u8") ? "/real/plain" : "/real/index.m3u8";
        res.writeHead(302, { location });
        res.end();
        return;
      }
      if (pathname === "/bounce-local") {
        res.writeHead(302, { location: `http://127.0.0.1:${secretPort}/owned` });
        res.end();
        return;
      }
      if (pathname === "/real/index.m3u8") {
        const lines = [
          "#EXTM3U",
          '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
          "#EXTINF:4.0,",
          "seg.ts",
          "#EXTINF:4.0,",
          "http://cdn.invalid/cdn/other.ts",
          "#EXTINF:4.0,",
          `http://127.0.0.1:${secretPort}/local-secret.ts`,
        ];
        if (cdnBase) {
          lines.push("#EXTINF:4.0,", `${cdnBase}/seg.ts`);
        }
        res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
        res.end(lines.join("\n"));
        return;
      }
      // Redirect target has no playlist extension and a generic type. The original
      // .m3u8 URL is what tells the proxy to rewrite it.
      if (pathname === "/real/plain") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end("#EXTM3U\nplain-seg.ts\n");
        return;
      }
      if (pathname === "/real/plain-seg.ts") {
        res.writeHead(200, { "content-type": "video/mp2t" });
        res.end("plain-segment");
        return;
      }
      if (pathname === "/real/seg.ts") {
        if (req.headers.range) {
          res.writeHead(206, {
            "content-type": "video/mp2t",
            "content-range": "bytes 0-3/13",
            "content-length": "4",
          });
          res.end("segm");
          return;
        }
        res.writeHead(200, { "content-type": "video/mp2t", "content-length": "13" });
        res.end("segment-bytes");
        return;
      }
      if (pathname === "/real/key.bin") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end("key-bytes");
        return;
      }
      res.writeHead(404);
      res.end("missing");
    });
    providerBase = `http://127.0.0.2:${provider.port}`;
    closers.push(() => provider.server.close());

    settingsStore.setXtream({ baseUrl: providerBase, username: "user", password: "pass" });
    clearLearnedStreamHosts();

    app = await startServer();
    closers.push(() => app.close());
  });

  t.after(async () => {
    for (const close of closers.reverse()) await close();
  });

  const base = `http://127.0.0.1:${port}`;

  await t.test("allows the app and Vite origins only", () => {
    assert.equal(isAppOrigin(`http://127.0.0.1:${port}`), true);
    assert.equal(isAppOrigin(`http://localhost:${port}`), true);
    assert.equal(isAppOrigin("http://localhost:5173"), true);
    assert.equal(isAppOrigin("http://127.0.0.1:5174"), true);
    assert.equal(isAppOrigin("http://[::1]:5173"), true);
    assert.equal(isAppOrigin("https://evil.example"), false);
    assert.equal(isAppOrigin(`http://192.168.1.20:${port}`), false);
    assert.equal(isAppOrigin("null"), false);
    assert.equal(isAppOrigin(`http://127.0.0.1:${port + 1}`), false);
    assert.equal(isLoopbackHostHeader(`127.0.0.1:${port}`), true);
    assert.equal(isLoopbackHostHeader("localhost"), true);
    assert.equal(isLoopbackHostHeader("[::1]:4000"), true);
    assert.equal(isLoopbackHostHeader("evil.example"), false);
  });

  await t.test("allows configured provider hosts and playlist hosts, not loopback relays", () => {
    clearLearnedStreamHosts();
    assert.equal(isAllowedStreamUrl(`${providerBase}/live/user/pass/1.m3u8`), true);
    assert.equal(isAllowedStreamUrl("http://127.0.0.2:1/other-port"), false);
    assert.equal(isAllowedStreamUrl("http://cdn.invalid/seg.ts"), false);
    assert.equal(isAllowedStreamUrl("http://2130706433/secret"), false);
    assert.equal(isAllowedStreamUrl("http://127.0.0.1/secret"), false);
    assert.equal(isAllowedStreamUrl("file:///etc/passwd"), false);

    assert.equal(rememberStreamUrl("http://cdn.invalid/seg.ts"), true);
    assert.equal(isAllowedStreamUrl("http://cdn.invalid:9999/other-path"), true);
    assert.equal(rememberStreamUrl(`http://127.0.0.1:${secretPort}/owned`), false);
    assert.equal(isAllowedStreamUrl(`http://127.0.0.1:${secretPort}/owned`), false);

    clearLearnedStreamHosts();
    assert.equal(isAllowedStreamUrl("http://cdn.invalid/seg.ts"), false);
    assert.equal(isAllowedStreamUrl(`${providerBase}/live/user/pass/1.m3u8`), true);
  });

  await t.test("listens on 127.0.0.1 only", async () => {
    const address = app.server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    assert.equal((address as AddressInfo).address, "127.0.0.1");
    assert.equal((address as AddressInfo).port, port);
    for (const ip of lanIps()) {
      await expectRefused(ip, port);
    }
  });

  await t.test("refuses a foreign origin and a foreign Host", async () => {
    const foreign = await fetch(`${base}/api/settings/status`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).error, "forbidden_origin");
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);

    const posted = await fetch(`${base}/api/settings/xtream`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://evil.example", username: "a", password: "b" }),
    });
    assert.equal(posted.status, 403);
    assert.equal(settingsStore.status().xtream, true);
    assert.equal(settingsStore.getXtream()?.baseUrl, providerBase);

    const host = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/settings/status", headers: { Host: "evil.example" } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(host.status, 403);
    assert.match(host.body, /forbidden/);
  });

  await t.test("serves the app origin and the Vite dev origin", async () => {
    const appOrigin = await fetch(`${base}/api/settings/status`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(appOrigin.status, 200);
    assert.equal(appOrigin.headers.get("access-control-allow-origin"), `http://127.0.0.1:${port}`);
    assert.equal((await appOrigin.json()).xtream, true);

    const vite = await fetch(`${base}/api/settings/status`, {
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(vite.status, 200);
    assert.equal(vite.headers.get("access-control-allow-origin"), "http://localhost:5173");

    const sameOrigin = await fetch(`${base}/api/settings/status`);
    assert.equal(sameOrigin.status, 200);

    const reached = await fetch(`${base}/api/settings/xtream`, {
      method: "POST",
      headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(reached.status, 400);
  });

  await t.test("proxies a provider playlist, its redirect, and learned segment hosts", async () => {
    clearLearnedStreamHosts();
    secretHits = 0;

    const blocked = await fetch(`${base}/api/hls?u=${encodeURIComponent("http://cdn.invalid/seg.ts")}`);
    assert.equal(blocked.status, 403);
    if (cdnBase) {
      const earlyCdn = await fetch(`${base}/api/hls?u=${encodeURIComponent(`${cdnBase}/seg.ts`)}`);
      assert.equal(earlyCdn.status, 403);
    }

    const playlistRes = await fetch(`${base}/api/stream/live/1`);
    assert.equal(playlistRes.status, 200);
    assert.match(playlistRes.headers.get("content-type") ?? "", /mpegurl/);
    const playlist = await playlistRes.text();
    const urls = proxiedUrls(playlist);
    const segment = urls.find((url) => url.endsWith("/real/seg.ts"));
    const key = urls.find((url) => url.endsWith("/real/key.bin"));
    const cdn = urls.find((url) => url.startsWith("http://cdn.invalid/"));
    const local = urls.find((url) => url.includes("/local-secret.ts"));
    assert.ok(segment, playlist);
    assert.ok(key, playlist);
    assert.ok(cdn, playlist);
    assert.ok(local, playlist);

    const segmentRes = await fetch(`${base}/api/hls?u=${encodeURIComponent(segment)}`);
    assert.equal(segmentRes.status, 200);
    assert.equal(await segmentRes.text(), "segment-bytes");

    const ranged = await fetch(`${base}/api/hls?u=${encodeURIComponent(segment)}`, {
      headers: { Range: "bytes=0-3" },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 0-3/13");
    assert.equal(await ranged.text(), "segm");

    const keyRes = await fetch(`${base}/api/hls?u=${encodeURIComponent(key)}`);
    assert.equal(keyRes.status, 200);
    assert.equal(await keyRes.text(), "key-bytes");

    const learned = await fetch(`${base}/api/hls?u=${encodeURIComponent("http://cdn.invalid:9999/elsewhere.ts")}`);
    assert.equal(learned.status, 502);

    if (cdnBase) {
      const cdnUrl = urls.find((url) => url.startsWith(`${cdnBase}/seg.ts`));
      assert.ok(cdnUrl, playlist);
      const cdnRes = await fetch(`${base}/api/hls?u=${encodeURIComponent(cdnUrl)}`);
      assert.equal(cdnRes.status, 200);
      assert.equal(await cdnRes.text(), "cdn-segment");
    }

    const plain = await fetch(`${base}/api/stream/live/2`);
    assert.equal(plain.status, 200);
    assert.match(plain.headers.get("content-type") ?? "", /mpegurl/);
    const plainBody = await plain.text();
    const plainSegment = proxiedUrls(plainBody).find((url) => url.endsWith("/real/plain-seg.ts"));
    assert.ok(plainSegment, plainBody);
    const plainRes = await fetch(`${base}/api/hls?u=${encodeURIComponent(plainSegment)}`);
    assert.equal(plainRes.status, 200);
    assert.equal(await plainRes.text(), "plain-segment");

    const notLearned = await fetch(`${base}/api/hls?u=${encodeURIComponent("http://not-a-provider.invalid/x.ts")}`);
    assert.equal(notLearned.status, 403);

    const loopback = await fetch(`${base}/api/hls?u=${encodeURIComponent(local)}`);
    assert.equal(loopback.status, 403);
    assert.equal(secretHits, 0);

    const decimal = await fetch(
      `${base}/api/hls?u=${encodeURIComponent(`http://2130706433:${secretPort}/secret`)}`,
    );
    assert.equal(decimal.status, 403);
    assert.equal(secretHits, 0);

    const bounce = await fetch(`${base}/api/hls?u=${encodeURIComponent(`${providerBase}/bounce-local`)}`);
    assert.equal(bounce.status, 403);
    assert.equal(secretHits, 0);
  });

  await t.test("dropping a provider forgets hosts learned from its playlists", async () => {
    assert.equal(isAllowedStreamUrl("http://cdn.invalid/cdn/other.ts"), true);
    const removed = await fetch(`${base}/api/settings/xtream`, {
      method: "DELETE",
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(removed.status, 200);
    assert.equal(isAllowedStreamUrl("http://cdn.invalid/cdn/other.ts"), false);
    assert.equal(isAllowedStreamUrl(`${providerBase}/live/user/pass/1.m3u8`), false);

    settingsStore.setXtream({ baseUrl: providerBase, username: "user", password: "pass" });
    clearLearnedStreamHosts();
  });
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
