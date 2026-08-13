import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_HARNESSES, installSkill, setupHarness } from "../src/skill.js";
import { createTestRuntime } from "./helpers.js";

describe("portable Scalius skill and MCP setup", () => {
  it.each([
    ["agents", [".agents", "skills"]],
    ["codex", ["codex-home", "skills"]],
    ["claude", [".claude", "skills"]],
    ["opencode", [".config", "opencode", "skills"]],
    ["pi", [".pi", "agent", "skills"]],
  ] as const)("installs for %s without changing the skill", async (harness, segments) => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-skill-test-"));
    const runtime = createTestRuntime({ directory, env: { CODEX_HOME: join(directory, "codex-home") } });
    const installed = await installSkill(runtime, harness, false);
    expect(installed).toMatchObject({ status: "installed", skill: "scalius-commerce", harness });
    const skill = await readFile(join(directory, ...segments, "scalius-commerce", "SKILL.md"), "utf8");
    expect(skill).toContain("Treat the store's live operation contract as authority");
    await expect(installSkill(runtime, harness, false)).rejects.toMatchObject({ errorCode: "skill_exists" });
    await expect(installSkill(runtime, harness, true)).resolves.toMatchObject({ status: "updated" });
  });

  it.each(["codex", "claude", "opencode"] as const)("emits two native OAuth MCP setup paths for %s", async (harness) => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-setup-test-"));
    const result = await setupHarness(createTestRuntime({ directory }), {
      harness,
      force: false,
      server: "https://api.shop.example/path",
    });
    const mcp = result.mcp as { install: string[]; authenticate: string[]; dashboard: string; storefront: string };
    expect(mcp.install).toHaveLength(2);
    expect(mcp.authenticate).toHaveLength(2);
    expect(mcp.dashboard).toBe("https://api.shop.example/api/v1/mcp/dashboard");
    expect(mcp.storefront).toBe("https://api.shop.example/api/v1/mcp/storefront");
    expect(JSON.stringify(result)).not.toContain("Bearer");
  });

  it("keeps Pi truthful when no native MCP client exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-pi-test-"));
    const result = await setupHarness(createTestRuntime({ directory }), {
      harness: "pi",
      force: false,
      server: "https://api.shop.example",
    });
    expect(result.mcp).toMatchObject({ nativeMcp: false });
    expect(JSON.stringify(result)).toContain("pi install npm:pi-mcp-adapter");
    expect(JSON.stringify(result)).toContain("/mcp-auth scalius-dashboard");
  });

  it("supports the complete declared harness set and rejects unsafe server origins", async () => {
    expect(AGENT_HARNESSES).toEqual(["agents", "codex", "claude", "opencode", "pi"]);
    const directory = await mkdtemp(join(tmpdir(), "scalius-origin-test-"));
    await expect(setupHarness(createTestRuntime({ directory }), {
      harness: "agents",
      force: false,
      server: "http://api.shop.example?token=secret",
    })).rejects.toMatchObject({ errorCode: "invalid_server" });
  });
});
