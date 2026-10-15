import type { FastifyInstance } from "fastify";
import { settingsStore } from "../settingsStore.js";
import { checkPin, createPin, resolveServerFromAuthToken } from "../clients/plexLink.js";
import { resetSiloSession } from "../clients/silo.js";
import {
  createDeviceCode,
  pollDeviceToken,
  validateClientId as validateTraktClientId,
  verifyAccountLink as verifyTraktAccountLink,
} from "../clients/trakt.js";
import { bustCache } from "../cache.js";
import { listSections } from "../clients/plex.js";

interface PendingPin {
  id: number;
  createdAt: number;
}

let pendingPin: PendingPin | null = null;

interface PendingTraktDevice {
  deviceCode: string;
  createdAt: number;
}

let pendingTraktDevice: PendingTraktDevice | null = null;

async function validateSilo(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.includes("application/json")) {
    throw new Error(`Silo login failed (${res.status}). Check the server URL and credentials.`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Silo login failed. The server responded but did not return an access token.");
  }
}

async function validateXtream(baseUrl: string, username: string, password: string) {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/player_api.php`);
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Xtream login failed (${res.status}). Check the server URL and credentials.`);
  }
  const data = (await res.json()) as { user_info?: { auth?: number } };
  if (data.user_info && data.user_info.auth !== 1) {
    throw new Error("Xtream login failed. Check your username and password.");
  }
}

async function validateTmdb(accessToken: string) {
  const res = await fetch("https://api.themoviedb.org/3/authentication", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean };
  if (!res.ok || !data.success) {
    throw new Error("TMDB login failed. Check your API Read Access Token.");
  }
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings/status", async () => {
    return settingsStore.status();
  });

  app.post("/api/settings/silo", async (request, reply) => {
    const { baseUrl, username, password } = request.body as {
      baseUrl?: string;
      username?: string;
      password?: string;
    };
    if (!baseUrl || !username || !password) {
      return reply.code(400).send({ error: "baseUrl, username, and password are required" });
    }
    const cleanBaseUrl = baseUrl.replace(/\/+$/, "");
    try {
      await validateSilo(cleanBaseUrl, username, password);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    settingsStore.setSilo({ baseUrl: cleanBaseUrl, username, password });
    resetSiloSession();
    bustCache("ondemand:");
    bustCache("popular:");
    bustCache("trakt:");
    return { ok: true };
  });

  app.delete("/api/settings/silo", async () => {
    settingsStore.clearSilo();
    resetSiloSession();
    bustCache("ondemand:");
    bustCache("popular:");
    bustCache("trakt:");
    return { ok: true };
  });

  app.post("/api/settings/xtream", async (request, reply) => {
    const { baseUrl, username, password } = request.body as {
      baseUrl?: string;
      username?: string;
      password?: string;
    };
    if (!baseUrl || !username || !password) {
      return reply.code(400).send({ error: "baseUrl, username, and password are required" });
    }
    const cleanBaseUrl = baseUrl.replace(/\/+$/, "");
    try {
      await validateXtream(cleanBaseUrl, username, password);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    settingsStore.setXtream({ baseUrl: cleanBaseUrl, username, password });
    bustCache("live:");
    bustCache("xtream:");
    bustCache("ondemand:");
    bustCache("popular:");
    bustCache("trakt:");
    return { ok: true };
  });

  app.delete("/api/settings/xtream", async () => {
    settingsStore.clearXtream();
    bustCache("live:");
    bustCache("xtream:");
    bustCache("ondemand:");
    bustCache("popular:");
    bustCache("trakt:");
    return { ok: true };
  });

  app.post("/api/settings/plex/link/start", async () => {
    const pin = await createPin();
    pendingPin = { id: pin.id, createdAt: Date.now() };
    return { pinId: pin.id, code: pin.code, linkUrl: "https://plex.tv/link" };
  });

  app.get("/api/settings/plex/link/status", async (request, reply) => {
    const { pinId } = request.query as { pinId?: string };
    const id = Number(pinId ?? pendingPin?.id);
    if (!id) {
      return reply.code(400).send({ error: "No pending Plex link request" });
    }

    const pin = await checkPin(id);
    if (!pin.authToken) {
      return { linked: false };
    }

    try {
      const server = await resolveServerFromAuthToken(pin.authToken);
      settingsStore.setPlex(server);
      pendingPin = null;
      bustCache("ondemand:");
      bustCache("popular:");
      bustCache("trakt:");
      return { linked: true, serverName: server.serverName };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete("/api/settings/plex", async () => {
    settingsStore.clearPlex();
    bustCache("ondemand:");
    bustCache("popular:");
    bustCache("trakt:");
    return { ok: true };
  });

  app.post("/api/settings/tmdb", async (request, reply) => {
    const { accessToken } = request.body as { accessToken?: string };
    if (!accessToken) {
      return reply.code(400).send({ error: "accessToken is required" });
    }
    try {
      await validateTmdb(accessToken);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    settingsStore.setTmdb({ accessToken });
    bustCache("popular:");
    bustCache("trakt:");
    bustCache("details:");
    return { ok: true };
  });

  app.delete("/api/settings/tmdb", async () => {
    settingsStore.clearTmdb();
    bustCache("popular:");
    bustCache("trakt:");
    bustCache("details:");
    return { ok: true };
  });

  app.post("/api/settings/trakt", async (request, reply) => {
    const { clientId, clientSecret } = request.body as { clientId?: string; clientSecret?: string };
    if (!clientId || !clientSecret) {
      return reply.code(400).send({ error: "clientId and clientSecret are required" });
    }
    try {
      await validateTraktClientId(clientId);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    settingsStore.setTrakt({ clientId, clientSecret });
    return { ok: true };
  });

  app.delete("/api/settings/trakt", async () => {
    settingsStore.clearTrakt();
    pendingTraktDevice = null;
    bustCache("trakt:");
    bustCache("details:");
    return { ok: true };
  });

  app.post("/api/settings/trakt/link/start", async (_request, reply) => {
    const trakt = settingsStore.getTrakt();
    if (!trakt) {
      return reply.code(409).send({ error: "Save a Trakt Client ID and Secret first" });
    }
    const device = await createDeviceCode(trakt.clientId);
    pendingTraktDevice = { deviceCode: device.deviceCode, createdAt: Date.now() };
    return {
      userCode: device.userCode,
      verificationUrl: device.verificationUrl,
      interval: device.interval,
      expiresIn: device.expiresIn,
    };
  });

  app.get("/api/settings/trakt/link/status", async (_request, reply) => {
    const trakt = settingsStore.getTrakt();
    if (!trakt || !pendingTraktDevice) {
      return reply.code(400).send({ error: "No pending Trakt link request" });
    }
    try {
      const tokens = await pollDeviceToken(trakt.clientId, trakt.clientSecret, pendingTraktDevice.deviceCode);
      if (!tokens) {
        return { linked: false };
      }
      settingsStore.updateTrakt(tokens);
      pendingTraktDevice = null;
      bustCache("trakt:");
      bustCache("details:");
      return { linked: true };
    } catch (err) {
      pendingTraktDevice = null;
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Re-runs each service's own login check against whatever is already saved, so a
  // previously-connected service that's since gone stale (expired token, changed
  // password, server moved) can be surfaced without waiting for something else to break.
  app.post("/api/settings/:service/test", async (request, reply) => {
    const { service } = request.params as { service: string };
    try {
      switch (service) {
        case "plex": {
          const plex = settingsStore.getPlex();
          if (!plex) return reply.code(409).send({ error: "Plex isn't connected" });
          await listSections();
          return { ok: true };
        }
        case "silo": {
          const silo = settingsStore.getSilo();
          if (!silo) return reply.code(409).send({ error: "Silo isn't connected" });
          await validateSilo(silo.baseUrl, silo.username, silo.password);
          return { ok: true };
        }
        case "xtream": {
          const xtream = settingsStore.getXtream();
          if (!xtream) return reply.code(409).send({ error: "Xtream isn't connected" });
          await validateXtream(xtream.baseUrl, xtream.username, xtream.password);
          return { ok: true };
        }
        case "tmdb": {
          const tmdb = settingsStore.getTmdb();
          if (!tmdb) return reply.code(409).send({ error: "TMDB isn't connected" });
          await validateTmdb(tmdb.accessToken);
          return { ok: true };
        }
        case "trakt": {
          const trakt = settingsStore.getTrakt();
          if (!trakt) return reply.code(409).send({ error: "Trakt isn't connected" });
          if (!trakt.accessToken) {
            return reply.code(409).send({ error: "Trakt account isn't linked yet" });
          }
          await verifyTraktAccountLink();
          return { ok: true };
        }
        default:
          return reply.code(400).send({ error: `Unknown service: ${service}` });
      }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
