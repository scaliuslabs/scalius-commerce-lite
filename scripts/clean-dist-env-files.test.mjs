import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = new URL("./clean-dist-env-files.mjs", import.meta.url);
const tmpRoots = [];

function createAppDist() {
  const root = mkdtempSync(join(tmpdir(), "scalius-dist-env-"));
  tmpRoots.push(root);
  const appDir = join(root, "app");
  const distDir = join(appDir, "dist", "server");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, ".dev.vars"), "SECRET=local-only\n");
  writeFileSync(join(distDir, "entry.mjs"), "export default {}\n");
  return { appDir, distDir };
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("clean-dist-env-files", () => {
  it("removes local env files from app dist output", () => {
    const { appDir, distDir } = createAppDist();

    execFileSync(process.execPath, [scriptPath.pathname, appDir]);

    expect(existsSync(join(distDir, ".dev.vars"))).toBe(false);
    expect(existsSync(join(distDir, "entry.mjs"))).toBe(true);
  });

  it("fails in check mode without deleting the env file", () => {
    const { appDir, distDir } = createAppDist();

    expect(() =>
      execFileSync(process.execPath, [scriptPath.pathname, "--check", appDir], {
        stdio: "pipe",
      }),
    ).toThrow();
    expect(existsSync(join(distDir, ".dev.vars"))).toBe(true);
  });
});
