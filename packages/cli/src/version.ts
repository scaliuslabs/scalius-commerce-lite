import { readFileSync } from "node:fs";
import { CliError } from "./errors.js";

let cached: string | undefined;

/** The published package version (also stamped on installed skills and the plugin manifests). */
export function packageVersion(): string {
  if (cached) return cached;
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new CliError(8, "invalid_package", "The installed Scalius package version is invalid.");
  }
  cached = manifest.version;
  return cached;
}
