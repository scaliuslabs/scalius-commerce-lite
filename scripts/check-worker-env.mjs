#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const apps = [
  {
    name: "api",
    configs: ["apps/api/wrangler.jsonc", "apps/api/wrangler.local.jsonc"],
    envFiles: ["apps/api/src/env.d.ts", "apps/api/src/hono-env.d.ts"],
    extraEnv: [
      "BETTER_AUTH_SECRET",
      "API_TOKEN",
      "JWT_SECRET",
      "FIREBASE_SERVICE_ACCOUNT_CRED_JSON",
      "CREDENTIAL_ENCRYPTION_KEY",
      "PURGE_TOKEN",
      "PROJECT_CACHE_PREFIX",
      "FCM_SEND_CONCURRENCY",
    ],
  },
  {
    name: "admin-v2",
    configs: ["apps/admin-v2/wrangler.jsonc"],
    envFiles: ["apps/admin-v2/src/env.d.ts"],
    extraEnv: [
      "BETTER_AUTH_SECRET",
      "API_TOKEN",
      "JWT_SECRET",
      "FIREBASE_SERVICE_ACCOUNT_CRED_JSON",
      "CREDENTIAL_ENCRYPTION_KEY",
      "PURGE_TOKEN",
      "PROJECT_CACHE_PREFIX",
    ],
  },
  {
    name: "storefront",
    configs: ["apps/storefront/wrangler.jsonc"],
    envFiles: ["apps/storefront/src/env.d.ts"],
    extraEnv: ["API_TOKEN", "JWT_SECRET", "PURGE_TOKEN"],
  },
];

function readText(path) {
  return readFileSync(resolve(root, path), "utf8");
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

function readJsonc(path) {
  return JSON.parse(stripJsonc(readText(path)));
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

  return names;
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
  const patterns = [/interface\s+Env\s*{/g, /type\s+Env\s*=\s*{/g];

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

const errors = [];

for (const app of apps) {
  const expected = new Set();

  for (const configPath of app.configs) {
    for (const name of collectConfigNames(readJsonc(configPath))) {
      expected.add(name);
    }
  }

  const allowed = new Set([...expected, ...app.extraEnv]);

  for (const envPath of app.envFiles) {
    const actual = extractEnvNames(readText(envPath));
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

if (errors.length > 0) {
  console.error("Worker Env check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Worker Env OK: checked ${apps.length} apps, ${apps.reduce(
    (count, app) => count + app.envFiles.length,
    0,
  )} Env declaration files.`,
);
