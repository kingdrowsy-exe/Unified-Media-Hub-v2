import { randomBytes } from "node:crypto";
import { isAllowedStreamUrl, onLearnedHostsCleared } from "./streamAllowlist.js";

const tickets = new Map<string, string>();
const MAX_TICKETS = 4096;

/** Opaque id for a URL the server has already accepted. The renderer never sees the upstream URL. */
export function issueStreamTicket(rawUrl: string): string | null {
  if (!isAllowedStreamUrl(rawUrl)) return null;
  if (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next().value;
    if (oldest) tickets.delete(oldest);
  }
  const id = randomBytes(18).toString("base64url");
  tickets.set(id, rawUrl);
  return id;
}

export function resolveStreamTicket(id: string): string | null {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return null;
  return tickets.get(id) ?? null;
}

export function clearStreamTickets(): void {
  tickets.clear();
}

onLearnedHostsCleared(clearStreamTickets);
