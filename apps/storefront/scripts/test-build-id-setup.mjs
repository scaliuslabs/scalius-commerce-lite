// Vitest global setup: storefront modules import the generated
// src/config/build-id.ts, which a fresh checkout or worktree does not have
// until a build, typecheck or `pnpm dev` writes it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default function setup() {
  if (existsSync(fileURLToPath(new URL("../src/config/build-id.ts", import.meta.url)))) return;
  const script = fileURLToPath(new URL("./generate-build-id.js", import.meta.url));
  const result = spawnSync(process.execPath, [script], { stdio: "ignore" });
  if (result.status !== 0) throw new Error("apps/storefront/scripts/generate-build-id.js failed.");
}
