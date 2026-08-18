import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_HARNESSES,
  installSkill,
  SCALIUS_SKILL_NAMES,
  setupHarness,
} from "../src/skill.js";
import { createTestRuntime } from "./helpers.js";

describe("portable Scalius skill and MCP setup", () => {
  it.each([
    ["agents", [".agents", "skills"]],
    ["codex", ["codex-home", "skills"]],
    ["claude", [".claude", "skills"]],
    ["opencode", [".config", "opencode", "skills"]],
    ["pi", [".pi", "agent", "skills"]],
  ] as const)("installs the focused suite for %s without changing its sources", async (harness, segments) => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-skill-test-"));
    const runtime = createTestRuntime({ directory, env: { CODEX_HOME: join(directory, "codex-home") } });
    const installed = await installSkill(runtime, harness, false);
    expect(installed).toMatchObject({
      status: "installed",
      harness,
      skills: SCALIUS_SKILL_NAMES.map((name) => expect.objectContaining({ name })),
    });
    const skill = await readFile(join(directory, ...segments, "scalius-commerce", "SKILL.md"), "utf8");
    expect(skill).toContain("Treat the live finalized contract as authority");
    expect(skill).toContain("## Route the task");
    expect(skill).toContain("`workflows.read`");
    const catalog = await readFile(
      join(directory, ...segments, "scalius-catalog", "SKILL.md"),
      "utf8",
    );
    expect(catalog).toContain("pmed");
    expect(catalog).toContain("atomic");
    await expect(installSkill(runtime, harness, false)).rejects.toMatchObject({ errorCode: "skill_exists" });

    const stale = join(directory, ...segments, "scalius-commerce", "stale.md");
    await writeFile(stale, "must be removed", "utf8");
    await expect(installSkill(runtime, harness, true)).resolves.toMatchObject({ status: "updated" });
    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ships valid concise trigger metadata without stale discovery instructions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-skill-shape-"));
    await installSkill(createTestRuntime({ directory }), "agents", false);
    for (const name of SCALIUS_SKILL_NAMES) {
      const root = join(directory, ".agents", "skills", name);
      const [body, metadata] = await Promise.all([
        readFile(join(root, "SKILL.md"), "utf8"),
        readFile(join(root, "agents", "openai.yaml"), "utf8"),
      ]);
      expect(body, name).toContain(`name: ${name}`);
      expect(body, name).not.toContain("TODO");
      expect(body, name).not.toContain("operations.search");
      expect(Buffer.byteLength(body), name).toBeLessThan(6 * 1024);
      expect(metadata, name).toContain(`$${name}`);
    }
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
