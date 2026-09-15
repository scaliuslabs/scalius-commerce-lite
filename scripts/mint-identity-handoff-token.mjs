#!/usr/bin/env node
/**
 * Operator tool: mint one short-lived dashboard identity-handoff token.
 *
 * When a managed control plane owns the operator identity, it signs a token
 * that the dashboard's Better Auth handoff endpoint verifies before it creates
 * an admin session. The signing key is derived from `SCALIUS_SECRET` with the
 * `identity-handoff` purpose, so no second secret is ever installed; the same
 * derivation is available on its own through `derive-runtime-secret.mjs`.
 *
 * Tokens are deliberately hard to misuse: at most a 120-second lifetime, a
 * single-use `jti` the Worker records in its audit ledger, and a purpose claim
 * that keeps a sign-in token from being replayed against the revoke endpoint.
 *
 * The signature is plain HS256 over the compact JWT, computed here with
 * `node:crypto` so the tool has no dependencies an operator must install.
 * `scripts/mint-identity-handoff-token.test.mjs` verifies every token this
 * script mints with the Worker's own verifier, so the two cannot drift.
 *
 * The master secret is never accepted as an argument, never echoed, and never
 * logged. Requires Node 24.
 *
 *   pnpm exec node scripts/mint-identity-handoff-token.mjs \
 *     --issuer https://control-plane.example --audience scalius-dashboard \
 *     --email operator@example.com --role owner \
 *     --dashboard-url https://shop.example.com/dashboard --from-env
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  parseDeriveArgs,
  readMasterSecretInput,
  resolvePurpose,
} from "./derive-runtime-secret.mjs";

const sharedRuntimeSecrets = new URL(
  "../packages/shared/src/runtime-secrets.ts",
  import.meta.url,
);

/** Mirrors `IDENTITY_HANDOFF_MAX_LIFETIME_SECONDS` in the Worker's verifier. */
export const MAX_HANDOFF_LIFETIME_SECONDS = 120;
export const DEFAULT_HANDOFF_LIFETIME_SECONDS = 60;
export const HANDOFF_PURPOSES = Object.freeze({
  handoff: "dashboard-handoff",
  revoke: "dashboard-revoke",
});
/** Better Auth mounts the plugin under the dashboard's own base path. */
export const HANDOFF_ENDPOINT_PATH = "/api/auth/handoff";
export const HANDOFF_REVOKE_ENDPOINT_PATH = "/api/auth/handoff/revoke";

function usage() {
  return `Usage:
  pnpm exec node scripts/mint-identity-handoff-token.mjs --issuer <url> --audience <aud> \\
    --email <address> [--role <role>] [--name <display name>] [--subject <id>] \\
    [--mode handoff|revoke] [--suspend] [--lifetime <seconds>] \\
    [--dashboard-url <url>] [--stdin | --from-env] [--json]

The issuer and audience must match the Platform settings of the target store.
Roles are the dashboard's own role names, or "owner" for the store owner.
--suspend is valid only with --mode revoke. Lifetime is at most ${MAX_HANDOFF_LIFETIME_SECONDS} seconds.

The master secret is read from an interactive hidden prompt, from standard input
with --stdin, or from SCALIUS_SECRET with --from-env. It is never accepted as an
argument and never printed.`;
}

const VALUE_OPTIONS = new Map([
  ["--issuer", "issuer"],
  ["--audience", "audience"],
  ["--email", "email"],
  ["--role", "role"],
  ["--name", "name"],
  ["--subject", "subject"],
  ["--mode", "mode"],
  ["--lifetime", "lifetime"],
  ["--dashboard-url", "dashboardUrl"],
]);

export function parseMintArgs(argv) {
  const result = {
    help: false, json: false, stdin: false, fromEnv: false, suspend: false, mode: "handoff",
  };
  const passthrough = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--suspend") {
      result.suspend = true;
    } else if (VALUE_OPTIONS.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Option ${argument} requires a value.`);
      result[VALUE_OPTIONS.get(argument)] = value;
      index += 1;
    } else {
      const matched = [...VALUE_OPTIONS].find(([flag]) => argument.startsWith(`${flag}=`));
      if (matched) {
        const value = argument.slice(matched[0].length + 1);
        if (!value) throw new Error(`Option ${matched[0]} requires a value.`);
        result[matched[1]] = value;
      } else {
        passthrough.push(argument);
      }
    }
  }
  // Secret-source and help flags share one definition with the derive tool.
  const shared = parseDeriveArgs([...passthrough, "--purpose", "identity-handoff"]);
  result.help = shared.help;
  result.json = shared.json;
  result.stdin = shared.stdin;
  result.fromEnv = shared.fromEnv;
  if (result.help) return result;

  if (!Object.hasOwn(HANDOFF_PURPOSES, result.mode)) {
    throw new Error(`Option --mode must be "handoff" or "revoke".`);
  }
  for (const [flag, key] of [["--issuer", "issuer"], ["--audience", "audience"], ["--email", "email"]]) {
    if (!result[key]) throw new Error(`Option ${flag} is required.\n${usage()}`);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(result.email)) {
    throw new Error("Option --email must be a complete e-mail address.");
  }
  if (result.mode === "handoff" && !result.role) {
    throw new Error('Option --role is required for a sign-in token ("owner" for the store owner).');
  }
  if (result.suspend && result.mode !== "revoke") {
    throw new Error("Option --suspend is valid only with --mode revoke.");
  }
  result.lifetime = parseLifetime(result.lifetime);
  if (result.dashboardUrl) result.dashboardUrl = parseDashboardUrl(result.dashboardUrl);
  return result;
}

function parseLifetime(value) {
  if (value === undefined) return DEFAULT_HANDOFF_LIFETIME_SECONDS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_HANDOFF_LIFETIME_SECONDS) {
    throw new Error(`Option --lifetime must be between 1 and ${MAX_HANDOFF_LIFETIME_SECONDS} seconds.`);
  }
  return parsed;
}

function parseDashboardUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Option --dashboard-url must be an absolute URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Option --dashboard-url must be an http(s) URL.");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

/** Compact HS256 JWT. Kept dependency-free for operators; see the test. */
export function signCompactHs256(secret, claims) {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

/** Proves a minted token verifies locally before it is handed to an operator. */
export function verifyCompactHs256(secret, token) {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return false;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function buildHandoffClaims(args, { now = Math.floor(Date.now() / 1000), jti = randomBytes(18).toString("base64url") } = {}) {
  return {
    iss: args.issuer,
    aud: args.audience,
    sub: args.subject ?? args.email,
    jti,
    iat: now,
    exp: now + args.lifetime,
    purpose: HANDOFF_PURPOSES[args.mode],
    email: args.email,
    email_verified: true,
    ...(args.name ? { name: args.name } : {}),
    ...(args.role ? { role: args.role } : {}),
    ...(args.suspend ? { suspend: true } : {}),
  };
}

export function buildHandoffUrl(dashboardUrl, mode, token) {
  if (!dashboardUrl) return undefined;
  if (mode === "revoke") return `${dashboardUrl}${HANDOFF_REVOKE_ENDPOINT_PATH}`;
  const url = new URL(`${dashboardUrl}${HANDOFF_ENDPOINT_PATH}`);
  url.searchParams.set("token", token);
  return url.toString();
}

export async function main(argv = process.argv.slice(2), {
  log = console.log,
  warn = console.error,
  isTty = () => Boolean(process.stdout.isTTY),
  now,
  jti,
  ...io
} = {}) {
  const args = parseMintArgs(argv);
  if (args.help) {
    log(usage());
    return 0;
  }
  const { purpose } = resolvePurpose("identity-handoff");
  const master = await readMasterSecretInput(args, io);
  const { deriveRuntimeSecret } = await import(sharedRuntimeSecrets.href);
  const signingKey = await deriveRuntimeSecret(master, purpose);

  const claims = buildHandoffClaims(args, {
    ...(now === undefined ? {} : { now }),
    ...(jti === undefined ? {} : { jti }),
  });
  const token = signCompactHs256(signingKey, claims);
  if (!verifyCompactHs256(signingKey, token)) {
    throw new Error("The minted token failed local verification and was discarded.");
  }
  const url = buildHandoffUrl(args.dashboardUrl, args.mode, token);

  if (isTty()) {
    warn(`Warning: this token signs in as ${claims.email} for ${args.lifetime} seconds. Clear the scrollback when you are done.`);
  }
  if (args.json) {
    log(JSON.stringify({
      token,
      purpose: claims.purpose,
      jti: claims.jti,
      expiresAt: claims.exp,
      ...(url ? { url } : {}),
    }));
  } else {
    log(token);
    if (url) log(url);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
