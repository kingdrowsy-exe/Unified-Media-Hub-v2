import { isSafePlexProbe } from "../streamAllowlist.js";
import { fetchProvider, readJsonLimited } from "../upstream.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.join(__dirname, "..", "..", "data");
const clientIdPath = path.join(dataDir, "plex-client-id");

const PLEX_HEADERS_BASE = {
  "X-Plex-Product": "Unified Media Hub",
  "X-Plex-Version": "0.1.0",
  "X-Plex-Device": "Computer",
  "X-Plex-Device-Name": "Unified Media Hub",
  "X-Plex-Platform": "Web",
  Accept: "application/json",
};

export function getClientIdentifier(): string {
  if (fs.existsSync(clientIdPath)) {
    return fs.readFileSync(clientIdPath, "utf-8").trim();
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const id = crypto.randomUUID();
  fs.writeFileSync(clientIdPath, id);
  return id;
}

function headers(clientId: string) {
  return { ...PLEX_HEADERS_BASE, "X-Plex-Client-Identifier": clientId };
}

export interface PlexPin {
  id: number;
  code: string;
  authToken: string | null;
}

interface PlexConnection {
  uri: string;
  local: boolean;
  relay: boolean;
}

interface PlexResource {
  name: string;
  provides: string;
  owned: boolean;
  accessToken: string;
  connections: PlexConnection[];
}

export async function createPin(): Promise<PlexPin> {
  const clientId = getClientIdentifier();
  const res = await fetchProvider("https://plex.tv/api/v2/pins", {
    method: "POST",
    headers: headers(clientId),
  });
  if (!res.ok) {
    throw new Error(`Failed to create Plex pin: ${res.status}`);
  }
  return readJsonLimited<PlexPin>(res);
}

export async function checkPin(pinId: number): Promise<PlexPin> {
  const clientId = getClientIdentifier();
  const res = await fetchProvider(`https://plex.tv/api/v2/pins/${pinId}`, {
    headers: headers(clientId),
  });
  if (!res.ok) {
    throw new Error(`Failed to check Plex pin: ${res.status}`);
  }
  return readJsonLimited<PlexPin>(res);
}

export async function isReachable(uri: string): Promise<boolean> {
  if (!isSafePlexProbe(uri)) return false;
  try {
    const res = await fetchProvider(`${uri}/identity`, { signal: AbortSignal.timeout(3000) });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

// "local" connections are only reachable from the Plex server's own LAN - this app is
// often running elsewhere (a genuinely remote Plex setup), so we can't just prefer
// local over public like a same-network client would. Instead, actually probe every
// candidate and use whichever responds, trying non-relay connections before relay ones.
async function pickReachableConnection(connections: PlexConnection[]): Promise<PlexConnection | undefined> {
  const direct = connections.filter((c) => !c.relay);
  const relay = connections.filter((c) => c.relay);

  for (const group of [direct, relay]) {
    if (group.length === 0) continue;
    const results = await Promise.all(group.map(async (c) => ((await isReachable(c.uri)) ? c : null)));
    const reachable = results.find((c): c is PlexConnection => c !== null);
    if (reachable) return reachable;
  }
  return undefined;
}

export async function resolveServerFromAuthToken(
  authToken: string,
): Promise<{ baseUrl: string; token: string; serverName: string }> {
  const clientId = getClientIdentifier();
  const url = new URL("https://plex.tv/api/v2/resources");
  url.searchParams.set("includeHttps", "1");
  url.searchParams.set("includeRelay", "1");
  url.searchParams.set("X-Plex-Token", authToken);
  const res = await fetchProvider(url, { headers: headers(clientId) });
  if (!res.ok) {
    throw new Error(`Failed to list Plex resources: ${res.status}`);
  }
  const resources = await readJsonLimited<PlexResource[]>(res);
  const servers = resources.filter((r) => r.provides.includes("server"));
  if (servers.length === 0) {
    throw new Error("No Plex Media Server found on this account.");
  }
  const server = servers.find((s) => s.owned) ?? servers[0];
  const connection = await pickReachableConnection(server.connections);
  if (!connection) {
    throw new Error(
      `Couldn't reach server "${server.name}" on any known address (tried ${server.connections.length} connection(s)). Check that it's online and reachable from wherever this app is running.`,
    );
  }
  return { baseUrl: connection.uri, token: server.accessToken, serverName: server.name };
}
