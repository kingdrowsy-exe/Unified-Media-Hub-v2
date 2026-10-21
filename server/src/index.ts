import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { recordCrash } from "./crashLog.js";
import { config } from "./config.js";
import { isAppOrigin, isLoopbackHostHeader } from "./localAccess.js";
import { redactText, redactUrl } from "./redact.js";
import { installUpstreamGuards } from "./upstream.js";
import "./streamTickets.js";

installUpstreamGuards();
import { NotConfiguredError } from "./settingsStore.js";
import { onDemandRoutes } from "./routes/ondemand.js";
import { liveRoutes } from "./routes/live.js";
import { streamRoutes } from "./routes/stream.js";
import { settingsRoutes } from "./routes/settings.js";
import { popularRoutes } from "./routes/popular.js";
import { detailsRoutes } from "./routes/details.js";
import { traktRoutes } from "./routes/trakt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Socket failures that undici cannot attach to a request are handled on the
// dispatcher (see upstream.ts). Anything that still escapes is process-wide.
function fatal(kind: string, err: unknown): void {
  recordCrash(kind, err);
  process.exit(1);
}
process.on("uncaughtException", (err) => {
  fatal("uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  fatal("unhandledRejection", reason);
});

export async function startServer() {
  const app = Fastify({
    logger:
      process.env.LOG_LEVEL === "silent"
        ? false
        : {
            level: process.env.LOG_LEVEL ?? "info",
            serializers: {
              req(request) {
                return { method: request.method, url: redactUrl(request.url) };
              },
              err(error) {
                const err = error as Error;
                return {
                  type: err.name,
                  message: redactText(err.message),
                  stack: redactText(err.stack ?? ""),
                };
              },
            },
          },
  });

  // Websites and other LAN devices must not be able to call this API. The
  // socket is loopback-only (see listen below). Browsers omit Origin on
  // no-cors GETs such as <img>, so Origin alone does not stop those. They do
  // send Sec-Fetch-Site: cross-site, which a page on this origin never does.
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
    const site = request.headers["sec-fetch-site"];
    const sites = Array.isArray(site) ? site : site ? [site] : [];
    if (sites.some((value) => value === "cross-site" || value === "same-site")) {
      reply.code(403).send({ error: "forbidden" });
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
    reply.code(500).send({ error: "internal_error" });
  });

  await app.register(settingsRoutes);
  await app.register(onDemandRoutes);
  await app.register(popularRoutes);
  await app.register(liveRoutes);
  await app.register(streamRoutes);
  await app.register(detailsRoutes);
  await app.register(traktRoutes);

  const webDist = path.join(__dirname, "../../web/dist");
  await app.register(fastifyStatic, { root: webDist, wildcard: false, list: false });
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
