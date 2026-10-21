import { EventEmitter } from "node:events";
import dns from "node:dns";
import net from "node:net";
import { Agent, Client, Pool, fetch as undiciFetch, type Dispatcher } from "undici";
import { recordCrash } from "./crashLog.js";
import { isAllowedStreamUrl, resolvedAddressAllowed } from "./streamAllowlist.js";

/**
 * Undici attributes a socket failure to the request when it can. When it cannot
 * (the socket was idle, or the request already settled), Client emits "error".
 * Nothing in undici listens for that event, so Node raises it as an
 * uncaughtException from the socket callback — outside Fastify and outside the
 * fetch promise. The listener below is that boundary. Process-wide crash
 * handlers must not keep running after a different exception.
 */
function guardDispatcher(dispatcher: Dispatcher): Dispatcher {
  // Client emits "error"; the published Dispatcher typings omit that event.
  (dispatcher as unknown as EventEmitter).on("error", (err: Error) => {
    try {
      recordCrash("upstream-socket", err);
    } catch {
      // The socket failure is already isolated. Logging must not replace it.
    }
  });
  return dispatcher;
}

export function createGuardedClient(origin: string): Client {
  const client = new Client(origin);
  guardDispatcher(client);
  return client;
}

function agent(lookup?: net.LookupFunction): Dispatcher {
  return guardDispatcher(
    new Agent({
      connect: lookup ? { lookup } : undefined,
      factory(origin, opts) {
        return new Pool(origin, {
          ...opts,
          factory(poolOrigin, poolOpts) {
            return guardDispatcher(new Client(poolOrigin, poolOpts));
          },
        });
      },
    }),
  );
}

type Resolved = { address: string; family: number };

async function defaultResolve(hostname: string): Promise<Resolved[]> {
  const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
}

let resolveAddresses = defaultResolve;

/** Test hook. Production uses dns.lookup. Pass null to restore it. */
export function setStreamAddressResolver(resolver: ((hostname: string) => Promise<Resolved[]>) | null): void {
  resolveAddresses = resolver ?? defaultResolve;
}

function blockedError(): NodeJS.ErrnoException {
  return Object.assign(new Error("Blocked address"), { code: "EBLOCKED" });
}

const pinnedLookup: net.LookupFunction = (hostname, options, callback) => {
  resolveAddresses(hostname)
    .then((addresses) => {
      if (addresses.length === 0 || addresses.some((entry) => !resolvedAddressAllowed(hostname, entry.address))) {
        callback(blockedError(), "", 4);
        return;
      }
      if (options.all) {
        callback(
          null,
          addresses.map((entry) => ({ address: entry.address, family: entry.family })),
        );
        return;
      }
      callback(null, addresses[0].address, addresses[0].family);
    })
    .catch((err: NodeJS.ErrnoException) => {
      callback(err, "", 4);
    });
};

const appDispatcher = agent();
const streamDispatcher = agent(pinnedLookup);

let fetchInstalled = false;

export function installUpstreamGuards(): void {
  if (fetchInstalled) return;
  fetchInstalled = true;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    callFetch(input, { ...(init ?? {}), dispatcher: appDispatcher })) as typeof fetch;
}

function callFetch(input: RequestInfo | URL, init: RequestInit & { dispatcher: Dispatcher }): Promise<Response> {
  return undiciFetch(input as never, init as never) as unknown as Promise<Response>;
}

export class StreamBlockedError extends Error {
  code = "EBLOCKED";
  constructor() {
    super("Stream host is not allowed");
  }
}

export function isBlockedFetchError(err: unknown): boolean {
  if (err instanceof StreamBlockedError) return true;
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "EBLOCKED") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function portOf(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

export function sameHostRedirect(from: string, location: string): string | null {
  let base: URL;
  let next: URL;
  try {
    base = new URL(from);
    next = new URL(location, base);
  } catch {
    return null;
  }
  if (!redirectStaysOnHost(base, next)) return null;
  return next.toString();
}

function redirectStaysOnHost(from: URL, to: URL): boolean {
  if (to.protocol !== "http:" && to.protocol !== "https:") return false;
  if (to.username || to.password) return false;
  if (hostnameOf(from) !== hostnameOf(to)) return false;
  const left = portOf(from);
  const right = portOf(to);
  if (left === right) return true;
  const web = new Set(["80", "443"]);
  return web.has(left) && web.has(right);
}

/** Provider API fetch. Follows a redirect only when it stays on the same host. */
export async function fetchProvider(input: string | URL, init: RequestInit = {}, hops = 0): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider redirect was refused");
  }
  const res = await callFetch(url, {
    ...init,
    dispatcher: appDispatcher,
    redirect: "manual",
  });
  if (res.status < 300 || res.status >= 400) return res as unknown as Response;
  const location = res.headers.get("location");
  await res.body?.cancel().catch(() => undefined);
  if (!location || hops >= 3) throw new Error("Provider redirect was refused");
  let next: URL;
  try {
    next = new URL(location, url);
  } catch {
    throw new Error("Provider redirect was refused");
  }
  if (!redirectStaysOnHost(url, next)) throw new Error("Provider redirect was refused");
  return fetchProvider(next, init, hops + 1);
}

export async function fetchStream(targetUrl: string, init: RequestInit = {}): Promise<Response> {
  if (!isAllowedStreamUrl(targetUrl)) throw new StreamBlockedError();
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new StreamBlockedError();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new StreamBlockedError();
  return callFetch(url, {
    ...init,
    dispatcher: streamDispatcher,
    redirect: "manual",
  });
}

export function maxPlaylistBytes(): number {
  const configured = Number(process.env.UMH_MAX_PLAYLIST_BYTES ?? 2_000_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 2_000_000;
}

export function maxJsonBytes(): number {
  const configured = Number(process.env.UMH_MAX_JSON_BYTES ?? 16_000_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 16_000_000;
}

export async function readTextLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("response too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("response too large");
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJsonLimited<T>(res: Response, maxBytes = maxJsonBytes()): Promise<T> {
  const text = await readTextLimited(res, maxBytes);
  return JSON.parse(text) as T;
}
