import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "umh-plex-"));
const port = await freePort();
process.env.DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.LOG_LEVEL = "silent";

const TOKEN = "plex-token-should-not-leak";
let secretHits = 0;

const secret = await new Promise<{ server: http.Server; port: number }>((resolve, reject) => {
  const server = http.createServer((_req, res) => {
    secretHits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("secret-body");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
});

const plex = await new Promise<{ server: http.Server; port: number }>((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/library/metadata/99") {
      res.writeHead(302, { location: `http://127.0.0.1:${secret.port}/owned` });
      res.end();
      return;
    }
    if (url.pathname === "/library/metadata/55/thumb/1") {
      if (url.searchParams.get("X-Plex-Token") !== TOKEN) {
        res.writeHead(401);
        res.end("missing token");
        return;
      }
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end("IMG");
      return;
    }
    if (url.pathname === "/library/metadata/55") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          MediaContainer: { Metadata: [{ Media: [{ Part: [{ key: "/library/parts/55/file.mp4" }] }] }] },
        }),
      );
      return;
    }
    if (url.pathname === "/library/parts/55/file.mp4") {
      if (url.searchParams.get("X-Plex-Token") !== TOKEN) {
        res.writeHead(401);
        res.end("missing token");
        return;
      }
      res.writeHead(302, { location: "/library/files/movie.mp4" });
      res.end();
      return;
    }
    if (url.pathname === "/library/files/movie.mp4") {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end("VIDEO");
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    resolve({ server, port: (server.address() as AddressInfo).port });
  });
});

const { startServer } = await import("../src/index.js");
const { settingsStore } = await import("../src/settingsStore.js");
const { plexPosterUrl } = await import("../src/clients/plex.js");

settingsStore.setPlex({
  baseUrl: `http://127.0.0.1:${plex.port}`,
  token: TOKEN,
  serverName: "Test",
});

const app = await startServer();

test("plex playback is proxied and the token never reaches the client", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/stream/plex/55`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.equal(body, "VIDEO");
  assert.equal(res.headers.get("location"), null);
  assert.equal(body.includes(TOKEN), false);
  assert.equal(JSON.stringify([...res.headers]).includes(TOKEN), false);

  const poster = plexPosterUrl(`/library/metadata/55/thumb/1?X-Plex-Token=${TOKEN}`);
  assert.ok(poster);
  assert.equal(poster.includes(TOKEN), false);
  const image = await fetch(`http://127.0.0.1:${port}${poster}`);
  const imageBody = await image.text();
  assert.equal(image.status, 200);
  assert.equal(imageBody, "IMG");
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.equal(imageBody.includes(TOKEN), false);
  assert.equal(JSON.stringify([...image.headers]).includes(TOKEN), false);

  secretHits = 0;
  const redirected = await fetch(`http://127.0.0.1:${port}/api/stream/plex/99`);
  const redirectedBody = await redirected.text();
  assert.notEqual(redirected.status, 200);
  assert.equal(redirectedBody.includes("secret-body"), false);
  assert.equal(redirectedBody.includes(TOKEN), false);
  assert.equal(secretHits, 0);
});

test.after(async () => {
  await app.close();
  plex.server.close();
  secret.server.close();
});
