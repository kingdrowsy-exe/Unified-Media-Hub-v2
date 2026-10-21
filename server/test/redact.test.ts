import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recordCrash } from "../src/crashLog.js";
import { redactText, redactUrl } from "../src/redact.js";

test("redacts credentials in query strings, userinfo, and Xtream paths", () => {
  const tokenUrl = "http://plex.example:32400/library/parts/1?X-Plex-Token=super-secret";
  assert.equal(redactUrl(tokenUrl).includes("super-secret"), false);
  assert.match(redactUrl(tokenUrl), /X-Plex-Token=%5Bredacted%5D|X-Plex-Token=\[redacted\]/);

  const proxy = "/api/hls?u=" + encodeURIComponent("http://cdn.example/live/user/s3cret/9.m3u8");
  const redacted = redactUrl(proxy);
  assert.equal(redacted.includes("s3cret"), false);
  assert.match(redacted, /u=%5Bredacted%5D|u=\[redacted\]/);

  const direct = "http://user:s3cret@panel.example/live/user/s3cret/9.m3u8?password=s3cret";
  const safe = redactUrl(direct);
  assert.equal(safe.includes("s3cret"), false);
  assert.match(safe, /\/live\/user\/\[redacted\]\/9\.m3u8/);
  assert.match(safe, /user:\[redacted\]@/);

  assert.equal(redactText(`fetch failed ${direct}`).includes("s3cret"), false);
});

test("writes crash.log under DATA_DIR without credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umh-crash-"));
  process.env.DATA_DIR = dir;
  recordCrash("test", new Error("boom http://user:s3cret@panel.example/live/user/s3cret/9.m3u8"));
  const text = fs.readFileSync(path.join(dir, "crash.log"), "utf-8");
  assert.match(text, /test/);
  assert.match(text, /boom/);
  assert.equal(text.includes("s3cret"), false);
});
