import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Fake `claude` and `codex` programs for init tests: real executables on
// PATH that log their arguments and keep their MCP registrations in a JSON
// file, so `scalius init` and `scalius doctor` drive them as they would the
// real CLIs.

const SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const home = process.env.HOME;
const log = process.env.FAKE_HARNESS_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ name, args }) + "\n");
const stateFile = path.join(home, "." + name + "-fake.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { mcp: {}, marketplaces: [], plugins: [] };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const plugins = process.env.FAKE_PLUGINS === "1";
const joined = args.join(" ");
if (name === "claude") {
  if (joined === "plugin --help") {
    if (!plugins) { console.error("error: unknown command 'plugin'"); process.exit(1); }
    console.log("Commands:\n  init|new [options] <name>  Scaffold a new plugin at ~/.claude/skills/<name>/ (auto-loads next session as <name>@skills-dir)");
    process.exit(0);
  }
  if (joined === "plugin list --json") {
    const root = path.join(home, ".claude", "skills");
    const found = fs.existsSync(root) ? fs.readdirSync(root).filter((dir) => fs.existsSync(path.join(root, dir, ".claude-plugin", "plugin.json"))) : [];
    console.log(JSON.stringify(found.map((dir) => ({ id: dir + "@skills-dir", enabled: true, version: JSON.parse(fs.readFileSync(path.join(root, dir, ".claude-plugin", "plugin.json"), "utf8")).version }))));
    process.exit(0);
  }
  if (args[0] === "mcp" && args[1] === "add") {
    const separator = args.indexOf("--");
    const before = args.slice(2, separator);
    const server = before[before.length - 1];
    state.mcp[server] = { command: args[separator + 1], args: args.slice(separator + 2), options: before.slice(0, -1) };
    save();
    process.exit(0);
  }
  if (args[0] === "mcp" && args[1] === "get") process.exit(state.mcp[args[2]] ? 0 : 1);
  if (args[0] === "mcp" && args[1] === "remove") { const had = Boolean(state.mcp[args[2]]); delete state.mcp[args[2]]; save(); process.exit(had ? 0 : 1); }
}
if (name === "codex") {
  if (joined === "plugin --help") process.exit(plugins ? 0 : 2);
  if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") { state.marketplaces.push(args[3]); save(); process.exit(0); }
  if (args[0] === "plugin" && args[1] === "add") {
    const root = state.marketplaces[state.marketplaces.length - 1];
    const config = JSON.parse(fs.readFileSync(path.join(root, "scalius", ".mcp.json"), "utf8"));
    Object.assign(state.mcp, config.mcpServers);
    state.plugins.push(args[2]);
    save();
    process.exit(0);
  }
  if (args[0] === "mcp" && args[1] === "add") {
    const separator = args.indexOf("--");
    state.mcp[args[separator - 1]] = { command: args[separator + 1], args: args.slice(separator + 2) };
    save();
    process.exit(0);
  }
  if (args[0] === "mcp" && args[1] === "get") process.exit(state.mcp[args[2]] ? 0 : 1);
  if (args[0] === "mcp" && args[1] === "remove") { delete state.mcp[args[2]]; save(); process.exit(0); }
}
console.error("fake " + name + ": unsupported " + joined);
process.exit(3);
`;

export async function installFakeHarness(binDirectory: string, name: "claude" | "codex"): Promise<string> {
  await mkdir(binDirectory, { recursive: true });
  const path = join(binDirectory, name);
  await writeFile(path, `#!${process.execPath}\n${SCRIPT}`);
  await chmod(path, 0o755);
  return path;
}

export async function harnessLog(path: string): Promise<Array<{ name: string; args: string[] }>> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { name: string; args: string[] });
}

export async function harnessState(home: string, name: "claude" | "codex"): Promise<{ mcp: Record<string, { command: string; args: string[]; options?: string[] }>; plugins: string[] }> {
  return JSON.parse(await readFile(join(home, `.${name}-fake.json`), "utf8").catch(() => '{"mcp":{},"plugins":[]}')) as {
    mcp: Record<string, { command: string; args: string[]; options?: string[] }>;
    plugins: string[];
  };
}
