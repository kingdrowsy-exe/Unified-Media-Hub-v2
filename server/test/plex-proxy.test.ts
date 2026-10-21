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

const plex = await new Promise<{ server: http.Server; port: number }>((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
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
});

test.after(async () => {
  await app.close();
  plex.server.close();
});
