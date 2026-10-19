import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";
import type { Runtime } from "./types.js";
import { packageVersion } from "./version.js";

export const AGENT_HARNESSES = ["agents", "codex", "claude", "cursor", "opencode", "pi"] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];

/** The bundled suite: one router plus seven focused skills. */
export const SCALIUS_SKILL_NAMES = [
  "scalius",
  "scalius-insights",
  "scalius-catalog",
  "scalius-sales",
  "scalius-content",
  "scalius-settings",
  "scalius-marketing",
  "scalius-storefront",
] as const;
/** Skills an older CLI installed; removed when the current suite is installed. */
export const LEGACY_SKILL_NAMES = ["scalius-commerce"] as const;
/** Written beside an installed suite so `doctor` can spot a stale copy. */
export const SKILL_STAMP_FILE = ".scalius-skills.json";

const MCP_PATHS = {
  dashboard: "/api/v1/mcp/dashboard",
  storefront: "/api/v1/mcp/storefront",
} as const;

export function bundledSkillsDirectory(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

export function skillRoot(runtime: Runtime, harness: AgentHarness): string {
  switch (harness) {
    case "agents": return join(runtime.homedir(), ".agents", "skills");
    case "codex": return join(runtime.env.CODEX_HOME?.trim() || join(runtime.homedir(), ".codex"), "skills");
    case "claude": return join(runtime.homedir(), ".claude", "skills");
    case "cursor": return join(runtime.homedir(), ".cursor", "skills");
    case "opencode": return join(runtime.homedir(), ".config", "opencode", "skills");
    case "pi": return join(runtime.homedir(), ".pi", "agent", "skills");
  }
}

function serverOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(5, "invalid_server", "The MCP server must be an absolute HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new CliError(5, "invalid_server", "The MCP server must be an absolute HTTPS origin without credentials, query, or fragment.");
  }
  return url.origin;
}

/** Printed remote-MCP instructions, for a harness the CLI cannot configure itself. */
function mcpInstructions(harness: AgentHarness, server?: string): Record<string, unknown> {
  if (!server) {
    return {
      status: "server_required",
      next: `Run scalius init --harness ${harness} --server https://your-api-origin to connect it in one step.`,
    };
  }
  const origin = serverOrigin(server);
  const dashboard = `${origin}${MCP_PATHS.dashboard}`;
  const storefront = `${origin}${MCP_PATHS.storefront}`;
  if (harness === "codex") {
    return {
      transport: "streamable-http",
      dashboard,
      storefront,
      install: [
        `codex mcp add scalius-dashboard --url ${dashboard}`,
        `codex mcp add scalius-storefront --url ${storefront}`,
      ],
      authenticate: ["codex mcp login scalius-dashboard", "codex mcp login scalius-storefront"],
    };
  }
  if (harness === "claude") {
    return {
      transport: "http",
      dashboard,
      storefront,
      install: [
        `claude mcp add --transport http --scope user scalius-dashboard ${dashboard}`,
        `claude mcp add --transport http --scope user scalius-storefront ${storefront}`,
      ],
      authenticate: ["claude mcp login scalius-dashboard", "claude mcp login scalius-storefront"],
    };
  }
  if (harness === "opencode") {
    return {
      transport: "remote",
      dashboard,
      storefront,
      install: [
        `opencode mcp add scalius-dashboard --url ${dashboard}`,
        `opencode mcp add scalius-storefront --url ${storefront}`,
      ],
      authenticate: ["opencode mcp auth scalius-dashboard", "opencode mcp auth scalius-storefront"],
    };
  }
  if (harness === "pi") {
    return {
      transport: "streamable-http",
      dashboard,
      storefront,
      nativeMcp: false,
      note: "Pi loads the skill natively; MCP requires the separately installed pi-mcp-adapter package listed in Pi's package catalog.",
      install: ["pi install npm:pi-mcp-adapter"],
      configPath: "~/.agents/mcp.json",
      config: {
        mcpServers: {
          "scalius-dashboard": { url: dashboard, auth: "oauth", lifecycle: "lazy" },
          "scalius-storefront": { url: storefront, auth: "oauth", lifecycle: "lazy" },
        },
      },
      authenticate: ["/mcp-auth scalius-dashboard", "/mcp-auth scalius-storefront"],
      next: "Review the extension, install it explicitly, merge the shown servers into the shared config, restart Pi, then authenticate both audiences.",
    };
  }
  return {
    transport: "streamable-http",
    dashboard,
    storefront,
    config: {
      mcpServers: {
        "scalius-dashboard": { type: "http", url: dashboard },
        "scalius-storefront": { type: "http", url: storefront },
      },
    },
    authentication: "OAuth with dynamic client registration and PKCE",
    next: "Add both URLs as remote Streamable HTTP MCP servers in the harness, then authenticate each audience separately.",
  };
}

export interface SkillStamp {
  version: string;
  skills: string[];
}

export async function readSkillStamp(root: string): Promise<SkillStamp | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(root, SKILL_STAMP_FILE), "utf8")) as SkillStamp;
    return typeof parsed.version === "string" && Array.isArray(parsed.skills) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Removes a skill directory only when its SKILL.md names it: never a merchant's own skill. */
async function removeOwnedSkill(root: string, name: string): Promise<void> {
  const body = await readFile(join(root, name, "SKILL.md"), "utf8").catch(() => "");
  if (new RegExp(`^name: ${name}$`, "m").test(body)) await rm(join(root, name), { recursive: true, force: true });
}

/** Removes an installed flat suite (current and legacy names) and its stamp. */
export async function removeSkillSuite(root: string): Promise<void> {
  for (const name of [...SCALIUS_SKILL_NAMES, ...LEGACY_SKILL_NAMES]) await removeOwnedSkill(root, name);
  await rm(join(root, SKILL_STAMP_FILE), { force: true });
}

export async function installSkill(runtime: Runtime, harness: AgentHarness, force: boolean): Promise<Record<string, unknown>> {
  return { ...(await installSkillSuite(skillRoot(runtime, harness), force)), harness };
}

/** Stages and swaps the whole suite into `root`, so no stale guide stays behind. */
export async function installSkillSuite(
  root: string,
  force: boolean,
): Promise<{ status: string; root: string; skills: Array<{ name: string; path: string }> }> {
  const nonce = randomUUID();
  const entries = await Promise.all(SCALIUS_SKILL_NAMES.map(async (name) => {
    const target = join(root, name);
    return {
      name,
      source: join(bundledSkillsDirectory(), name),
      target,
      stage: join(root, `.${name}.${nonce}.stage`),
      backup: join(root, `.${name}.${nonce}.backup`),
      exists: await stat(target).then(() => true, () => false),
    };
  }));
  const existing = entries.filter((entry) => entry.exists);
  if (existing.length > 0 && !force) {
    throw new CliError(
      5,
      "skill_exists",
      `Scalius skill suite already exists at '${existing[0]!.target}'. Re-run with --force to replace the suite.`,
    );
  }
  await mkdir(root, { recursive: true, mode: 0o700 });

  const staged = await Promise.allSettled(entries.map((entry) =>
    cp(entry.source, entry.stage, { recursive: true, force: false, errorOnExist: true })
  ));
  if (staged.some((result) => result.status === "rejected")) {
    await Promise.all(entries.map((entry) => rm(entry.stage, { recursive: true, force: true })));
    throw new CliError(8, "skill_install_failed", "Unable to stage the bundled Scalius skill suite.");
  }

  const backedUp: typeof entries = [];
  const promoted: typeof entries = [];
  try {
    for (const entry of existing) {
      await rename(entry.target, entry.backup);
      backedUp.push(entry);
    }
    for (const entry of entries) {
      await rename(entry.stage, entry.target);
      promoted.push(entry);
    }
  } catch {
    for (const entry of [...promoted].reverse()) {
      await rm(entry.target, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const entry of [...backedUp].reverse()) {
      await rename(entry.backup, entry.target).catch(() => undefined);
    }
    await Promise.all(entries.map((entry) => rm(entry.stage, { recursive: true, force: true })));
    throw new CliError(8, "skill_install_failed", "Unable to replace the bundled Scalius skill suite.");
  }
  await Promise.all(backedUp.map((entry) => rm(entry.backup, { recursive: true, force: true })));
  for (const name of LEGACY_SKILL_NAMES) await removeOwnedSkill(root, name);
  const stamp: SkillStamp = { version: packageVersion(), skills: [...SCALIUS_SKILL_NAMES] };
  await writeFile(join(root, SKILL_STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o600 });
  return {
    status: existing.length > 0 ? "updated" : "installed",
    root,
    skills: entries.map((entry) => ({ name: entry.name, path: entry.target })),
  };
}

export async function setupHarness(
  runtime: Runtime,
  options: { harness: AgentHarness; force: boolean; server?: string },
): Promise<Record<string, unknown>> {
  const mcp = mcpInstructions(options.harness, options.server);
  const skills = await installSkill(runtime, options.harness, options.force);
  return {
    status: "ready_for_mcp",
    harness: options.harness,
    skills,
    mcp,
    operatingLoop: "scalius_answer for data questions; otherwise scalius_search, scalius_describe the chosen ids, scalius_write with dryRun first and the merchant's approval for gated changes, then verify with scalius_read.",
    next: "Prefer 'scalius init': it pairs once and registers the MCP server for you.",
  };
}
