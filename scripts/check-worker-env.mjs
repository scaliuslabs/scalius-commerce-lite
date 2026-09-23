#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

// The only Wrangler `vars` entry any config may declare: the dev-only mailbox
// sink in apps/api/wrangler.local.jsonc. Every other runtime value is either an
// installed secret or a dashboard Platform setting (GET /api/v1/platform).
export const ALLOWED_WRANGLER_VARS = Object.freeze({
  "apps/api/wrangler.local.jsonc": Object.freeze(["LOCAL_MAILPIT_URL"]),
});

// The per-store resource shape: one KV namespace, one R2 bucket, one jobs
// queue (plus its DLQ), two rate limiters. Other users share these by key
// prefix; a new binding of these kinds needs an explicit architecture decision.
export const ALLOWED_RESOURCE_BINDINGS = Object.freeze({
  kv_namespaces: Object.freeze(["CACHE"]),
  r2_buckets: Object.freeze(["BUCKET"]),
  ratelimits: Object.freeze(["RL_STRICT", "RL_STANDARD"]),
  queue_producers: Object.freeze(["JOBS_QUEUE"]),
});

export function collectResourceBindingViolations(configPath, config) {
  const declared = {
    kv_namespaces: (config?.kv_namespaces ?? []).map((entry) => entry.binding),
    r2_buckets: (config?.r2_buckets ?? []).map((entry) => entry.binding),
    ratelimits: (config?.ratelimits ?? []).map((entry) => entry.name),
    queue_producers: (config?.queues?.producers ?? []).map((entry) => entry.binding),
  };
  return Object.entries(declared).flatMap(([kind, names]) => {
    const extra = sorted(names.filter((name) => !ALLOWED_RESOURCE_BINDINGS[kind].includes(name)));
    return extra.length === 0 ? [] : [
      `${configPath} declares ${kind} ${extra.join(", ")}. `
      + `Only ${ALLOWED_RESOURCE_BINDINGS[kind].join(", ")} may exist; share them by key prefix instead.`,
    ];
  });
}

// Installed secrets and optional provider selection shared by API + admin.
const INSTALLED_SECRETS = ["SCALIUS_SECRET", "CREDENTIAL_ENCRYPTION_KEY"];
const OPTIONAL_DATABASE_PROVIDER_ENV = [
  "DATABASE_PROVIDER",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "POSTGRES_DATABASE_URL",
  "HYPERDRIVE",
  "DATABASE_MIGRATION_FREEZE",
];

export const apps = [
  {
    name: "api",
    configs: ["apps/api/wrangler.jsonc", "apps/api/wrangler.local.jsonc"],
    // One Env declaration per Worker. apps/api/src/hono-env.d.ts only augments
    // Hono's ContextVariableMap and references this same global Env.
    envFiles: ["apps/api/src/env.d.ts"],
    envScanDir: "apps/api/src",
    extraEnv: [
      ...INSTALLED_SECRETS,
      ...OPTIONAL_DATABASE_PROVIDER_ENV,
      // Derived at Worker entry from SCALIUS_SECRET (apps/api/src/runtime/runtime-env.ts).
      "BETTER_AUTH_SECRET",
      "JWT_SECRET",
      "API_TOKEN",
      "AGENT_TOKEN_PEPPER",
      "CUSTOMER_SESSION_HASH_KEY",
      "ADMIN_SETUP_TOKEN",
      "FRONT_PROXY_SECRET",
      "IDENTITY_HANDOFF_SECRET",
      // Resolved at Worker entry from dashboard Platform settings.
      "PLATFORM_CONFIG",
      "STOREFRONT_URL",
      "PUBLIC_API_BASE_URL",
      "BETTER_AUTH_URL",
      "R2_PUBLIC_URL",
      "CDN_DOMAIN_URL",
      "CUSTOMER_AUTH_COOKIE_DOMAIN",
      "CORS_ALLOWED_ORIGINS",
      // Local development only (apps/api/wrangler.local.jsonc vars).
      "LOCAL_MAILPIT_URL",
    ],
  },
  {
    name: "admin-v2",
    configs: ["apps/admin-v2/wrangler.jsonc"],
    envFiles: ["apps/admin-v2/src/env.d.ts"],
    envScanDir: "apps/admin-v2/src",
    extraEnv: [
      ...INSTALLED_SECRETS,
      ...OPTIONAL_DATABASE_PROVIDER_ENV,
      // Derived per request from SCALIUS_SECRET.
      "BETTER_AUTH_SECRET",
      "IDENTITY_HANDOFF_SECRET",
      "FRONT_PROXY_SECRET",
      // Resolved per request from GET /api/v1/platform.
      "BETTER_AUTH_URL",
      "PUBLIC_API_BASE_URL",
      "STOREFRONT_URL",
      "R2_PUBLIC_URL",
      "PLATFORM_CONFIG",
      // Local development only (admin vite dev config).
      "LOCAL_MAILPIT_URL",
    ],
  },
  {
    name: "storefront",
    configs: ["apps/storefront/wrangler.jsonc"],
    envFiles: ["apps/storefront/src/env.d.ts"],
    envScanDir: "apps/storefront/src",
    extraEnv: ["SCALIUS_SECRET"],
  },
];

function readText(path) {
  return readFileSync(resolve(root, path), "utf8");
}

/** Repo-relative paths of every `.d.ts` file under `dir`. */
function listDeclarationFiles(dir) {
  const entries = readdirSync(resolve(root, dir), {
    withFileTypes: true,
    recursive: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".d.ts"))
    .map((entry) => `${relative(root, resolve(entry.parentPath ?? entry.path, entry.name))}`);
}

function stripJsonc(input) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < input.length &&
        !(input[index] === "*" && input[index + 1] === "/")
      ) {
        if (input[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output.replace(/,\s*([}\]])/g, "$1");
}

function collectConfigNames(config) {
  const names = new Set(Object.keys(config.vars ?? {}));

  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (!value || typeof value !== "object") return;

    if (typeof value.binding === "string") {
      names.add(value.binding);
    }

    for (const child of Object.values(value)) {
      visit(child);
    }
  }

  visit(config);

  for (const binding of config.durable_objects?.bindings ?? []) {
    if (typeof binding.name === "string") {
      names.add(binding.name);
    }
  }

  for (const binding of config.send_email ?? []) {
    if (typeof binding.name === "string") {
      names.add(binding.name);
    }
  }

  for (const binding of config.ratelimits ?? []) {
    if (typeof binding.name === "string") {
      names.add(binding.name);
    }
  }

  return names;
}

/**
 * Wrangler `vars` are forbidden: URLs and other runtime configuration are
 * dashboard Platform settings, and secrets are installed with
 * `wrangler secret put`. Returns one message per offending config.
 */
export function collectWranglerVarsViolations(configPath, config) {
  const allowed = new Set(ALLOWED_WRANGLER_VARS[configPath] ?? []);
  const declared = Object.keys(config?.vars ?? {});
  const forbidden = sorted(declared.filter((name) => !allowed.has(name)));
  if (forbidden.length === 0) return [];

  const allowedNote = allowed.size > 0
    ? ` Only ${sorted(allowed).join(", ")} may stay in this file.`
    : "";
  return [
    `${configPath} declares Wrangler vars ${forbidden.join(", ")}. `
    + "Wrangler vars are not read: configure URLs, cookie domain, and CORS origins "
    + "in the dashboard (Settings -> System -> Platform, served by GET /api/v1/platform) "
    + "and install secrets with `wrangler secret put`."
    + allowedNote,
  ];
}

function extractBalancedBlock(source, startIndex) {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex + 1, index);
      }
    }
  }

  throw new Error("Unclosed Env block");
}

function extractEnvBlocks(source) {
  const blocks = [];
  const patterns = [
    /interface\s+Env\s*{/g,
    /type\s+Env\s*=\s*{/g,
    // Wrangler 4 emits bindings into a generated base interface and has the
    // public Env interface extend it. Read that generated source of truth
    // instead of forcing deployable Workers back to hand-written Env blocks.
    /interface\s+__BaseEnv_[A-Za-z_$][A-Za-z0-9_$]*\s*{/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const start = source.indexOf("{", match.index);
      blocks.push(extractBalancedBlock(source, start));
    }
  }

  return blocks;
}

function extractEnvNames(source) {
  const names = new Set();

  for (const block of extractEnvBlocks(source)) {
    for (const line of block.split("\n")) {
      const match = line.match(
        /^\s*(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/,
      );
      if (match) {
        names.add(match[1]);
      }
    }
  }

  return names;
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

/**
 * A Worker declares its Cloudflare bindings in exactly one file. A second
 * `Env` interface or type alias anywhere else in the same Worker silently
 * drifts from the first, so fail closed on it.
 */
export function collectDuplicateEnvDeclarations(app, {
  readTextImpl = readText,
  listDeclarationFilesImpl = listDeclarationFiles,
} = {}) {
  if (!app.envScanDir) return [];
  const declared = new Set(app.envFiles);
  const offenders = listDeclarationFilesImpl(app.envScanDir)
    .filter((path) => !declared.has(path))
    .filter((path) => extractEnvBlocks(readTextImpl(path)).length > 0);

  return sorted(offenders).map((path) => (
    `${app.name}:${path} declares a second Env block. `
    + `Keep exactly one Env declaration per Worker (${app.envFiles.join(", ")}) `
    + "and reference that global Env instead of redeclaring it."
  ));
}

export function runWorkerEnvCheck({ readTextImpl = readText } = {}) {
  const errors = [];
  let checkedEnvFileCount = 0;
  const readJsoncWith = (path) => JSON.parse(stripJsonc(readTextImpl(path)));

  for (const configPath of apps[0].configs) {
    const config = readJsoncWith(configPath);
    if (config.cache?.enabled !== true ||
      config.exports?.default?.cache?.enabled !== false ||
      config.exports?.PublicApi?.cache?.enabled !== true) {
      errors.push(`${configPath} must keep the default API entrypoint uncached and PublicApi Workers Caching enabled`);
    }
  }

  for (const app of apps) {
    const expected = new Set();

    for (const configPath of app.configs) {
      const config = readJsoncWith(configPath);
      errors.push(...collectWranglerVarsViolations(configPath, config));
      errors.push(...collectResourceBindingViolations(configPath, config));
      for (const name of collectConfigNames(config)) {
        expected.add(name);
      }
    }

    const allowed = new Set([...expected, ...app.extraEnv]);
    errors.push(...collectDuplicateEnvDeclarations(app, { readTextImpl }));

    for (const envPath of app.envFiles) {
      checkedEnvFileCount += 1;
      const actual = extractEnvNames(readTextImpl(envPath));
      const missing = sorted([...expected].filter((name) => !actual.has(name)));
      const extra = sorted([...actual].filter((name) => !allowed.has(name)));
      const label = `${app.name}:${relative(root, resolve(root, envPath))}`;

      if (missing.length > 0) {
        errors.push(`${label} is missing Wrangler names: ${missing.join(", ")}`);
      }

      if (extra.length > 0) {
        errors.push(`${label} declares names not present in Wrangler configs or the explicit secret/override allowlist: ${extra.join(", ")}`);
      }
    }
  }

  return { errors, checkedEnvFileCount };
}

export { collectConfigNames, extractEnvBlocks, extractEnvNames, stripJsonc };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { errors, checkedEnvFileCount } = runWorkerEnvCheck();

  if (errors.length > 0) {
    console.error("Worker Env check failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `Worker Env OK: checked ${apps.length} apps, ${checkedEnvFileCount} Env declaration files.`,
  );
}
