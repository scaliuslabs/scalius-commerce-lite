import { login } from "./auth.js";
import { promptLine } from "./agent.js";
import { ConfigStore, normalizeServer } from "./config.js";
import { renderDoctor, runDoctor, doctorExitCode, type DoctorReport } from "./doctor.js";
import { CliError } from "./errors.js";
import { detectHarnesses, installHarness, parseHarnesses, type HarnessInstall } from "./harness.js";
import type { Audience } from "./mcp-client.js";
import { MCP_SERVER_NAMES, launchCommand, materializePlugin, type McpServerEntry } from "./plugin.js";
import { writeDiagnostic } from "./output.js";
import type { ResolvedProfile, Runtime } from "./types.js";

// `scalius init`: one command from nothing to a working agent. It pairs the
// CLI once (the only login), installs the skills and the stdio MCP server
// into every agent harness it finds, and proves the connection with doctor.

export interface InitOptions {
  server?: string;
  harness: string;
  storefront: boolean;
  auth: boolean;
  open: boolean;
  profileName?: string;
}

export interface InitResult {
  ok: boolean;
  server: string;
  profiles: Partial<Record<Audience, string>>;
  harnesses: HarnessInstall[];
  doctor: DoctorReport | null;
  next: string[];
}

function profileNameFor(server: string, audience: Audience, existing: readonly string[]): string {
  const base = existing.length === 0 ? "default" : new URL(server).hostname.replace(/[^A-Za-z0-9.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 60) || "store";
  return audience === "storefront" ? `${base}-storefront` : base;
}

/** A saved, unexpired credential for this server and audience, if one exists. */
async function existingProfile(runtime: Runtime, server: string, audience: Audience): Promise<ResolvedProfile | undefined> {
  const store = new ConfigStore(runtime);
  const [config, credentials] = await Promise.all([store.loadConfig(), store.loadCredentials()]);
  const names = Object.keys(config.profiles).sort((left, right) =>
    Number(right === config.activeProfiles?.[audience]) - Number(left === config.activeProfiles?.[audience]) || left.localeCompare(right));
  for (const name of names) {
    const credential = credentials.credentials[name];
    if (config.profiles[name]?.server !== server || !credential || (credential.resource ?? "dashboard") !== audience) continue;
    if (credential.pendingAcknowledgement) continue;
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= runtime.now()) continue;
    return store.resolveProfile(name, true);
  }
  return undefined;
}

async function resolveServer(runtime: Runtime, requested?: string): Promise<string> {
  if (requested) return normalizeServer(requested);
  const environment = runtime.env.SCALIUS_SERVER?.trim();
  if (environment) return normalizeServer(environment);
  const store = new ConfigStore(runtime);
  const config = await store.loadConfig();
  const active = config.activeProfile ? config.profiles[config.activeProfile]?.server : undefined;
  if (active) return active;
  if (runtime.stdin.isTTY && runtime.stderr.isTTY) {
    const answer = await promptLine(runtime, "Your store's API address (for example https://api.yourstore.com): ");
    if (answer) return normalizeServer(answer);
  }
  throw new CliError(2, "server_required", "Tell init which store to connect.", undefined, {
    hint: "Run: npx scalius@latest init --server https://api.yourstore.com (Settings > Agent access shows the exact line).",
  });
}

export async function runInit(runtime: Runtime, options: InitOptions): Promise<{ result: InitResult; exitCode: number }> {
  const server = await resolveServer(runtime, options.server);
  const requested = parseHarnesses(options.harness);
  const harnesses = requested === "auto" ? await detectHarnesses(runtime) : requested;
  const audiences: Audience[] = options.storefront ? ["dashboard", "storefront"] : ["dashboard"];
  const store = new ConfigStore(runtime);
  const profiles: Partial<Record<Audience, string>> = {};
  const next: string[] = [];

  for (const audience of audiences) {
    const reusable = await existingProfile(runtime, server, audience);
    if (reusable) {
      profiles[audience] = reusable.name;
      continue;
    }
    if (!options.auth) {
      next.push(`Pair the ${audience} audience: scalius auth login --server ${server}${audience === "storefront" ? " --resource storefront" : ""}`);
      continue;
    }
    const config = await store.loadConfig();
    const name = options.profileName
      ? (audience === "storefront" ? `${options.profileName}-storefront` : options.profileName)
      : profileNameFor(server, audience, Object.keys(config.profiles));
    writeDiagnostic(runtime, `Connecting ${audience === "dashboard" ? "your store" : "the storefront audience"}: approve this device in the browser.`);
    await login(runtime, { server, profileName: name, openBrowser: options.open, resource: audience });
    profiles[audience] = name;
  }

  const servers: McpServerEntry[] = audiences.map((audience) => ({
    audience,
    name: MCP_SERVER_NAMES[audience],
    launch: launchCommand(runtime, audience, profiles[audience]),
  }));
  const bundle = await materializePlugin(runtime, servers);
  const installs: HarnessInstall[] = [];
  for (const harness of harnesses) {
    const install = await installHarness(runtime, harness, servers, bundle);
    installs.push(install);
    if (install.mcp.status === "manual" && install.mcp.next) next.push(`${harness}: ${install.mcp.next}`);
  }

  let doctor: DoctorReport | null = null;
  if (profiles.dashboard) {
    doctor = await runDoctor(runtime, { profile: profiles.dashboard, audience: "dashboard", harnesses });
  }
  next.push("Restart your agent, then ask it: \"How did my store do today?\"");
  const ok = doctor?.ok ?? false;
  return {
    result: { ok: ok || (!options.auth && installs.length > 0), server, profiles, harnesses: installs, doctor, next },
    exitCode: doctor ? doctorExitCode(doctor) : 0,
  };
}

export function renderInit(result: InitResult): string {
  const lines = [`Scalius connected to ${result.server}`];
  for (const [audience, name] of Object.entries(result.profiles)) lines.push(`  signed in   ${audience} as profile '${name}'`);
  for (const install of result.harnesses) {
    lines.push(`  ${install.harness.padEnd(10)}  skills: ${install.skills}`);
    lines.push(`  ${"".padEnd(10)}  mcp: ${install.mcp.status} via ${install.mcp.via} (${install.mcp.servers.join(", ")})`);
  }
  if (result.doctor) lines.push("", renderDoctor(result.doctor));
  if (result.next.length > 0) lines.push("", "Next:", ...result.next.map((step) => `  - ${step}`));
  return lines.join("\n");
}
