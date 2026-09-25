import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkAppDist, parseEnvFileNames, scanText } from "./check-dist-secrets.mjs";

const scriptPath = new URL("./check-dist-secrets.mjs", import.meta.url).pathname;
const VALUE = "synthetic-canary-value-7f3a";
const names = ["SCALIUS_SECRET", "CREDENTIAL_ENCRYPTION_KEY", "API_TOKEN", "STOREFRONT_URL"];
const tmpRoots = [];

function appWithDist(files, localEnv) {
  const appDir = mkdtempSync(join(tmpdir(), "scalius-dist-secrets-"));
  tmpRoots.push(appDir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(appDir, "dist", path, ".."), { recursive: true });
    writeFileSync(join(appDir, "dist", path), text);
  }
  if (localEnv) writeFileSync(join(appDir, ".dev.vars"), localEnv);
  return appDir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("scanText", () => {
  it("reports Astro's inlined private env by name, never by value", () => {
    const text = `if (Object.assign({"BASE_URL": "/", "DEV": false, "MODE": "production", "PROD": true, "SSR": true}, {
      API_TOKEN: "${VALUE}", SCALIUS_SECRET: "${VALUE}" }).SSR) {}`;
    const found = scanText(text, { names });
    expect(found).toContain("private env inlined: API_TOKEN, SCALIUS_SECRET");
    expect(found).toContain("SCALIUS_SECRET is bound to a string literal");
    expect(found.join("\n")).not.toContain(VALUE);
  });

  it("reports PUBLIC_ or other keys in an inlined import.meta.env object", () => {
    const text = `const e={ASSETS_PREFIX:void 0,BASE_URL:"/",DEV:!1,MODE:"production",PROD:!0,PUBLIC_API_URL:"${VALUE}",SITE:void 0,SSR:!0};`;
    expect(scanText(text, { names })).toEqual(["import.meta.env carries PUBLIC_API_URL"]);
    expect(scanText('const e={BASE_URL:"/",DEV:!1,MODE:"production",PROD:!0,SSR:!0};', { names })).toEqual([]);
  });

  it("allows the derived-secret purpose labels and plain name references", () => {
    const text = [
      'var RUNTIME_SECRET_PURPOSES = { API_TOKEN: "service-api-token", JWT_SECRET: "jwt-signing" };',
      'var MASTER_SECRET_NAME = "SCALIUS_SECRET";',
      "const value = env.SCALIUS_SECRET; if (env.API_TOKEN === \"\") {}",
      'console.error("API_TOKEN is not configured.");',
    ].join("\n");
    expect(scanText(text, { names: [...names, "JWT_SECRET"] })).toEqual([]);
  });

  it("reports a secret assigned a literal, including in source maps", () => {
    expect(scanText(`process.env.SCALIUS_SECRET = "${VALUE}";`, { names })).toEqual([
      "SCALIUS_SECRET is bound to a string literal",
    ]);
    expect(scanText(`{"sourcesContent":["const x = { API_TOKEN: \\"${VALUE}\\" }"]}`, { names })).toEqual([
      "API_TOKEN is bound to a string literal",
    ]);
  });

  it("keeps installed secret names out of browser output only", () => {
    const text = "const hint = 'SCALIUS_SECRET must be installed';";
    expect(scanText(text, { names })).toEqual([]);
    expect(scanText(text, { names, browser: true })).toEqual(["SCALIUS_SECRET is named in browser output"]);
  });

  it("reports canaries by index", () => {
    expect(scanText(`x="${VALUE}"`, { names, canaries: ["absent", VALUE] })).toEqual(["canary #2 found"]);
  });
});

describe("parseEnvFileNames", () => {
  it("returns names only", () => {
    expect(parseEnvFileNames(`# c\nSCALIUS_SECRET="${VALUE}"\nexport API_TOKEN=${VALUE}\n\nnot a line\n`))
      .toEqual(["SCALIUS_SECRET", "API_TOKEN"]);
  });
});

describe("checkAppDist", () => {
  it("fails on env files in dist and on names declared in the app's local env files", () => {
    const appDir = appWithDist(
      {
        "server/.dev.vars": `SCALIUS_SECRET=${VALUE}\n`,
        "server/chunks/a.mjs": `const c = { LEGACY_LOCAL_TOKEN: "${VALUE}" };`,
        "client/app.js": "export {};",
      },
      `LEGACY_LOCAL_TOKEN=${VALUE}\n`,
    );
    const violations = checkAppDist(appDir);
    expect(violations.some((v) => v.endsWith("dist/server/.dev.vars: local env file in build output"))).toBe(true);
    expect(violations.some((v) => v.endsWith("a.mjs: LEGACY_LOCAL_TOKEN is bound to a string literal"))).toBe(true);
    expect(violations.join("\n")).not.toContain(VALUE);
  });

  it("passes clean output and fails the CLI on a leak without printing the value", () => {
    const clean = appWithDist({ "server/entry.mjs": "export default { fetch() {} };" });
    expect(checkAppDist(clean)).toEqual([]);

    const leaky = appWithDist({ "client/app.js": `window.x = { CREDENTIAL_ENCRYPTION_KEY: "${VALUE}" };` });
    let output = "";
    try {
      execFileSync(process.execPath, [scriptPath, leaky], { stdio: "pipe" });
    } catch (error) {
      output = `${error.stdout}${error.stderr}`;
    }
    expect(output).toContain("CREDENTIAL_ENCRYPTION_KEY is bound to a string literal");
    expect(output).toContain("CREDENTIAL_ENCRYPTION_KEY is named in browser output");
    expect(output).not.toContain(VALUE);
  });
});
