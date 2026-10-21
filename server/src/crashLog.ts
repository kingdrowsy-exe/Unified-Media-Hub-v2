import fs from "node:fs";
import path from "node:path";
import { redactText } from "./redact.js";

function crashLogPath(): string {
  const dir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dir, "crash.log");
}

export function recordCrash(kind: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const line = `[${new Date().toISOString()}] ${kind}\n${redactText(detail)}\n`;
  try {
    fs.mkdirSync(path.dirname(crashLogPath()), { recursive: true });
    fs.appendFileSync(crashLogPath(), line);
  } catch (writeErr) {
    console.error("Failed to write crash.log:", writeErr);
  }
  console.error(line);
}
