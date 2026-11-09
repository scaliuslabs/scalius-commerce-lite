#!/usr/bin/env node
/**
 * A local Wrangler state folder belongs to the dev secrets it was created
 * with: SCALIUS_SECRET derives the password pepper, session and token keys,
 * and CREDENTIAL_ENCRYPTION_KEY encrypts saved provider credentials. Another
 * checkout (a worktree) generates its own secrets, so pointing it at the same
 * `--state` would leave every stored password, session and credential
 * unreadable, and the admin would get 401 with no reason given.
 *
 * The state records a one-way fingerprint of each secret (never the value,
 * and nothing that recovers it). A stack (scripts/dev.sh) or a helper that
 * starts the API (scripts/dev-admin.mjs) checks it first: a new state records
 * this checkout's fingerprints, a matching state starts, and a mismatched one
 * refuses with the ways out. `dev:admin:reset` adopts the state for this
 * checkout, since it recreates the sign-ins under the current secret.
 *
 *   node scripts/dev-state-secrets.mjs check [--state <dir>]
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { devStateDir } from "./dev-ports.mjs";
import { readEnvVarsIfExists } from "./dev-local-utils.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The file in a state folder that records its secrets' fingerprints. */
export const STATE_SECRETS_FILE = "scalius-dev-secrets.json";

const SECRETS = Object.freeze(["SCALIUS_SECRET", "CREDENTIAL_ENCRYPTION_KEY"]);

/** A one-way, salted, truncated fingerprint: it tells two secrets apart and reveals nothing of either. */
export function secretFingerprint(name, value) {
  return createHash("sha256").update(`scalius-dev-state\0${name}\0${value}`).digest("hex").slice(0, 16);
}

/**
 * Fingerprints of the secrets the API Worker of this checkout binds: its
 * apps/api/.dev.vars, else the process environment (Wrangler's fallback).
 * Null when a secret is not set at all.
 */
export function checkoutSecretFingerprints({ root = ROOT, env = process.env } = {}) {
  const file = readEnvVarsIfExists(join(root, "apps", "api", ".dev.vars"));
  const entries = SECRETS.map((name) => {
    const value = file ? file[name] : env[name];
    return [name, value ? secretFingerprint(name, value) : null];
  });
  return entries.every(([, fingerprint]) => fingerprint) ? Object.fromEntries(entries) : null;
}

/** True when the state already holds a local database. */
export function stateHasDatabase(stateDir) {
  const d1 = join(stateDir, "v3", "d1");
  if (!existsSync(d1)) return false;
  const walk = (dir) => readdirSync(dir, { withFileTypes: true })
    .some((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".sqlite"));
  return walk(d1);
}

function readRecord(stateDir) {
  try {
    const record = JSON.parse(readFileSync(join(stateDir, STATE_SECRETS_FILE), "utf8"));
    return SECRETS.every((name) => typeof record?.[name] === "string") ? record : null;
  } catch {
    return null;
  }
}

/** Records these fingerprints as the state's own. */
export function recordStateSecrets(stateDir, fingerprints) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, STATE_SECRETS_FILE), `${JSON.stringify(Object.fromEntries(SECRETS.map((name) => [name, fingerprints[name]])))}\n`);
}

/**
 * Checks a state folder against this checkout's secrets. Returns
 * `{ status, mismatched }`: "recorded" (a new state, or one from before
 * fingerprints, now records this checkout's), "match", "mismatch" (the
 * secrets named in `mismatched` differ), or "no-secrets" (this checkout has
 * no local secrets yet; nothing is recorded).
 */
export function checkStateSecrets(stateDir, fingerprints) {
  if (!fingerprints) return { status: "no-secrets", mismatched: [] };
  const record = readRecord(stateDir);
  if (!record) {
    recordStateSecrets(stateDir, fingerprints);
    return { status: "recorded", mismatched: [], adopted: stateHasDatabase(stateDir) };
  }
  const mismatched = SECRETS.filter((name) => record[name] !== fingerprints[name]);
  return { status: mismatched.length === 0 ? "match" : "mismatch", mismatched };
}

/** What to tell the developer when a state belongs to other secrets. */
export function stateSecretsMismatchMessage(stateDir, mismatched) {
  return [
    `The local state ${stateDir} was created with a different ${mismatched.join(" and ")} than this checkout's apps/api/.dev.vars.`,
    "Its admin passwords, sessions and access tokens would not verify (every sign-in answers 401), and saved provider credentials would not decrypt.",
    "Choose one:",
    "  - give this checkout its own state: pnpm dev ... --state <a new directory>",
    `  - keep this state and recreate its sign-ins under this checkout's secrets: pnpm dev:admin:reset --state ${stateDir}`,
    "    (orders, products and settings stay; re-enter saved provider credentials in the dashboard)",
    "  - run the stack from the checkout that created this state.",
  ].join("\n");
}

/** Throws the mismatch message when the state belongs to other secrets; records a new state's. */
export function assertStateSecrets({ state, env = process.env, root = ROOT } = {}) {
  const stateDir = devStateDir({ env, state });
  const result = checkStateSecrets(stateDir, checkoutSecretFingerprints({ root, env }));
  if (result.status === "mismatch") throw new Error(stateSecretsMismatchMessage(stateDir, result.mismatched));
  return { ...result, stateDir };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const stateIndex = rest.indexOf("--state");
  const state = stateIndex >= 0 ? rest[stateIndex + 1] : undefined;
  if (command === "check") {
    const result = assertStateSecrets({ state });
    if (result.status === "recorded") {
      console.log(result.adopted
        ? `Local state ${result.stateDir} now records this checkout's secrets (it had no record; if sign-ins answer 401, run pnpm dev:admin:reset --state ${result.stateDir}).`
        : `Local state ${result.stateDir} records this checkout's secrets.`);
    }
    return;
  }
  console.error("Usage: node scripts/dev-state-secrets.mjs check [--state <dir>]");
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
