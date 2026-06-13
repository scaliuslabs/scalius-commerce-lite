#!/usr/bin/env node
/**
 * dev-setup.mjs — One-command local development setup
 *
 * Usage: pnpm dev:setup
 *
 * 1. Installs dependencies
 * 2. Generates secrets and creates .dev.vars for all three apps
 * 3. Creates .env.development for admin + storefront (Vite/Astro build-time vars)
 * 4. Applies local D1 migrations
 * 5. Creates the default local admin account unless --skip-admin is passed
 */

import { execSync } from "child_process";
import { appendFileSync, existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  assertLocalSecretSync,
  assertPassword,
  getArgValue,
  readEnvVarsIfExists,
  resolveLocalStatePath,
  resolveSharedLocalSecrets,
  shellQuote,
} from "./dev-local-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const adminDir = resolve(root, "apps", "admin-v2");
const apiDir = resolve(root, "apps", "api");
const storefrontDir = resolve(root, "apps", "storefront");
const args = process.argv.slice(2);
const forceRegenerate = args.includes("--force");
const skipInstall = args.includes("--skip-install");
const skipAdmin = args.includes("--skip-admin");
const envOnly = args.includes("--env-only") || args.includes("--repair-env");
const showHelp = args.includes("--help") || args.includes("-h");

let wranglerState;
let localAdminEmail;
let localAdminPassword;
let localAdminName;
try {
  wranglerState = getArgValue(args, "--state") || process.env.SCALIUS_WRANGLER_STATE;
  localAdminEmail = getArgValue(args, "--admin-email") || process.env.LOCAL_ADMIN_EMAIL || "admin@local.scalius.test";
  localAdminPassword = getArgValue(args, "--admin-password") || process.env.LOCAL_ADMIN_PASSWORD || "ScaliusLocal123!";
  localAdminName = getArgValue(args, "--admin-name") || process.env.LOCAL_ADMIN_NAME || "Local Admin";
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const resolvedWranglerState = wranglerState ? resolveLocalStatePath(root, wranglerState) : null;

if (resolvedWranglerState) {
  process.env.SCALIUS_WRANGLER_STATE = resolvedWranglerState;
}

const apiDevVarsPath = resolve(apiDir, ".dev.vars");
const adminDevVarsPath = resolve(adminDir, ".dev.vars");
const storefrontDevVarsPath = resolve(storefrontDir, ".dev.vars");
const existingApiVars = readEnvVarsIfExists(apiDevVarsPath);
const existingAdminVars = readEnvVarsIfExists(adminDevVarsPath);
const existingStorefrontVars = readEnvVarsIfExists(storefrontDevVarsPath);
const {
  betterAuthSecret,
  jwtSecret,
  apiToken,
  purgeToken,
  credentialEncryptionKey,
} = resolveSharedLocalSecrets({
  forceRegenerate,
  apiVars: existingApiVars,
  adminVars: existingAdminVars,
  storefrontVars: existingStorefrontVars,
});

const apiDevVars = {
  BETTER_AUTH_SECRET: betterAuthSecret,
  JWT_SECRET: jwtSecret,
  API_TOKEN: apiToken,
  CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
  PURGE_TOKEN: purgeToken,
  BETTER_AUTH_URL: "http://localhost:4323",
  PUBLIC_API_BASE_URL: "http://localhost:8787",
  STOREFRONT_URL: "http://localhost:4322",
  R2_PUBLIC_URL: "http://localhost:8787/api/v1/media",
  PURGE_URL: "http://localhost:4322/api/purge-cache",
};

const adminDevVars = {
  BETTER_AUTH_SECRET: betterAuthSecret,
  JWT_SECRET: jwtSecret,
  API_TOKEN: apiToken,
  CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
  BETTER_AUTH_URL: "http://localhost:4323",
  PUBLIC_API_BASE_URL: "http://localhost:8787",
  STOREFRONT_URL: "http://localhost:4322",
  R2_PUBLIC_URL: "http://localhost:8787/api/v1/media",
};

const storefrontDevVars = {
  API_TOKEN: apiToken,
  JWT_SECRET: jwtSecret,
  PURGE_TOKEN: purgeToken,
  PUBLIC_API_URL: "http://localhost:8787/api/v1",
  PUBLIC_API_BASE_URL: "http://localhost:8787",
  STOREFRONT_URL: "http://localhost:4322",
};
const adminBuildEnv = {
  PUBLIC_API_BASE_URL: "http://localhost:8787",
};
const storefrontBuildEnv = {
  PUBLIC_API_URL: "http://localhost:8787/api/v1",
  PUBLIC_API_BASE_URL: "http://localhost:8787",
  STOREFRONT_URL: "http://localhost:4322",
};

if (showHelp) {
  console.log(`
Usage: pnpm dev:setup [options]

Options:
  --force                    Regenerate local env files
  --env-only                 Create/repair env files only; skip install, migrations, admin
  --skip-install             Do not run pnpm install
  --skip-admin               Do not create the default local admin
  --admin-email <email>      Local admin email (default: ${localAdminEmail})
  --admin-password <value>   Local admin password, 12+ chars (default: ${localAdminPassword})
  --admin-name <name>        Local admin name (default: ${localAdminName})
  --state <path>             Wrangler local state path; relative paths resolve from repo root
`);
  process.exit(0);
}

if (!skipAdmin && !envOnly) {
  try {
    assertPassword(localAdminPassword);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function run(cmd, label) {
  console.log(`\n▶ ${label}`);
  console.log(`  $ ${cmd}\n`);
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

function appendMissingEnvVars(filePath, expectedValues, label) {
  const currentValues = readEnvVarsIfExists(filePath);
  if (!currentValues) return;

  const missingEntries = Object.entries(expectedValues).filter(([key]) => {
    const current = currentValues[key];
    return !current || current.trim() === "" || current.trim() === "<auto-generated>";
  });
  if (missingEntries.length === 0) return;

  const block = [
    "",
    "# Added by pnpm dev:setup to repair local development env.",
    ...missingEntries.map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
  appendFileSync(filePath, block);
  console.log(`  ✓ Added missing ${missingEntries.map(([key]) => key).join(", ")} to ${label}`);
}

console.log("\n🚀 Scalius Commerce — Local Development Setup\n");
console.log("=".repeat(55));

// 1. Install dependencies
if (skipInstall || envOnly) {
  console.log("\n⚡ Skipping dependency install");
} else {
  run("pnpm install", "Installing dependencies");
}

// 2. Create .dev.vars for all apps. Existing shared secrets are reused so
// partially missing local env files do not desynchronize API/admin/storefront.
// API Worker .dev.vars
if (existsSync(apiDevVarsPath) && !forceRegenerate) {
  console.log(
    "\n⚡ apps/api/.dev.vars already exists — skipping (use --force to regenerate)"
  );
} else {
  console.log("\n▶ Generating secrets and creating apps/api/.dev.vars");
  const devVars = [
    "# Auto-generated by: pnpm dev:setup",
    "# Cloudflare runtime bindings for local development (API Worker).",
    "",
    "# ── Secrets ──",
    `BETTER_AUTH_SECRET=${apiDevVars.BETTER_AUTH_SECRET}`,
    `JWT_SECRET=${apiDevVars.JWT_SECRET}`,
    `API_TOKEN=${apiDevVars.API_TOKEN}`,
    `CREDENTIAL_ENCRYPTION_KEY=${apiDevVars.CREDENTIAL_ENCRYPTION_KEY}`,
    `PURGE_TOKEN=${apiDevVars.PURGE_TOKEN}`,
    "",
    "# ── Local overrides ──",
    `BETTER_AUTH_URL=${apiDevVars.BETTER_AUTH_URL}`,
    `PUBLIC_API_BASE_URL=${apiDevVars.PUBLIC_API_BASE_URL}`,
    `STOREFRONT_URL=${apiDevVars.STOREFRONT_URL}`,
    `R2_PUBLIC_URL=${apiDevVars.R2_PUBLIC_URL}`,
    `PURGE_URL=${apiDevVars.PURGE_URL}`,
    "",
  ].join("\n");
  writeFileSync(apiDevVarsPath, devVars);
  console.log("  ✓ Created apps/api/.dev.vars");
}
appendMissingEnvVars(apiDevVarsPath, apiDevVars, "apps/api/.dev.vars");

// Admin Worker .dev.vars
if (existsSync(adminDevVarsPath) && !forceRegenerate) {
  console.log(
    "\n⚡ apps/admin-v2/.dev.vars already exists — skipping (use --force to regenerate)"
  );
} else {
  console.log("\n▶ Generating secrets and creating apps/admin-v2/.dev.vars");
  // Use the SAME secrets as API so both workers can validate tokens
  const devVars = [
    "# Auto-generated by: pnpm dev:setup",
    "# Cloudflare runtime bindings for local development (Admin V2 Worker).",
    "",
    "# ── Secrets (must match API worker) ──",
    `BETTER_AUTH_SECRET=${adminDevVars.BETTER_AUTH_SECRET}`,
    `JWT_SECRET=${adminDevVars.JWT_SECRET}`,
    `API_TOKEN=${adminDevVars.API_TOKEN}`,
    `CREDENTIAL_ENCRYPTION_KEY=${adminDevVars.CREDENTIAL_ENCRYPTION_KEY}`,
    "",
    "# ── Local overrides ──",
    `BETTER_AUTH_URL=${adminDevVars.BETTER_AUTH_URL}`,
    `PUBLIC_API_BASE_URL=${adminDevVars.PUBLIC_API_BASE_URL}`,
    `STOREFRONT_URL=${adminDevVars.STOREFRONT_URL}`,
    `R2_PUBLIC_URL=${adminDevVars.R2_PUBLIC_URL}`,
    "",
  ].join("\n");
  writeFileSync(adminDevVarsPath, devVars);
  console.log("  ✓ Created apps/admin-v2/.dev.vars");
}
appendMissingEnvVars(adminDevVarsPath, adminDevVars, "apps/admin-v2/.dev.vars");

// Storefront Worker .dev.vars
if (existsSync(storefrontDevVarsPath) && !forceRegenerate) {
  console.log(
    "\n⚡ apps/storefront/.dev.vars already exists — skipping (use --force to regenerate)"
  );
} else {
  console.log("\n▶ Generating secrets and creating apps/storefront/.dev.vars");
  const devVars = [
    "# Auto-generated by: pnpm dev:setup",
    "# Cloudflare runtime bindings for local development (Storefront Worker).",
    "",
    "# ── Secrets (must match API worker) ──",
    `API_TOKEN=${storefrontDevVars.API_TOKEN}`,
    `JWT_SECRET=${storefrontDevVars.JWT_SECRET}`,
    `PURGE_TOKEN=${storefrontDevVars.PURGE_TOKEN}`,
    "",
    "# ── Local overrides ──",
    `PUBLIC_API_URL=${storefrontDevVars.PUBLIC_API_URL}`,
    `PUBLIC_API_BASE_URL=${storefrontDevVars.PUBLIC_API_BASE_URL}`,
    `STOREFRONT_URL=${storefrontDevVars.STOREFRONT_URL}`,
    "",
  ].join("\n");
  writeFileSync(storefrontDevVarsPath, devVars);
  console.log("  ✓ Created apps/storefront/.dev.vars");
}
appendMissingEnvVars(storefrontDevVarsPath, storefrontDevVars, "apps/storefront/.dev.vars");

assertLocalSecretSync({
  apiVars: readEnvVarsIfExists(apiDevVarsPath),
  adminVars: readEnvVarsIfExists(adminDevVarsPath),
  storefrontVars: readEnvVarsIfExists(storefrontDevVarsPath),
});

// 3. Create .env.development for admin-v2 app (Vite build-time vars)
const envDevPath = resolve(adminDir, ".env.development");
if (existsSync(envDevPath) && !forceRegenerate) {
  console.log(
    "\n⚡ apps/admin-v2/.env.development already exists — skipping (use --force to regenerate)"
  );
} else {
  console.log("\n▶ Creating apps/admin-v2/.env.development");
  const envDev = [
    "# Auto-generated by: pnpm dev:setup",
    "# Vite build-time variables (available via import.meta.env.*)",
    ...Object.entries(adminBuildEnv).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
  writeFileSync(envDevPath, envDev);
  console.log("  ✓ Created apps/admin-v2/.env.development");
}
appendMissingEnvVars(envDevPath, adminBuildEnv, "apps/admin-v2/.env.development");

// Storefront .env.development (Vite/Astro build-time vars)
const storefrontEnvDevPath = resolve(storefrontDir, ".env.development");
if (existsSync(storefrontEnvDevPath) && !forceRegenerate) {
  console.log(
    "\n⚡ apps/storefront/.env.development already exists — skipping (use --force to regenerate)"
  );
} else {
  console.log("\n▶ Creating apps/storefront/.env.development");
  const envDev = [
    "# Auto-generated by: pnpm dev:setup",
    "# Vite/Astro build-time variables (available via import.meta.env.*)",
    ...Object.entries(storefrontBuildEnv).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
  writeFileSync(storefrontEnvDevPath, envDev);
  console.log("  ✓ Created apps/storefront/.env.development");
}
appendMissingEnvVars(storefrontEnvDevPath, storefrontBuildEnv, "apps/storefront/.env.development");

if (envOnly) {
  console.log("\n⚡ Env-only mode: skipping local D1 migrations and admin creation");
} else {
  // 4. Apply local D1 migrations (via API worker's wrangler config)
  run(
    "node scripts/deploy.mjs --migrate-only --local",
    "Applying local D1 migrations"
  );
}

// 5. Create default local admin through the same setup endpoint used by the UI.
if (envOnly) {
  // Already handled above.
} else if (skipAdmin) {
  console.log("\n⚡ Skipping local admin creation");
} else {
  run(
    [
      "node scripts/dev-admin.mjs create",
      `--email ${shellQuote(localAdminEmail)}`,
      `--password ${shellQuote(localAdminPassword)}`,
      `--name ${shellQuote(localAdminName)}`,
      "--skip-migrations",
      ...(resolvedWranglerState ? [`--state ${shellQuote(resolvedWranglerState)}`] : []),
    ].join(" "),
    "Creating default local admin if needed",
  );
}

console.log("\n" + "=".repeat(55));
console.log(envOnly ? "✅ Env repair complete!\n" : "✅ Setup complete!\n");
console.log("Next steps:");
if (envOnly) {
  console.log("  1. pnpm dev:doctor   — Re-check local readiness");
  console.log("  2. pnpm dev:setup    — Apply migrations and create local admin if needed");
  console.log("  3. pnpm dev          — Start API + admin + storefront\n");
} else {
  console.log("  1. pnpm dev          — Start API + admin + storefront");
  console.log("  2. http://localhost:4323/admin");
  if (!skipAdmin) {
    console.log(`  3. Sign in with ${localAdminEmail} / ${localAdminPassword}\n`);
  } else {
    console.log("  3. Create the first admin in the browser or run pnpm dev:admin:create\n");
  }
}
