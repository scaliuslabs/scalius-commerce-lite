import { access, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CliError } from "./errors.js";
import { LOCAL_MARKETPLACE, PLUGIN_NAME, mcpConfig, type McpServerEntry } from "./plugin.js";
import { installSkillSuite, readSkillStamp, removeSkillSuite, skillRoot, type AgentHarness } from "./skill.js";
import type { CommandResult, Runtime } from "./types.js";
import { packageVersion } from "./version.js";

// Agent harnesses `scalius init` can connect: it finds them, installs the
// skills, and registers the stdio MCP server with each harness's own
// mechanism (a Claude Code plugin, a Codex plugin, or the harness config),
// replacing an earlier Scalius registration rather than adding a second.

export const INIT_HARNESSES = ["claude", "codex", "cursor", "opencode", "pi", "agents"] as const;
export type InitHarness = (typeof INIT_HARNESSES)[number];

export interface HarnessInstall {
  harness: InitHarness;
  skills: string;
  mcp: {
    status: "registered" | "manual";
    via: string;
    servers: string[];
    config?: unknown;
    next?: string;
  };
}

export interface HarnessCheck {
  id: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
  fix?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/** The first executable named `name` on PATH. */
export async function which(runtime: Runtime, name: string): Promise<string | undefined> {
  const extensions = runtime.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const directory of (runtime.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}

async function run(runtime: Runtime, command: string, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  if (!runtime.run) return { code: 127, stdout: "", stderr: "This environment cannot run local programs." };
  return runtime.run(command, args, { timeoutMs });
}

function codexHome(runtime: Runtime): string {
  return runtime.env.CODEX_HOME?.trim() || join(runtime.homedir(), ".codex");
}

/** Harnesses installed on this machine, by their command or their config directory. */
export async function detectHarnesses(runtime: Runtime): Promise<InitHarness[]> {
  const home = runtime.homedir();
  const found: InitHarness[] = [];
  if (await which(runtime, "claude") || await exists(join(home, ".claude"))) found.push("claude");
  if (await which(runtime, "codex") || await exists(codexHome(runtime))) found.push("codex");
  if (await which(runtime, "cursor-agent") || await exists(join(home, ".cursor"))) found.push("cursor");
  if (await which(runtime, "opencode") || await exists(join(home, ".config", "opencode"))) found.push("opencode");
  if (await which(runtime, "pi") || await exists(join(home, ".pi"))) found.push("pi");
  return found.length > 0 ? found : ["agents"];
}

export function parseHarnesses(value: string): InitHarness[] | "auto" {
  if (value === "auto") return "auto";
  const names = [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))];
  for (const name of names) {
    if (!INIT_HARNESSES.includes(name as InitHarness)) {
      throw new CliError(2, "invalid_harness", `Harness must be auto or one of: ${INIT_HARNESSES.join(", ")}.`);
    }
  }
  if (names.length === 0) throw new CliError(2, "invalid_harness", "Name at least one harness.");
  return names as InitHarness[];
}

async function copyDirectory(source: string, target: string): Promise<void> {
  const stage = join(dirname(target), `.${PLUGIN_NAME}.${randomUUID()}.stage`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await cp(source, stage, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(stage, target);
}

/** A directory this CLI installed: our plugin (by manifest name) or our router skill. */
async function ownedPluginDirectory(path: string): Promise<boolean> {
  const manifest = await readFile(join(path, ".claude-plugin", "plugin.json"), "utf8").catch(() => "");
  if (manifest) {
    try {
      return (JSON.parse(manifest) as { name?: unknown }).name === PLUGIN_NAME;
    } catch {
      return false;
    }
  }
  return !(await exists(path));
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

async function claudeSupportsSkillsDirPlugins(runtime: Runtime): Promise<boolean> {
  const help = await run(runtime, "claude", ["plugin", "--help"], 20_000);
  return help.code === 0 && /skills-dir/.test(`${help.stdout}${help.stderr}`);
}

async function installClaude(runtime: Runtime, servers: readonly McpServerEntry[], pluginDir: string): Promise<HarnessInstall> {
  const root = skillRoot(runtime, "claude");
  const target = join(root, PLUGIN_NAME);
  const hasCli = Boolean(await which(runtime, "claude"));
  if (!hasCli || await claudeSupportsSkillsDirPlugins(runtime)) {
    // A plugin in ~/.claude/skills/<name>/ loads as <name>@skills-dir: skills and MCP server in one unit.
    if (hasCli) {
      for (const server of servers) await run(runtime, "claude", ["mcp", "remove", server.name, "-s", "user"], 20_000);
    }
    await removeSkillSuite(root);
    if (!(await ownedPluginDirectory(target))) {
      throw new CliError(5, "skill_exists", `${target} holds another plugin or skill; move it, then run scalius init again.`);
    }
    await copyDirectory(pluginDir, target);
    return {
      harness: "claude",
      skills: join(target, "skills"),
      mcp: { status: "registered", via: `plugin ${PLUGIN_NAME}@skills-dir`, servers: servers.map((server) => `plugin:${PLUGIN_NAME}:${server.name}`) },
    };
  }
  if (await ownedPluginDirectory(target) && await exists(join(target, ".claude-plugin"))) await rm(target, { recursive: true, force: true });
  await installSkillSuite(root, true);
  for (const server of servers) {
    await run(runtime, "claude", ["mcp", "remove", server.name, "-s", "user"], 20_000);
    const env = Object.entries(server.launch.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const added = await run(runtime, "claude", ["mcp", "add", "-s", "user", ...env, server.name, "--", server.launch.command, ...server.launch.args]);
    if (added.code !== 0) {
      throw new CliError(8, "harness_registration_failed", `claude mcp add failed: ${(added.stderr || added.stdout).trim().slice(0, 300)}`);
    }
  }
  return { harness: "claude", skills: root, mcp: { status: "registered", via: "claude mcp add --scope user", servers: servers.map((server) => server.name) } };
}

async function checkClaude(runtime: Runtime, servers: readonly McpServerEntry[]): Promise<HarnessCheck> {
  const plugin = join(skillRoot(runtime, "claude"), PLUGIN_NAME, ".claude-plugin", "plugin.json");
  if (await exists(plugin)) {
    const version = await readFile(plugin, "utf8").then((text) => (JSON.parse(text) as { version?: string }).version, () => undefined);
    if (await which(runtime, "claude")) {
      const listed = await run(runtime, "claude", ["plugin", "list", "--json"], 20_000);
      let enabled: boolean | undefined;
      try {
        const plugins = JSON.parse(listed.stdout) as Array<{ id?: string; enabled?: boolean }>;
        enabled = plugins.find((entry) => entry.id === `${PLUGIN_NAME}@skills-dir`)?.enabled;
      } catch {
        enabled = undefined;
      }
      if (enabled === false) {
        return { id: "harness.claude", status: "fail", detail: "The Scalius plugin is installed but disabled.", fix: `claude plugin enable ${PLUGIN_NAME}@skills-dir` };
      }
    }
    return version === packageVersion()
      ? { id: "harness.claude", status: "ok", detail: `Claude Code plugin ${PLUGIN_NAME}@skills-dir ${version} (skills and MCP server)` }
      : { id: "harness.claude", status: "warn", detail: `Claude Code plugin is version ${String(version)}; this CLI is ${packageVersion()}.`, fix: "scalius init" };
  }
  for (const server of servers) {
    const got = await run(runtime, "claude", ["mcp", "get", server.name], 30_000);
    if (got.code !== 0) return { id: "harness.claude", status: "fail", detail: `Claude Code has no '${server.name}' MCP server.`, fix: "scalius init --harness claude" };
  }
  return skillsCheck(runtime, "claude", `Claude Code MCP server ${servers.map((server) => server.name).join(", ")}`);
}

// ─── Codex ───────────────────────────────────────────────────────────────────

async function installCodex(runtime: Runtime, servers: readonly McpServerEntry[], bundleRoot: string): Promise<HarnessInstall> {
  if (!(await which(runtime, "codex"))) {
    const root = skillRoot(runtime, "codex");
    await installSkillSuite(root, true);
    return {
      harness: "codex",
      skills: root,
      mcp: { status: "manual", via: "codex mcp add", servers: servers.map((server) => server.name), next: servers.map((server) => `codex mcp add ${server.name} -- ${[server.launch.command, ...server.launch.args].join(" ")}`).join("; ") },
    };
  }
  const config = await readFile(join(codexHome(runtime), "config.toml"), "utf8").catch(() => "");
  const plugins = await run(runtime, "codex", ["plugin", "--help"], 20_000);
  if (plugins.code === 0) {
    for (const server of servers) {
      if (new RegExp(`^\\[mcp_servers\\.${server.name.replace(/-/g, "\\-")}\\]`, "m").test(config)) {
        await run(runtime, "codex", ["mcp", "remove", server.name], 20_000);
      }
    }
    await removeSkillSuite(skillRoot(runtime, "codex"));
    const marketplace = await run(runtime, "codex", ["plugin", "marketplace", "add", bundleRoot]);
    const added = marketplace.code === 0 ? await run(runtime, "codex", ["plugin", "add", `${PLUGIN_NAME}@${LOCAL_MARKETPLACE}`]) : marketplace;
    if (added.code !== 0) {
      throw new CliError(8, "harness_registration_failed", `codex plugin install failed: ${(added.stderr || added.stdout).trim().slice(0, 300)}`);
    }
    return {
      harness: "codex",
      skills: join(bundleRoot, PLUGIN_NAME, "skills"),
      mcp: { status: "registered", via: `plugin ${PLUGIN_NAME}@${LOCAL_MARKETPLACE}`, servers: servers.map((server) => server.name) },
    };
  }
  const root = skillRoot(runtime, "codex");
  await installSkillSuite(root, true);
  for (const server of servers) {
    await run(runtime, "codex", ["mcp", "remove", server.name], 20_000);
    const env = Object.entries(server.launch.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const added = await run(runtime, "codex", ["mcp", "add", ...env, server.name, "--", server.launch.command, ...server.launch.args]);
    if (added.code !== 0) {
      throw new CliError(8, "harness_registration_failed", `codex mcp add failed: ${(added.stderr || added.stdout).trim().slice(0, 300)}`);
    }
  }
  return { harness: "codex", skills: root, mcp: { status: "registered", via: "codex mcp add", servers: servers.map((server) => server.name) } };
}

async function checkCodex(runtime: Runtime, servers: readonly McpServerEntry[]): Promise<HarnessCheck> {
  if (!(await which(runtime, "codex"))) return { id: "harness.codex", status: "warn", detail: "The codex command is not on PATH, so its MCP setup cannot be checked." };
  for (const server of servers) {
    const got = await run(runtime, "codex", ["mcp", "get", server.name], 20_000);
    if (got.code !== 0) return { id: "harness.codex", status: "fail", detail: `Codex has no '${server.name}' MCP server.`, fix: "scalius init --harness codex" };
  }
  return { id: "harness.codex", status: "ok", detail: `Codex MCP server ${servers.map((server) => server.name).join(", ")}` };
}

// ─── Config-file harnesses (Cursor, OpenCode) ────────────────────────────────

async function mergeJsonConfig(path: string, update: (config: Record<string, unknown>) => void): Promise<boolean> {
  let config: Record<string, unknown> = {};
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text !== undefined && text.trim()) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed)) return false;
      config = parsed;
    } catch {
      return false;
    }
  }
  update(config);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return true;
}

function cursorConfigPath(runtime: Runtime): string {
  return join(runtime.homedir(), ".cursor", "mcp.json");
}

function opencodeConfigPath(runtime: Runtime): string {
  return join(runtime.homedir(), ".config", "opencode", "opencode.json");
}

function opencodeEntry(server: McpServerEntry): Record<string, unknown> {
  return {
    type: "local",
    command: [server.launch.command, ...server.launch.args],
    enabled: true,
    ...(server.launch.env ? { environment: server.launch.env } : {}),
  };
}

async function installConfigHarness(runtime: Runtime, harness: "cursor" | "opencode", servers: readonly McpServerEntry[]): Promise<HarnessInstall> {
  const root = skillRoot(runtime, harness);
  await installSkillSuite(root, true);
  const names = servers.map((server) => server.name);
  if (harness === "cursor") {
    const path = cursorConfigPath(runtime);
    const entries = mcpConfig(servers).mcpServers;
    const merged = await mergeJsonConfig(path, (config) => {
      config.mcpServers = { ...(isRecord(config.mcpServers) ? config.mcpServers : {}), ...entries };
    });
    return merged
      ? { harness, skills: root, mcp: { status: "registered", via: path, servers: names } }
      : { harness, skills: root, mcp: { status: "manual", via: path, servers: names, config: { mcpServers: entries }, next: `Add these servers to ${path}.` } };
  }
  const path = opencodeConfigPath(runtime);
  const entries = Object.fromEntries(servers.map((server) => [server.name, opencodeEntry(server)]));
  const jsonc = join(dirname(path), "opencode.jsonc");
  const merged = !(await exists(path)) && await exists(jsonc)
    ? false
    : await mergeJsonConfig(path, (config) => {
      config.$schema ??= "https://opencode.ai/config.json";
      config.mcp = { ...(isRecord(config.mcp) ? config.mcp : {}), ...entries };
    });
  return merged
    ? { harness, skills: root, mcp: { status: "registered", via: path, servers: names } }
    : { harness, skills: root, mcp: { status: "manual", via: jsonc, servers: names, config: { mcp: entries }, next: `Add these servers under "mcp" in ${jsonc}.` } };
}

async function checkConfigHarness(runtime: Runtime, harness: "cursor" | "opencode", servers: readonly McpServerEntry[]): Promise<HarnessCheck> {
  const path = harness === "cursor" ? cursorConfigPath(runtime) : opencodeConfigPath(runtime);
  const text = await readFile(path, "utf8").catch(() => "");
  let section: unknown;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    section = harness === "cursor" ? parsed.mcpServers : parsed.mcp;
  } catch {
    section = undefined;
  }
  const missing = servers.filter((server) => !isRecord(section) || !isRecord(section[server.name]));
  if (missing.length > 0) {
    return { id: `harness.${harness}`, status: "fail", detail: `${path} has no '${missing[0]!.name}' MCP server.`, fix: `scalius init --harness ${harness}` };
  }
  return skillsCheck(runtime, harness, `${harness === "cursor" ? "Cursor" : "OpenCode"} MCP server in ${path}`);
}

// ─── Skills-only harnesses (Pi, generic Agent Skills clients) ────────────────

async function installManualHarness(runtime: Runtime, harness: "pi" | "agents", servers: readonly McpServerEntry[]): Promise<HarnessInstall> {
  const root = skillRoot(runtime, harness);
  await installSkillSuite(root, true);
  return {
    harness,
    skills: root,
    mcp: {
      status: "manual",
      via: harness === "pi" ? "pi-mcp-adapter" : "your agent's MCP settings",
      servers: servers.map((server) => server.name),
      config: mcpConfig(servers),
      next: harness === "pi"
        ? "Pi has no built-in MCP client: install pi-mcp-adapter yourself (pi install npm:pi-mcp-adapter), add this server to ~/.agents/mcp.json, and restart Pi. The skills and the scalius CLI work without it."
        : "Add this stdio server to your agent's MCP settings; it uses the credential 'scalius init' paired.",
    },
  };
}

async function skillsCheck(runtime: Runtime, harness: AgentHarness, registered: string): Promise<HarnessCheck> {
  const stamp = await readSkillStamp(skillRoot(runtime, harness));
  if (!stamp) return { id: `harness.${harness}`, status: "fail", detail: `${registered}; the Scalius skills are not installed.`, fix: `scalius init --harness ${harness}` };
  if (stamp.version !== packageVersion()) {
    return { id: `harness.${harness}`, status: "warn", detail: `${registered}; skills are from scalius ${stamp.version}, this CLI is ${packageVersion()}.`, fix: `scalius init --harness ${harness}` };
  }
  return { id: `harness.${harness}`, status: "ok", detail: `${registered}; skills ${stamp.version}` };
}

// ─── Entry points ────────────────────────────────────────────────────────────

export async function installHarness(
  runtime: Runtime,
  harness: InitHarness,
  servers: readonly McpServerEntry[],
  bundle: { root: string; pluginDir: string },
): Promise<HarnessInstall> {
  switch (harness) {
    case "claude": return installClaude(runtime, servers, bundle.pluginDir);
    case "codex": return installCodex(runtime, servers, bundle.root);
    case "cursor":
    case "opencode": return installConfigHarness(runtime, harness, servers);
    case "pi":
    case "agents": return installManualHarness(runtime, harness, servers);
  }
}

export async function checkHarness(runtime: Runtime, harness: InitHarness, servers: readonly McpServerEntry[]): Promise<HarnessCheck> {
  switch (harness) {
    case "claude": return checkClaude(runtime, servers);
    case "codex": return checkCodex(runtime, servers);
    case "cursor":
    case "opencode": return checkConfigHarness(runtime, harness, servers);
    case "pi":
    case "agents": {
      const check = await skillsCheck(runtime, harness, "Skills installed (MCP is configured by hand here)");
      return check.status === "ok" ? { ...check, status: "warn", fix: "Add the scalius stdio MCP server shown by 'scalius init' to this agent." } : check;
    }
  }
}
