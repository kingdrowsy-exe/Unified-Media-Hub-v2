import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "umh-urls-"));
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = "silent";

const { settingsStore } = await import("../src/settingsStore.js");
const { liveStreamUrl } = await import("../src/clients/xtream.js");
const { redactUrl } = await import("../src/redact.js");

test("Xtream stream URLs keep the password server-side and logs can strip it", () => {
  settingsStore.setXtream({
    baseUrl: "http://panel.example:8080",
    username: "user",
    password: "s3cret",
  });
  const upstream = liveStreamUrl(42);
  assert.equal(upstream, "http://panel.example:8080/live/user/s3cret/42.m3u8");
  assert.equal(redactUrl(upstream).includes("s3cret"), false);

  const saved = fs.readFileSync(path.join(dataDir, "settings.json"), "utf-8");
  assert.match(saved, /s3cret/);
  assert.equal(saved.startsWith("enc:v1:"), false);
});
