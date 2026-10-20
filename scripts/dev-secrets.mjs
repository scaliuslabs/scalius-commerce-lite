/**
 * The installed secrets local Workers need (AGENTS.md: SCALIUS_SECRET on both
 * Workers, CREDENTIAL_ENCRYPTION_KEY on the API), and where `pnpm dev` finds
 * them: the Worker's .dev.vars file, else the process environment. Wrangler
 * reads the process env only for the names a config declares under
 * `secrets.required` (apps/api/wrangler.local.jsonc, and the storefront's
 * generated dev config below), so no other shell variable becomes a binding.
 * Never reads a .dev.vars file; only checks that one exists.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripJsonc } from "./check-worker-env.mjs";

export const INSTALLED_SECRETS = Object.freeze({
  api: Object.freeze(["SCALIUS_SECRET", "CREDENTIAL_ENCRYPTION_KEY"]),
  storefront: Object.freeze(["SCALIUS_SECRET"]),
});

/** Name of the storefront's dev-only Wrangler config, written beside wrangler.jsonc (gitignored). */
export const STOREFRONT_DEV_CONFIG = "wrangler.dev.gen.json";

/**
 * Writes a dev copy of a Wrangler config with `secrets.required` set, beside
 * the original so relative paths and .dev.vars resolve the same. Returns its path.
 */
export function writeDevWranglerConfig(configUrl, required) {
  const source = fileURLToPath(configUrl);
  const config = JSON.parse(stripJsonc(readFileSync(source, "utf8")));
  const out = join(dirname(source), STOREFRONT_DEV_CONFIG);
  const text = `${JSON.stringify({ ...config, secrets: { required: [...required] } }, null, 2)}\n`;
  if (!existsSync(out) || readFileSync(out, "utf8") !== text) writeFileSync(out, text);
  return out;
}

/** Whether the process env carries every installed secret one Worker needs (values are not checked here). */
export function processEnvHasSecrets(worker, env = process.env) {
  return INSTALLED_SECRETS[worker].every((name) => typeof env[name] === "string" && env[name].trim() !== "");
}
