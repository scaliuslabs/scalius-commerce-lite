import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../../../..");

describe("Tiptap ProseMirror dependency boundary", () => {
  it("keeps one prosemirror-model implementation across every editor command", () => {
    const workspace = readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8");
    const lockfile = readFileSync(resolve(repoRoot, "pnpm-lock.yaml"), "utf8");

    expect(workspace).toContain('prosemirror-model: "1.25.11"');
    const lockedVersions = [
      ...lockfile.matchAll(/^\x20{2}prosemirror-model@([^:]+):/gm),
    ].map((match) => match[1]);

    expect(new Set(lockedVersions)).toEqual(new Set(["1.25.11"]));
    expect(lockfile).not.toContain("prosemirror-model@1.25.8");
    expect(lockfile).not.toContain("prosemirror-model: 1.25.8");
  });
});
