#!/usr/bin/env node
/**
 * Operator tool: derive one opt-in automation secret from `SCALIUS_SECRET`.
 *
 * A deployment installs exactly one secret per Worker. Every other runtime
 * secret is derived from it with HKDF-SHA256 and a fixed purpose label, so an
 * operator (or the automation that provisions the store) never installs a
 * second credential. This script computes the same value the Worker computes
 * at request time, using the one shared implementation in
 * `packages/shared/src/runtime-secrets.ts` — the algorithm is never restated
 * here, so the two can never drift.
 *
 * Only the three automation purposes can be derived. The session, JWT,
 * service-token, purge-token, agent-pepper, and customer-session keys are
 * needed exclusively inside a Worker; printing them to a terminal would move a
 * live credential into shell history and scrollback for no operational gain.
 *
 * The master secret is never accepted as a command-line argument (arguments
 * are visible to every process on the host) and is never echoed or logged.
 * Read it from an interactive hidden prompt (the default), from standard input
 * (`--stdin`), or from the environment (`--from-env`).
 *
 * Requires Node 24, which runs the TypeScript source of the shared module
 * directly.
 *
 *   pnpm exec node scripts/derive-runtime-secret.mjs --purpose admin-setup
 *   printf %s "$SCALIUS_SECRET" | pnpm exec node scripts/derive-runtime-secret.mjs \
 *     --purpose front-proxy --stdin
 */
import { readHiddenLine } from "./demo-store/credentials.mjs";

const sharedRuntimeSecrets = new URL(
  "../packages/shared/src/runtime-secrets.ts",
  import.meta.url,
);

/** The purposes an operator may derive outside a Worker. */
export const DERIVABLE_AUTOMATION_SECRETS = Object.freeze({
  ADMIN_SETUP_TOKEN: "admin-setup",
  FRONT_PROXY_SECRET: "front-proxy",
  IDENTITY_HANDOFF_SECRET: "identity-handoff",
});

function usage() {
  return `Usage:
  pnpm exec node scripts/derive-runtime-secret.mjs --purpose <purpose> [--stdin | --from-env] [--json]

Purposes:
  admin-setup       ADMIN_SETUP_TOKEN      value for the X-Scalius-Setup-Token header
  front-proxy       FRONT_PROXY_SECRET     HMAC key a trusted front proxy signs with
  identity-handoff  IDENTITY_HANDOFF_SECRET  HS256 key for dashboard handoff tokens

The master secret is read from an interactive hidden prompt, from standard input
with --stdin, or from SCALIUS_SECRET with --from-env. It is never accepted as an
argument and never printed.`;
}

export function parseDeriveArgs(argv) {
  const result = { help: false, json: false, stdin: false, fromEnv: false, purpose: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--json") result.json = true;
    else if (argument === "--stdin") result.stdin = true;
    else if (argument === "--from-env") result.fromEnv = true;
    else if (/^--(?:secret|master|master-secret|scalius-secret|password)(?:=|$)/iu.test(argument)) {
      throw new Error("The master secret is never accepted as an argument. Use --stdin, --from-env, or the interactive prompt.");
    } else if (argument === "--purpose") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Option --purpose requires a value.");
      result.purpose = value;
      index += 1;
    } else if (argument.startsWith("--purpose=")) {
      const value = argument.slice("--purpose=".length);
      if (!value) throw new Error("Option --purpose requires a value.");
      result.purpose = value;
    } else {
      throw new Error(`Unknown option: ${argument}\n${usage()}`);
    }
  }
  if (result.stdin && result.fromEnv) {
    throw new Error("Choose either --stdin or --from-env, not both.");
  }
  if (!result.help && !result.purpose) {
    throw new Error(`Option --purpose is required.\n${usage()}`);
  }
  return result;
}

/** Accepts either the purpose label (`admin-setup`) or the secret name. */
export function resolvePurpose(value) {
  const requested = String(value ?? "").trim();
  const byName = DERIVABLE_AUTOMATION_SECRETS[requested.toUpperCase().replace(/-/gu, "_")];
  if (byName) return { name: requested.toUpperCase().replace(/-/gu, "_"), purpose: byName };
  const entry = Object.entries(DERIVABLE_AUTOMATION_SECRETS).find(([, label]) => label === requested);
  if (entry) return { name: entry[0], purpose: entry[1] };
  throw new Error(
    `Unknown purpose "${requested}". Derivable automation purposes: ${Object.values(DERIVABLE_AUTOMATION_SECRETS).join(", ")}.`,
  );
}

async function readStdin(input) {
  const chunks = [];
  for await (const chunk of input) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function readMasterSecretInput(args, {
  input = process.stdin,
  output = process.stderr,
  env = process.env,
  hiddenReader = readHiddenLine,
} = {}) {
  if (args.fromEnv) {
    const value = String(env.SCALIUS_SECRET ?? "").trim();
    if (!value) throw new Error("SCALIUS_SECRET is not set in this environment.");
    return value;
  }
  if (args.stdin) {
    const value = (await readStdin(input)).trim();
    if (!value) throw new Error("No master secret arrived on standard input.");
    return value;
  }
  const value = String(await hiddenReader("SCALIUS_SECRET: ", { input, output })).trim();
  if (!value) throw new Error("A master secret is required.");
  return value;
}

export async function main(argv = process.argv.slice(2), {
  log = console.log,
  warn = console.error,
  isTty = () => Boolean(process.stdout.isTTY),
  ...io
} = {}) {
  const args = parseDeriveArgs(argv);
  if (args.help) {
    log(usage());
    return 0;
  }
  const { name, purpose } = resolvePurpose(args.purpose);
  const master = await readMasterSecretInput(args, io);
  const { deriveRuntimeSecret } = await import(sharedRuntimeSecrets.href);
  const secret = await deriveRuntimeSecret(master, purpose);
  if (isTty()) {
    warn(`Warning: ${name} was written to a terminal. Clear the scrollback when you are done.`);
  }
  log(args.json ? JSON.stringify({ name, purpose, secret }) : secret);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
