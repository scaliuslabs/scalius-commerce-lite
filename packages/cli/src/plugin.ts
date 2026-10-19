import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { configDirectory } from "./config.js";
import type { Audience } from "./mcp-client.js";
import { bundledSkillsDirectory } from "./skill.js";
import type { Runtime } from "./types.js";
import { packageVersion } from "./version.js";

// The Scalius agent plugin: the skill suite plus the stdio MCP server, in
// the layout Claude Code and Codex both load (`.claude-plugin/plugin.json`,
// `.codex-plugin/plugin.json`, `.mcp.json`, `skills/`). The package root is
// itself the published plugin (its `.mcp.json` runs `npx scalius@<version>
// mcp`); `scalius init` materializes a per-user copy whose MCP entry runs
// this exact CLI with the paired profile.

export const PLUGIN_NAME = "scalius";
export const LOCAL_MARKETPLACE = "scalius-local";
export const MCP_SERVER_NAMES: Record<Audience, string> = { dashboard: "scalius", storefront: "scalius-storefront" };

export interface LaunchCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpServerEntry {
  audience: Audience;
  name: string;
  launch: LaunchCommand;
}

function packageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

/** How a harness starts the stdio bridge: this installed CLI, or a pinned npx package when run from a throwaway npx cache. */
export function launchCommand(runtime: Runtime, audience: Audience, profileName?: string): LaunchCommand {
  const script = runtime.entryScript;
  const selection = [...(profileName ? ["--profile", profileName] : []), "mcp", ...(audience === "storefront" ? ["--surface", "storefront"] : [])];
  const configHome = runtime.env.SCALIUS_CONFIG_HOME?.trim();
  const env = configHome ? { env: { SCALIUS_CONFIG_HOME: configHome } } : {};
  const ephemeral = !script || /[\\/](?:_npx|\.npm|npm-cache|dlx-[^\\/]*|pnpm[\\/]dlx)[\\/]/.test(script) || !existsSync(script);
  if (!ephemeral) return { command: process.execPath, args: [script, ...selection], ...env };
  return { command: "npx", args: ["-y", `scalius@${packageVersion()}`, ...selection], ...env };
}

export function mcpConfig(servers: readonly McpServerEntry[]): { mcpServers: Record<string, Record<string, unknown>> } {
  return {
    mcpServers: Object.fromEntries(servers.map((server) => [server.name, {
      command: server.launch.command,
      args: server.launch.args,
      ...(server.launch.env ? { env: server.launch.env } : {}),
    }])),
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

/** The published manifests shipped in the package root. */
export async function publishedManifests(): Promise<{ claude: Record<string, unknown>; codex: Record<string, unknown>; marketplace: Record<string, unknown>; mcp: Record<string, unknown> }> {
  const root = packageRoot();
  const [claude, codex, marketplace, mcp] = await Promise.all([
    readJson(join(root, ".claude-plugin", "plugin.json")),
    readJson(join(root, ".codex-plugin", "plugin.json")),
    readJson(join(root, ".claude-plugin", "marketplace.json")),
    readJson(join(root, ".mcp.json")),
  ]);
  return { claude, codex, marketplace, mcp };
}

export function pluginBundleRoot(runtime: Runtime): string {
  return join(configDirectory(runtime), "agent-plugin");
}

/**
 * Writes the per-user plugin and its one-plugin local marketplace:
 * `<config>/agent-plugin/.claude-plugin/marketplace.json` and
 * `<config>/agent-plugin/scalius/{.claude-plugin,.codex-plugin,.mcp.json,skills}`.
 */
export async function materializePlugin(runtime: Runtime, servers: readonly McpServerEntry[]): Promise<{ root: string; pluginDir: string }> {
  const root = pluginBundleRoot(runtime);
  const { claude, codex, marketplace } = await publishedManifests();
  const version = packageVersion();
  const stage = join(root, `.stage-${randomUUID()}`);
  await mkdir(join(stage, ".claude-plugin"), { recursive: true, mode: 0o700 });
  await mkdir(join(stage, ".codex-plugin"), { recursive: true, mode: 0o700 });
  await cp(bundledSkillsDirectory(), join(stage, "skills"), { recursive: true });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(join(stage, ".claude-plugin", "plugin.json"), json({ ...claude, version }));
  await writeFile(join(stage, ".codex-plugin", "plugin.json"), json({ ...codex, version }));
  await writeFile(join(stage, ".mcp.json"), json(mcpConfig(servers)), { mode: 0o600 });
  const pluginDir = join(root, PLUGIN_NAME);
  await rm(pluginDir, { recursive: true, force: true });
  await rename(stage, pluginDir);
  const entry = (Array.isArray(marketplace.plugins) ? marketplace.plugins[0] : {}) as Record<string, unknown>;
  await mkdir(join(root, ".claude-plugin"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".claude-plugin", "marketplace.json"), json({
    ...marketplace,
    name: LOCAL_MARKETPLACE,
    plugins: [{ ...entry, name: PLUGIN_NAME, source: `./${PLUGIN_NAME}`, version }],
  }));
  return { root, pluginDir };
}
