import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENCRYPTED_PREFIX = "enc:v1:";

function safeStorageOrNull(): {
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
} | null {
  // Requiring the `electron` package from plain Node downloads and launches
  // Electron. Only the real Electron process sets process.versions.electron.
  if (!process.versions.electron) return null;
  try {
    const electron = require("electron") as {
      safeStorage?: {
        isEncryptionAvailable: () => boolean;
        encryptString: (plainText: string) => Buffer;
        decryptString: (encrypted: Buffer) => string;
      };
    };
    const safeStorage = electron.safeStorage;
    if (!safeStorage?.isEncryptionAvailable()) return null;
    return safeStorage;
  } catch {
    // Standalone `node` and the test runner have no Electron.
    return null;
  }
}
// The packaged Electron app points this at Electron's per-user app-data folder
// (writable regardless of where the app itself is installed); running the server
// standalone falls back to a data/ folder next to the compiled server code.
const dataDir = process.env.DATA_DIR ?? path.join(__dirname, "..", "data");
const settingsPath = path.join(dataDir, "settings.json");

export interface PlexSettings {
  baseUrl: string;
  token: string;
  serverName: string;
}

export interface SiloSettings {
  baseUrl: string;
  username: string;
  password: string;
}

export interface XtreamSettings {
  baseUrl: string;
  username: string;
  password: string;
}

export interface TmdbSettings {
  accessToken: string;
}

export interface TraktSettings {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface Settings {
  plex?: PlexSettings;
  silo?: SiloSettings;
  xtream?: XtreamSettings;
  tmdb?: TmdbSettings;
  trakt?: TraktSettings;
}

let cache: Settings | null = null;

function readSettingsText(): { json: string; encrypted: boolean } {
  const raw = fs.readFileSync(settingsPath, "utf-8");
  if (!raw.startsWith(ENCRYPTED_PREFIX)) return { json: raw, encrypted: false };
  const safeStorage = safeStorageOrNull();
  if (!safeStorage) {
    throw new Error(
      "settings.json is encrypted with Electron safeStorage. Open the desktop app to read it.",
    );
  }
  const decoded = Buffer.from(raw.slice(ENCRYPTED_PREFIX.length), "base64");
  return { json: safeStorage.decryptString(decoded), encrypted: true };
}

function load(): Settings {
  if (cache) return cache;
  if (!fs.existsSync(settingsPath)) {
    cache = {};
    return cache;
  }
  const { json, encrypted } = readSettingsText();
  cache = JSON.parse(json) as Settings;
  // Upgrade a plaintext file the first time the desktop app opens it.
  if (!encrypted && safeStorageOrNull()) persist();
  return cache;
}

function persist() {
  fs.mkdirSync(dataDir, { recursive: true });
  const json = JSON.stringify(cache, null, 2);
  const safeStorage = safeStorageOrNull();
  const body = safeStorage
    ? ENCRYPTED_PREFIX + safeStorage.encryptString(json).toString("base64")
    : json;
  fs.writeFileSync(settingsPath, body, { mode: 0o600 });
  try {
    fs.chmodSync(settingsPath, 0o600);
  } catch {
    // Windows ignores chmod. safeStorage (DPAPI) is the protection there.
  }
}

export const settingsStore = {
  getPlex(): PlexSettings | undefined {
    return load().plex;
  },
  setPlex(plex: PlexSettings) {
    load().plex = plex;
    persist();
  },
  clearPlex() {
    delete load().plex;
    persist();
  },
  getSilo(): SiloSettings | undefined {
    return load().silo;
  },
  setSilo(silo: SiloSettings) {
    load().silo = silo;
    persist();
  },
  clearSilo() {
    delete load().silo;
    persist();
  },
  getXtream(): XtreamSettings | undefined {
    return load().xtream;
  },
  setXtream(xtream: XtreamSettings) {
    load().xtream = xtream;
    persist();
  },
  clearXtream() {
    delete load().xtream;
    persist();
  },
  getTmdb(): TmdbSettings | undefined {
    return load().tmdb;
  },
  setTmdb(tmdb: TmdbSettings) {
    load().tmdb = tmdb;
    persist();
  },
  clearTmdb() {
    delete load().tmdb;
    persist();
  },
  getTrakt(): TraktSettings | undefined {
    return load().trakt;
  },
  setTrakt(trakt: TraktSettings) {
    load().trakt = trakt;
    persist();
  },
  updateTrakt(patch: Partial<TraktSettings>) {
    const existing = load().trakt;
    if (!existing) return;
    load().trakt = { ...existing, ...patch };
    persist();
  },
  clearTrakt() {
    delete load().trakt;
    persist();
  },
  status() {
    const s = load();
    return {
      plex: Boolean(s.plex),
      silo: Boolean(s.silo),
      xtream: Boolean(s.xtream),
      tmdb: Boolean(s.tmdb),
      trakt: Boolean(s.trakt?.accessToken),
      traktConfigured: Boolean(s.trakt),
      plexServerName: s.plex?.serverName,
      siloBaseUrl: s.silo?.baseUrl,
      xtreamBaseUrl: s.xtream?.baseUrl,
    };
  },
};

export class NotConfiguredError extends Error {
  constructor(public service: "plex" | "silo" | "xtream" | "tmdb" | "trakt") {
    super(`${service} is not configured yet`);
  }
}
