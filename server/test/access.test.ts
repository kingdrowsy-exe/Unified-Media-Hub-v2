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

function playlistTickets(playlist: string): string[] {
  return [...playlist.matchAll(/\/api\/hls\?t=([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
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
  let clipPath = "";
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
      if (pathname.endsWith("/9.m3u8")) {
        res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
        res.end("#EXTM3U\nclip.ts\n");
        return;
      }
      if (pathname.endsWith("/clip.ts")) {
        clipPath = pathname;
        res.writeHead(200, { "content-type": "video/mp2t" });
        res.end("clip-bytes");
        return;
      }
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
        lines.push("#EXTINF:4.0,", "http://10.1.2.3/x.ts");
        lines.push("#EXTINF:4.0,", `http://2130706433:${secretPort}/secret`);
        lines.push("#EXTINF:4.0,", `${providerBase}/bounce-local`);
        lines.push("#EXTINF:4.0,", "page.html");
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
      if (pathname === "/real/page.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><script>alert(1)</script></html>");
        return;
      }
      res.writeHead(404);
      res.end("missing");
    });
    providerBase = `http://127.0.0.2:${provider.port}`;
    closers.push(() => provider.server.close());

    settingsStore.setXtream({ baseUrl: providerBase, username: "alice", password: "s3cret" });
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
    process.env.UMH_DESKTOP = "1";
    try {
      assert.equal(isAppOrigin("http://localhost:5173"), false);
      assert.equal(isAppOrigin("http://127.0.0.1:5174"), false);
      assert.equal(isAppOrigin(`http://127.0.0.1:${port}`), true);
    } finally {
      delete process.env.UMH_DESKTOP;
    }
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
    assert.equal(isAllowedStreamUrl(`${providerBase}/live/alice/s3cret/1.m3u8`), true);
    assert.equal(isAllowedStreamUrl("http://127.0.0.2:1/other-port"), false);
    assert.equal(isAllowedStreamUrl("http://cdn.invalid/seg.ts"), false);
    assert.equal(isAllowedStreamUrl("http://2130706433/secret"), false);
    assert.equal(isAllowedStreamUrl("http://127.0.0.1/secret"), false);
    assert.equal(isAllowedStreamUrl("file:///etc/passwd"), false);

    assert.equal(rememberStreamUrl("http://cdn.invalid/seg.ts"), true);
    assert.equal(isAllowedStreamUrl("http://cdn.invalid/other-path"), true);
    assert.equal(isAllowedStreamUrl("http://cdn.invalid:9999/other-path"), false);
    assert.equal(rememberStreamUrl("https://cdn.example/a.ts"), true);
    assert.equal(isAllowedStreamUrl("http://cdn.example/b.ts"), true);
    for (const blocked of [
      "http://10.1.2.3/a",
      "http://192.168.0.1/a",
      "http://172.16.0.1/a",
      "http://[::1]/a",
      "http://[fc00::1]/a",
      "http://[::ffff:10.0.0.1]/a",
      "http://metadata.google.internal/a",
      "http://router.local/a",
      `http://127.0.0.1:${secretPort}/owned`,
    ]) {
      assert.equal(rememberStreamUrl(blocked), false, blocked);
      assert.equal(isAllowedStreamUrl(blocked), false, blocked);
    }

    clearLearnedStreamHosts();
    assert.equal(isAllowedStreamUrl("http://cdn.invalid/seg.ts"), false);
    assert.equal(isAllowedStreamUrl(`${providerBase}/live/alice/s3cret/1.m3u8`), true);
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

    const crossSite = await new Promise<{ status?: number }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/settings/status",
          headers: { "Sec-Fetch-Site": "cross-site" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(crossSite.status, 403);

    const sameSite = await new Promise<{ status?: number }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/settings/status",
          headers: { "Sec-Fetch-Site": "same-site" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(sameSite.status, 403);
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

  await t.test("proxies a provider playlist through tickets and refuses relays", async () => {
    clearLearnedStreamHosts();
    secretHits = 0;
    clipPath = "";

    const raw = await fetch(`${base}/api/hls?u=${encodeURIComponent("http://cdn.invalid/seg.ts")}`);
    assert.equal(raw.status, 400);

    const playlistRes = await fetch(`${base}/api/stream/live/1`);
    assert.equal(playlistRes.status, 200);
    assert.match(playlistRes.headers.get("content-type") ?? "", /mpegurl/);
    const playlist = await playlistRes.text();
    assert.equal(playlist.includes("s3cret"), false);
    assert.equal(playlist.includes("127.0.0.1"), false);
    assert.equal(playlist.includes("10.1.2.3"), false);
    assert.equal(playlist.includes("2130706433"), false);
    if (cdnBase) assert.equal(playlist.includes(new URL(cdnBase).hostname), false);
    assert.match(playlist, /# blocked/);
    const tickets = playlistTickets(playlist);
    assert.equal(tickets.length, 5, playlist);

    const bodies = new Map<string, { status: number; body: string; headers: Headers }>();
    for (const ticket of tickets) {
      const res = await fetch(`${base}/api/hls?t=${ticket}`);
      bodies.set(ticket, { status: res.status, body: await res.text(), headers: res.headers });
    }
    const segment = [...bodies.values()].find((entry) => entry.body === "segment-bytes");
    const key = [...bodies.values()].find((entry) => entry.body === "key-bytes");
    const cdn = [...bodies.values()].find((entry) => entry.status === 502);
    const bounce = [...bodies.values()].find((entry) => entry.status === 403);
    const page = [...bodies.values()].find((entry) => entry.body.includes("<script"));
    assert.ok(segment, JSON.stringify([...bodies.values()].map((entry) => entry.status)));
    assert.ok(key);
    assert.ok(cdn);
    assert.ok(bounce);
    assert.ok(page);
    assert.equal(page.headers.get("content-type"), "application/octet-stream");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(secretHits, 0);

    const segmentTicket = tickets.find((ticket) => bodies.get(ticket)?.body === "segment-bytes");
    assert.ok(segmentTicket);
    const ranged = await fetch(`${base}/api/hls?t=${segmentTicket}`, { headers: { Range: "bytes=0-3" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 0-3/13");
    assert.equal(await ranged.text(), "segm");

    const plain = await fetch(`${base}/api/stream/live/2`);
    assert.equal(plain.status, 200);
    assert.match(plain.headers.get("content-type") ?? "", /mpegurl/);
    const plainTickets = playlistTickets(await plain.text());
    assert.equal(plainTickets.length, 1);
    const plainRes = await fetch(`${base}/api/hls?t=${plainTickets[0]}`);
    assert.equal(plainRes.status, 200);
    assert.equal(await plainRes.text(), "plain-segment");

    const forged = await fetch(`${base}/api/hls?t=not-a-real-ticket-value`);
    assert.equal(forged.status, 403);
    assert.equal(secretHits, 0);

    const direct = await fetch(`${base}/api/stream/live/9`);
    assert.equal(direct.status, 200);
    const directBody = await direct.text();
    assert.equal(directBody.includes("s3cret"), false);
    assert.equal(directBody.includes("/live/alice/"), false);
    const clipTickets = playlistTickets(directBody);
    assert.equal(clipTickets.length, 1);
    const clipRes = await fetch(`${base}/api/hls?t=${clipTickets[0]}`);
    assert.equal(clipRes.status, 200);
    assert.equal(await clipRes.text(), "clip-bytes");
    assert.match(clipPath, /\/live\/alice\/s3cret\/clip\.ts$/);
  });

  await t.test("dropping a provider forgets hosts learned from its playlists", async () => {
    assert.equal(isAllowedStreamUrl("http://cdn.invalid/cdn/other.ts"), true);
    const removed = await fetch(`${base}/api/settings/xtream`, {
      method: "DELETE",
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(removed.status, 200);
    assert.equal(isAllowedStreamUrl("http://cdn.invalid/cdn/other.ts"), false);
    assert.equal(isAllowedStreamUrl(`${providerBase}/live/alice/s3cret/1.m3u8`), false);

    settingsStore.setXtream({ baseUrl: providerBase, username: "alice", password: "s3cret" });
    clearLearnedStreamHosts();
  });
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
