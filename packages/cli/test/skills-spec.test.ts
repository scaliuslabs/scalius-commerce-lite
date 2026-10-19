import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { publishedManifests } from "../src/plugin.js";
import { bundledSkillsDirectory, installSkillSuite, readSkillStamp, SCALIUS_SKILL_NAMES } from "../src/skill.js";
import { packageVersion } from "../src/version.js";

// (d) The bundled suite against the Agent Skills specification
// (agentskills.io/specification, the rules `skills-ref validate` checks) and
// this package's own budgets: SKILL.md at most 3 KB, each reference at most
// 6 KB, references one level deep, no retired tool names.

const SKILL_MAX_BYTES = 3 * 1024;
const REFERENCE_MAX_BYTES = 6 * 1024;
const ALLOWED_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RETIRED_TOOLS = /\b(?:workflows\.(?:resolve|read)|operations\.(?:search|describe|read|write|execute|batch|read_batch|write_batch))\b|\bworkflow (?:resolve|read)\b/;

interface Frontmatter {
  fields: Map<string, string>;
  body: string;
}

/** The YAML frontmatter as the spec allows it: top-level `key: value` lines and a `metadata` map. */
function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter between --- lines");
  const fields = new Map<string, string>();
  let current: string | undefined;
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z][a-z-]*):\s?(.*)$/.exec(line);
    if (field) {
      current = field[1]!;
      if (fields.has(current)) throw new Error(`duplicate field ${current}`);
      fields.set(current, field[2]!.replace(/^"(.*)"$/, "$1"));
      continue;
    }
    if (current === "metadata" && /^ {2}[A-Za-z0-9_-]+:\s.+$/.test(line)) continue;
    throw new Error(`unparsed frontmatter line: ${line}`);
  }
  return { fields, body: match[2]! };
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : Promise.resolve([join(directory, entry.name)])));
  return nested.flat();
}

describe("bundled skills follow the Agent Skills spec and the size budgets", () => {
  const root = bundledSkillsDirectory();

  it("ships exactly the eight declared skills", async () => {
    const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(directories).toEqual([...SCALIUS_SKILL_NAMES].sort());
    expect(SCALIUS_SKILL_NAMES).toHaveLength(8);
  });

  it.each(SCALIUS_SKILL_NAMES)("%s: valid frontmatter, budgets, resolvable links, no retired tool names", async (name) => {
    const directory = join(root, name);
    const text = await readFile(join(directory, "SKILL.md"), "utf8");
    expect(Buffer.byteLength(text), `${name}/SKILL.md bytes`).toBeLessThanOrEqual(SKILL_MAX_BYTES);
    const { fields, body } = parseFrontmatter(text);
    for (const field of fields.keys()) expect(ALLOWED_FIELDS.has(field), `${name}: field ${field}`).toBe(true);
    expect(fields.get("name")).toBe(name);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(NAME);
    const description = fields.get("description") ?? "";
    expect(description.length).toBeGreaterThan(40);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/\bUse\b/);
    if (fields.has("compatibility")) expect(fields.get("compatibility")!.length).toBeLessThanOrEqual(500);
    expect(body.trim().length).toBeGreaterThan(0);

    for (const file of await files(directory)) {
      const path = relative(directory, file);
      const content = await readFile(file, "utf8");
      expect(content, `${name}/${path}`).not.toMatch(RETIRED_TOOLS);
      if (path.startsWith("references/")) {
        expect(path.split("/"), `${name}/${path} is one level deep`).toHaveLength(2);
        expect(Buffer.byteLength(content), `${name}/${path} bytes`).toBeLessThanOrEqual(REFERENCE_MAX_BYTES);
      }
      if (!path.endsWith(".md")) continue;
      for (const [, target] of content.matchAll(/\]\(([^)#\s]+)\)/g)) {
        if (/^https?:/.test(target!)) continue;
        await expect(stat(resolve(dirname(file), target!)), `${name}/${path} links ${target}`).resolves.toBeTruthy();
      }
    }
    const metadata = await readFile(join(directory, "agents", "openai.yaml"), "utf8");
    expect(metadata).toContain(`$${name}`);
  });

  it("installs atomically, stamps the version and removes the retired router skill", async () => {
    const target = await mkdtemp(join(tmpdir(), "scalius-skills-root-"));
    await mkdir(join(target, "scalius-commerce"), { recursive: true });
    await writeFile(join(target, "scalius-commerce", "SKILL.md"), "---\nname: scalius-commerce\ndescription: old\n---\n");
    await mkdir(join(target, "my-own-skill"), { recursive: true });
    await writeFile(join(target, "my-own-skill", "SKILL.md"), "---\nname: my-own-skill\ndescription: mine\n---\n");
    await installSkillSuite(target, false);
    await expect(stat(join(target, "scalius-commerce"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(target, "my-own-skill", "SKILL.md"))).resolves.toBeTruthy();
    expect(await readSkillStamp(target)).toEqual({ version: packageVersion(), skills: [...SCALIUS_SKILL_NAMES] });
  });

  it("keeps the Claude Code and Codex plugin manifests on the package version", async () => {
    const { claude, codex, marketplace, mcp } = await publishedManifests();
    const version = packageVersion();
    expect(claude).toMatchObject({ name: "scalius", version });
    expect(codex).toMatchObject({ name: "scalius", version, skills: "./skills/", mcpServers: "./.mcp.json" });
    expect(marketplace).toMatchObject({ name: "scalius", plugins: [{ name: "scalius", source: "./", version }] });
    expect(mcp).toEqual({ mcpServers: { scalius: { command: "npx", args: ["-y", `scalius@${version}`, "mcp"] } } });
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };
    expect(manifest.files).toEqual(expect.arrayContaining(["skills", ".claude-plugin", ".codex-plugin", ".mcp.json"]));
  });
});
