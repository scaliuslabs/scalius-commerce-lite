// The measured stack: the API under `wrangler dev` (local D1/KV/R2 on the
// harness state) and the BUILT storefront (`astro build` output) under
// `wrangler dev`. Wrangler's dev registry is machine-wide, so the API gets the
// port-derived name from scripts/dev-ports.mjs (`scalius-api-local-9001`), the
// storefront's BACKEND_API binding targets that name, both use a private
// registry, and start() fails fast unless the storefront renders this stack's
// origins. Secrets are fresh random values in a temp env file, so no
// `.dev.vars` is read.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devApiWorkerName, localStorefrontWorkerConfig, verifyStorefrontBinding } from "../../dev-ports.mjs";
import { API_DIR, STOREFRONT_DIR, assertLocalDatabase, assertOwnedState, childEnv, kvValueUrl, origins, wranglerBin } from "./context.mjs";
import { killTree, startGroup, waitForUrl } from "./proc.mjs";

export const STOREFRONT_CONFIG = join(STOREFRONT_DIR, "dist", "server", "wrangler.fidelity.json");

export function writeSecretsFile(file) {
  writeFileSync(file, [
    `SCALIUS_SECRET=${randomBytes(48).toString("base64")}`,
    `CREDENTIAL_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    "",
  ].join("\n"), { mode: 0o600 });
  return file;
}

/** `astro build` of the storefront (no `astro check`: the harness measures, typecheck is separate). */
export function buildStorefront(logFile) {
  const env = childEnv();
  execFileSync(process.execPath, ["scripts/generate-build-id.js"], { cwd: STOREFRONT_DIR, env, stdio: "ignore" });
  const astro = join(STOREFRONT_DIR, "node_modules", "astro", "bin", "astro.mjs");
  const out = execFileSync(process.execPath, ["--max-old-space-size=2048", astro, "build"], { cwd: STOREFRONT_DIR, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  if (logFile) writeFileSync(logFile, out);
}

export function storefrontBuilt() {
  return existsSync(join(STOREFRONT_DIR, "dist", "server", "wrangler.json")) && existsSync(join(STOREFRONT_DIR, "dist", "server", "entry.mjs"));
}

/** The API worker name of a harness stack (scripts/dev-ports.mjs). */
export function apiWorkerName(ports) {
  return devApiWorkerName({ api: ports.api });
}

/** The built Worker's config, rebound to this run's API worker and ports. */
export function writeStorefrontConfig(ports) {
  const built = JSON.parse(readFileSync(join(STOREFRONT_DIR, "dist", "server", "wrangler.json"), "utf8"));
  const config = localStorefrontWorkerConfig(built, { apiWorkerName: apiWorkerName(ports), port: ports.storefront, inspectorPort: ports.storefrontInspector });
  writeFileSync(STOREFRONT_CONFIG, JSON.stringify(config, null, 1));
  return STOREFRONT_CONFIG;
}

export class Stack {
  constructor({ stateDir, ports, runDir }) {
    this.stateDir = assertOwnedState(stateDir);
    this.ports = ports;
    this.runDir = runDir;
    this.api = null;
    this.storefront = null;
    this.registry = join(runDir, "registry");
    this.secrets = join(runDir, "secrets.env");
  }

  env() {
    // A soft Go memory limit makes the resident esbuild watch service return
    // its build garbage; local observability traces are not needed.
    return childEnv({
      WRANGLER_REGISTRY_PATH: this.registry, X_LOCAL_EXPLORER: "true", X_LOCAL_OBSERVABILITY: "false", GOMEMLIMIT: "256MiB", GOGC: "50",
    });
  }

  /** Why the stack is not serving, or null when both Workers are up. */
  deadReason() {
    for (const [name, child] of [["API", this.api], ["storefront", this.storefront]]) {
      if (!child) return `${name} not started`;
      if (child.exitCode !== null || child.signalCode !== null) return `${name} wrangler exited (${child.exitCode ?? child.signalCode}); see ${name === "API" ? "api" : "storefront"}.log`;
    }
    return null;
  }

  /** Both Workers answer within a few seconds. */
  async healthy() {
    const ok = async (url) => {
      try {
        await fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.arrayBuffer());
        return true;
      } catch {
        return false;
      }
    };
    return !this.deadReason()
      && await ok(`http://localhost:${this.ports.api}/api/v1/platform`)
      && await ok(`http://localhost:${this.ports.storefront}/favicon.svg`);
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async start() {
    assertLocalDatabase();
    mkdirSync(this.registry, { recursive: true });
    if (!existsSync(this.secrets)) writeSecretsFile(this.secrets);
    const wrangler = wranglerBin();
    this.api = startGroup("api", process.execPath, [
      wrangler, "dev", "--config", "wrangler.local.jsonc", "--local", "--name", apiWorkerName(this.ports), "--port", String(this.ports.api),
      "--inspector-port", String(this.ports.apiInspector), "--persist-to", this.stateDir,
      "--env-file", this.secrets, "--show-interactive-dev-session=false",
    ], { cwd: API_DIR, env: this.env(), logFile: join(this.runDir, "api.log") });
    await waitForUrl(`http://localhost:${this.ports.api}/api/v1/platform`, { timeoutMs: 180000, child: this.api });
    writeStorefrontConfig(this.ports);
    this.storefront = startGroup("storefront", process.execPath, [
      wrangler, "dev", "-c", STOREFRONT_CONFIG, "--local", "--persist-to", this.stateDir, "--port", String(this.ports.storefront),
      "--inspector-port", String(this.ports.storefrontInspector), "--env-file", this.secrets, "--show-interactive-dev-session=false",
    ], { cwd: STOREFRONT_DIR, env: this.env(), logFile: join(this.runDir, "storefront.log") });
    await waitForUrl(`http://localhost:${this.ports.storefront}/favicon.svg`, { timeoutMs: 180000, child: this.storefront });
    // The Platform KV mirror is a hint the API rebuilds from D1 (dev-ports.mjs).
    await fetch(kvValueUrl(this.ports, "settings:platform"), { method: "DELETE" }).catch(() => {});
    // Fail fast when the storefront's BACKEND_API reached another stack's API.
    const o = origins(this.ports);
    await verifyStorefrontBinding({ storefrontUrl: o.storefrontUrl, mediaUrl: o.mediaUrl });
  }

  async kvPut(key, value) {
    const r = await fetch(kvValueUrl(this.ports, key), { method: "PUT", body: value });
    if (!r.ok) throw new Error(`KV ${key} write failed (${r.status})`);
  }

  async stop() {
    const left = [];
    if (this.storefront) left.push(...(await killTree(this.storefront.pid)));
    if (this.api) left.push(...(await killTree(this.api.pid)));
    this.storefront = null;
    this.api = null;
    rmSync(STOREFRONT_CONFIG, { force: true });
    return left;
  }
}
