import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveMcpBridge } from "../src/bridge.js";
import { ConfigStore } from "../src/config.js";
import { runProgram } from "../src/program.js";
import { createCommandRunner } from "../src/runtime.js";
import { SCALIUS_SKILL_NAMES } from "../src/skill.js";
import { harnessLog, harnessState, installFakeHarness } from "./fixtures/fake-harness.js";
import { startLocalApi, type LocalApi } from "./fixtures/local-api.js";
import { createTestRuntime } from "./helpers.js";

let api: LocalApi;
const ENTRY = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

beforeAll(async () => {
  api = await startLocalApi();
});

afterAll(async () => {
  await api.close();
});

async function machine(options: { plugins: boolean; harnesses?: Array<"claude" | "codex">; tty?: boolean }) {
  const home = await mkdtemp(join(tmpdir(), "scalius-init-home-"));
  const bin = join(home, "bin");
  for (const name of options.harnesses ?? ["claude"]) await installFakeHarness(bin, name);
  const log = join(home, "harness.log");
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    FAKE_HARNESS_LOG: log,
    FAKE_PLUGINS: options.plugins ? "1" : "0",
    SCALIUS_CONFIG_HOME: join(home, ".config", "scalius"),
  };
  const runtime = createTestRuntime({
    directory: home,
    env,
    fetch: globalThis.fetch,
    run: createCommandRunner(env),
    entryScript: ENTRY,
    tty: options.tty ?? false,
  });
  return { home, log, runtime };
}

describe("scalius init", () => {
  it("(a) pairs once, installs the Claude Code plugin with skills and MCP server, and passes doctor", async () => {
    const { home, log, runtime } = await machine({ plugins: true, tty: true });
    const exit = await runProgram(runtime, ["init", "--harness", "claude", "--server", api.origin, "--no-open"]);
    const transcript = `$ scalius init --harness claude --server ${api.origin} --no-open\n${runtime.stderrText()}${runtime.stdoutText()}`;
    await writeFile(join(home, "init-transcript.txt"), transcript);
    if (process.env.SCALIUS_SHOW_TRANSCRIPT) process.stdout.write(`${transcript}\n`);
    expect(exit, transcript).toBe(0);

    // One login: the device pairing, approved once, saved as the default profile.
    expect(api.requests.filter((request) => request.path === "/api/v1/agent-auth/device/start")).toHaveLength(1);
    expect(runtime.stderrText()).toContain("Enter code: ABCD-EFGH");
    const profile = await new ConfigStore(runtime).resolveProfileForResource("dashboard");
    expect(profile).toMatchObject({ name: "default", server: api.origin, token: api.token });

    // The plugin: manifest, the skills and a stdio MCP server that runs this CLI with the profile.
    const plugin = join(home, ".claude", "skills", "scalius");
    const manifest = JSON.parse(await readFile(join(plugin, ".claude-plugin", "plugin.json"), "utf8")) as { name: string; version: string };
    expect(manifest.name).toBe("scalius");
    for (const name of SCALIUS_SKILL_NAMES) await expect(stat(join(plugin, "skills", name, "SKILL.md"))).resolves.toBeTruthy();
    const mcp = JSON.parse(await readFile(join(plugin, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> };
    expect(mcp.mcpServers.scalius).toEqual({
      command: process.execPath,
      args: [ENTRY, "--profile", "default", "mcp"],
      env: { SCALIUS_CONFIG_HOME: join(home, ".config", "scalius") },
    });
    expect(JSON.stringify(mcp)).not.toContain(api.token);
    expect(JSON.stringify(await harnessState(home, "claude"))).not.toContain(api.token);

    const calls = (await harnessLog(log)).map((entry) => entry.args.join(" "));
    expect(calls).toContain("plugin --help");
    expect(calls).toContain("plugin list --json");

    // Doctor ran and every link is green, including the store context over MCP.
    expect(transcript).toContain("Scalius doctor (ready)");
    expect(transcript).toContain("Demo Store");
    expect(transcript).toMatch(/ok\s+mcp\s+MCP \/api\/v1\/mcp\/dashboard: 5 scalius tools/);
    expect(transcript).toMatch(/ok\s+harness\.claude/);

    // Running init again reuses the credential and replaces its own registration.
    const again = createTestRuntime({ directory: home, env: runtime.env, fetch: globalThis.fetch, run: runtime.run, entryScript: ENTRY, tty: false });
    expect(await runProgram(again, ["init", "--harness", "claude", "--server", api.origin, "--no-open"])).toBe(0);
    expect(api.requests.filter((request) => request.path === "/api/v1/agent-auth/device/start")).toHaveLength(1);
    expect(JSON.parse(again.stdoutText())).toMatchObject({ ok: true, profiles: { dashboard: "default" } });
  });

  it("falls back to skills plus claude mcp add on a Claude Code without skills-dir plugins", async () => {
    const { home, runtime } = await machine({ plugins: false });
    expect(await runProgram(runtime, ["init", "--harness", "claude", "--server", api.origin, "--no-open"]), runtime.stderrText()).toBe(0);
    for (const name of SCALIUS_SKILL_NAMES) await expect(stat(join(home, ".claude", "skills", name, "SKILL.md"))).resolves.toBeTruthy();
    const state = await harnessState(home, "claude");
    expect(state.mcp.scalius).toEqual({
      command: process.execPath,
      args: [ENTRY, "--profile", "default", "mcp"],
      options: ["-s", "user", "-e", `SCALIUS_CONFIG_HOME=${join(home, ".config", "scalius")}`],
    });
    const report = JSON.parse(runtime.stdoutText()) as { doctor: { ok: boolean; checks: Array<{ id: string; status: string }> } };
    expect(report.doctor.ok).toBe(true);
    expect(report.doctor.checks.find((check) => check.id === "harness.claude")?.status).toBe("ok");
  });

  it("installs the Codex plugin from the local marketplace", async () => {
    const { home, runtime } = await machine({ plugins: true, harnesses: ["codex"] });
    expect(await runProgram(runtime, ["init", "--harness", "codex", "--server", api.origin, "--no-open"]), runtime.stderrText()).toBe(0);
    const state = await harnessState(home, "codex");
    expect(state.plugins).toEqual(["scalius@scalius-local"]);
    expect(state.mcp.scalius?.args).toEqual([ENTRY, "--profile", "default", "mcp"]);
    const bundle = join(home, ".config", "scalius", "agent-plugin");
    const codexManifest = JSON.parse(await readFile(join(bundle, "scalius", ".codex-plugin", "plugin.json"), "utf8")) as Record<string, unknown>;
    expect(codexManifest).toMatchObject({ name: "scalius", skills: "./skills/", mcpServers: "./.mcp.json" });
    const marketplace = JSON.parse(await readFile(join(bundle, ".claude-plugin", "marketplace.json"), "utf8")) as { name: string; plugins: Array<{ source: string }> };
    expect(marketplace).toMatchObject({ name: "scalius-local", plugins: [{ source: "./scalius" }] });
  });

  it("doctor names the fix when nothing is connected", async () => {
    const { runtime } = await machine({ plugins: true });
    const exit = await runProgram(runtime, ["doctor", "--harness", "claude"]);
    expect(exit).toBe(3);
    const report = JSON.parse(runtime.stdoutText()) as { ok: boolean; checks: Array<{ id: string; status: string; fix?: string }> };
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "profile")).toMatchObject({ status: "fail", fix: expect.stringContaining("scalius init") });
  });
});

describe("scalius mcp (stdio bridge)", () => {
  it("serves a 2025-11-25 harness session from the remote MCP endpoint with the paired credential", async () => {
    const { runtime: setup } = await machine({ plugins: true });
    const store = new ConfigStore(setup);
    await store.putProfile("default", api.origin);
    await store.putCredential("default", { token: api.token, resource: "dashboard", createdAt: "2026-08-13T00:00:00.000Z" });
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "scalius_answer", arguments: { question: "sales today" } } },
    ];
    const runtime = createTestRuntime({
      directory: setup.homedir(),
      env: setup.env,
      fetch: globalThis.fetch,
      stdin: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    });
    // Sequential like a harness: each request after the previous answer.
    await serveMcpBridge(runtime, { audience: "dashboard" });
    const replies = runtime.stdoutText().trim().split("\n").map((line) => JSON.parse(line) as { id: number; result?: Record<string, unknown> });
    const byId = new Map(replies.map((reply) => [reply.id, reply]));
    expect(byId.get(1)?.result).toMatchObject({ protocolVersion: "2025-11-25", serverInfo: { name: "scalius-dashboard" } });
    expect(((byId.get(2)?.result?.tools as Array<{ name: string }>) ?? []).map((tool) => tool.name).sort())
      .toEqual(["scalius_answer", "scalius_describe", "scalius_read", "scalius_search", "scalius_write"]);
    expect(byId.get(3)?.result).toMatchObject({ structuredContent: { ok: true, kind: "result" } });
    const forwarded = api.requests.filter((request) => request.path === "/api/v1/mcp/dashboard" && request.rpcMethod === "tools/list").at(-1)!;
    expect(forwarded.headers.authorization).toBe(`Bearer ${api.token}`);
    expect(forwarded.headers["mcp-protocol-version"]).toBe("2025-11-25");
  });

  it("relays a 2026-07-28 subscription stream as it arrives and ends it when the harness closes stdin", async () => {
    const { runtime: setup } = await machine({ plugins: true });
    const store = new ConfigStore(setup);
    await store.putProfile("default", api.origin);
    await store.putCredential("default", { token: api.token, resource: "dashboard", createdAt: "2026-08-13T00:00:00.000Z" });
    const envelope = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
    const messages = [
      { jsonrpc: "2.0", id: "listen-1", method: "subscriptions/listen", params: { notifications: { toolsListChanged: true }, _meta: envelope } },
      { jsonrpc: "2.0", id: 11, method: "tools/list", params: { _meta: envelope } },
    ];
    const stdin = new PassThrough();
    const runtime = { ...createTestRuntime({ directory: setup.homedir(), env: setup.env, fetch: globalThis.fetch }), stdin } as ReturnType<typeof createTestRuntime>;
    const serving = serveMcpBridge(runtime, { audience: "dashboard" });
    for (const message of messages) stdin.write(`${JSON.stringify(message)}\n`);
    // The harness keeps stdin open while it listens; the ack arrives on the open stream.
    for (let wait = 0; wait < 200 && !runtime.stdoutText().includes("acknowledged") && !runtime.stdoutText().includes('"listen-1"'); wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stdin.end();
    await serving;
    const replies = runtime.stdoutText().trim().split("\n").map((line) => JSON.parse(line) as { id?: unknown; method?: string; result?: Record<string, unknown> });
    if (process.env.SCALIUS_SHOW_TRANSCRIPT) process.stdout.write(`${JSON.stringify(replies)}\n`);
    expect(replies.find((reply) => reply.id === 11)?.result?.tools).toHaveLength(5);
    expect(replies.some((reply) => reply.method === "notifications/subscriptions/acknowledged" || reply.id === "listen-1")).toBe(true);
  });

  it("answers every request with a connect hint when no credential exists", async () => {
    const { runtime: base } = await machine({ plugins: true });
    const runtime = createTestRuntime({
      directory: base.homedir(),
      env: base.env,
      stdin: `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })}\n`,
    });
    await serveMcpBridge(runtime, { audience: "dashboard" });
    expect(JSON.parse(runtime.stdoutText())).toMatchObject({ id: 7, error: { code: -32001, message: expect.stringContaining("scalius init") } });
  });
});
