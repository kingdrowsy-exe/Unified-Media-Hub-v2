import fs from "node:fs";
import path from "node:path";

function crashLogPath(): string {
  const dir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dir, "crash.log");
}

export function recordCrash(kind: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const line = `[${new Date().toISOString()}] ${kind}\n${detail}\n`;
  try {
    fs.mkdirSync(path.dirname(crashLogPath()), { recursive: true });
    fs.appendFileSync(crashLogPath(), line);
  } catch (writeErr) {
    console.error("Failed to write crash.log:", writeErr);
  }
  console.error(line);
}

/**
 * Undici throws these outside the request promise when a provider truncates
 * a response. They belong to that one socket, not to the whole process.
 */
export function isIsolatedUpstreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = "code" in err && typeof err.code === "string" ? err.code : "";
  if (code.startsWith("UND_ERR_")) return true;
  const blob = `${err.name} ${code} ${err.message}`;
  return /undici|Content-Length mismatch|Parse Error/i.test(blob);
}
