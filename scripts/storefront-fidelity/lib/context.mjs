// Shared run context: repo paths, ports, the state directory the harness owns,
// and the guards that keep it away from shared or hosted data.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HARNESS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = resolve(HARNESS_DIR, "..", "..");
export const API_DIR = join(ROOT, "apps", "api");
export const STOREFRONT_DIR = join(ROOT, "apps", "storefront");

/** The cache KV namespace both local Workers bind (wrangler.local.jsonc). */
export const CACHE_KV_NAMESPACE = "d6e2d77d898e4b3f9c186802ce63f9b8";

export const TEMPLATES = Object.freeze([
  "boutique", "heritage-editorial", "fashion-value", "spec-catalogue", "rounded-tech",
  "marketplace", "mass-retail", "department-mall", "daily-essentials", "showcase-landing",
]);

export const DEFAULT_PORTS = Object.freeze({ api: 9001, storefront: 4601, admin: 4602, media: 4603, chrome: 9601 });

/** The main checkout (a worktree's git common dir parent), for gitignored audit evidence. */
export function mainCheckoutRoot() {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ROOT, encoding: "utf8" }).trim();
    return dirname(common);
  } catch {
    return ROOT;
  }
}

/**
 * Refuses a state directory inside any repo `.wrangler` (the shared dev state
 * of this checkout or of the main checkout). The harness state is always a
 * directory it created or copied itself.
 */
export function assertOwnedState(stateDir) {
  const resolved = existsSync(stateDir) ? realpathSync(stateDir) : resolve(stateDir);
  for (const base of [ROOT, mainCheckoutRoot()]) {
    const shared = join(base, ".wrangler");
    const sharedReal = existsSync(shared) ? realpathSync(shared) : shared;
    if (resolved === sharedReal || resolved.startsWith(sharedReal + sep)) {
      throw new Error(`Refusing the shared wrangler state at ${shared}. The fidelity harness only runs on a state it owns.`);
    }
  }
  return resolved;
}

/** Refuses a hosted relational provider: the harness is D1-local only. */
export function assertLocalDatabase(env = process.env) {
  const provider = (env.DATABASE_PROVIDER ?? "").toLowerCase();
  if (provider && provider !== "d1") throw new Error(`Refusing DATABASE_PROVIDER=${provider}: the fidelity harness runs on a local D1 state only.`);
  for (const key of ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "POSTGRES_DATABASE_URL"]) {
    if (env[key]) throw new Error(`Refusing ${key} in the environment: the fidelity harness never talks to a hosted database.`);
  }
}

/** A child-process environment with nothing that could point at hosted data. */
export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ["DATABASE_PROVIDER", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "POSTGRES_DATABASE_URL", "CLOUDFLARE_INCLUDE_PROCESS_ENV", "CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
  return { ...env, CI: "1", WRANGLER_SEND_METRICS: "false", ...extra };
}

export function d1File(stateDir) {
  const dir = join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject");
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".sqlite") && n !== "metadata.sqlite") : [];
  if (files.length !== 1) throw new Error(`Expected exactly one D1 sqlite file under ${dir}; found ${files.length}.`);
  return join(dir, files[0]);
}

export function openDb(stateDir) {
  const db = new DatabaseSync(d1File(assertOwnedState(stateDir)));
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
  return db;
}

export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const apiRequire = createRequire(join(API_DIR, "package.json"));
const storefrontRequire = createRequire(join(STOREFRONT_DIR, "package.json"));

/** Imports repo TypeScript (extensionless imports included) through tsx. */
let tsxApi;
export async function importTs(relativePath) {
  tsxApi ??= await import(pathToFileURL(apiRequire.resolve("tsx/esm/api")).href);
  return tsxApi.tsImport(join(ROOT, relativePath), import.meta.url);
}

export async function loadSharp() {
  const mod = await import(pathToFileURL(storefrontRequire.resolve("sharp")).href);
  return mod.default;
}

export function wranglerBin() {
  const pkg = apiRequire.resolve("wrangler/package.json");
  return join(dirname(pkg), "bin", "wrangler.js");
}

/** Local explorer endpoint of the API's wrangler dev (KV writes during a run). */
export function kvValueUrl(ports, key) {
  return `http://localhost:${ports.api}/cdn-cgi/local/explorer/api/storage/kv/namespaces/${CACHE_KV_NAMESPACE}/values/${encodeURIComponent(key)}`;
}

/** Platform origins of the stack; media comes from the harness media server (lib/media-server.mjs). */
export function origins(ports) {
  const apiUrl = `http://localhost:${ports.api}`;
  return { apiUrl, storefrontUrl: `http://localhost:${ports.storefront}`, dashboardUrl: `http://localhost:${ports.admin}`, mediaUrl: `http://localhost:${ports.media}` };
}
