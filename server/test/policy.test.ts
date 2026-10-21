import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "umh-policy-"));
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = "silent";

const { addressKind, clearLearnedStreamHosts, isSafePlexProbe, rememberStreamUrl } = await import(
  "../src/streamAllowlist.js"
);
const { issueStreamTicket, resolveStreamTicket } = await import("../src/streamTickets.js");
const { isAppNavigation, isTrustedExternal, safeExternalUrl } = await import("../src/externalUrls.js");
const { sanitizeArtworkUrl } = await import("../src/artwork.js");
const { settingsStore } = await import("../src/settingsStore.js");
const { buildPlexPartUrl, plexPosterUrl } = await import("../src/clients/plex.js");

test("stream policy blocks relays, caps learned hosts, and keeps external links on known sites", () => {
  clearLearnedStreamHosts();
  assert.equal(addressKind("10.1.2.3"), "private");
  assert.equal(addressKind("169.254.169.254"), "linklocal");
  assert.equal(addressKind("::ffff:a00:1"), "private");
  assert.equal(addressKind("100.64.0.1"), "private");

  for (let i = 0; i < 2048; i++) {
    assert.equal(rememberStreamUrl(`http://h${i}.example/a.ts`), true);
  }
  assert.equal(rememberStreamUrl("http://overflow.example/a.ts"), false);
  const ticket = issueStreamTicket("http://h0.example/a.ts");
  assert.ok(ticket);
  clearLearnedStreamHosts();
  assert.equal(resolveStreamTicket(ticket), null);
  assert.equal(rememberStreamUrl("http://overflow.example/a.ts"), true);

  assert.equal(isSafePlexProbe("http://169.254.169.254/latest"), false);
  assert.equal(isSafePlexProbe("http://metadata.google.internal/"), false);
  assert.equal(isSafePlexProbe("http://192.168.1.5:32400"), true);
  assert.equal(isSafePlexProbe("http://localhost:32400"), true);
  assert.equal(isSafePlexProbe("http://user:pass@192.168.1.5:32400"), false);

  assert.equal(isTrustedExternal("javascript:alert(1)"), false);
  assert.equal(isTrustedExternal("http://evil.example"), false);
  assert.equal(isTrustedExternal("https://evil.trakt.tv.evil.com/activate"), false);
  assert.equal(isTrustedExternal("https://user:pass@trakt.tv/activate"), false);
  assert.equal(isTrustedExternal("https://trakt.tv/activate"), true);
  assert.equal(isTrustedExternal("https://www.plex.tv/link"), true);
  assert.equal(safeExternalUrl("https://evil.example/phish", "https://trakt.tv/activate"), "https://trakt.tv/activate");
  assert.equal(isAppNavigation("http://127.0.0.1:4173/library", 4173), true);
  assert.equal(isAppNavigation("http://localhost:4173/", 4173), true);
  assert.equal(isAppNavigation("http://127.0.0.1:4174/", 4173), false);
  assert.equal(isAppNavigation("https://127.0.0.1:4173/", 4173), false);
  assert.equal(isAppNavigation("javascript:alert(1)", 4173), false);

  settingsStore.setXtream({ baseUrl: "http://192.168.1.5:8080", username: "alice", password: "s3cret" });
  assert.equal(sanitizeArtworkUrl("http://192.168.1.5:8080/icon.png"), "http://192.168.1.5:8080/icon.png");
  assert.equal(sanitizeArtworkUrl("http://10.1.2.3/icon.png"), undefined);
  assert.equal(sanitizeArtworkUrl("javascript:alert(1)"), undefined);
  assert.equal(sanitizeArtworkUrl("http://user:s3cret@cdn.example/a.png"), undefined);
  assert.equal(sanitizeArtworkUrl("http://cdn.example/a.png"), "http://cdn.example/a.png");
  assert.equal(sanitizeArtworkUrl("http://router.local/a.png"), undefined);

  settingsStore.setPlex({ baseUrl: "http://plex.local:32400", token: "plex-token", serverName: "Test" });
  const poster = plexPosterUrl("/library/metadata/1/thumb?X-Plex-Token=plex-token");
  assert.ok(poster);
  assert.equal(poster.includes("plex-token"), false);
  assert.match(poster, /^\/api\/image\/plex\?path=/);
  assert.equal(plexPosterUrl("//evil.example/a.jpg"), undefined);

  const part = new URL(buildPlexPartUrl("http://plex.local:32400", "plex-token", "@evil.com/x"));
  assert.equal(part.hostname, "plex.local");
  assert.equal(part.username, "");
  assert.equal(part.searchParams.get("X-Plex-Token"), "plex-token");
  assert.throws(() => buildPlexPartUrl("http://plex.local:32400", "plex-token", "//evil.com/a"));

  clearLearnedStreamHosts();
});
