import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
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

function listen(host: string, handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "umh-boundaries-"));
const port = await freePort();
process.env.DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.LOG_LEVEL = "silent";

const { startServer } = await import("../src/index.js");
const { settingsStore } = await import("../src/settingsStore.js");
const { createGuardedClient, setStreamAddressResolver } = await import("../src/upstream.js");
const { clearLearnedStreamHosts, rememberStreamUrl } = await import("../src/streamAllowlist.js");
const { issueStreamTicket } = await import("../src/streamTickets.js");
const { isReachable } = await import("../src/clients/plexLink.js");
const { resetSiloSession } = await import("../src/clients/silo.js");

test("upstream failures stay inside the request", async (t) => {
  let app: FastifyInstance;
  const closers: Array<() => void | Promise<void>> = [];

  t.before(async () => {
    app = await startServer();
    closers.push(() => app.close());
  });

  t.after(async () => {
    setStreamAddressResolver(null);
    delete process.env.UMH_MAX_PLAYLIST_BYTES;
    for (const close of closers.reverse()) await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await t.test("a client error event is handled on the dispatcher", () => {
    const client = createGuardedClient("http://127.0.0.1:9");
    const failure = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    assert.doesNotThrow(() => {
      client.emit("error", failure);
    });
    return client.close();
  });

  await t.test("an isolated undici failure still exits the process", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umh-fatal-"));
    const childPort = await freePort();
    const script = path.join(dir, "crash.ts");
    fs.writeFileSync(
      script,
      `
        import { startServer } from ${JSON.stringify(path.resolve("src/index.ts"))};
        startServer().then(() => {
          setTimeout(() => {
            const err = new Error("other side closed");
            err.code = "UND_ERR_SOCKET";
            throw err;
          }, 50);
        });
      `,
    );
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", script], {
        cwd: path.resolve("."),
        env: { ...process.env, DATA_DIR: dir, PORT: String(childPort), LOG_LEVEL: "silent" },
      });
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`process stayed alive\n${output}`));
      }, 8000);
      child.on("exit", (status) => {
        clearTimeout(timer);
        if (status !== 1 || !output.includes("other side closed")) {
          reject(new Error(`exit ${status}\n${output}`));
          return;
        }
        resolve(status);
      });
    });
    assert.equal(code, 1);
    const crash = fs.readFileSync(path.join(dir, "crash.log"), "utf-8");
    assert.match(crash, /uncaughtException/);
    assert.match(crash, /other side closed/);
  });

  await t.test("a learned name that resolves to loopback is not fetched", async () => {
    let secretHits = 0;
    let lookedUp = false;
    const secret = await listen("127.0.0.1", (_req, res) => {
      secretHits += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("secret-body");
    });
    closers.push(() => secret.server.close());
    setStreamAddressResolver(async (hostname) => {
      lookedUp = hostname === "cdn.example";
      return [{ address: "127.0.0.1", family: 4 }];
    });
    try {
      clearLearnedStreamHosts();
      const target = `http://cdn.example:${secret.port}/owned.ts`;
      assert.equal(rememberStreamUrl(target), true);
      const ticket = issueStreamTicket(target);
      assert.ok(ticket);
      const res = await fetch(`http://127.0.0.1:${port}/api/hls?t=${ticket}`);
      assert.equal(res.status, 403);
      await res.body?.cancel();
      assert.equal(lookedUp, true);
      assert.equal(secretHits, 0);
    } finally {
      setStreamAddressResolver(null);
      clearLearnedStreamHosts();
    }
  });

  await t.test("a configured localhost provider still plays when lookup returns loopback", async () => {
    const upstream = await listen("127.0.0.1", (req, res) => {
      const pathname = req.url?.split("?")[0] ?? "/";
      if (pathname.endsWith(".m3u8")) {
        res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
        res.end("#EXTM3U\nclip.ts\n");
        return;
      }
      res.writeHead(200, { "content-type": "video/mp2t" });
      res.end("local-clip");
    });
    closers.push(() => upstream.server.close());
    clearLearnedStreamHosts();
    settingsStore.setXtream({
      baseUrl: `http://localhost:${upstream.port}`,
      username: "alice",
      password: "s3cret",
    });
    const playlistRes = await fetch(`http://127.0.0.1:${port}/api/stream/live/1`);
    const playlist = await playlistRes.text();
    assert.equal(playlistRes.status, 200, playlist);
    assert.equal(playlist.includes("s3cret"), false);
    const ticket = playlist.match(/\/api\/hls\?t=([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(ticket, playlist);
    const clip = await fetch(`http://127.0.0.1:${port}/api/hls?t=${ticket}`);
    assert.equal(clip.status, 200);
    assert.equal(await clip.text(), "local-clip");
  });

  await t.test("an oversized playlist is cancelled instead of buffered", async () => {
    let closed = false;
    const upstream = await listen("127.0.0.1", (req, res) => {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      const timer = setInterval(() => {
        res.write(`${"a".repeat(64)}\n`);
      }, 10);
      req.on("close", () => {
        clearInterval(timer);
        closed = true;
      });
    });
    closers.push(() => upstream.server.close());
    settingsStore.setXtream({
      baseUrl: `http://127.0.0.1:${upstream.port}`,
      username: "alice",
      password: "s3cret",
    });
    process.env.UMH_MAX_PLAYLIST_BYTES = "128";
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/stream/live/1`);
      assert.equal(res.status, 502);
      await res.body?.cancel();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("upstream stayed open")), 1500);
        const poll = setInterval(() => {
          if (!closed) return;
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }, 20);
      });
    } finally {
      delete process.env.UMH_MAX_PLAYLIST_BYTES;
    }
  });

  await t.test("closing the client aborts the upstream stream", async () => {
    let closed = false;
    let started = false;
    const upstream = await listen("127.0.0.1", (req, res) => {
      started = true;
      res.writeHead(200, { "content-type": "video/mp2t", "content-length": "1000000" });
      res.write("x");
      req.on("close", () => {
        closed = true;
      });
    });
    closers.push(() => upstream.server.close());
    clearLearnedStreamHosts();
    const target = `http://127.0.0.1:${upstream.port}/slow.ts`;
    settingsStore.setXtream({ baseUrl: `http://127.0.0.1:${upstream.port}`, username: "alice", password: "s3cret" });
    assert.equal(rememberStreamUrl(target), true);
    const ticket = issueStreamTicket(target);
    assert.ok(ticket);
    const ac = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/api/hls?t=${ticket}`, { signal: ac.signal });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("upstream never saw the request")), 1500);
      const poll = setInterval(() => {
        if (!started) return;
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }, 10);
    });
    ac.abort();
    await pending.catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("upstream stayed open after the client left")), 1500);
      const poll = setInterval(() => {
        if (!closed) return;
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }, 20);
    });
  });

  await t.test("silo media redirects do not leave the configured host", async () => {
    let secretHits = 0;
    const secret = await listen("127.0.0.1", (_req, res) => {
      secretHits += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("secret-body");
    });
    const silo = await listen("127.0.0.1", (req, res) => {
      const pathname = req.url?.split("?")[0] ?? "/";
      if (req.method === "POST" && pathname === "/api/v1/auth/login") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "silo-token", expires_in: 3600 }));
        return;
      }
      if (pathname === "/api/v1/profiles") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ profiles: [{ id: "p1", is_primary: true }] }));
        return;
      }
      if (pathname === "/api/v1/watch/1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ versions: [{ file_id: 7 }] }));
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/playback/start") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ playback_plan: { stream: { url: "/files/movie.mp4" } } }));
        return;
      }
      if (pathname === "/api/v1/files/movie.mp4") {
        res.writeHead(302, { location: `http://127.0.0.1:${secret.port}/owned` });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end(pathname);
    });
    closers.push(() => secret.server.close(), () => silo.server.close());
    resetSiloSession();
    settingsStore.setSilo({ baseUrl: `http://127.0.0.1:${silo.port}`, username: "alice", password: "s3cret" });
    const res = await fetch(`http://127.0.0.1:${port}/api/stream/silo/1`);
    const body = await res.text();
    assert.notEqual(res.status, 200, body);
    assert.equal(body.includes("secret-body"), false);
    assert.equal(secretHits, 0);
  });

  await t.test("plex discovery does not probe link-local or follow a cross-host redirect", async () => {
    const started = Date.now();
    assert.equal(await isReachable("http://169.254.169.254/latest"), false);
    assert.equal(await isReachable("http://metadata.google.internal/"), false);
    assert.ok(Date.now() - started < 500);

    let secretHits = 0;
    const secret = await listen("127.0.0.1", (_req, res) => {
      secretHits += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("secret-body");
    });
    const plex = await listen("127.0.0.1", (_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${secret.port}/identity` });
      res.end();
    });
    closers.push(() => secret.server.close(), () => plex.server.close());
    assert.equal(await isReachable(`http://127.0.0.1:${plex.port}`), false);
    assert.equal(secretHits, 0);

    let probeClosed = false;
    const identity = await listen("127.0.0.1", (req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000000" });
      res.write("{");
      req.on("close", () => {
        probeClosed = true;
      });
    });
    closers.push(() => identity.server.close());
    assert.equal(await isReachable(`http://127.0.0.1:${identity.port}`), true);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("identity body stayed open")), 1500);
      const poll = setInterval(() => {
        if (!probeClosed) return;
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }, 20);
    });
  });

  await t.test("saving an xtream server refuses an unbounded login body", async () => {
    let closed = false;
    const upstream = await listen("127.0.0.1", (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const timer = setInterval(() => {
        res.write("x".repeat(64));
      }, 10);
      req.on("close", () => {
        clearInterval(timer);
        closed = true;
      });
    });
    closers.push(() => upstream.server.close());
    process.env.UMH_MAX_JSON_BYTES = "128";
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/xtream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: `http://127.0.0.1:${upstream.port}`,
          username: "alice",
          password: "s3cret",
        }),
      });
      assert.equal(res.status, 400);
      await res.body?.cancel();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("login body stayed open")), 1500);
        const poll = setInterval(() => {
          if (!closed) return;
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }, 20);
      });
    } finally {
      delete process.env.UMH_MAX_JSON_BYTES;
    }
  });
});
