import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const patchUrl = new URL(
  "../patches/@flue__runtime@1.0.0-beta.9.patch",
  import.meta.url,
);
const lockfileUrl = new URL("../pnpm-lock.yaml", import.meta.url);

describe("Flue runtime policy patch", () => {
  it("does not expose recursive task delegation when an agent declares no subagents", async () => {
    const [patch, lockfile] = await Promise.all([
      readFile(patchUrl, "utf8"),
      readFile(lockfileUrl, "utf8"),
    ]);

    expect(lockfile).toContain("'@flue/runtime@1.0.0-beta.9':");
    expect(lockfile).toContain("patchedDependencies:");
    expect(patch).toContain(
      "Object.keys(this.config.subagents ?? {}).length > 0 ? createTaskTool",
    );
    expect(patch).toContain("tools: frameworkTools");
  });
});
