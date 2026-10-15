import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { isAppOrigin, isLoopbackHostHeader } from "./localAccess.js";
import { NotConfiguredError } from "./settingsStore.js";
import { onDemandRoutes } from "./routes/ondemand.js";
import { liveRoutes } from "./routes/live.js";
import { streamRoutes } from "./routes/stream.js";
import { settingsRoutes } from "./routes/settings.js";
import { popularRoutes } from "./routes/popular.js";
import { detailsRoutes } from "./routes/details.js";
import { traktRoutes } from "./routes/trakt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A malformed/truncated HTTP response from a flaky upstream provider (Xtream, Plex, etc.)
// can trip an internal assertion in Node's HTTP client (undici) that throws outside of any
// request's own promise chain - Fastify's per-request error handling can't catch that, and
// left unhandled it takes the whole process down over one bad response from one provider.
// Log it and keep serving instead - especially important here since a packaged desktop app
// has no one watching a terminal to notice and restart it.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server staying up):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (server staying up):", reason);
});

export async function startServer() {
  const app = Fastify({ logger: process.env.LOG_LEVEL === "silent" ? false : true });

  // Websites and other LAN devices must not be able to call this API. The
  // socket is loopback-only (see listen below). This hook refuses a browser
  // request whose Origin is not the app window or the Vite dev server, which
  // also stops "simple" GETs such as /api/hls that CORS headers alone would
  // still let the browser send. Same-origin app requests often omit Origin
  // and are allowed; cross-site browser requests always send one.
  app.addHook("onRequest", (request, reply, done) => {
    const host = request.headers.host;
    if (Array.isArray(host) || !isLoopbackHostHeader(host)) {
      reply.code(403).send({ error: "forbidden" });
      return;
    }
    const origin = request.headers.origin;
    if (Array.isArray(origin) || (origin !== undefined && !isAppOrigin(origin))) {
      reply.code(403).send({ error: "forbidden_origin" });
      return;
    }
    done();
  });

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || isAppOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  });

  app.setErrorHandler((err: Error, request, reply) => {
    if (err instanceof NotConfiguredError) {
      reply.code(409).send({ error: "not_configured", service: err.service });
      return;
    }
    request.log.error(err);
    reply.code(500).send({ error: "internal_error", message: err.message });
  });

  await app.register(settingsRoutes);
  await app.register(onDemandRoutes);
  await app.register(popularRoutes);
  await app.register(liveRoutes);
  await app.register(streamRoutes);
  await app.register(detailsRoutes);
  await app.register(traktRoutes);

  const webDist = path.join(__dirname, "../../web/dist");
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api")) {
      reply.code(404).send({ error: "Not found" });
      return;
    }
    reply.sendFile("index.html");
  });

  // 127.0.0.1, not 0.0.0.0: nothing else on the LAN can open a connection.
  // Electron loads http://127.0.0.1 explicitly so this still works where
  // "localhost" resolves to ::1 first.
  await app.listen({ port: config.port, host: "127.0.0.1" });
  return app;
}

// Runnable standalone (`node dist/index.js`) for testing this copy outside Electron;
// the packaged app instead imports startServer() directly from electron/main.js.
const isMain = path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
