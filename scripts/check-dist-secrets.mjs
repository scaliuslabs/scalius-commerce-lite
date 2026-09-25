#!/usr/bin/env node
/**
 * Fails when an app's build output carries local env values.
 *
 * Builds must never inline a local `.dev.vars`/`.env*` value or a shell
 * credential: runtime secrets come only from the Worker `env` at request time.
 * This scans every text file under `<app>/dist` (server and browser output)
 * and reports only file paths and variable NAMES, never values:
 *
 * - local env files (`.dev.vars*`, `.env*`) copied into dist;
 * - an `import.meta.env` object carrying anything beyond the bundler's
 *   built-in keys (Astro/Vite inlining of private or PUBLIC_ variables);
 * - a known secret name, or a name declared in a local env file, bound to a
 *   string literal (`NAME: "..."`, `NAME = "..."`). The derived-secret HKDF
 *   purpose labels in @scalius/shared/runtime-secrets are the only allowed
 *   bindings;
 * - in browser-served output, any mention of an installed secret name;
 * - with `--canary <value>` (repeatable), any occurrence of a synthetic canary.
 *
 * Usage: node scripts/check-dist-secrets.mjs [--canary VALUE]... [appDir...]
 * Default apps: apps/api apps/admin-v2 apps/storefront.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { RUNTIME_SECRET_PURPOSES } from "../packages/shared/src/runtime-secrets.ts";

const root = resolve(import.meta.dirname, "..");
export const defaultApps = ["apps/api", "apps/admin-v2", "apps/storefront"];

/** The installed Worker secrets (apps/*\/src/env.d.ts). Never named in browser output. */
export const INSTALLED_SECRET_NAMES = Object.freeze(["SCALIUS_SECRET", "CREDENTIAL_ENCRYPTION_KEY"]);

/** Every name that holds a credential on some deployment path. */
export const KNOWN_SECRET_NAMES = Object.freeze([
  ...INSTALLED_SECRET_NAMES,
  ...Object.keys(RUNTIME_SECRET_PURPOSES),
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "POSTGRES_DATABASE_URL",
  "CLOUDFLARE_API_TOKEN",
]);

// The keys Astro and Vite put in `import.meta.env` without any env file.
const BUILT_IN_IMPORT_META_ENV_KEYS = new Set(["ASSETS_PREFIX", "BASE_URL", "DEV", "MODE", "PROD", "SITE", "SSR"]);
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".wasm", ".mp4", ".webm", ".mp3", ".pdf", ".zip", ".gz", ".br",
]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isLocalEnvFileName(name) {
  return name === ".dev.vars" || name.startsWith(".dev.vars.") || name.endsWith(".vars")
    || name === ".env" || name.startsWith(".env.");
}

/** Key names declared in env-file text. Values are discarded line by line. */
export function parseEnvFileNames(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/** Names declared in the app's local env files (never their values). */
export function localEnvNames(appDir) {
  if (!existsSync(appDir)) return [];
  return readdirSync(appDir)
    .filter((name) => isLocalEnvFileName(name) && !name.endsWith(".example"))
    .flatMap((name) => parseEnvFileNames(readFileSync(join(appDir, name), "utf8")));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function objectKeys(body) {
  return [...body.matchAll(/(?:^|[,{])\s*(\\?["'`]?)([A-Za-z_$][\w$]*)\1\s*:/g)].map((m) => m[2]);
}

/**
 * Violations in one file's text. `browser` marks output served to browsers.
 * Messages carry names only.
 */
export function scanText(text, { names, browser = false, canaries = [] }) {
  const found = [];
  // Astro/Vite `import.meta.env` objects: `{ BASE_URL: "/", ..., MODE: "production", ... }`.
  for (const match of text.matchAll(/\{([^{}]*\bMODE\\?["'`]?\s*:[^{}]*)\}/g)) {
    const keys = objectKeys(match[1]);
    if (!keys.includes("BASE_URL")) continue;
    const extra = keys.filter((key) => !BUILT_IN_IMPORT_META_ENV_KEYS.has(key));
    if (extra.length > 0) found.push(`import.meta.env carries ${[...new Set(extra)].join(", ")}`);
  }
  // Astro's private-env merge: Object.assign({...import.meta.env}, { NAME: "value" }).
  for (const match of text.matchAll(/Object\.assign\(\s*\{[^{}]*\bMODE\b[^{}]*\}\s*,\s*\{([^{}]*)\}\s*\)/g)) {
    const keys = objectKeys(match[1]);
    if (keys.length > 0) found.push(`private env inlined: ${[...new Set(keys)].join(", ")}`);
  }
  for (const name of names) {
    if (!text.includes(name)) continue;
    const bound = new RegExp(
      `(?<![\\w$])\\\\?["'\`]?${escapeRegExp(name)}\\\\?["'\`]?\\s*[:=]\\s*(\\\\?["'\`])((?:(?!\\1)[^\\n])*)\\1`,
      "g",
    );
    for (const match of text.matchAll(bound)) {
      if (RUNTIME_SECRET_PURPOSES[name] === match[2]) continue;
      found.push(`${name} is bound to a string literal`);
      break;
    }
    if (browser && INSTALLED_SECRET_NAMES.includes(name) && new RegExp(`\\b${name}\\b`).test(text)) {
      found.push(`${name} is named in browser output`);
    }
  }
  for (const [index, canary] of canaries.entries()) {
    if (canary && text.includes(canary)) found.push(`canary #${index + 1} found`);
  }
  return [...new Set(found)];
}

function* distFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* distFiles(path);
    else if (entry.isFile()) yield path;
  }
}

/** Violations for one app directory (e.g. apps/storefront), as "path: message". */
export function checkAppDist(appDir, { canaries = [], extraNames = [] } = {}) {
  const distDir = join(appDir, "dist");
  if (!existsSync(distDir)) return [];
  const names = [...new Set([...KNOWN_SECRET_NAMES, ...localEnvNames(appDir), ...extraNames])]
    .filter((name) => IDENTIFIER.test(name));
  const violations = [];
  for (const file of distFiles(distDir)) {
    const rel = relative(root, file);
    if (isLocalEnvFileName(basename(file))) {
      violations.push(`${rel}: local env file in build output`);
      continue;
    }
    if (BINARY_EXTENSIONS.has(extname(file).toLowerCase()) || statSync(file).size > 32 * 1024 * 1024) continue;
    // Worker code: Astro's dist/server and the API's wrangler --outdir bundle.
    const relToDist = relative(distDir, file);
    const server = relToDist.startsWith(`server${sep}`) || basename(appDir) === "api";
    const text = readFileSync(file, "utf8");
    for (const message of scanText(text, { names, browser: !server, canaries })) {
      violations.push(`${rel}: ${message}`);
    }
  }
  return violations;
}

function parseArgs(argv) {
  const canaries = [];
  const apps = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--canary") canaries.push(argv[(i += 1)] ?? "");
    else apps.push(argv[i]);
  }
  return { canaries: canaries.filter(Boolean), apps: apps.length > 0 ? apps : defaultApps };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { canaries, apps } = parseArgs(process.argv.slice(2));
  const violations = apps.flatMap((app) => checkAppDist(resolve(root, app), { canaries }));
  if (violations.length > 0) {
    console.error("Build output carries local env values (names only):");
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error("Delete the dist output and rebuild; see docs/ARCHITECTURE.md (Build outputs and secrets).");
    process.exit(1);
  }
  console.log(`Dist secret check: OK (${apps.join(", ")})`);
}
